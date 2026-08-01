#!/usr/bin/env node
/**
 * claude-model-error-rates.mjs
 *
 * Standalone analysis pass over Claude Code's own session transcripts
 * (~/.claude/projects/**\/*.jsonl, one JSON object per line) to compute
 * a per-model x error-class breakdown: API errors (network/5xx/overloaded/
 * rate-limited), model-safety refusal fallbacks, truncated responses
 * (stop_reason: "max_tokens"), and tool-call failures.
 *
 * This is a READ-ONLY, offline pass over local log files already on disk.
 * It does not call any network API and does not modify the transcripts.
 *
 * Schema notes (reverse-engineered from real transcripts on this machine,
 * Claude Code CLI ~v2.1.153-2.1.206):
 *
 *   - Each line is a JSON object with a "type" field: "user" | "assistant" |
 *     "system" | "attachment" | "file-history-snapshot" | "queue-operation" |
 *     "mode" | "permission-mode" | "ai-title" | "last-prompt".
 *
 *   - type:"assistant" carries message.model (e.g. "claude-opus-4-8",
 *     "claude-sonnet-5", "claude-fable-5", "claude-haiku-4-5-20251001") and
 *     message.stop_reason ("end_turn" | "tool_use" | "stop_sequence" |
 *     "max_tokens"). This is the ONLY place the real model id is recorded
 *     per-turn — there is no session-level "model" field.
 *
 *   - Soft/billing-adjacent failures (spend limit hit, out of usage
 *     credits, prompt too long, not logged in, image processing failure,
 *     mid-response connection drop) surface as a SYNTHETIC assistant
 *     message: type:"assistant", message.model:"<synthetic>",
 *     isApiErrorMessage:true, with a human-readable text block. Because
 *     the model field is "<synthetic>" rather than the real model, these
 *     are attributed here to the last real (non-synthetic) model seen
 *     earlier in the same session.
 *
 *   - Hard transport/API failures (connection refused/reset, DNS failure,
 *     529 overloaded, 5xx, 429 rate-limited) surface as
 *     type:"system", subtype:"api_error", with a structured `error` object
 *     (error.formatted, error.connection.code) plus retryAttempt/
 *     retryInMs/maxRetries. No model field either — same
 *     last-real-model attribution as above. Each retry attempt writes its
 *     own line, so retryAttempt lets us recover backoff/retry counts.
 *
 *   - Model-safety fallbacks (a model's own safeguards refuse a message
 *     and Claude Code silently retries on a different model) surface as
 *     type:"system", subtype:"model_refusal_fallback" (or
 *     "model_consent_fallback"), and DO carry exact originalModel /
 *     fallbackModel fields — the cleanest per-model attribution of any
 *     error class found. Session's "current model" is updated to
 *     fallbackModel afterward.
 *
 *   - Tool-call failures surface as type:"user" (Claude Code represents
 *     tool results as synthetic user turns) with a content block
 *     { type:"tool_result", is_error:true, tool_use_id }. These are
 *     correlated back to the model that issued the matching tool_use
 *     block. NOTE: this bucket is noisy — it includes routine command
 *     failures (grep no-match, non-existent file, non-zero exit) that
 *     have nothing to do with Claude Code/API reliability, alongside
 *     genuine tool-plumbing failures. Reported separately from the
 *     "hard" API-reliability classes for that reason; see --help.
 *
 * Usage:
 *   node scripts/claude-model-error-rates.mjs [options]
 *
 * Options:
 *   --dir <path>       Root to scan for *.jsonl transcripts
 *                       (default: ~/.claude/projects)
 *   --since <ISO date> Only count events at/after this timestamp
 *   --project <substr> Only scan project dirs whose name contains this
 *   --json             Emit raw JSON instead of formatted tables
 *   --samples <n>      Include up to n raw sample error snippets per
 *                       class in JSON output, for spot-checking (default 3)
 *   --help             Show this help and exit
 */

import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";

