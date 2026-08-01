//! Live per-model error-class tracking — Slice 2 of the per-model error-rate work (Slice 1:
//! `scripts/claude-model-error-rates.mjs`, a READ-ONLY offline batch pass over
//! `~/.claude/projects/**/*.jsonl`).
//!
//! ## Data source (the load-bearing design call)
//!
//! maiTerm's hook pipeline (`claude_code/server.rs::hooks_handler`) sees per-tab model +
//! lifecycle events, but NOT the error-signal classes Slice 1 classifies — `system/api_error`
//! (hard transport failures), synthetic `isApiErrorMessage:true` soft-blocks (spend/usage
//! limits, context-too-long, …), `system/model_refusal_fallback`, assistant
//! `stop_reason:"max_tokens"` (truncation), and `tool_result.is_error` (tool failures,
//! correlated via `tool_use_id`) — none of these are hook events. They live ONLY in the
//! session's transcript JSONL.
//!
//! So this module tails the transcript directly, using the SAME resolver
//! (`mailink::transcript::locate_jsonl`) the maiLink chat distiller already uses: local
//! `~/.claude/projects/*/<sid>.jsonl` first, falling back to the SSH shadow-mirror copy
//! (`mailink::mirror`) when maiLink is bridging a remote tab. That single lookup is what makes
//! this "just work" for both local and (already-mirrored) SSH tabs with no new I/O path.
//!
//! Reading is triggered off the EXISTING hook lifecycle: `hooks_handler` already re-touches
//! `AgentSessionInfo.transcript_path` and calls `mailink::mirror::schedule_fetch` on every hook
//! event (see the tail of its match in server.rs). `on_hook_event` below is called from that
//! same spot, so a turn's errors surface within one hook tick of landing — no polling loop, no
//! steady-state cost beyond a cheap seek+read of local bytes already on disk (a `stat()` short-
//! circuits the common "nothing new" case). This is a clear winner over a hook-fields-only
//! design (which would silently miss every signal class above), so no HITL/park is needed here.
//!
//! Classification (`classify_line`, `classify_synthetic_error_text`, `classify_api_error_event`,
//! `model_family`) is a line-for-line Rust port of Slice 1's `classify*`/`modelFamily` functions
//! — SAME class name strings, so live counts are directly comparable to a batch run over the
//! same file (see `tests` below, which assert exact parity on a shared fixture transcript).
//! Keep both in sync if the signal taxonomy changes.
//!
//! ## Scope of this slice
//!
//! Backend live-tracking + a minimal panel (`ModelErrorPanel.svelte`, Cmd+Shift+E), modeled on
//! the subagent panel. Counts are scoped to the CURRENT session only (cleared on `SessionEnd`,
//! same precedent as `AgentSessionInfo.subagents` — no rehydration command, no persistence
//! across a resumed session). Follow-ups (filed as remaining slices, not built here): carrying
//! counts across a tab's resumed sessions, a richer historical/trend view, and a first-class SSH
//! transcript-tail path that doesn't depend on maiLink already mirroring the tab.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;

use crate::state::app_state::{ErrorTailState, ModelErrorCounts};
use crate::state::AppState;

/// Bucket key used when an error is observed before any real model has been seen in the
/// session's transcript yet (mirrors Slice 1's `"unknown"` bucket).
pub const UNKNOWN_MODEL: &str = "unknown";

/// One model's live error-class summary for a tab — what `get_tab_model_errors` returns to the
/// frontend panel (initial load; live updates ride the `agent-model-errors-updated` event).
#[derive(Clone, serde::Serialize)]
pub struct ModelErrorSummary {
    pub model: String,
    pub family: String,
    #[serde(flatten)]
    pub counts: ModelErrorCounts,
}

/// Current per-model error summaries for a tab's live (or most-recently-ended-without-a-new-
/// session) agent session — the `get_tab_model_errors` Tauri command's implementation. Scoped
/// to whichever session(s) currently carry this `tab_id` in `agent_sessions` (in practice one).
pub fn tab_summaries(app: &Arc<AppState>, tab_id: &str) -> Vec<ModelErrorSummary> {
    let sessions = app.agent_sessions.read();
    sessions
        .values()
        .filter(|s| s.tab_id == tab_id)
        .flat_map(|s| to_summaries(&s.error_counts))
        .collect()
}

