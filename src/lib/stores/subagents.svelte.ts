import { countedListen as listen } from '$lib/utils/listenCounter';
import { SvelteMap } from 'svelte/reactivity';
import { getDescriptor } from '$lib/agents/descriptor';
import type { AgentRuntime } from '$lib/agents/types';

/**
 * Live subagent (Task-tool fan-out) tracking, driven by the SubagentStart/SubagentStop
 * hook events plus PreToolUse/PostToolUse payloads carrying `agent_id` (fired INSIDE a
 * subagent — see `src-tauri/src/claude_code/CLAUDE.md` § Subagent tracking). Rides the
 * SAME `agent-hook-*` event bus `agentState.svelte.ts` listens to (a second, independent
 * subscription — Tauri fans one emitted event out to every listener) rather than
 * threading through that store, so a per-tab session's own active/idle state machine
 * stays untouched by fan-out noise.
 *
 * Powers `SubagentPanel.svelte` — the "what are my subagents doing" view the maiTerm
 * agent itself has no visibility into otherwise.
 */

/** Lifecycle of a tracked subagent. Mirrors Rust's `SubagentState` in
 *  `state/app_state.rs` — keep both in sync. `failed` means the subagent's parent tab
 *  session ended while it was still `running` (Claude Code has no explicit subagent
 *  failure signal — see that enum's doc comment). */
export type SubagentState = 'running' | 'done' | 'failed';

/** One tool invocation inside a subagent, oldest first, capped at LOG_CAP — the log
 *  `SubagentPanel.svelte` expands to show. Logged at invocation (PreToolUse), not
 *  completion, so a subagent that never returns still leaves a visible trail. */
export interface SubagentLogEntry {
  toolName: string;
  detail?: string;
  atMs: number;
}

export interface SubagentSession {
  agentId: string;
  tabId: string;
  runtime: AgentRuntime;
  /** Claude's agent type/name, e.g. "general-purpose", "Explore", or a custom subagent name. */
  agentType: string;
  state: SubagentState;
  /** Tool currently in flight inside the subagent (undefined once thinking/idle). */
  toolName?: string;
  toolDetail?: string;
  log: SubagentLogEntry[];
  startedAt: number;
  updatedAt: number;
}

/** Client-side mirror of `SUBAGENT_LOG_CAP` in `state/app_state.rs`. */
const LOG_CAP = 50;

function runtimeOf(payload: { runtime?: string }): AgentRuntime {
  const r = payload.runtime;
  return r === 'codex' || r === 'gemini' ? r : 'claude';
}

/** Append a tool invocation to a subagent's log, returning a NEW bounded array
 *  (never mutates the input) so callers can build a fresh session object for `.set()`. */
function appendLog(log: SubagentLogEntry[], toolName: string, detail: string | undefined, atMs: number): SubagentLogEntry[] {
  if (!toolName) return log;
  const next = [...log, { toolName, detail, atMs }];
  return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
}

