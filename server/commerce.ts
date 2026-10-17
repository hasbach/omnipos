// Commerce layer — specs/001-commerce-domain-foundation/plan.md (Slice A: store & listings).
//
// Model
//  - Commerce is opt-in per tenant: settings key `commerce_enabled` ('1' = on; absent or '0' = off).
//    While off, nothing here changes how the shop works and the cloud public catalog returns nothing.
//  - A store (`stores`) and its listings (`store_listings`) are authored locally and synced like
//    products. A listing REFERENCES a product and never copies its price, stock or units.
//  - Public (anonymous) reads go through cloud functions with an explicit field allow-list
//    (supabase/migrations/2026-10-18_commerce_store_foundation.sql), never through raw tables.
import { db, logAction } from './db.js';
import { ValidationError, validationErrorBody } from './errors.js';

// ---- commerce flag -------------------------------------------------------------------------------

export function isCommerceEnabled(tenantId: number): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'commerce_enabled'").get(tenantId) as any;
  return row?.value === '1';
}

/** Turns commerce on/off. Off keeps every store and listing; it only stops them being public. */
export function setCommerceEnabled(tenantId: number, userId: number | null, enabled: boolean): boolean {
  const before = isCommerceEnabled(tenantId);
  if (before !== enabled) {
    // Upsert (not INSERT OR REPLACE) so the row keeps its global_id and syncs as an update.
    db.prepare(
      "INSERT INTO settings (tenant_id, key, value) VALUES (?, 'commerce_enabled', ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value"
    ).run(tenantId, enabled ? '1' : '0');
    logAction(tenantId, userId, 'commerce_toggle', JSON.stringify({ entity: 'tenant', before: { enabled: before }, after: { enabled } }));
  }
  return enabled;
}

/** Same rule as the cloud public functions: a lifetime online license, or one that hasn't expired. */
export function isOnlineLicenseValid(tenantId: number): boolean {
  const t = db.prepare("SELECT online_license_type, online_license_expiry FROM tenants WHERE id = ?").get(tenantId) as any;
  if (!t) return false;
  if (t.online_license_type === 'lifetime') return true;
  if (!t.online_license_expiry) return false;
  const expiry = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(String(t.online_license_expiry)) ? String(t.online_license_expiry) : String(t.online_license_expiry).replace(' ', 'T') + 'Z');
  return Number.isFinite(expiry) && expiry > Date.now();
}

/** The tenant's first live store, as a small summary (the UI manages one store in Slice A). */
export function storeSummary(tenantId: number) {
  return (db.prepare(
    "SELECT id, global_id, name, slug, mode, status FROM stores WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1"
  ).get(tenantId) as any) || null;
}

export function commerceStatus(tenantId: number) {
  return { enabled: isCommerceEnabled(tenantId), online_license_valid: isOnlineLicenseValid(tenantId), store: storeSummary(tenantId) };
}

// ---- routes (contracts/backoffice-api.md; permissions in server/permissions.ts ROUTE_RULES) ---------

export function setupCommerceRoutes(app: any, authenticate: any) {
  app.get('/api/commerce/status', authenticate, (req: any, res: any) => {
    res.json(commerceStatus(req.session.tenantId));
  });

  app.put('/api/commerce/status', authenticate, (req: any, res: any) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      const err = new ValidationError('enabled must be true or false.', 400, { code: 'COMMERCE_ENABLED_INVALID', field: 'enabled' });
      return res.status(err.status).json(validationErrorBody(err));
    }
    setCommerceEnabled(req.session.tenantId, req.session.userId ?? null, enabled);
    res.json(commerceStatus(req.session.tenantId));
  });
}