/// Shared shape between the `get_tab_model_errors` command (above) and the
/// `agent-model-errors-updated` live event (`hooks_handler` in server.rs) — both send the
/// frontend the SAME `{model, family, ...counts}` array, so `ModelErrorPanel.svelte` has one
/// merge path regardless of whether it came from the initial fetch or a live update.
pub fn to_summaries(counts: &HashMap<String, ModelErrorCounts>) -> Vec<ModelErrorSummary> {
    counts
        .iter()
        .map(|(model, c)| ModelErrorSummary {
            model: model.clone(),
            family: model_family(model),
            counts: c.clone(),
        })
        .collect()
}

/// Entry point called from `hooks_handler` on every Claude hook event for a known session.
/// Tails the session's transcript from the last-read offset, classifies any newly-appended
/// lines, and merges the delta into `AgentSessionInfo.error_counts`.
///
/// Returns the session's updated (cumulative) per-model counts when something changed, so the
/// caller can emit a live-update event without taking its own lock; `None` means either the
/// transcript hasn't grown, isn't resolvable yet, or the session is already gone (e.g. this
/// call landed after `SessionEnd` already removed it — same as `mailink::mirror::schedule_fetch`
/// silently no-opping in that case).
pub fn on_hook_event(app: &Arc<AppState>, session_id: &str) -> Option<HashMap<String, ModelErrorCounts>> {
    let path = crate::mailink::transcript::locate_jsonl(session_id)?;

    // Phase 1: read + classify the delta. Only the tailer's own per-session state is touched
    // here — never held alongside the agent_sessions lock, so lock order can't invert.
    let delta = {
        let mut tails = app.error_tail_state.write();
        let tail = tails.entry(session_id.to_string()).or_default();
        read_and_classify_delta(&path, tail)?
    };
    if delta.is_empty() {
        return None;
    }

    // Phase 2: merge the delta into the session's public rollup.
    let mut sessions = app.agent_sessions.write();
    let session = sessions.get_mut(session_id)?;
    for (model, add) in delta {
        let bucket = session.error_counts.entry(model).or_default();
        bucket.turns += add.turns;
        bucket.tool_calls += add.tool_calls;
        bucket.tool_errors += add.tool_errors;
        bucket.retry_events += add.retry_events;
        for (cls, n) in add.errors_by_class {
            *bucket.errors_by_class.entry(cls).or_insert(0) += n;
        }
    }
    Some(session.error_counts.clone())
}

/// Drop a session's tailer bookkeeping (called from `hooks_handler`'s `SessionEnd` arm,
/// alongside the `agent_sessions` removal that already discards `error_counts`) so a long-lived
/// app doesn't accumulate one offset/classifier-state entry per session forever.
pub fn forget_session(app: &Arc<AppState>, session_id: &str) {
    app.error_tail_state.write().remove(session_id);
}

/// Read the transcript's new bytes since `tail.offset`, classify each complete new line, and
/// return the per-model delta (NOT cumulative — the caller merges it). Only consumes up to the
/// last complete newline, so a line still being written is picked up on the next call rather
/// than parsed half-written. `None` = nothing new to report (no growth, or only a partial line
/// pending); the tail's offset is left untouched in that case.
fn read_and_classify_delta(
    path: &std::path::Path,
    tail: &mut ErrorTailState,
) -> Option<HashMap<String, ModelErrorCounts>> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len < tail.offset {
        // Replaced/rotated transcript (shouldn't happen for append-only JSONL, but never
        // stall) — reset and reclassify from the top on the next pass.
        *tail = ErrorTailState::default();
    }
    if len <= tail.offset {
        return None;
    }

    file.seek(SeekFrom::Start(tail.offset)).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;

    let last_nl = buf.iter().rposition(|&b| b == b'\n')?;
    let consume = last_nl + 1;
    let text = String::from_utf8_lossy(&buf[..consume]).into_owned();

    let mut delta: HashMap<String, ModelErrorCounts> = HashMap::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            classify_line(&v, tail, &mut delta);
        }
        // Tolerate a truncated/malformed line (e.g. read mid-write) — same as Slice 1's script.
    }
    tail.offset += consume as u64;
    Some(delta)
}

