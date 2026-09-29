// Roles & permissions — docs/plans/2026-09-29-roles-cashflow-ui-connections.md (workstream A).
//
// Model
//  - The server session knows the TENANT (business login) and, once a cashier signs in with a PIN on
//    the POS lock screen, the USER (`req.session.userId`, set by /api/auth/verify-pin, cleared by
//    /api/auth/lock). Restrictions only apply while a session user exists — the business owner
//    signed in with the password (no PIN), the test suite and legacy clients keep full access.
//  - role -> permissions lives in the tenant `settings` row `role_permissions` (JSON {role: string[]}).
//    The `admin` role ALWAYS has every permission and cannot be edited. Roles absent from the stored
//    map fall back to DEFAULT_ROLE_PERMISSIONS.
//  - Enforcement is ONE middleware (permissionMiddleware) that matches `METHOD path` against ROUTE_RULES
//    below and answers 403 PERMISSION_DENIED. Individual route handlers are never touched; routes with
//    no rule pass. Reads the POS itself needs stay open to every signed-in user.
//
// The catalogue / defaults are mirrored on the client in src/lib/permissions.ts — keep them in sync.
import { db, logAction } from './db.js';
import { ValidationError, validationErrorBody } from './errors.js';

export const PERMISSION_GROUPS: { area: string; keys: string[] }[] = [
  { area: 'dashboard', keys: ['dashboard.overview'] },
  { area: 'sales', keys: ['invoices.view', 'invoices.edit', 'invoices.delete', 'invoices.refund', 'daily_sales.view', 'live_monitor.view'] },
  { area: 'inventory', keys: ['products.view', 'products.edit', 'stock.view', 'stock.adjust'] },
  { area: 'purchasing', keys: ['purchases.view', 'purchases.edit', 'parties.view', 'parties.edit'] },
  { area: 'finance', keys: ['cash_flow.view', 'cash_flow.add', 'cash_flow.edit', 'settlement.cash_out', 'settlement.close', 'settlement.correct', 'reports.view'] },
  { area: 'admin', keys: ['users.manage', 'logs.view', 'import.run', 'settings.manage', 'data.reset'] },
  { area: 'pos', keys: ['pos.discount', 'pos.price_override', 'pos.refund', 'pos.open_dashboard'] },
];

export const ALL_PERMISSIONS: string[] = PERMISSION_GROUPS.flatMap((g) => g.keys);
const PERMISSION_SET = new Set(ALL_PERMISSIONS);

/** Roles the matrix can edit (admin is fixed: always everything). */
export const EDITABLE_ROLES = ['manager', 'accountant', 'staff', 'cashier'] as const;
export const ROLES = ['admin', ...EDITABLE_ROLES] as const;

export const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [...ALL_PERMISSIONS],
  // Live Monitor is admin + accountant only by default (owner's request).
  manager: ALL_PERMISSIONS.filter((k) => !['users.manage', 'settings.manage', 'data.reset', 'live_monitor.view'].includes(k)),
  accountant: [
    'dashboard.overview', 'invoices.view', 'daily_sales.view', 'live_monitor.view', 'purchases.view', 'parties.view',
    'cash_flow.view', 'cash_flow.add', 'cash_flow.edit',
    'settlement.cash_out', 'settlement.close', 'settlement.correct',
    'reports.view', 'logs.view', 'pos.open_dashboard',
  ],
  staff: [
    'dashboard.overview', 'invoices.view', 'daily_sales.view', 'products.view', 'stock.view', 'parties.view',
    'pos.discount', 'pos.refund', 'pos.open_dashboard',
  ],
  cashier: ['daily_sales.view', 'pos.refund', 'pos.open_dashboard'],
};

// ---- storage -------------------------------------------------------------------------------------

function readStoredMap(tenantId: number | string): Record<string, string[]> | null {
  const row = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'role_permissions'").get(tenantId) as any;
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function cleanList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return Array.from(new Set(list.filter((k): k is string => typeof k === 'string' && PERMISSION_SET.has(k))));
}

