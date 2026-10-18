// Online-store photos (spec 002 FR-025): shrink a chosen JPEG / PNG / WebP (≤ 5 MB) in the browser to WebP
// with the longest side ≤ 1600 px, so uploads are small and the server never needs a native image module.

export const PHOTO_MAX_INPUT_BYTES = 5 * 1024 * 1024;
export const PHOTO_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const PHOTO_MAX_SIDE = 1600;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

export type ImageErrorCode = 'PHOTO_TYPE' | 'PHOTO_TOO_LARGE' | 'PHOTO_UNREADABLE';
export class ImageError extends Error {
  constructor(public code: ImageErrorCode) { super(code); this.name = 'ImageError'; }
}

export const PHOTO_ACCEPT = ACCEPTED.join(',');

async function encode(source: CanvasImageSource, w: number, h: number, quality: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    if (!ctx) throw new ImageError('PHOTO_UNREADABLE');
    ctx.drawImage(source, 0, 0, w, h);
    return c.convertToBlob({ type: 'image/webp', quality });
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new ImageError('PHOTO_UNREADABLE');
  ctx.drawImage(source, 0, 0, w, h);
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new ImageError('PHOTO_UNREADABLE'))), 'image/webp', quality));
}

/** Resizes and re-encodes a photo to WebP; throws ImageError with a code the UI translates. */
export async function resizeToWebp(file: Blob): Promise<Blob> {
  if (!ACCEPTED.includes(file.type)) throw new ImageError('PHOTO_TYPE');
  if (file.size > PHOTO_MAX_INPUT_BYTES) throw new ImageError('PHOTO_TOO_LARGE');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageError('PHOTO_UNREADABLE');
  }
  try {
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    for (const q of [0.82, 0.7, 0.55]) {
      const out = await encode(bitmap, w, h, q);
      if (out.type !== 'image/webp') throw new ImageError('PHOTO_UNREADABLE');
      if (out.size <= PHOTO_MAX_OUTPUT_BYTES) return out;
    }
    throw new ImageError('PHOTO_TOO_LARGE');
  } finally {
    bitmap.close();
  }
}
