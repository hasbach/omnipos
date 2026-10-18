// /img/<path> — product photos and store logos/covers, proxied from the public Supabase bucket and cached
// for a year at the CDN (object names are random and never reused, so they never go stale — research R7).
export const IMG_PATH = /^[0-9a-f-]{36}\/(l|s)\/[0-9a-f-]{36}\/[A-Za-z0-9_-]+\.webp$/;

export interface ImgResult { status: number; body: Uint8Array | string; contentType: string }

export async function fetchImage(path: string, supabaseUrl: string, fetchImpl: typeof fetch = fetch): Promise<ImgResult> {
  if (!IMG_PATH.test(path)) return { status: 404, body: 'Not found', contentType: 'text/plain; charset=utf-8' };
  let res: Response;
  try {
    res = await fetchImpl(`${supabaseUrl}/storage/v1/object/public/store-images/${path}`);
  } catch {
    return { status: 502, body: 'Upstream error', contentType: 'text/plain; charset=utf-8' };
  }
  if (res.status === 404 || res.status === 400) return { status: 404, body: 'Not found', contentType: 'text/plain; charset=utf-8' };
  if (!res.ok) return { status: 502, body: 'Upstream error', contentType: 'text/plain; charset=utf-8' };
  return { status: 200, body: new Uint8Array(await res.arrayBuffer()), contentType: 'image/webp' };
}
