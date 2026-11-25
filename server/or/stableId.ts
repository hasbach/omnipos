// Deterministic global ids for OmniPulse OR rows that every register would otherwise create on its own
// (per-tenant config, draw policies, buckets, supplier profiles, the daily briefing and the daily cycle count).
// Same tenant + same natural key => same UUID on every register, so the cloud upsert (ON CONFLICT global_id)
// merges them instead of failing on the natural-key unique constraints or duplicating rows.
import crypto from "crypto";
import { db } from "../db.js";

export function tenantGlobalId(tenantId: number): string | null {
  const row = db.prepare("SELECT global_id FROM tenants WHERE id = ?").get(tenantId) as any;
  return row?.global_id ? String(row.global_id) : null;
}

/** UUID (v5 layout) from the tenant's global id and the row's natural key; null when the tenant has no global id. */
export function stableGlobalId(tenantId: number, ...key: Array<string | number>): string | null {
  const tg = tenantGlobalId(tenantId);
  if (!tg) return null;
  const h = crypto.createHash("sha1").update(`omnipulse-or|${tg}|${key.join("|")}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Global id of a local row (or null) — for keys built from another synced row. */
export function rowGlobalId(table: string, id: number | null | undefined): string | null {
  if (!id) return null;
  const row = db.prepare(`SELECT global_id FROM ${table} WHERE id = ?`).get(id) as any;
  return row?.global_id ? String(row.global_id) : null;
}