fn bump(map: &mut HashMap<String, u64>, key: &str, n: u64) {
    *map.entry(key.to_string()).or_insert(0) += n;
}

/// Classify one parsed transcript line, mutating `tail`'s running classifier state
/// (current model, in-flight tool_use→model correlation) and bumping `delta`. Line-for-line
/// port of the `type:"assistant"|"user"|"system"` branches in
/// `scripts/claude-model-error-rates.mjs`'s per-line loop — keep both in sync.
fn classify_line(v: &Value, tail: &mut ErrorTailState, delta: &mut HashMap<String, ModelErrorCounts>) {
    let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match ty {
        "assistant" => classify_assistant(v, tail, delta),
        "user" => classify_user(v, tail, delta),
        "system" => classify_system(v, tail, delta),
        _ => {}
    }
}

fn classify_assistant(v: &Value, tail: &mut ErrorTailState, delta: &mut HashMap<String, ModelErrorCounts>) {
    let msg = v.get("message").cloned().unwrap_or(Value::Null);
    let model = msg.get("model").and_then(|m| m.as_str());

    if let Some(model) = model.filter(|m| *m != "<synthetic>") {
        // A real turn: track it as the session's current model, bump turns/tool_calls, and
        // record any tool_use_id → model correlation for later tool_result attribution.
        tail.current_model = Some(model.to_string());
        let bucket = delta.entry(model.to_string()).or_default();
        bucket.turns += 1;
        if msg.get("stop_reason").and_then(|s| s.as_str()) == Some("max_tokens") {
            bump(&mut bucket.errors_by_class, "truncation_max_tokens", 1);
        }
        if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
            for c in content {
                if c.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                    if let Some(id) = c.get("id").and_then(|i| i.as_str()) {
                        tail.tool_use_model.insert(id.to_string(), model.to_string());
                    }
                    bucket.tool_calls += 1;
                }
            }
        }
    } else if v.get("isApiErrorMessage").and_then(|b| b.as_bool()) == Some(true) {
        // Synthetic soft-block/error message (model:"<synthetic>") — attribute to the last
        // real model seen in this session so far (or "unknown" if none yet).
        let text = extract_text(&msg).unwrap_or_default();
        let cls = classify_synthetic_error_text(&text);
        let attr_model = tail.current_model.clone().unwrap_or_else(|| UNKNOWN_MODEL.to_string());
        bump(&mut delta.entry(attr_model).or_default().errors_by_class, &cls, 1);
    }
}

fn classify_user(v: &Value, tail: &mut ErrorTailState, delta: &mut HashMap<String, ModelErrorCounts>) {
    let Some(content) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) else {
        return;
    };
    for c in content {
        if c.get("type").and_then(|t| t.as_str()) == Some("tool_result")
            && c.get("is_error").and_then(|b| b.as_bool()) == Some(true)
        {
            let id = c.get("tool_use_id").and_then(|i| i.as_str());
            // Correlate back to the model that issued the matching tool_use, then FORGET the
            // entry — unlike Slice 1's one-shot batch Map, a live session must not accumulate
            // in-flight tool_use_ids forever.
            let model = id
                .and_then(|id| tail.tool_use_model.remove(id))
                .or_else(|| tail.current_model.clone())
                .unwrap_or_else(|| UNKNOWN_MODEL.to_string());
            delta.entry(model).or_default().tool_errors += 1;
        }
    }
}

