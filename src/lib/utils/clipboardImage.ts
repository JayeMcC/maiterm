/** Encode clipboard RGBA pixels for an agent attachment.
 *
 * The macOS clipboard hands us decoded raw pixels (the original compressed
 * source is already gone by the time `readImage()` returns), so we have to
 * re-encode. Screenshots are opaque, and a lossless PNG of a screenshot-sized
 * image is multi-MB bloat — so opaque images encode as JPEG (a fraction of the
 * size). Images with any transparency stay PNG to preserve the alpha channel.
 *
 * Returns the base64 payload plus the matching file extension so the temp file
 * is named correctly (agents infer image type from the extension).
 */
export async function encodeClipboardImage(rgba: Uint8Array, width: number, height: number): Promise<{ base64: string; ext: 'png' | 'jpg' }> {
  const opaque = isFullyOpaque(rgba);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const blob = opaque ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }) : await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return { base64: btoa(binary), ext: opaque ? 'jpg' : 'png' };
}

/** True when every pixel's alpha byte is fully opaque (255). RGBA is laid out
    [r,g,b,a, r,g,b,a, ...], so the alpha bytes start at index 3, stride 4. */
function isFullyOpaque(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return false;
  }
  return true;
}
