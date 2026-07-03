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
- [ ] **Container-tab detection** — the rail only appears on host tabs. A tab
  whose cwd is `/workspaces/…` (inside a container) isn't detected host-side.
  Map the container path → the host clone (docker inspection; disambiguate
  which container, since `/workspaces/website` is shared across
  developing/reviewing/experimenting).
- [ ] **Provider config → preference** — the provider command is hardcoded
  (`forwood-launcher`) in `hotbar.svelte.ts`. Graduate to a real preference so
  the rail is a generic, user-configurable "contextual action rail" (ADR-0006
  ideal; upstreamable).
- [ ] **Click-to-open protocol** — ports open via `http://`; WEB `:5173` is
  HTTPS. Add a protocol heuristic (or per-port config).

## Updater
- **Done (Layer 1):** signed updater feed on the fork's GitHub Releases. Own
  minisign keypair (pubkey embedded; private key in repo secrets), `release.yml`
  builds+signs the maiTerm3 bundle and publishes a Release + `latest.json`,
  `scripts/release.sh <version>` cuts it, the in-app updater checks the fork feed
  (not Flexmark). Install via DMG download (one-time `xattr` bypass).
- [ ] **Layer 2 — Apple Developer ID + notarization.** Removes the one-time
  Gatekeeper bypass on download/update entirely (truly frictionless on any Mac).
  Needs a paid Apple Developer account ($99/yr) + Developer ID cert; add
  `APPLE_CERTIFICATE` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` secrets
  and the notarize+staple step to `release.yml`. Purely additive on Layer 1.

## In-app integrations
- **Done:** Report Bug / Feature Request buttons (WorkspaceSidebar footer) now
  open issues against `JayeMcC/maiterm` instead of upstream.
- [ ] **AI-agent feature parity: Cursor + Claude Code.** Today the terminal
  integrates Claude Code (the `maiterm` MCP server, `claudeCode.svelte.ts`).
  Extend the same first-class integration to the **Cursor API** and the
  **`cursor-agent` CLI** so both agent backends get parity (session detection,
  status indicators, notes/bridge, tab context) — not just Claude Code. Larger
  feature; scope a design pass first.

## Fork issues (GitHub)
- [ ] **#6** — allow read-only MCP introspection (`getTabContext`/
  `listWorkspaces`) without `initSession` for token-authenticated clients.
- (For reference, #1 state-file thrash and #2 pointer-dead editor panes are
  pre-existing upstream-ish issues, not from the PLAN-15 work.)
