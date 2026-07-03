# maiTerm fork — to-do / follow-ups

Personal-fork backlog (github.com/JayeMcC/maiterm). Not upstream's.

## Sync
- [ ] **Bring in latest changes from upstream `Flexmark-Intl/maiterm` main.**
  The fork's updater already *consumes* upstream releases (pubkey is
  Flexmark's), but the source tree hasn't been merged forward. Add the
  upstream remote, fetch, merge/rebase `main` onto upstream `main`, resolve
  fork-specific conflicts (channel configs, `app_data_slug`, the rail, the
  `[BOOT]`/log-target changes, CI workflows), re-run the CI suite, then
  re-promote to the fork's `main`.

## Stability
- **Won't do — sluggish under high CPU load.** Reassessed 2026-07-03: the latest
  occurrence was just *slow*, not broken (earlier "breaks" were the now-fixed
  white screen). Not chasing it. If it ever HARD-breaks (crash/blank), grab
  `~/Library/Logs/com.aiterm.app3/aiterm.log` at that moment and reopen then.

## Rail (PLAN-15 stream 3)
- **Done: Container-tab detection** — confirmed working. The rail resolves the
  active tab's real cwd from its PTY process (`getPtyInfo`), and a container
  tab's host-side process cwd resolves to the host clone, so the rail targets
  the right stack without a separate `/workspaces/…` → clone mapping.
- **Done: Provider config.** Rail providers now come from
  `~/.config/maiterm/rail.json` (merged over the forwood defaults; new
  `read_rail_config` command) — the rail is a generic, configurable action rail.
- **Done: Click-to-open protocol.** The launcher emits a per-port `scheme`
  (Vite WEB `:5173` = https); the rail opens `<scheme>://localhost:<port>`.
- **Done: dev-server tab lifecycle.** Idempotent container fire (converges
  in-container whether started on host or in-container; no double-container);
  keep-alive drops into a live shell at the project root on exit.

## Updater
- **Done (Layer 1):** signed updater feed on the fork's GitHub Releases. Own
  minisign keypair (pubkey embedded; private key in repo secrets), `release.yml`
  builds+signs the maiTerm3 bundle and publishes a Release + `latest.json`,
  `scripts/release.sh <version>` cuts it, the in-app updater checks the fork feed
  (not Flexmark). Install via DMG download (one-time `xattr` bypass).
- **Won't do — Layer 2 (Apple notarization).** Would remove the one-time
  Gatekeeper `xattr` bypass, but needs a paid Apple Developer account ($99/yr) +
  cert + notarize/staple in `release.yml`. Decided not worth it — the one-time
  `xattr` (or right-click-Open) is acceptable. Kept only as a reference for what
  it would take.

## In-app integrations
- **Done:** Report Bug / Feature Request buttons (WorkspaceSidebar footer) now
  open issues against `JayeMcC/maiterm` instead of upstream.
- **Design pass done → see `docs/cursor-parity-design.md`.** Cursor is a 4th
  `AgentRuntime` (Codex is the template); the MCP server already accepts
  `cursor-agent` via `Authorization: Bearer` with no changes. Three plug-in
  points (liveness match list, a `CursorRegistrar` → `~/.cursor/mcp.json`, a
  `~/.cursor/hooks.json` → `/hooks?runtime=cursor` + dormancy reaper).
  - **Done: Phase 1 — tools + presence.** `AgentRuntime::Cursor` (agent_runtime.rs)
    + `cursor-agent` in the liveness lists (pty/manager.rs, descriptor) + a
    `CursorRegistrar` writing `~/.cursor/mcp.json` (Bearer auth), gated on the new
    `cursor_ide` pref (default on). cursor-agent now auto-connects to the maiterm
    MCP server → gets every terminal tool + registers a runtime=cursor session.
  - **Done: Phase 2 (lite) — status dots.** CursorRegistrar also writes
    `~/.cursor/hooks.json` (Cursor's flat schema) + the shared agent-hook shim
    (parameterized with `runtime=$3`), forwarding to `/hooks?runtime=cursor`.
    `normalize_hook_event` maps Cursor's camelCase events (before/afterShellExecution
    + before/afterMCPExecution → tool pre/post = "working"; sessionStart/stop/
    sessionEnd best-effort). The dormancy reaper (already covers Cursor via
    PtyExitOrPrompt) drives idle. So: **working (blue) during shell/MCP ops +
    idle (green)** — as much as the Cursor CLI reliably offers.
  - **Won't do — Phase 3** (permission/red dot). The Cursor CLI has no reliable
    approval-needed hook, so this isn't achievable from our side. Parked
    permanently unless Cursor changes its CLI hooks.
  - **Open:** "Cursor API" (cloud/background-agents) is a separate, out-of-scope
    integration vs the `cursor-agent` CLI covered here — confirm intent.

## Features
- [ ] **Export / import window setup as JSON.** Serialize the current window
  arrangement — windows → panes → tabs, split layout, terminals + editors, and
  each tab's intent (name, task/cwd) — to a portable JSON blob, and re-create
  that structure on import. Use case: share a layout ("here's the setup I use")
  with someone running the same terminal. Add **Export setup to JSON** (current
  window, or a saved preset) + **Import setup from JSON**.
  - Build on the existing window-presets infra (`commands::window_presets`, the
    preset save/manage modals) — a preset already captures a window arrangement;
    this adds a portable serialize/deserialize on top.
  - Decide portable vs machine-specific: keep layout + tab names + task/cwd
    *intent*; strip or relativize machine-specific bits (absolute cwd paths,
    ptyIds, live PTY state) so it re-creates cleanly on a different machine.
  - On import, spawn fresh terminals/editors per the tree rather than trying to
    restore live process state.

## maiLink / mobile
- [ ] **Set up WireGuard for mobile control (out-of-house).** maiLink's data
  channel is LAN or **WireGuard** (the cloud relay is only a content-free push
  doorbell — never sees terminal content). Install + configure a WireGuard VPN
  back to the home network so the phone can reach maiTerm when away, then pair
  the maiLink mobile app. Goal: control some things from the phone; **likely to
  expand maiLink functionality** (more than the current chat/approvals companion
  surface) once it's usable end-to-end. Setup is a user/network task; the fork
  side is already merged (upstream maiLink).

## UI
- **Done: tab close (×) button no longer hidden by long names.** `.tab-name`
  now `flex: 1 1 auto; min-width: 0` so it truncates with its ellipsis, and
  `.tab-actions` is `flex-shrink: 0` so the × keeps its reserved width and stays
  clickable regardless of name length or tab count.

## Fork issues (GitHub)
- **Done: #6** — read-only MCP introspection without `initSession`. `getTabContext`
  + `getActiveTab` added to the `global_tools` allowlist in `server.rs` (the rest
  — `listWorkspaces`/`listWindows`/`getDiagnostics`/`getOpenEditors` — were
  already exempt). Token auth is independent of the session gate, so
  token-authenticated clients can now read state without borrowing a tabId.
- (For reference, #1 state-file thrash and #2 pointer-dead editor panes are
  pre-existing upstream-ish issues, not from the PLAN-15 work.)