function createSubagentStore() {
  // agent_id → live session. Flat (not nested per-tab): Claude mints a fresh id per
  // spawn, so a single map keyed by it is enough — every consumer filters by tabId via
  // getForTab. Hook events broadcast to every window (see agentState.svelte.ts), so
  // this map — like sessions there — holds subagents from ALL windows; callers scope
  // to their own tabs.
  const sessions = new SvelteMap<string, SubagentSession>();
  const unlisteners: (() => void)[] = [];

  return {
    /** Diagnostic snapshot for getDiagnostics. */
    getInternalSizes() {
      return { subagent_sessions: sessions.size, unlisteners: unlisteners.length };
    },

    /** Live + recent subagents for a tab, most-recently-started first. */
    getForTab(tabId: string): SubagentSession[] {
      const out: SubagentSession[] = [];
      for (const s of sessions.values()) {
        if (s.tabId === tabId) out.push(s);
      }
      return out.sort((a, b) => b.startedAt - a.startedAt);
    },

    /** Count of subagents currently `running` for a tab — drives a small badge on
     *  whatever triggers the panel open (e.g. a tab-bar indicator). */
    runningCount(tabId: string): number {
      let n = 0;
      for (const s of sessions.values()) {
        if (s.tabId === tabId && s.state === 'running') n++;
      }
      return n;
    },

    async init() {
      const u1 = await listen<{ tab_id: string | null; agent_id: string; agent_type: string; runtime?: string }>(
        'agent-hook-subagent-start',
        (e) => {
          const { tab_id, agent_id, agent_type } = e.payload;
          if (!tab_id || !agent_id) return;
          const now = Date.now();
          sessions.set(agent_id, {
            agentId: agent_id,
            tabId: tab_id,
            runtime: runtimeOf(e.payload),
            agentType: agent_type || 'subagent',
            state: 'running',
            toolName: undefined,
            toolDetail: undefined,
            log: [],
            startedAt: now,
            updatedAt: now,
          });
        },
      );
      unlisteners.push(u1);

      const u2 = await listen<{ tab_id: string | null; agent_id: string }>('agent-hook-subagent-stop', (e) => {
        const { agent_id } = e.payload;
        const sub = agent_id ? sessions.get(agent_id) : undefined;
        if (!sub) return;
        sessions.set(sub.agentId, { ...sub, state: 'done', toolName: undefined, toolDetail: undefined, updatedAt: Date.now() });
      });
      unlisteners.push(u2);

      // PreToolUse/PostToolUse ride the SAME event names agentState.svelte.ts listens
      // to (a second, independent subscription — Tauri fans one emitted event out to
      // every listener). Only payloads carrying agent_id (fired INSIDE a subagent) are
      // relevant here; the parent session's own tool calls have no agent_id and are
      // ignored, matching how the backend routes them (see claude_code/server.rs).
      const u3 = await listen<{
        tab_id: string | null;
        tool_name: string;
        tool_input: Record<string, unknown> | null;
        agent_id?: string | null;
        agent_type?: string | null;
        runtime?: string;
      }>('agent-hook-pre-tool-use', (e) => {
        const { tab_id, tool_name, tool_input, agent_id, agent_type } = e.payload;
        if (!tab_id || !agent_id) return;
        const runtime = runtimeOf(e.payload);
        const now = Date.now();
        const existing = sessions.get(agent_id);
        const detail = getDescriptor(runtime).summarizeTool(tool_name, tool_input);
        sessions.set(agent_id, {
          agentId: agent_id,
          tabId: tab_id,
          runtime,
          agentType: existing?.agentType || agent_type || 'subagent',
          state: 'running',
          toolName: tool_name || undefined,
          toolDetail: detail,
          log: appendLog(existing?.log ?? [], tool_name, detail, now),
          startedAt: existing?.startedAt ?? now,
          updatedAt: now,
        });
      });
      unlisteners.push(u3);

      const u4 = await listen<{ tab_id: string | null; agent_id?: string | null }>('agent-hook-post-tool-use', (e) => {
        const { agent_id } = e.payload;
        const sub = agent_id ? sessions.get(agent_id) : undefined;
        if (!sub) return;
        sessions.set(sub.agentId, { ...sub, toolName: undefined, toolDetail: undefined, updatedAt: Date.now() });
      });
      unlisteners.push(u4);

      // A tab's Claude session ending mid-subagent means it never got its Stop — the
      // only failure signal Claude Code's hooks give us (see the SubagentState doc
      // comment in state/app_state.rs). Entries are kept, not deleted, so `failed` is
      // actually visible in the panel until this tab's NEXT session starts fresh.
      const u5 = await listen<{ tab_id: string | null }>('agent-hook-session-end', (e) => {
        const { tab_id } = e.payload;
        if (!tab_id) return;
        for (const [id, s] of sessions) {
          if (s.tabId === tab_id && s.state === 'running') {
            sessions.set(id, { ...s, state: 'failed', toolName: undefined, toolDetail: undefined, updatedAt: Date.now() });
          }
        }
      });
      unlisteners.push(u5);

      // A fresh session on this tab means subagents from the PREVIOUS session are
      // stale history — clear them before the new session's own spawns arrive.
      const u6 = await listen<{ tab_id: string | null }>('agent-hook-session-start', (e) => {
        const { tab_id } = e.payload;
        if (!tab_id) return;
        for (const [id, s] of sessions) {
          if (s.tabId === tab_id) sessions.delete(id);
        }
      });
      unlisteners.push(u6);
    },

    destroy() {
      for (const u of unlisteners) u();
      unlisteners.length = 0;
    },
  };
}

export const subagentStore = createSubagentStore();
