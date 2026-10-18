// The online store's cloud calls (spec 002 US5): photo / logo / cover files in the Supabase Storage bucket
// `store-images`, and owner preview tokens. Always made with the business's own signed-in cloud session, so
// the bucket policies (writes only inside the caller's folder) and the RPC owner check apply. Injectable for
// tests (__setCommerceCloud) and for the preview server (local folder instead of the cloud).
import { getActiveSession } from './session.js';

// One shape (the project is not in strict mode, so a discriminated union wouldn't narrow): ok, or a reason.
export interface CloudResult<T> { ok: boolean; value?: T; reason?: 'offline' | 'failed' }

export interface CommerceCloud {
  upload(tenantId: number, path: string, bytes: Uint8Array): Promise<CloudResult<null>>;
  remove(tenantId: number, paths: string[]): Promise<CloudResult<null>>;
  previewToken(tenantId: number, storeGlobalId: string): Promise<CloudResult<string>>;
}

export const STORE_IMAGES_BUCKET = 'store-images';

/** The signed-in cloud client, but only for THIS business (never act on another tenant's session). */
function clientFor(tenantId: number) {
  const s = getActiveSession();
  return s && s.localId === tenantId ? s.client : null;
}

const supabaseCloud: CommerceCloud = {
  async upload(tenantId, path, bytes) {
    const client = clientFor(tenantId);
    if (!client) return { ok: false, reason: 'offline' };
    try {
      const { error } = await client.storage.from(STORE_IMAGES_BUCKET).upload(path, bytes, {
        contentType: 'image/webp', cacheControl: '31536000', upsert: false,
      });
      return error ? { ok: false, reason: 'failed' } : { ok: true, value: null };
    } catch {
      return { ok: false, reason: 'offline' };
    }
  },
  async remove(tenantId, paths) {
    if (paths.length === 0) return { ok: true, value: null };
    const client = clientFor(tenantId);
    if (!client) return { ok: false, reason: 'offline' };
    try {
      const { error } = await client.storage.from(STORE_IMAGES_BUCKET).remove(paths);
      return error ? { ok: false, reason: 'failed' } : { ok: true, value: null };
    } catch {
      return { ok: false, reason: 'offline' };
    }
  },
  async previewToken(tenantId, storeGlobalId) {
    const client = clientFor(tenantId);
    if (!client) return { ok: false, reason: 'offline' };
    try {
      const { data, error } = await client.rpc('create_store_preview_token', { p_store: storeGlobalId });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row?.token) return { ok: false, reason: 'failed' };
      return { ok: true, value: String(row.token) };
    } catch {
      return { ok: false, reason: 'offline' };
    }
  },
};

let cloud: CommerceCloud = supabaseCloud;
export function getCommerceCloud(): CommerceCloud { return cloud; }
/** Test / preview-server hook: replace the cloud (pass nothing to restore Supabase). */
export function __setCommerceCloud(c?: CommerceCloud) { cloud = c || supabaseCloud; }
