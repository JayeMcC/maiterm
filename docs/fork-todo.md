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

## Stability (parked — low priority)
- [ ] **Sluggish under high CPU load.** Reassessed 2026-07-03: the latest
  occurrence was just *slow*, not broken (earlier "breaks" may have been the
  now-fixed white screen). Parked — don't chase. If it ever hard-breaks
  again, note the exact symptom and grab
  `~/Library/Logs/com.aiterm.app3/aiterm.log` at that moment (the `[BOOT]`
  banner + any `web content process terminated` / state-conflict lines point
  the cause). No crash reports / terminations in the log at rest.

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
- **Deferred (reference only — probably won't do).** Layer 2: Apple Developer
  ID + notarization would remove the one-time Gatekeeper `xattr` bypass entirely
  (frictionless install/update on any Mac). It needs a paid Apple Developer
  account ($99/yr) + Developer ID cert, then `APPLE_CERTIFICATE` / `APPLE_ID` /
  `APPLE_PASSWORD` / `APPLE_TEAM_ID` secrets and a notarize+staple step in
  `release.yml`. Kept here so the requirement is known if frictionless install
  ever becomes worth the cost.

## In-app integrations
- **Done:** Report Bug / Feature Request buttons (WorkspaceSidebar footer) now
  open issues against `JayeMcC/maiterm` instead of upstream.
- [ ] **AI-agent feature parity: Cursor + Claude Code.** Today the terminal
  integrates Claude Code (the `maiterm` MCP server, `claudeCode.svelte.ts`).
  Extend the same first-class integration to the **Cursor API** and the
  **`cursor-agent` CLI** so both agent backends get parity (session detection,
  status indicators, notes/bridge, tab context) — not just Claude Code. Larger
  feature; scope a design pass first.

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