function parseArgs(argv) {
  const opts = {
    dir: path.join(os.homedir(), ".claude", "projects"),
    since: null,
    project: null,
    json: false,
    samples: 3,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") opts.dir = argv[++i];
    else if (a === "--since") opts.since = argv[++i];
    else if (a === "--project") opts.project = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--samples") opts.samples = Number(argv[++i]);
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`claude-model-error-rates.mjs

Scans Claude Code session transcripts (~/.claude/projects/**/*.jsonl by
default) and reports a per-model x error-class breakdown: API errors
(network/5xx/overloaded/rate-limited), model-safety refusal fallbacks,
truncated (max_tokens) responses, and tool-call failures.

Options:
  --dir <path>       Root to scan (default: ~/.claude/projects)
  --since <ISO date> Only count events at/after this timestamp
  --project <substr> Only scan project dirs whose name contains this
  --json             Emit raw JSON instead of formatted tables
  --samples <n>      Sample error snippets per class in JSON (default 3)
  --help             Show this help
`);
}

// ---- error classification -------------------------------------------------

/** Classify a system/api_error record's structured error into a class. */
function classifyApiErrorEvent(err) {
  const code = err?.connection?.code || "";
  const formatted = (err?.formatted || err?.message || "").toLowerCase();
  if (/econnreset|econnrefused|enotfound|etimedout|epipe|eai_again/i.test(code)) {
    return "network_error";
  }
  if (/overloaded/.test(formatted)) return "overloaded";
  if (/500|internal server error/.test(formatted)) return "server_5xx";
  if (/rate.?limit|429|temporarily limiting/.test(formatted)) return "rate_limited_429";
  if (/connect/.test(formatted)) return "network_error";
  return "api_error_other";
}

/** Classify a synthetic isApiErrorMessage:true assistant text into a class. */
function classifySyntheticErrorText(text) {
  const t = (text || "").toLowerCase();
  if (/monthly spend limit/.test(t)) return "spend_limit_soft_block";
  if (/usage credit/.test(t)) return "usage_credits_soft_block";
  if (/prompt is too long/.test(t)) return "context_too_long";
  if (/not logged in/.test(t)) return "auth_error";
  if (/could not be processed/.test(t)) return "input_processing_error";
  if (/connection closed mid-response/.test(t)) return "connection_closed_mid_response";
  if (/overloaded/.test(t)) return "overloaded";
  if (/temporarily limiting requests/.test(t)) return "rate_limited_429";
  if (/500 internal server error/.test(t)) return "server_5xx";
  if (/unable to connect to api/.test(t)) return "network_error";
  return "other_synthetic_error";
}

