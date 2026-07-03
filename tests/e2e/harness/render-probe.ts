/**
 * Standalone render probe for the debug-vs-release parity experiment
 * (render-parity.yml). Spawns ONE binary VISIBLE, waits for paint, and prints
 * a machine-greppable result line. CI-only — a visible window steals focus.
 *
 *   npx tsx tests/e2e/harness/render-probe.ts <binary> [label]
 *   → RENDER_RESULT label=<label> distinctColors=<n> rendered=<bool>
 */
import { spawnMaiterm } from './spawn.ts';
import { checkRendered, CaptureUnavailableError } from './render-check.ts';

const binary = process.argv[2];
const label = process.argv[3] ?? 'unlabeled';
if (!binary) {
  console.error('usage: render-probe.ts <binary> [label]');
  process.exit(2);
}

// visible: true — a render check on an invisible (background) window is
// meaningless. Pass through the webview-log A/B env if the workflow set it.
const passEnv: Record<string, string> = {};
if (process.env.MAITERM_DISABLE_WEBVIEW_LOG) {
  passEnv.MAITERM_DISABLE_WEBVIEW_LOG = process.env.MAITERM_DISABLE_WEBVIEW_LOG;
}
const handle = await spawnMaiterm({ binary, timeoutMs: 90_000, visible: true, env: passEnv });
await new Promise((r) => setTimeout(r, 6000));
try {
  const res = checkRendered();
  console.log(
    `RENDER_RESULT label=${label} distinctColors=${res.distinctColors} rendered=${res.rendered}`,
  );
  process.exitCode = res.rendered ? 0 : 1;
} catch (err) {
  if (err instanceof CaptureUnavailableError) {
    console.log(`RENDER_RESULT label=${label} distinctColors=NA rendered=SKIP (${err.message})`);
    process.exitCode = 0; // can't judge — don't fail the experiment
  } else {
    throw err;
  }
} finally {
  await handle.kill();
}
