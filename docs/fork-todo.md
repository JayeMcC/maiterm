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
- [ ] **Retire the dead Tauri-installer UI.** The updater store now checks the
  `Jaye-term` branch via `git ls-remote` and prompts via toast → Bitbucket
  (no upstream, no auto-install). The old banner + What's-New modal +
  install/restart flow in `WorkspaceSidebar.svelte` are kept as inert stubs
  (`showBanner === false`). A cleanup pass could delete that UI and the stub
  store methods (`currentUpdate`/`downloadAndInstall`/`recheckForNewer`/
  `switchToUpdate`/`fetchReleaseNotes`/`restart`) outright.

## Fork issues (GitHub)
- [ ] **#6** — allow read-only MCP introspection (`getTabContext`/
  `listWorkspaces`) without `initSession` for token-authenticated clients.
- (For reference, #1 state-file thrash and #2 pointer-dead editor panes are
  pre-existing upstream-ish issues, not from the PLAN-15 work.)
