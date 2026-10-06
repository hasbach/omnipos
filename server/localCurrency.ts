// The tenant's "local currency": any configured currency that is not USD (merchants use 'LBP' and
// 'LB' interchangeably, so the code is never hardcoded). Prefer the one flagged is_default, else
// the first non-USD by id; null when the tenant only has USD.
import { db } from "./db.js";

export interface LocalCurrency { code: string; symbol: string; rate: number }

export function localCurrencyFor(tenantId: number): LocalCurrency | null {
  const row = db.prepare(
    `SELECT code, symbol, rate FROM currencies
     WHERE tenant_id = ? AND UPPER(code) <> 'USD' AND rate > 0
     ORDER BY is_default DESC, id ASC LIMIT 1`
  ).get(tenantId) as any;
  return row ? { code: row.code, symbol: row.symbol, rate: Number(row.rate) } : null;
}

export interface EffectiveLocalRate extends LocalCurrency { source: 'party' | 'global' }

/** A party's own local-currency rate (stakeholders.local_rate) or null when it uses the global one. */
export function partyLocalRate(tenantId: number, stakeholderId: number | null | undefined): number | null {
  if (!stakeholderId) return null;
  const row = db.prepare("SELECT name, local_rate FROM stakeholders WHERE id = ? AND tenant_id = ?").get(stakeholderId, tenantId) as any;
  // The built-in walk-in customer always uses the global rate, even if a rate got onto its row.
  if (row?.name === 'Walk-in Customer') return null;
  const r = row?.local_rate == null ? null : Number(row.local_rate);
  return r != null && Number.isFinite(r) && r > 0 ? r : null;
}

/**
 * The rate to use for a party: its own override when set (and the tenant has a local currency),
 * else the global local-currency rate; null for USD-only tenants.
 */
export function effectiveLocalRate(tenantId: number, stakeholderId: number | null | undefined): EffectiveLocalRate | null {
  const cur = localCurrencyFor(tenantId);
  if (!cur) return null;
  const own = partyLocalRate(tenantId, stakeholderId);
  return own != null ? { ...cur, rate: own, source: 'party' } : { ...cur, source: 'global' };
}

/** True when `code` is the tenant's local currency (case-insensitive; never a hardcoded LBP/LB). */
export function isLocalCode(local: LocalCurrency | null, code: unknown): boolean {
  return !!local && typeof code === 'string' && code.toUpperCase() === local.code.toUpperCase();
}

/** Validates a client-supplied party rate: null/'' clears it, otherwise a finite number > 0. */
export function parsePartyRate(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return { ok: true, value: null };
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return { ok: false };
  return { ok: true, value: n };
}
