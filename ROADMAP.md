# OmniPOS Roadmap

Single place to see what has shipped and what is still open. Update it in the same commit as each release
(add a section under **Shipped**) and whenever a new idea or follow-up comes up (add it under **To do**).

Feature design docs live in [docs/plans/](docs/plans/); release notes for 1.2.0 in
[docs/RELEASE-1.2.0.md](docs/RELEASE-1.2.0.md). Every version below has a matching `vX.Y.Z` git tag.

---

## To do

Nothing in the plan docs is recorded as deferred or left unfinished — every planned workstream shipped.
Add new items here as they come up.

| # | Item | Notes / plan doc | Status |
|---|------|------------------|--------|
| 1 | _(add next feature or fix here)_ | | |

**Housekeeping**
- [ ] [task.md](task.md) is the original July 2026 improvement plan (all items done, folded into "Foundation" below) —
      keep as history or delete.
- [ ] 1.6.2 and 1.7.x shipped without plan docs; their scope is recorded here only.

---

## Shipped

### 1.7.x — Cash-flow categories, POS layout, shift vs day (2026-09-29 → 2026-10-01)
- **1.7.2** — Balance Payment: searchable customer/supplier picker (Combobox), each party listed once.
- **1.7.1** — Cash Out reconciles the whole shared drawer since the last close; Settlement covers the whole day
  since the last settlement; shift / day views.
- **1.7.0**
  - Custom cash-flow categories (Settings).
  - Resizable, denser POS layout.
  - Enter in invoice lines returns to search; Combobox Tab / click-away selects the match.
  - Daily Sales: sales by product category, overall and per cashier.

### 1.6.x — Roles & permissions, cash flow, store connections (2026-09-29)
Plan: [2026-09-29-roles-cashflow-ui-connections.md](docs/plans/2026-09-29-roles-cashflow-ui-connections.md)
- **1.6.2**
  - POS: multiple open sales (sale tabs), Alt+N / Alt+1..9, persisted per terminal.
  - Purchase entry: invoice currency, editable line total, qty auto-focus, distinct search results.
  - POS success dialog: Esc finishes the sale; edit form UTC time + null discount fixes.
- **1.6.1** — Permissions audit: `settlement.view`, controls hidden by permission, price override enforced,
  PINs no longer exposed.
- **1.6.0** — Roles & permissions, cash-flow edit and analytics, searchable pickers (Combobox), POS categories,
  store connections.

### 1.5.x — Settlement detail & corrections (2026-09-29)
Plan: [2026-09-29-settlement-detail.md](docs/plans/2026-09-29-settlement-detail.md)
- **1.5.1** — Live Monitor access links card: online monitor URL and this host's LAN address, copy / open.
- **1.5.0**
  - Settlement detail per closed day; admin corrections with reason + PIN; "totals changed after closing" warning.
  - Settlement only renumbers the settling tenant's colliding ids (fixes FK failure across tenants).

### 1.4.0 — Units of measure, guards, data reset (2026-09-29)
Plans: [units-of-measure](docs/plans/2026-09-28-units-of-measure.md),
[stock-and-price-guards](docs/plans/2026-09-29-stock-and-price-guards.md),
[tenant-data-reset](docs/plans/2026-09-29-tenant-data-reset.md)
- Units of measure: packs / cartons with their own barcodes and prices; per-line refunds.
- Settings: allow selling below cost, allow negative stock, hide out-of-stock in POS; disable products.
- Danger zone: wipe the tenant's transactions, stock, products and/or customers & suppliers (local + cloud).

### 1.3.0 — Data import wizard (2026-09-28)
Plan: [2026-09-28-import-wizard.md](docs/plans/2026-09-28-import-wizard.md)
- Import products, customers and suppliers from Excel/CSV with a downloadable template, dry-run preview,
  row-level errors, re-runnable (updates instead of duplicating).

### 1.2.x — Professional upgrade (2026-09-28)
Plans: [pro-upgrade](docs/plans/2026-09-28-pro-upgrade.md),
[store-credit-and-levels](docs/plans/2026-09-28-store-credit-and-levels.md),
[page-agent-brief](docs/plans/page-agent-brief.md) · Notes: [RELEASE-1.2.0.md](docs/RELEASE-1.2.0.md)
- **1.2.1** — Full Arabic / French coverage (UI, dates, enums, logs, server errors, receipts); Walk-in customer
  shown in the active language.
- **1.2.0**
  - Price tiers (retail / wholesale / super-wholesale), customer price levels and credit limits, bulk price update.
  - Weighted-average costing, cost snapshot per invoice line, historically correct COGS / profit.
  - Edit current and settled invoices in place, with reason + audit history.
  - Refund screen; refunds pay back what was actually charged; store credit ("From account balance").
  - Optional price levels (single retail price for cafés / restaurants).
  - Reports: KPIs, P&L, trend, by product/category/customer/supplier/cashier/payment, inventory valuation,
    low stock, slow movers, aging, Excel/PDF/print export.
  - Stock adjustments with reasons and per-product movement ledger.
  - New design system, grouped sidebar, data tables, drawers, toasts, dark mode, RTL, bundled offline fonts.

### 1.1.x — Stabilization, cloud sync, printing (2026-07-10 → 2026-09-25)
- **1.1.15 – 1.1.19** — Customer selector kept on header, invoice item preview, register stays open across days;
  customer address field + edit customers from POS; address on receipts; correct Arabic on thermal printers
  (optional Arabic code-page mode); white-screen fix on launch.
- **1.1.12 – 1.1.14** — POS header collapses into a menu on narrow screens; silent print failures and receipt
  footer bleed fixed; hardcoded LBP rate removed from Cash Flow, Invoices and Settlement.
- **1.1.9 – 1.1.11** — Main window fits the display; settlement visibility, receipt branding, transaction
  validation; larger touch category buttons; cash flow / settlement day-boundary, opening balance carry-forward
  and archive-on-settlement fixes.
- **1.1.8** — Recovered and protected customer balances lost to settlement-archived transactions.
- **1.1.5 – 1.1.7** — Derived stakeholder balances; online credit sales and invoice edit fixes; cloud sync fixes
  (cross-tenant ids, resilient per-row push).
- **1.1.3 – 1.1.4** — Settlement, live monitor, number inputs, PIN entry, currency fixes; manual "Check for
  Updates" button.
- **1.1.1 – 1.1.2** — Secure cloud reconnect; native modules built for Electron ABI.
- **1.1.0** — Cloud auth security fixes, emergency online sales, ESC/POS printing; Super Admin license
  management in Live Monitor (web).

### Foundation — initial build (2026-07-09)
From the original [task.md](task.md):
- Security: SQLite session store, secrets moved to `.env`.
- Refactor: `server/` modules and routes; Dashboard split into pages; POS split into Cart / ProductGrid /
  PaymentModal.
- POS: credit-customer payment button, end-of-day settlement resets register totals and numbering,
  frameless Electron window with custom controls.
- Multi-terminal: per-terminal numbering (`terminal_id-terminal_sequence`), UDP discovery beacon,
  host/client setup screen.
