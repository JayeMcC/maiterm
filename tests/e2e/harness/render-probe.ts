/**
 * Standalone render probe for the debug-vs-release parity experiment
 * (render-parity.yml). Spawns ONE binary VISIBLE, waits for paint, and prints
 * a machine-greppable result line. CI-only — a visible window steals focus.
 *
 *   npx tsx tests/e2e/harness/render-probe.ts <binary> [label]
 *   → RENDER_RESULT label=<label> distinctColors=<n> rendered=<bool>
 */
import { spawnMaiterm } from './spawn.ts';
import { waitForRender, CaptureUnavailableError } from './render-check.ts';

const binary = process.argv[2];
const label = process.argv[3] ?? 'unlabeled';
if (!binary) {
  console.error('usage: render-probe.ts <binary> [label]');
  process.exit(2);
}

// Pass through the webview-log opt-in env if the workflow set it (A/B).
const passEnv: Record<string, string> = {};
if (process.env.MAITERM_ENABLE_WEBVIEW_LOG) {
  passEnv.MAITERM_ENABLE_WEBVIEW_LOG = process.env.MAITERM_ENABLE_WEBVIEW_LOG;
}
const handle = await spawnMaiterm({ binary, timeoutMs: 90_000, env: passEnv });
await new Promise((r) => setTimeout(r, 3000));
try {
  const res = await waitForRender();
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
