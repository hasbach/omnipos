# 1.6.0 — roles & permissions, cash-flow edit/analytics, searchable pickers, POS categories, store connections

Four workstreams run in parallel on branch `feature/roles-cashflow-ui`. FILE OWNERSHIP IS STRICT — only edit files
in your list; if you truly need a one-line change elsewhere, keep it surgical and mention it in your report.
Shared rule: all new UI strings in en/ar/fr (src/intl/locales/*.ts), RTL-safe logical classes, existing ui kit
(src/components/ui), ValidationError `{error, code, field}` for server errors + translateServerError codes.
Tests: `npm test` rebuilds the native sqlite module — two agents running it at once corrupt each other. Before
running `npm test`, acquire the lock: `mkdir .test-lock` (retry every 20 s until it succeeds), and ALWAYS
`rmdir .test-lock` afterwards (even on failure). Never run git commands that change the working tree.

---------------------------------------------------------------------------------------------------------
## A. Roles & permissions (points 2) — owner: A
Files: server/permissions.ts (new), server.ts (session typing + middleware registration only), server/routes.ts
(ONLY: verify-pin sets the session user; new /api/auth/whoami + /api/permissions routes may live in
permissions.ts instead), src/lib/permissions.ts (new), src/context/* or a new src/lib/usePermissions.ts,
src/components/shell/Sidebar.tsx, src/Dashboard.tsx (route guards), src/pages/settings/RolesSection.tsx (new) +
its nav entry in src/pages/Settings.tsx, src/pages/UserManagement.tsx (role list/labels), src/components/PosHeader.tsx
(dashboard button gating), src/components/LockScreen.tsx, tests/permissions.test.ts, locale files.

Facts: roles in use: admin, manager, staff, cashier, accountant (labels usr_role_*). Server auth = tenant
session cookie only (`req.session.tenantId`); `POST /api/auth/verify-pin` (routes.ts ~472) just checks the PIN.
The dashboard learns the cashier from `?cashierId=` → sessionStorage (src/Dashboard.tsx ~230), looked up in
/api/users. The dashboard is a child window of the POS, same cookie/session.

Design:
- Session user: verify-pin success stores `req.session.userId` (+ role). Add `POST /api/auth/lock` (clears
  userId) and call it from the POS lock action. `GET /api/auth/whoami` → `{ user: {id,name,role}|null,
  permissions: string[] , enforced: boolean }`.
- Permission catalogue (server/permissions.ts, mirrored in src/lib/permissions.ts): keys grouped by area, e.g.
  `dashboard.overview`, `invoices.view`, `invoices.edit`, `invoices.delete`, `invoices.refund`,
  `daily_sales.view`, `live_monitor.view`, `products.view`, `products.edit`, `stock.view`, `stock.adjust`,
  `purchases.view`, `purchases.edit`, `parties.view`, `parties.edit`, `cash_flow.view`, `cash_flow.add`,
  `cash_flow.edit`, `settlement.cash_out`, `settlement.close`, `settlement.correct`, `reports.view`,
  `users.manage`, `logs.view`, `import.run`, `settings.manage`, `data.reset`, `pos.discount`,
  `pos.price_override`, `pos.refund`, `pos.open_dashboard`.
- Role → permissions stored in settings key `role_permissions` (JSON `{role: string[]}`); `admin` ALWAYS has
  everything and is not editable. Defaults (used when the key is absent):
  manager: everything except users.manage, settings.manage, data.reset;
  accountant: dashboard.overview, invoices.view, daily_sales.view, live_monitor.view, purchases.view,
  parties.view, cash_flow.*, settlement.*, reports.view, logs.view, pos.open_dashboard;
  staff: dashboard.overview, invoices.view, daily_sales.view, products.view, stock.view, parties.view,
  pos.discount, pos.refund, pos.open_dashboard;
  cashier: daily_sales.view, pos.refund, pos.open_dashboard  (live monitor: admin + accountant only by default,
  per the owner's request "live monitor only admin and finance").
- Enforcement (server): ONE middleware registered before the routes, matching `METHOD path-pattern` →
  permission from a table in permissions.ts (e.g. `POST /api/cash-flow` → cash_flow.add, `PUT /api/cash-flow/:id`
  → cash_flow.edit, `DELETE /api/transactions/:id` → invoices.delete, `POST /api/tenant/settlement` →
  settlement.close, `POST /api/tenant/reset` → data.reset, `POST /api/settings` → settings.manage, users CRUD →
  users.manage, product/stock/purchase writes, etc.). Do NOT touch individual route handlers. Unmatched routes pass.
  **Backward compatible**: when the session has NO userId (tenant owner signed in with the business password,
  tests, legacy), everything is allowed — restrictions apply once a cashier has signed in with a PIN. Reads the POS
  itself needs (products, stakeholders, currencies, settings GET, transactions POST for sales) must stay open to
  every signed-in user. Denied → 403 `{error, code:'PERMISSION_DENIED', permission}`.
- Client: `usePermissions()` (fetch whoami, refetch on 'pos-sync'/focus) → `can(key)`. Sidebar hides items the
  user can't view; Dashboard routes render a friendly "No access" EmptyState for forbidden pages; PosHeader hides
  the dashboard button without pos.open_dashboard. (POS discount/price-override/refund buttons: gate them only
  if the code lives in PosHeader/LockScreen; the cart files belong to workstream C — skip those, the server
  still enforces.)
- Settings → "Roles & permissions" (admin only): matrix with roles as columns and permissions grouped by area as
  rows, checkboxes, "Reset to defaults", admin column locked/checked. Save via POST /api/permissions (requires
  settings.manage). Users page: role dropdown lists all 5 roles with short descriptions.
- Tests: whoami; a cashier PIN session gets 403 on live monitor data? (server gating of reads: gate the dashboard
  read endpoints that are sensitive: cash-flow list/summary, reports, settlement, users, logs); owner session (no
  PIN) allowed; custom role_permissions respected; admin always allowed; lock clears.

---------------------------------------------------------------------------------------------------------
## B. Cash flow: admin edit, analytics & filters, card layout (points 3, 4, 7) — owner: B
Files: server/cashFlow.ts (new; move/extend cash-flow routes here — you may delete the old handlers from
server/routes.ts ~2370-2435 and register the module, nothing else in routes.ts), server/db.ts (new columns/tables
for cash flow only), src/pages/CashFlowRegister.tsx + new src/pages/cashflow/*, tests/cash-flow-*.test.ts (new),
locale file for cash flow strings, supabase/migrations/2026-09-29_cash_flow_categories.sql (new).

- Category: add `cash_flow.category TEXT` (+ archived_cash_flow). Built-in categories: `top_up` (owner adds float),
  `loan_in` (borrowed cash received), `loan_repayment` (paying back a borrowing), `owner_withdrawal`, `expense`,
  `supplier_payment`, `customer_collection`, `other`. Existing automatic rows (balance-payment "Balance collection
  from X" / "Payment to supplier X", "Payment on invoice #…") get customer_collection / supplier_payment on insert
  and via a one-time backfill by reason prefix. Optional `counterparty TEXT` (who lent / who was paid) for loans.
  Add both to the cash-in/out entry form (category select + optional counterparty).
- Admin edit: `PUT /api/cash-flow/:id` (live or archived row; body amount, currency, exchange_rate, type,
  category, counterparty, reason, `edit_reason` REQUIRED) and optional `DELETE` (soft? — no: keep it edit-only,
  deletion not required). Audit table `cash_flow_edits(id, tenant_id, cash_flow_id, archived, user_id,
  edit_reason, before_json, after_json, created_at)`; list via `GET /api/cash-flow/:id/edits`. Editing an
  archived row changes that settled day's rebuilt figures (the settlement detail will show "changed after
  closing" through its register diff) — that is intended; mention it in the edit modal. Server-side the
  permission check is workstream A's middleware (`PUT /api/cash-flow/:id` → cash_flow.edit); do not add role
  checks yourself. UI: edit button on each row → modal with mandatory reason; show an "Edited" badge + history.
- Analytics & filters: `GET /api/cash-flow/analytics?from&to&type&category&q&counterparty` over live + archived
  rows → `{ totals: {in, out, net}, by_category: [{category, type, count, total}], by_counterparty (loans):
  [{counterparty, borrowed, repaid, outstanding}], by_day: [{date, in, out}], rows: [...] }` (USD, local-date
  boundaries — use localToday / 'localtime' like the rest of the app). Page: filter bar (date range with the
  existing DateRangePicker, type, category, counterparty/search) + stat cards ("Top-ups: 7 times · $1,200",
  "Borrowed / repaid / outstanding", totals in/out/net) + a by-category table + loans table + the filtered list
  (live + archived, with an "archived/settled" badge). Keep the existing register (today's live view) working.
- Point 7 — card layout: the analytics StatCards on this page overflow. Use a 2-row grid (e.g. `grid-cols-2
  md:grid-cols-3 xl:grid-cols-4`, never one long row), and make the numbers shrink to fit: CSS
  `font-size: clamp(...)` with container query units (`@container` + `cqi`) or a small `useFitText` hook; values
  must never be cut off (no truncate on money) at 1024 px width, in USD and LBP, in Arabic too.
- Tests: categories + backfill; edit live and archived rows with audit + required reason; analytics totals,
  top-up counts, loan outstanding; filters.

---------------------------------------------------------------------------------------------------------
## C. Searchable pickers & POS categories (points 5, 6) — owner: C
Files: src/components/ui/Combobox.tsx (new, export from ui/index.ts), src/pages/invoices/InvoiceEditor.tsx
(party picker only), src/pages/invoices/RefundModal.tsx / PaymentModal.tsx ONLY if they have a party select,
src/pages/PurchaseManagement.tsx, src/pages/InvoiceManagement.tsx, src/pages/StakeholderManagement.tsx,
src/pages/stakeholders/* , src/components/ProductGrid.tsx, locale files for new strings.

- `Combobox` (searchable select): keyboard (↑/↓/Enter/Esc/Home/End, type-to-filter), ARIA combobox/listbox,
  diacritic- and case-insensitive match incl. Arabic (normalize alef/hamza/taa marbuta like the import wizard's
  normalizeHeader), shows secondary text (phone, balance), "No results", clearable, optional "All" item for
  filters, virtualized or capped list for 1000+ entries, RTL. Replace every customer/supplier NAME dropdown:
  party picker in the invoice editor (sales and purchases), party filters on the Invoices and Purchases lists,
  and any party select on the Customers/Suppliers page (e.g. a "merge"/"settle" or statement picker if present).
- POS catalog categories (ProductGrid): categories currently wrap into many rows and eat product space. Make
  them a single-line horizontally scrollable chip row with prev/next arrow buttons (RTL-aware), plus a
  "collapse" toggle that hides the row down to the active category chip; remember the collapsed state in
  localStorage (try/catch). Product area gets the freed height. Keep the existing pagination of products.

---------------------------------------------------------------------------------------------------------
## D. Second window for another store (point 1) — owner: D
Files: electron-main.js, electron-preload.cjs, setup.html (if needed), a new `connections.html` (+ its own
preload `connections-preload.cjs`) OR a React page, src/components/PosHeader.tsx is owned by A — add your entry
point instead in src/pages/settings/ConnectionsSection.tsx (new) + its nav entry in src/pages/Settings.tsx
(surgical), and a global keyboard shortcut / app menu item in electron-main.js.

- Config: network-config.json gains `connections: [{id, name, url}]` (other stores' hosts, e.g.
  http://192.168.1.60:3000). Current host/client mode is unchanged and keeps running.
- Opening a connection = a NEW BrowserWindow (frameless like the others) loading `${url}/?terminalId=<this
  terminal name>` with its OWN session partition `persist:conn-<id>` so logins/cookies never mix with the main
  window. Window title shows the store name. Several can be open.
- Preload API (`window.electronAPI.connections`): list, add {name, url} (validate http(s) URL, reachable check with
  a short fetch to `${url}/api/auth/me` accepting 200/401), remove, open(id), scan() (reuse scanForServers from
  the setup window), plus `resetConnectionMode()` = "Change host/client mode" (deletes network-config.json after a
  confirm and relaunches → setup window).
- UI: Settings → "Store connections" section (only rendered when window.electronAPI.connections exists): list
  with Open / Remove, "Add store" (name + address, or pick from a network scan), and a "Change this register's
  mode (host/client)" button with a clear warning. Also expose "Open another store…" in the app menu /
  Ctrl+Shift+O opening the Settings section.
- In the opened window, external links follow the same openOutsideLinkExternally rule.
- No automated tests possible for Electron here; keep main-process code small and defensive; `node --check`
  electron-main.js; `npx tsc --noEmit`; `npm run build`.