/** Effective permissions of a role for a tenant (admin: everything, always). */
export function permissionsForRole(tenantId: number | string, role: string): string[] {
  if (role === 'admin') return [...ALL_PERMISSIONS];
  const stored = readStoredMap(tenantId);
  if (stored && Object.prototype.hasOwnProperty.call(stored, role)) return cleanList(stored[role]);
  return [...(DEFAULT_ROLE_PERMISSIONS[role] || [])];
}

/** Effective role -> permissions map for every known role. */
export function effectiveRoleMap(tenantId: number | string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const role of ROLES) out[role] = permissionsForRole(tenantId, role);
  return out;
}

// ---- route table ---------------------------------------------------------------------------------

/** A rule resolves to: null (open), one permission, or a list where ANY one is enough. */
type Need = string | string[] | null;
interface RouteRule {
  method: string;
  pattern: string; // `:param` matches one segment, trailing `*` matches the rest
  need: Need | ((req: any) => Need);
}

const OVERVIEW_OR_REPORTS = ['reports.view', 'dashboard.overview'];
const SETTLEMENT_ANY = ['settlement.close', 'settlement.cash_out', 'settlement.correct'];

// FIRST match wins — keep specific paths above their `:param` siblings.
export const ROUTE_RULES: RouteRule[] = [
  // --- roles matrix itself ---
  { method: 'GET', pattern: '/api/permissions', need: 'settings.manage' },
  { method: 'POST', pattern: '/api/permissions', need: 'settings.manage' },

  // --- invoices / transactions (recent, :id and :id/refundable stay open: the POS history uses them) ---
  { method: 'GET', pattern: '/api/transactions/:id/edits', need: 'invoices.view' },
  { method: 'PUT', pattern: '/api/transactions/:id', need: 'invoices.edit' },
  { method: 'DELETE', pattern: '/api/transactions/:id', need: 'invoices.delete' },
  {
    method: 'POST',
    pattern: '/api/transactions',
    need: (req) => {
      const body = req.body || {};
      const type = body.type || 'sale';
      if (type === 'refund') return ['pos.refund', 'invoices.refund'];
      if (type === 'purchase') return 'purchases.edit';
      const hasDiscount = Number(body.discount?.value) > 0 ||
        (Array.isArray(body.items) && body.items.some((it: any) => Number(it?.discount?.value) > 0));
      if (type === 'sale' && hasDiscount) return ['pos.discount', 'invoices.edit'];
      return null; // a plain sale is what the POS does all day
    },
  },

  // --- reports ---
  { method: 'GET', pattern: '/api/reports/daily-sales', need: null }, // POS history + live monitor feed
  { method: 'GET', pattern: '/api/reports/daily-sales-by-payment', need: ['daily_sales.view', 'reports.view'] },
  { method: 'GET', pattern: '/api/reports/daily-sales-by-customer', need: ['daily_sales.view', 'reports.view'] },
  { method: 'GET', pattern: '/api/reports/sales', need: 'reports.view' },
  { method: 'GET', pattern: '/api/reports/summary', need: OVERVIEW_OR_REPORTS },
  { method: 'GET', pattern: '/api/reports/sales-trend', need: OVERVIEW_OR_REPORTS },
  { method: 'GET', pattern: '/api/reports/by-product', need: OVERVIEW_OR_REPORTS },
  { method: 'GET', pattern: '/api/reports/low-stock', need: [...OVERVIEW_OR_REPORTS, 'stock.view'] },
  { method: 'GET', pattern: '/api/reports/inventory-valuation', need: ['reports.view', 'stock.view'] },
  { method: 'GET', pattern: '/api/reports/aging', need: [...OVERVIEW_OR_REPORTS, 'parties.view'] },
  { method: 'GET', pattern: '/api/reports/unpaid-sales', need: ['reports.view', 'parties.view'] },
  { method: 'GET', pattern: '/api/reports/unpaid-purchases', need: ['reports.view', 'purchases.view'] },
  { method: 'GET', pattern: '/api/reports/customer-statement/:id', need: ['reports.view', 'parties.view'] },
  { method: 'GET', pattern: '/api/reports/daily', need: ['reports.view', ...SETTLEMENT_ANY] },
  { method: 'GET', pattern: '/api/reports/yearly', need: ['reports.view', ...SETTLEMENT_ANY] },
  { method: 'POST', pattern: '/api/reports/daily', need: 'settlement.close' },
  { method: 'POST', pattern: '/api/reports/yearly', need: 'settlement.close' },
  { method: 'GET', pattern: '/api/reports/*', need: 'reports.view' },
  { method: 'POST', pattern: '/api/reports/*', need: 'reports.view' },

  // --- cash flow (workstream B adds analytics / edit / edits) ---
  { method: 'GET', pattern: '/api/cash-flow/analytics', need: 'cash_flow.view' },
  { method: 'GET', pattern: '/api/cash-flow/summary', need: ['cash_flow.view', ...SETTLEMENT_ANY] },
  { method: 'GET', pattern: '/api/cash-flow/:id/edits', need: 'cash_flow.view' },
  { method: 'GET', pattern: '/api/cash-flow', need: 'cash_flow.view' },
  { method: 'POST', pattern: '/api/cash-flow', need: 'cash_flow.add' },
  { method: 'PUT', pattern: '/api/cash-flow/:id', need: 'cash_flow.edit' },
  { method: 'DELETE', pattern: '/api/cash-flow/:id', need: 'cash_flow.edit' },
  { method: 'POST', pattern: '/api/balance-payment', need: ['cash_flow.add', 'parties.edit'] },

  // --- settlement / end of day ---
  { method: 'POST', pattern: '/api/tenant/settlement', need: 'settlement.close' },
  { method: 'POST', pattern: '/api/tenant/cashout', need: 'settlement.cash_out' },
  { method: 'GET', pattern: '/api/tenant/cashier-shifts', need: ['reports.view', ...SETTLEMENT_ANY] },
  { method: 'GET', pattern: '/api/settlements/:reportId', need: ['reports.view', ...SETTLEMENT_ANY] },
  { method: 'POST', pattern: '/api/settlements/:reportId/corrections', need: 'settlement.correct' },

  // --- data reset / import ---
  { method: 'GET', pattern: '/api/tenant/reset/preview', need: 'data.reset' },
  { method: 'POST', pattern: '/api/tenant/reset', need: 'data.reset' },
  { method: 'POST', pattern: '/api/import/:entity', need: 'import.run' },

  // --- products (GET list / GET :query stay open for the POS) ---
  { method: 'GET', pattern: '/api/products/export', need: 'products.view' },
  { method: 'POST', pattern: '/api/products/bulk-import', need: 'products.edit' },
  { method: 'POST', pattern: '/api/products/bulk-price', need: 'products.edit' },
  { method: 'POST', pattern: '/api/products', need: 'products.edit' },
  { method: 'PUT', pattern: '/api/products/:id', need: 'products.edit' },
  { method: 'DELETE', pattern: '/api/products/:id', need: 'products.edit' },

  // --- stock ---
  { method: 'POST', pattern: '/api/stock/adjust', need: 'stock.adjust' },
  { method: 'GET', pattern: '/api/stock/adjustments', need: 'stock.view' },
  { method: 'GET', pattern: '/api/stock/movements/:productId', need: 'stock.view' },

  // --- purchases ---
  { method: 'GET', pattern: '/api/purchases', need: 'purchases.view' },
  { method: 'GET', pattern: '/api/purchases/:id', need: 'purchases.view' },
  { method: 'PUT', pattern: '/api/purchases/:id/receive', need: 'purchases.edit' },

  // --- customers & suppliers (POST/PUT/list/settle-balance stay open: the POS adds/edits customers and takes payments) ---
  { method: 'DELETE', pattern: '/api/stakeholders/:id', need: 'parties.edit' },

  // --- users, settings, currencies, printers, logs ---
  { method: 'POST', pattern: '/api/users', need: 'users.manage' },
  { method: 'PUT', pattern: '/api/users/:id', need: 'users.manage' },
  { method: 'DELETE', pattern: '/api/users/:id', need: 'users.manage' },
  {
    method: 'POST',
    pattern: '/api/settings',
    // Changing the UI language from the dashboard toolbar is harmless for everyone.
    need: (req) => {
      const keys = Object.keys(req.body || {});
      return keys.length > 0 && keys.every((k) => k === 'language') ? null : 'settings.manage';
    },
  },
  { method: 'POST', pattern: '/api/currencies', need: 'settings.manage' },
  { method: 'PUT', pattern: '/api/currencies/:id', need: 'settings.manage' },
  { method: 'DELETE', pattern: '/api/currencies/:id', need: 'settings.manage' },
  { method: 'GET', pattern: '/api/printers/scan', need: 'settings.manage' },
  { method: 'POST', pattern: '/api/printers', need: 'settings.manage' },
  { method: 'PUT', pattern: '/api/printers/:id', need: 'settings.manage' },
  { method: 'DELETE', pattern: '/api/printers/:id', need: 'settings.manage' },
  { method: 'POST', pattern: '/api/print/arabic-test', need: 'settings.manage' },
  { method: 'POST', pattern: '/api/print/test', need: 'settings.manage' },
  { method: 'GET', pattern: '/api/logs', need: 'logs.view' },
  { method: 'GET', pattern: '/api/system/network-info', need: 'live_monitor.view' },
];