fn classify_system(v: &Value, tail: &mut ErrorTailState, delta: &mut HashMap<String, ModelErrorCounts>) {
    let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
    if subtype == "api_error" {
        let err = v.get("error").cloned().unwrap_or(Value::Null);
        let cls = classify_api_error_event(&err);
        let attr_model = tail.current_model.clone().unwrap_or_else(|| UNKNOWN_MODEL.to_string());
        let bucket = delta.entry(attr_model).or_default();
        bump(&mut bucket.errors_by_class, &cls, 1);
        bucket.retry_events += 1;
    } else if subtype == "model_refusal_fallback" || subtype == "model_consent_fallback" {
        let cls = if subtype == "model_refusal_fallback" { "refusal_fallback" } else { "consent_fallback" };
        let orig_model = v
            .get("originalModel")
            .and_then(|m| m.as_str())
            .map(String::from)
            .or_else(|| tail.current_model.clone())
            .unwrap_or_else(|| UNKNOWN_MODEL.to_string());
        bump(&mut delta.entry(orig_model).or_default().errors_by_class, cls, 1);
        // The session continues on the fallback model from here on — mirrors Slice 1.
        if let Some(fb) = v.get("fallbackModel").and_then(|m| m.as_str()) {
            tail.current_model = Some(fb.to_string());
        }
    }
}

