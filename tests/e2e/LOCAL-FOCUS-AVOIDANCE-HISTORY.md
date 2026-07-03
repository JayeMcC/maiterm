# Local e2e focus-avoidance — attempts & why we removed them

**Status: removed 2026-07-03.** The e2e suite runs on GitHub Actions ONLY
(see the repo rule + `e2e.yml` / `render-parity.yml`). On a headless CI runner
there is no user to disturb, so the machinery below — which existed purely to
stop *local* spawns from stealing keyboard focus — was dead weight on the CI
path and is gone. This file preserves what was tried in case someone wants to
reapproach local runs.

## The problem

Every locally-spawned maiTerm instance stole the user's keyboard focus at
launch. A 24-file e2e suite = ~24 instances = constant focus theft while the
user typed. Root cause: tao (the macOS windowing layer under Tauri) calls
`NSApp.activateIgnoringOtherApps(true)` unconditionally when the run loop
launches, and Tauri exposes no off-switch.

## Attempts (all gated behind the `MAITERM_E2E_BACKGROUND` env var)

Applied in `src-tauri/src/lib.rs` (setup + build/run) and
`tests/e2e/harness/spawn.ts` (set the env on spawn). In rough order added,
each reducing but not eliminating the disruption:

1. **`ActivationPolicy::Accessory`** in `setup()` — no Dock icon / Spaces
   switch. Too late: windows are created & made key before `setup()` runs.
2. **Window config `visible = false`** (mutate `context.config_mut()` before
   `.build()`) — but the window-state plugin re-showed the window.
3. **Strip `StateFlags::VISIBLE`** from `tauri_plugin_window_state` — stopped
   the re-show.
4. **`window.focus = false` + `always_on_bottom = true`** in the window config.
5. **`set_focusable(false)`** on every webview window after build.
6. **`ActivationPolicy::Prohibited`** set on the `App` *before* `run()` — the
   only thing that neutralised tao's forced `activateIgnoringOtherApps` (an
   app that "may not be activated" makes that call a no-op).

**Outcome:** with all six, a full-suite local run went from constant theft to
"a tiny flash" — still not zero, and still visible windows briefly appeared on
top. The user's call: stop running locally, delete the machinery, CI only.

## If reapproaching local runs

- Re-add the `MAITERM_E2E_BACKGROUND` gate in `spawn.ts` and the
  `ActivationPolicy::Prohibited` + config `visible=false` +
  window-state `VISIBLE` strip block in `lib.rs::run()`.
- The truly-invisible path (visible=false + Prohibited) came closest; the
  residual "flash" likely needs an offscreen-window or a separate login
  session / virtual display rather than more activation tweaks.
- Render checks need a VISIBLE window regardless (pixels), so those stay
  CI-only even if MCP/PTY tests ever run locally again.