function compile(pattern: string): RegExp {
  const src = pattern
    .split('/')
    .map((seg) => (seg === '*' ? '.*' : seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${src}/?$`);
}

const COMPILED = ROUTE_RULES.map((rule) => ({ rule, re: compile(rule.pattern) }));

export function findRule(method: string, path: string): RouteRule | undefined {
  const m = method.toUpperCase();
  return COMPILED.find((c) => c.rule.method === m && c.re.test(path))?.rule;
}

// ---- session user --------------------------------------------------------------------------------

function sessionUser(req: any): { id: number; name: string; role: string } | null {
  const userId = req.session?.userId;
  const tenantId = req.session?.tenantId;
  if (!userId || !tenantId) return null;
  const row = db.prepare("SELECT id, name, role FROM users WHERE id = ? AND tenant_id = ?").get(userId, tenantId) as any;
  return row ? { id: row.id, name: row.name, role: row.role } : { id: userId, name: '', role: '' };
}

/** Called by verify-pin after a successful PIN check. */
export function setSessionUser(req: any, user: { id: number; name: string; role: string }) {
  req.session.userId = user.id;
  req.session.userName = user.name;
  req.session.userRole = user.role;
  delete req.session.locked;
}

// Locking keeps the session LOCKED (no permissions at all) rather than falling back to "tenant only":
// otherwise a dashboard window left open behind a locked POS would become unrestricted.
export function clearSessionUser(req: any) {
  delete req.session.userId;
  delete req.session.userName;
  delete req.session.userRole;
  req.session.locked = true;
}

// ---- middleware ----------------------------------------------------------------------------------

export function permissionMiddleware(req: any, res: any, next: any) {
  const user = sessionUser(req);
  const locked = !user && req.session?.locked === true;
  if (!user && !locked) return next(); // owner / legacy / tests: never locked, no PIN user => unrestricted
  const rule = findRule(req.method, req.path);
  if (!rule) return next();
  const need = typeof rule.need === 'function' ? rule.need(req) : rule.need;
  if (!need) return next();
  const anyOf = Array.isArray(need) ? need : [need];
  if (locked) return res.status(403).json({ error: 'The register is locked. Sign in with your PIN.', code: 'PERMISSION_DENIED', permission: anyOf[0], permissions: anyOf, locked: true });
  const granted = new Set(permissionsForRole(req.session.tenantId, user.role));
  if (anyOf.some((k) => granted.has(k))) return next();
  return res.status(403).json({ error: 'You do not have permission to do this.', code: 'PERMISSION_DENIED', permission: anyOf[0], permissions: anyOf });
}

// ---- routes + registration -----------------------------------------------------------------------

/**
 * Registers the permission middleware and the auth/permission endpoints. Call it AFTER the session +
 * JSON body middleware and BEFORE setupRoutes(), so the middleware runs ahead of every handler.
 */
export function installPermissions(app: any, authenticate: any, broadcast: Function) {
  app.use(permissionMiddleware);

  // Who is signed in on this session, and what may they do?
  app.get('/api/auth/whoami', authenticate, (req: any, res: any) => {
    const user = sessionUser(req);
    if (!user && req.session?.locked === true) return res.json({ user: null, permissions: [], enforced: true, locked: true });
    if (!user) return res.json({ user: null, permissions: [...ALL_PERMISSIONS], enforced: false });
    res.json({ user, permissions: permissionsForRole(req.session.tenantId, user.role), enforced: true });
  });

  // Locking the POS drops the PIN user; the session goes back to "tenant only".
  app.post('/api/auth/lock', authenticate, (req: any, res: any) => {
    clearSessionUser(req);
    res.json({ success: true });
  });

  // The roles matrix (requires settings.manage via the route table, and admin / owner below).
  app.get('/api/permissions', authenticate, (req: any, res: any) => {
    res.json({
      roles: effectiveRoleMap(req.session.tenantId),
      defaults: DEFAULT_ROLE_PERMISSIONS,
      groups: PERMISSION_GROUPS,
      customized: readStoredMap(req.session.tenantId) !== null,
    });
  });

  app.post('/api/permissions', authenticate, (req: any, res: any) => {
    const tenantId = req.session.tenantId;
    const user = sessionUser(req);
    if (user && user.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can change roles and permissions.', code: 'PERMISSION_DENIED', permission: 'settings.manage' });
    }
    try {
      const incoming = req.body?.role_permissions;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        throw new ValidationError('role_permissions must be an object of role -> permission list.', 400, { code: 'INVALID_PERMISSIONS', field: 'role_permissions' });
      }
      // Start from the current effective map so a partial body only changes the roles it names.
      const next: Record<string, string[]> = {};
      for (const role of EDITABLE_ROLES) next[role] = permissionsForRole(tenantId, role);
      for (const [role, list] of Object.entries(incoming)) {
        if (role === 'admin') continue; // admin is fixed
        if (!(EDITABLE_ROLES as readonly string[]).includes(role)) {
          throw new ValidationError(`Unknown role: ${role}`, 400, { code: 'INVALID_PERMISSIONS', field: 'role_permissions' });
        }
        if (!Array.isArray(list)) {
          throw new ValidationError(`Permissions for ${role} must be a list.`, 400, { code: 'INVALID_PERMISSIONS', field: 'role_permissions' });
        }
        next[role] = cleanList(list);
      }
      db.prepare("INSERT OR REPLACE INTO settings (tenant_id, key, value) VALUES (?, 'role_permissions', ?)").run(tenantId, JSON.stringify(next));
      logAction(tenantId, user?.id ?? 1, 'Permissions Updated', JSON.stringify(next));
      broadcast({ type: 'SETTINGS_UPDATED' }, tenantId);
      broadcast({ type: 'PERMISSIONS_UPDATED' }, tenantId);
      res.json({ success: true, roles: effectiveRoleMap(tenantId) });
    } catch (error: any) {
      if (error instanceof ValidationError) return res.status(error.status).json(validationErrorBody(error));
      res.status(500).json({ error: error.message });
    }
  });
}