/** Coarse model "family" for the human-readable rollup the todo item asks for. */
function modelFamily(model) {
  if (!model) return "unknown";
  const m = model.match(/^claude-(opus|sonnet|haiku|fable)-(\d[\w.-]*)/);
  if (!m) return model;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace(/-\d{8}$/, "")}`;
}

// ---- aggregation state ------------------------------------------------------

function newModelBucket() {
  return {
    turns: 0, // real (non-synthetic) assistant messages
    toolCalls: 0,
    toolErrors: 0,
    errors: {}, // class -> count (turn-level "hard" classes)
    retryEvents: 0, // count of system/api_error retry attempts
    projects: {}, // cwd -> turns (task-shape proxy)
  };
}

function bump(obj, key, n = 1) {
  obj[key] = (obj[key] || 0) + n;
}

async function* walkJsonlFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkJsonlFiles(full);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      yield full;
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const sinceMs = opts.since ? Date.parse(opts.since) : null;

  const models = new Map(); // model -> bucket
  const samples = {}; // class -> [snippet, ...]
  let filesScanned = 0;
  let linesScanned = 0;
  let sessionsScanned = 0;
  let firstTs = null;
  let lastTs = null;
  let unattributedErrorEvents = 0; // errors seen before any real model was observed in that session

  const getBucket = (model) => {
    if (!models.has(model)) models.set(model, newModelBucket());
    return models.get(model);
  };

  const addSample = (cls, obj) => {
    if (!samples[cls]) samples[cls] = [];
    if (samples[cls].length < opts.samples) samples[cls].push(obj);
  };

  for await (const file of walkJsonlFiles(opts.dir)) {
    if (opts.project && !file.includes(opts.project)) continue;
    filesScanned++;
    sessionsScanned++;

    let currentModel = null; // last real model observed in this session
    const toolUseModel = new Map(); // tool_use_id -> model that issued it

    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      linesScanned++;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue; // tolerate a truncated last line mid-write
      }

      const ts = d.timestamp ? Date.parse(d.timestamp) : null;
      if (ts) {
        if (firstTs === null || ts < firstTs) firstTs = ts;
        if (lastTs === null || ts > lastTs) lastTs = ts;
        if (sinceMs && ts < sinceMs) continue;
      }

      const cwd = d.cwd || null;

      if (d.type === "assistant") {
        const msg = d.message || {};
        const model = msg.model || null;

        if (model && model !== "<synthetic>") {
          currentModel = model;
          const b = getBucket(model);
          b.turns++;
          if (cwd) bump(b.projects, cwd);
          if (msg.stop_reason === "max_tokens") {
            bump(b.errors, "truncation_max_tokens");
            addSample("truncation_max_tokens", { file, model, requestId: d.requestId });
          }
          if (Array.isArray(msg.content)) {
            for (const c of msg.content) {
              if (c && c.type === "tool_use" && c.id) {
                toolUseModel.set(c.id, model);
                b.toolCalls++;
              }
            }
          }
        } else if (d.isApiErrorMessage === true) {
          const content = msg.content;
          let text = null;
          if (Array.isArray(content)) {
            const t = content.find((c) => c && c.type === "text");
            text = t ? t.text : null;
          } else if (typeof content === "string") {
            text = content;
          }
          const cls = classifySyntheticErrorText(text);
          const attrModel = currentModel || "unknown";
          if (!currentModel) unattributedErrorEvents++;
          const b = getBucket(attrModel);
          bump(b.errors, cls);
          addSample(cls, { file, attrModel, text: (text || "").slice(0, 160) });
        }
      } else if (d.type === "user") {
        const content = d.message?.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c && c.type === "tool_result" && c.is_error === true) {
              const model = toolUseModel.get(c.tool_use_id) || currentModel || "unknown";
              const b = getBucket(model);
              b.toolErrors++;
            }
          }
        }
      } else if (d.type === "system") {
        if (d.subtype === "api_error") {
          const cls = classifyApiErrorEvent(d.error);
          const attrModel = currentModel || "unknown";
          if (!currentModel) unattributedErrorEvents++;
          const b = getBucket(attrModel);
          bump(b.errors, cls);
          b.retryEvents++;
          addSample(cls, {
            file,
            attrModel,
            formatted: d.error?.formatted,
            retryAttempt: d.retryAttempt,
          });
        } else if (d.subtype === "model_refusal_fallback" || d.subtype === "model_consent_fallback") {
          const cls = d.subtype === "model_refusal_fallback" ? "refusal_fallback" : "consent_fallback";
          const origModel = d.originalModel || currentModel || "unknown";
          const b = getBucket(origModel);
          bump(b.errors, cls);
          addSample(cls, {
            file,
            originalModel: d.originalModel,
            fallbackModel: d.fallbackModel,
            category: d.apiRefusalCategory,
          });
          // Session continues on the fallback model from here on.
          if (d.fallbackModel) currentModel = d.fallbackModel;
        }
      }
    }
    if (filesScanned % 200 === 0) {
      process.stderr.write(`  scanned ${filesScanned} files, ${linesScanned} lines...\n`);
    }
  }

  const summary = {
    scannedDir: opts.dir,
    filesScanned,
    linesScanned,
    sessionsScanned,
    dateRange: {
      first: firstTs ? new Date(firstTs).toISOString() : null,
      last: lastTs ? new Date(lastTs).toISOString() : null,
    },
    unattributedErrorEvents,
    models: {},
  };

  for (const [model, b] of models) {
    if (model === "unknown") continue;
    const hardErrorTotal = Object.values(b.errors).reduce((a, n) => a + n, 0);
    summary.models[model] = {
      family: modelFamily(model),
      turns: b.turns,
      hardErrorTotal,
      hardErrorRatePct: b.turns ? +((hardErrorTotal / b.turns) * 100).toFixed(3) : null,
      errorsByClass: b.errors,
      retryEvents: b.retryEvents,
      toolCalls: b.toolCalls,
      toolErrors: b.toolErrors,
      toolErrorRatePct: b.toolCalls ? +((b.toolErrors / b.toolCalls) * 100).toFixed(3) : null,
      topProjects: Object.entries(b.projects)
        .sort((a, z) => z[1] - a[1])
        .slice(0, 5)
        .map(([p, n]) => ({ project: path.basename(p), turns: n })),
    };
  }
  if (models.has("unknown")) {
    const b = models.get("unknown");
    summary.unknownModelBucket = {
      note: "Errors observed before any real model was seen in that session (e.g. error is the first event, or session log starts mid-stream).",
      errorsByClass: b.errors,
      retryEvents: b.retryEvents,
    };
  }

  if (opts.json) {
    console.log(JSON.stringify({ summary, samples }, null, 2));
    return;
  }

  // ---- formatted table output ----
  console.log("Claude Code per-model error-rate report");
  console.log("========================================");
  console.log(`Scanned dir:      ${summary.scannedDir}`);
  console.log(`Sessions scanned: ${summary.sessionsScanned}  (${summary.filesScanned} files, ${summary.linesScanned} lines)`);
  console.log(`Date range:       ${summary.dateRange.first} .. ${summary.dateRange.last}`);
  console.log(`Unattributed error events (no known model yet): ${summary.unattributedErrorEvents}`);
  console.log("");

  const rows = Object.entries(summary.models).sort((a, z) => z[1].turns - a[1].turns);

  console.log("Overview (hard API-reliability errors: network/5xx/overloaded/rate-limited,");
  console.log("refusal fallbacks, spend/usage soft-blocks, max_tokens truncation)");
  console.log("-".repeat(100));
  console.log(
    padCols(["Model", "Family", "Turns", "Errors", "Error%", "Retries", "ToolCalls", "ToolErr", "ToolErr%"], [26, 14, 8, 8, 8, 8, 10, 8, 9])
  );
  for (const [model, m] of rows) {
    console.log(
      padCols(
        [
          model,
          m.family,
          String(m.turns),
          String(m.hardErrorTotal),
          m.hardErrorRatePct != null ? `${m.hardErrorRatePct}%` : "-",
          String(m.retryEvents),
          String(m.toolCalls),
          String(m.toolErrors),
          m.toolErrorRatePct != null ? `${m.toolErrorRatePct}%` : "-",
        ],
        [26, 14, 8, 8, 8, 8, 10, 8, 9]
      )
    );
  }

  console.log("");
  console.log("Per-model error-class breakdown (counts)");
  console.log("-".repeat(100));
  const allClasses = new Set();
  for (const [, m] of rows) for (const c of Object.keys(m.errorsByClass)) allClasses.add(c);
  const classList = [...allClasses].sort();
  console.log(padCols(["Model", ...classList], [26, ...classList.map(() => 14)]));
  for (const [model, m] of rows) {
    console.log(
      padCols(
        [model, ...classList.map((c) => String(m.errorsByClass[c] || 0))],
        [26, ...classList.map(() => 14)]
      )
    );
  }

  if (summary.unknownModelBucket) {
    console.log("");
    console.log("Unattributed (no model known yet in session):", JSON.stringify(summary.unknownModelBucket.errorsByClass));
  }

  console.log("");
  console.log("NOTE: ToolErr/ToolErr% is a noisy bucket — it includes routine command");
  console.log("failures (bad path, non-zero exit, no grep match) alongside genuine tool-");
  console.log("plumbing failures, so it is reported separately from the hard error rate.");
}

function padCols(cells, widths) {
  return cells.map((c, i) => String(c).padEnd(widths[i] ?? 12)).join(" ");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