/// `message.content` may be an array of blocks (find the first `text` block) or a plain string.
fn extract_text(msg: &Value) -> Option<String> {
    match msg.get("content") {
        Some(Value::Array(arr)) => arr
            .iter()
            .find(|c| c.get("type").and_then(|t| t.as_str()) == Some("text"))
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .map(String::from),
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// Port of `classifySyntheticErrorText` in `scripts/claude-model-error-rates.mjs`.
fn classify_synthetic_error_text(text: &str) -> String {
    let t = text.to_lowercase();
    let cls = if t.contains("monthly spend limit") {
        "spend_limit_soft_block"
    } else if t.contains("usage credit") {
        "usage_credits_soft_block"
    } else if t.contains("prompt is too long") {
        "context_too_long"
    } else if t.contains("not logged in") {
        "auth_error"
    } else if t.contains("could not be processed") {
        "input_processing_error"
    } else if t.contains("connection closed mid-response") {
        "connection_closed_mid_response"
    } else if t.contains("overloaded") {
        "overloaded"
    } else if t.contains("temporarily limiting requests") {
        "rate_limited_429"
    } else if t.contains("500 internal server error") {
        "server_5xx"
    } else if t.contains("unable to connect to api") {
        "network_error"
    } else {
        "other_synthetic_error"
    };
    cls.to_string()
}

/// Port of `classifyApiErrorEvent` in `scripts/claude-model-error-rates.mjs`. The JS regex
/// `/rate.?limit|429|temporarily limiting/` (any single optional separator char) is approximated
/// here with the concrete separators Anthropic's own error text actually uses; a `errors_by_class`
/// count is still bumped even on the (unobserved-so-far) miss case, just under `api_error_other`.
fn classify_api_error_event(err: &Value) -> String {
    let code = err
        .get("connection")
        .and_then(|c| c.get("code"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_lowercase();
    let formatted = err
        .get("formatted")
        .and_then(|f| f.as_str())
        .or_else(|| err.get("message").and_then(|m| m.as_str()))
        .unwrap_or("")
        .to_lowercase();

    const NETWORK_CODES: [&str; 6] = ["econnreset", "econnrefused", "enotfound", "etimedout", "epipe", "eai_again"];
    if NETWORK_CODES.iter().any(|c| code.contains(c)) {
        return "network_error".to_string();
    }
    if formatted.contains("overloaded") {
        return "overloaded".to_string();
    }
    if formatted.contains("500") || formatted.contains("internal server error") {
        return "server_5xx".to_string();
    }
    if formatted.contains("rate limit")
        || formatted.contains("rate-limit")
        || formatted.contains("ratelimit")
        || formatted.contains("429")
        || formatted.contains("temporarily limiting")
    {
        return "rate_limited_429".to_string();
    }
    if formatted.contains("connect") {
        return "network_error".to_string();
    }
    "api_error_other".to_string()
}

/// Port of `modelFamily` in `scripts/claude-model-error-rates.mjs` — a coarse human-readable
/// label ("Sonnet 5", "Opus 4-8") for the panel. Falls back to the raw model id for anything
/// that doesn't match the `claude-<family>-<version>` shape.
pub fn model_family(model: &str) -> String {
    const KNOWN: [&str; 4] = ["opus", "sonnet", "haiku", "fable"];
    if let Some(rest) = model.strip_prefix("claude-") {
        for fam in KNOWN {
            if let Some(after_fam) = rest.strip_prefix(fam) {
                if let Some(ver) = after_fam.strip_prefix('-') {
                    if ver.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                        let cap = format!("{}{}", fam[..1].to_uppercase(), &fam[1..]);
                        return format!("{cap} {}", strip_trailing_date(ver));
                    }
                }
            }
        }
    }
    model.to_string()
}

/// Strip a trailing `-YYYYMMDD` (exactly 8 digits) suffix, mirroring the JS
/// `.replace(/-\d{8}$/, "")`.
fn strip_trailing_date(ver: &str) -> String {
    if let Some(idx) = ver.rfind('-') {
        let suffix = &ver[idx + 1..];
        if suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_digit()) {
            return ver[..idx].to_string();
        }
    }
    ver.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A scratch file under `std::env::temp_dir()`, removed on drop. Matches the manual
    /// temp-file convention already used by `mailink/transcript.rs`'s own tests (no `tempfile`
    /// crate dependency in this workspace).
    struct ScratchFile(std::path::PathBuf);
    impl Drop for ScratchFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn write_fixture(name: &str, lines: &[&str]) -> ScratchFile {
        let path = std::env::temp_dir().join(format!("maiterm-model-errors-test-{name}.jsonl"));
        let mut f = std::fs::File::create(&path).unwrap();
        for line in lines {
            writeln!(f, "{line}").unwrap();
        }
        f.flush().unwrap();
        ScratchFile(path)
    }

    fn classify_all(lines: &[&str]) -> HashMap<String, ModelErrorCounts> {
        let mut tail = ErrorTailState::default();
        let mut totals: HashMap<String, ModelErrorCounts> = HashMap::new();
        for line in lines {
            let v: Value = serde_json::from_str(line).unwrap();
            let mut delta = HashMap::new();
            classify_line(&v, &mut tail, &mut delta);
            for (model, add) in delta {
                let bucket = totals.entry(model).or_default();
                bucket.turns += add.turns;
                bucket.tool_calls += add.tool_calls;
                bucket.tool_errors += add.tool_errors;
                bucket.retry_events += add.retry_events;
                for (cls, n) in add.errors_by_class {
                    *bucket.errors_by_class.entry(cls).or_insert(0) += n;
                }
            }
        }
        totals
    }

    /// A small fixture exercising every signal class Slice 1's script recognizes: a normal
    /// turn, a max_tokens truncation, a tool_use + failing tool_result, a hard system/api_error
    /// (network), a synthetic soft-block (spend limit), and a model_refusal_fallback that
    /// switches the attributed model for what follows.
    const FIXTURE: &[&str] = &[
        r#"{"type":"assistant","message":{"model":"claude-sonnet-5","stop_reason":"end_turn","content":[{"type":"text","text":"hi"}]}}"#,
        r#"{"type":"assistant","message":{"model":"claude-sonnet-5","stop_reason":"max_tokens","content":[{"type":"text","text":"cut off"}]}}"#,
        r#"{"type":"assistant","message":{"model":"claude-sonnet-5","stop_reason":"tool_use","content":[{"type":"tool_use","id":"tu_1","name":"Bash"}]}}"#,
        r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","is_error":true}]}}"#,
        r#"{"type":"system","subtype":"api_error","error":{"formatted":"Connection error.","connection":{"code":"ECONNRESET"}},"retryAttempt":1}"#,
        r#"{"type":"assistant","message":{"model":"<synthetic>"},"isApiErrorMessage":true,"message_text_probe":""}"#,
        r#"{"type":"system","subtype":"model_refusal_fallback","originalModel":"claude-sonnet-5","fallbackModel":"claude-opus-4-8","apiRefusalCategory":"safety"}"#,
        r#"{"type":"assistant","message":{"model":"claude-opus-4-8","stop_reason":"end_turn","content":[{"type":"text","text":"post-fallback"}]}}"#,
    ];

    // The synthetic soft-block line above deliberately omits `message.content` (no text block)
    // to exercise the "other_synthetic_error" fallback path — content presence is asserted
    // separately below with an explicit text block.
    const FIXTURE_WITH_SPEND_TEXT: &[&str] = &[
        r#"{"type":"assistant","message":{"model":"claude-sonnet-5","stop_reason":"end_turn","content":[{"type":"text","text":"hi"}]}}"#,
        r#"{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"You have hit your monthly spend limit."}]},"isApiErrorMessage":true}"#,
    ];

    #[test]
    fn classifies_every_signal_class_matching_slice_1_semantics() {
        let totals = classify_all(FIXTURE);

        let sonnet = totals.get("claude-sonnet-5").expect("sonnet bucket");
        assert_eq!(sonnet.turns, 3, "3 real sonnet turns before the fallback");
        assert_eq!(sonnet.tool_calls, 1);
        assert_eq!(sonnet.errors_by_class.get("truncation_max_tokens"), Some(&1));
        assert_eq!(sonnet.errors_by_class.get("network_error"), Some(&1), "system/api_error ECONNRESET");
        assert_eq!(sonnet.retry_events, 1);
        assert_eq!(sonnet.tool_errors, 1, "tool_result is_error correlated back via tool_use_id");
        assert_eq!(sonnet.errors_by_class.get("other_synthetic_error"), Some(&1), "no text block ⇒ falls through");
        assert_eq!(
            sonnet.errors_by_class.get("refusal_fallback"),
            Some(&1),
            "refusal_fallback is attributed to originalModel (sonnet), not the fallback"
        );

        let opus = totals.get("claude-opus-4-8").expect("opus bucket");
        assert_eq!(opus.turns, 1, "the turn AFTER the fallback is attributed to the new model");
        assert!(opus.errors_by_class.is_empty());
    }

    #[test]
    fn synthetic_soft_block_text_is_classified_from_the_message_body() {
        let totals = classify_all(FIXTURE_WITH_SPEND_TEXT);
        let sonnet = totals.get("claude-sonnet-5").expect("sonnet bucket");
        assert_eq!(sonnet.errors_by_class.get("spend_limit_soft_block"), Some(&1));
    }

    #[test]
    fn tool_use_model_map_is_pruned_on_match_not_accumulated_forever() {
        let mut tail = ErrorTailState::default();
        let mut delta = HashMap::new();
        for line in FIXTURE {
            let v: Value = serde_json::from_str(line).unwrap();
            classify_line(&v, &mut tail, &mut delta);
        }
        assert!(
            tail.tool_use_model.is_empty(),
            "tu_1 must be removed once its tool_result lands, unlike the batch script's Map"
        );
    }

    #[test]
    fn model_family_matches_slice_1_naming() {
        assert_eq!(model_family("claude-sonnet-5"), "Sonnet 5");
        assert_eq!(model_family("claude-opus-4-8"), "Opus 4-8");
        assert_eq!(model_family("claude-haiku-4-5-20251001"), "Haiku 4-5");
        assert_eq!(model_family("claude-fable-5"), "Fable 5");
        assert_eq!(model_family("gpt-4"), "gpt-4", "unrecognized shape falls back to the raw id");
    }

    #[test]
    fn read_and_classify_delta_tails_incrementally_and_skips_partial_trailing_lines() {
        let f = write_fixture("tail-incremental", &FIXTURE[..3]);
        let mut tail = ErrorTailState::default();

        let first = read_and_classify_delta(&f.0, &mut tail).expect("first read has data");
        assert_eq!(first.get("claude-sonnet-5").unwrap().turns, 3);
        let offset_after_first = tail.offset;

        // Nothing new appended yet ⇒ None, offset unchanged.
        assert!(read_and_classify_delta(&f.0, &mut tail).is_none());
        assert_eq!(tail.offset, offset_after_first);

        // Append a partial line (no trailing newline) — must NOT be consumed yet.
        {
            let mut file = std::fs::OpenOptions::new().append(true).open(&f.0).unwrap();
            write!(file, "{}", &FIXTURE[3][..FIXTURE[3].len() / 2]).unwrap();
        }
        assert!(
            read_and_classify_delta(&f.0, &mut tail).is_none(),
            "a trailing partial line must not be parsed"
        );
        assert_eq!(tail.offset, offset_after_first, "offset must not advance past a partial line");
    }
}
