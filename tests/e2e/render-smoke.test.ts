/**
 * White-screen smoke test — the guard the MCP/PTY e2e suite was missing.
 * Those tests read PTY buffers over MCP (served by Rust regardless of frontend
 * health), so a blank Svelte shell ships green. This one looks at actual
 * pixels and fails if the window rendered nothing.
 *
 * CI-ONLY by design: it needs a VISIBLE window (frontend readiness signals are
 * gated on visibility), which would steal focus on a developer's machine.
 * Skipped unless `process.env.CI` — never run this locally; let GitHub Actions
 * validate render. Also needs `MAITERM_BINARY` like the rest of the suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnMaiterm, type MaitermHandle } from './harness/spawn.ts';
import { checkRendered, CaptureUnavailableError } from './harness/render-check.ts';

const BIN = process.env.MAITERM_BINARY;
const RUN = !!BIN && !!process.env.CI;

(RUN ? describe : describe.skip)('maiTerm render smoke (CI-only)', () => {
  let handle: MaitermHandle;

  beforeAll(async () => {
    // VISIBLE spawn — a render check on an invisible (background) window is
    // meaningless. Hermetic HOME so it doesn't touch the runner's profile.
    handle = await spawnMaiterm({ binary: BIN!, timeoutMs: 90_000, visible: true });
    // Give the Svelte shell time to mount + paint the first frame.
    await new Promise((r) => setTimeout(r, 6000));
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.kill();
  });

  it('renders a non-blank window (not a white screen)', () => {
    let result;
    try {
      result = checkRendered();
    } catch (err) {
      if (err instanceof CaptureUnavailableError) {
        // No Screen Recording grant on this runner — can't judge; don't
        // false-fail. (Should not happen on GitHub macOS runners.)
        console.warn(`render smoke skipped: ${err.message}`);
        return;
      }
      throw err;
    }
    expect(
      result.rendered,
      `window centre had only ${result.distinctColors} distinct colours — looks blank/white-screened`,
    ).toBe(true);
  });
});
