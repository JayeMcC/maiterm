/**
 * White-screen detector. The MCP/PTY-based e2e tests all pass even when the
 * Svelte shell never paints (they read PTY buffers over MCP, which the Rust
 * side serves regardless of frontend health) — so a genuinely blank window
 * ships green. The only ground truth for "did it actually render" is looking
 * at pixels.
 *
 * Needs a VISIBLE window, so callers gate this to CI (headless runner) — it
 * must never run on a developer's machine where it would steal focus.
 *
 * Mechanism: `screencapture -t bmp` (uncompressed → parseable with zero deps),
 * sample the centre region where Tauri centres the 1200×800 window, and count
 * distinct colours. A white/blank screen yields 1–2; a real UI yields many.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

export interface RenderCheck {
  distinctColors: number;
  rendered: boolean;
  bmpPath: string;
}

/** Thrown when screencapture can't produce an image (no Screen Recording TCC
 *  grant — normal on a dev machine). Callers should SKIP, not fail, on this. */
export class CaptureUnavailableError extends Error {}

/** Parse a 24/32-bit uncompressed BMP into a distinct-colour count over a
 *  centred sample window. Only the subset of BMP that `screencapture` emits. */
function distinctColorsInCentre(bmp: Buffer, sampleFrac = 0.4, step = 7): number {
  // BITMAPFILEHEADER (14) + BITMAPINFOHEADER (≥40).
  const dataOffset = bmp.readUInt32LE(10);
  const width = bmp.readInt32LE(18);
  const heightRaw = bmp.readInt32LE(22);
  const height = Math.abs(heightRaw);
  const bpp = bmp.readUInt16LE(28);
  const bytesPP = bpp / 8;
  if (bytesPP < 3) throw new Error(`unexpected BMP depth ${bpp}`);
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;

  const halfW = Math.floor((width * sampleFrac) / 2);
  const halfH = Math.floor((height * sampleFrac) / 2);
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);

  const colors = new Set<number>();
  for (let y = cy - halfH; y < cy + halfH; y += step) {
    for (let x = cx - halfW; x < cx + halfW; x += step) {
      const off = dataOffset + y * rowSize + x * bytesPP;
      if (off + 2 >= bmp.length) continue;
      // Pack B,G,R into one int; ignore alpha.
      colors.add((bmp[off]! << 16) | (bmp[off + 1]! << 8) | bmp[off + 2]!);
    }
  }
  return colors.size;
}

/**
 * Capture the primary display and assert the centred app window rendered
 * something. `minColors` default 12: a blank window is 1–2; the maiTerm UI
 * (title bar, sidebar, terminal, prompt) is far more.
 */
export function checkRendered(minColors = 12): RenderCheck {
  const bmpPath = `/tmp/maiterm-render-${process.pid}.bmp`;
  try {
    // -x silent, -t bmp uncompressed, -D 1 primary display, -o no shadow.
    execFileSync('screencapture', ['-x', '-o', '-t', 'bmp', '-D', '1', bmpPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    throw new CaptureUnavailableError(
      `screencapture failed (Screen Recording permission not granted?): ${String(err)}`,
    );
  }
  try {
    const bmp = readFileSync(bmpPath);
    if (bmp.length < 54) throw new CaptureUnavailableError('screencapture produced no image');
    const distinctColors = distinctColorsInCentre(bmp);
    return { distinctColors, rendered: distinctColors >= minColors, bmpPath };
  } finally {
    rmSync(bmpPath, { force: true });
  }
}
