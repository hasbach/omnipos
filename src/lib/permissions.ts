// Client mirror of server/permissions.ts (catalogue, roles, defaults) plus the route -> permission map
// the Sidebar and the Dashboard route guards share. Keep in sync with the server file: the server is
// the authority (it answers 403 PERMISSION_DENIED); this only decides what to show.

export const PERMISSION_GROUPS: { area: string; keys: string[] }[] = [
  { area: 'dashboard', keys: ['dashboard.overview'] },
  { area: 'sales', keys: ['invoices.view', 'invoices.edit', 'invoices.delete', 'invoices.refund', 'daily_sales.view', 'live_monitor.view'] },
  { area: 'inventory', keys: ['products.view', 'products.edit', 'stock.view', 'stock.adjust'] },
  { area: 'purchasing', keys: ['purchases.view', 'purchases.edit', 'parties.view', 'parties.edit'] },
  { area: 'finance', keys: ['cash_flow.view', 'cash_flow.add', 'cash_flow.edit', 'settlement.cash_out', 'settlement.close', 'settlement.view', 'settlement.correct', 'reports.view'] },
  { area: 'admin', keys: ['users.manage', 'logs.view', 'import.run', 'settings.manage', 'data.reset'] },
  { area: 'pos', keys: ['pos.discount', 'pos.price_override', 'pos.refund', 'pos.open_dashboard'] },
];

export const ALL_PERMISSIONS: string[] = PERMISSION_GROUPS.flatMap((g) => g.keys);

/** admin first (locked), then the editable roles in the order the matrix shows them. */
export const ROLES = ['admin', 'manager', 'accountant', 'staff', 'cashier'] as const;
export type RoleKey = (typeof ROLES)[number];
export const EDITABLE_ROLES = ROLES.filter((r) => r !== 'admin');

export const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [...ALL_PERMISSIONS],
  // Live Monitor is admin + accountant only by default (owner's request).
  manager: ALL_PERMISSIONS.filter((k) => !['users.manage', 'settings.manage', 'data.reset', 'live_monitor.view'].includes(k)),
  accountant: [
    'dashboard.overview', 'invoices.view', 'daily_sales.view', 'live_monitor.view', 'purchases.view', 'parties.view',
    'cash_flow.view', 'cash_flow.add', 'cash_flow.edit',
    'settlement.cash_out', 'settlement.close', 'settlement.view', 'settlement.correct',
    'reports.view', 'logs.view', 'pos.open_dashboard',
  ],
  staff: [
    'dashboard.overview', 'invoices.view', 'daily_sales.view', 'products.view', 'stock.view', 'parties.view',
    'pos.discount', 'pos.refund', 'pos.open_dashboard',
  ],
  cashier: ['daily_sales.view', 'pos.refund', 'pos.open_dashboard'],
};

/** i18n key of a permission's label: 'cash_flow.edit' -> 'perm_cash_flow_edit' (description: `${key}_desc`). */
export const permLabelKey = (key: string) => `perm_${key.replace(/\./g, '_')}`;

/**
 * Dashboard page (path under /dashboard, '' = index) -> permissions of which ANY one grants access.
 * `null` = open to everyone.
 */
export const PAGE_PERMISSIONS: Record<string, string[] | null> = {
  '': ['dashboard.overview'],
  'live': ['live_monitor.view'],
  'daily-sales': ['daily_sales.view'],
  'reports': ['reports.view'],
  'products': ['products.view'],
  'stock': ['stock.view'],
  'purchases': ['purchases.view'],
  'stakeholders': ['parties.view'],
  'users': ['users.manage'],
  'invoices': ['invoices.view'],
  'cash-flow': ['cash_flow.view'],
  'settlement': ['settlement.cash_out', 'settlement.close', 'settlement.view', 'settlement.correct'],
  'logs': ['logs.view'],
  // Open to everyone: appearance / language are personal; Settings.tsx hides the other sections by permission.
  'settings': null,
  'ui-kit': ['settings.manage'],
  'import': ['import.run'],
};

/** Permission list for a sidebar/route path such as '/dashboard/cash-flow'. */
export function pagePermissions(path: string): string[] | null {
  const rest = path.replace(/^\/dashboard\/?/, '').split('/')[0];
  return Object.prototype.hasOwnProperty.call(PAGE_PERMISSIONS, rest) ? PAGE_PERMISSIONS[rest] : null;
}
