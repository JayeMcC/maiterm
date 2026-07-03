# Cursor / Claude-Code agent parity — design

Extend maiTerm's first-class agent integration (currently Claude Code, Codex,
Gemini) to the **Cursor CLI (`cursor-agent`)**. Design pass — 2026-07-03.

## Key finding: it's already a runtime abstraction

maiTerm has been refactored around an **`AgentRuntime`** seam
(`src-tauri/src/state/agent_runtime.rs`). Claude, Codex, and Gemini are all
runtimes behind it. **Cursor is a 4th runtime that plugs into the same seam** —
and **Codex is the near-exact template**, because Codex (like the Cursor CLI)
lacks reliable native lifecycle hooks: maiTerm handles Codex with a **shim
script** that forwards events to `/hooks?runtime=codex` plus a **dormancy
reaper** that synthesizes session-end when the agent goes quiet.

## What's already agent-agnostic (no work)

- **MCP transport + auth.** The maiterm MCP server (`claude_code/server.rs`) is a
  generic JSON-RPC-over-HTTP MCP server. `extract_auth` already accepts
  `Authorization: Bearer <token>` (server.rs:170-187) — which Cursor uses — so a
  `cursor-agent` MCP client authenticates with **zero code changes**.
- **Session model.** `initSession` stores a runtime-tagged session
  (server.rs:1220-1235); tool-call tab affinity, `getClaudeSessions` (enumerates
  all runtimes), and the agent bridge/mesh all route on `tabId`, not agent
  identity — all reusable as-is.
- **Status plumbing.** The footer dots (`agentState.svelte.ts` → a pure reducer
  over `agent-hook-*` Tauri events → `WorkspaceSidebar` `$derived`) are already
  runtime-neutral; events carry a `?runtime=` tag. **No store/UI changes needed.**

## The three plug-in points

1. **Liveness / detection.** Add `"cursor-agent"` to `AGENT_PROCESS_NAMES`
   (`pty/manager.rs:871`); add a `Cursor` variant to the `AgentRuntime` enum and
   a `n.contains("cursor")` arm in `detect()` (`agent_runtime.rs:16-52`), plus a
   `Cursor` `RuntimeDescriptor` with `agent_process_names: &["cursor-agent"]`.
2. **MCP config writer.** A `CursorRegistrar` (near-copy of `ClaudeRegistrar`)
   writing the HTTP `mcpServers` entry into **`~/.cursor/mcp.json`** (same shape
   as `~/.claude.json`, using `Authorization: Bearer`), registered in
   `all_registrars()` (`registrar.rs:45-47`), gated on a new `cursor_ide` pref.
3. **Status hooks.** Write **`~/.cursor/hooks.json`** posting to
   `/hooks?runtime=cursor`; extend `normalize_hook_event` (server.rs:1604-1633)
   to map Cursor's event names onto the existing `HookPhase` variants; add a
   `cursor` tool summarizer in `agents/descriptor.ts`; reuse the **dormancy
   reaper** for idle/end.

## Cursor CLI hooks — the constraint

Cursor 1.7+ has hooks (`~/.cursor/hooks.json`), same shape as Claude's. **But the
CLI (`cursor-agent`) reliably fires only `beforeShellExecution` /
`afterShellExecution`** — the lifecycle hooks (sessionStart/stop/sessionEnd) are
buggy/omitted today (Cursor forum). So:
- `before/afterShellExecution` → `ToolPre`/`ToolPost` → **"working" (blue) dot**.
- session-end → the **dormancy reaper** (already built for Codex) → **idle
  (green) dot**.
- **Likely gap:** the **"waiting for permission" (red) dot** — driven by Claude's
  `Notification{permission_prompt}` hook; the Cursor CLI has no clean
  approval-needed signal yet. Defer until Cursor's CLI hooks mature.

## Phased plan

- **Phase 1 — Tools + presence** (small; ~2-3 files, low risk). Plug-in points 1
  + 2. Result: `cursor-agent` connects via MCP, gets every terminal tool
  (openTab, getTabContext, initSession, bridge), appears in `getClaudeSessions`,
  and is detected as "an agent is running." Mostly reuses Codex/Gemini scaffolding.
- **Phase 2 — Status dots** (medium). Plug-in point 3 + dormancy reaper wiring +
  Cursor tool summarizer. Result: working/idle dots for `cursor-agent`.
- **Phase 3 — Polish / gaps.** The permission dot (blocked on Cursor CLI hooks);
  rename `getClaudeSessions` → runtime-neutral (cosmetic); `AGENT_ENV_MARKERS`
  for `cursor-agent` env vars (clean nested-shell behavior).

## Open question — "Cursor API" vs the CLI

The original ask named "the Cursor API as well as the `cursor-agent` CLI." This
design covers the **`cursor-agent` CLI** (the terminal agent — the direct analog
of Claude Code / Codex). A "Cursor API" (cloud / background-agents) would be a
*different* integration (not a terminal agent in a tab) and is out of scope here
unless that's specifically wanted.
