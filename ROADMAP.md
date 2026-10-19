# OmniPOS Roadmap

Single place to see what has shipped and what is still open. Update it in the same commit as each release
(add a section under **Shipped**) and whenever a new idea or follow-up comes up (add it under **To do**).

Feature design docs live in [docs/plans/](docs/plans/); release notes for 1.2.0 in
[docs/RELEASE-1.2.0.md](docs/RELEASE-1.2.0.md). Every version below has a matching `vX.Y.Z` git tag.

---

## To do

Commerce & supply-chain track, from
[OmniPOS_Marketplace_Supply_Chain_Master_Blueprint.md](OmniPOS_Marketplace_Supply_Chain_Master_Blueprint.md) §34.
Each feature gets its own Spec Kit folder under `specs/` (spec → plan → tasks → implement).

| # | Item | Spec | Status |
|---|------|------|--------|
| 001 | Commerce domain foundation (relationships, orders, shipments, receipts, posting rules — no storefront) | [spec](specs/001-commerce-domain-foundation/spec.md) · [plan A](specs/001-commerce-domain-foundation/plan.md) | **Slice A implemented** on branch `001-commerce-domain-foundation` (not merged; [validation](specs/001-commerce-domain-foundation/validation.md)): commerce on/off, store + web address, listings, store.* permissions, sync, public catalog functions. Slice B (relationships, orders, posting) not planned |
| 002 | Tenant online store (activation, slug, branding, product publishing) | [spec](specs/002-tenant-online-store/spec.md) · [plan](specs/002-tenant-online-store/plan.md) · [validation](specs/002-tenant-online-store/validation.md) | **Implemented** on branch `002-tenant-online-store` (on top of 001, not merged; 44/44 tasks): server-rendered storefront (`storefront/`, own Render web service, edge-cached), store home / product pages, WhatsApp-phone-email contact, en/ar/fr + RTL, up to 4 photos + logo/cover, owner preview, Wholesale stores never public. Cloud migration applied 2026-10-19; **deployed** 2026-10-19 at `myomnipos.com` (Render, from this branch; live test store checked). Before merge: customer-DB dry run |
| 003 | B2C retail ordering (cart, checkout, sales order, pickup/delivery) | [spec](specs/003-retail-ordering/spec.md) · [plan S1](specs/003-retail-ordering/plan.md) · [tasks S1](specs/003-retail-ordering/tasks.md) · [validation](specs/003-retail-ordering/validation.md) | **Slice 1 merged** to `main` 2026-10-20 (PR #3, 37/37 tasks) and the **storefront deployed** (Render, from `main`): browser-only cart on the storefront (pages still cached per URL), checkout → pre-filled WhatsApp message to the shop in its language, nothing stored; back office: Ordering card (WhatsApp mode, pickup/delivery notes, minimum order) and orderable units as unit keys (startup conversion of local ids). Cloud migration applied 2026-10-20. Ordering stays off until a shop turns it on, which needs the next desktop release. Pending: desktop release, real-phone check. Slice 2 (online orders → back office → POS sale) outlined in the plan, not planned in detail |
| 004 | Business-to-business relationships (request, approve, terms) | | Not started |
| 005 | B2B wholesale storefront (customer pricing, units, minimums, reorder) | | Not started |
| 006 | B2B order confirmation & fulfillment (partial, backorder, cancel) | | Not started |
| 007 | Goods receiving & inventory integration | | Not started |
| 008 | Commerce accounting integration (invoices, payments, allocation, aging) | | Not started |
| 009 | Supply-chain commerce (manufacturer → importer → distributor → wholesaler → retailer) | | Not started |
| 010 | Delivery & fulfillment (drivers, zones, fees, proof of delivery) | | Not started |
| 011 | OmniPOS marketplace (business/product discovery) | | Not started |
| 012 | Shop-owned custom domains for online stores (DNS record, verification, automatic HTTPS) | | Not started — split out of 002 on 2026-10-18 |

Other items: _(add fixes and ideas here)_
- [x] Cloud migration (commerce) `2026-10-18_commerce_store_foundation.sql` applied 2026-10-18 and verified read-only
      (tables, RLS with no anon policy, slug index, sync triggers, 6 functions with the intended grants, allow-list clean).
- [ ] Commerce before release: upgrade dry run (`scripts/commerce-dryrun.ts`) on a copy of a real customer database with
      settled days.
- [x] Cloud migrations (002) `2026-10-19_storefront.sql` + `2026-10-19b_storefront_storage.sql` applied 2026-10-19 and verified
      read-only (all 9 functions with the intended grants, Wholesale gate, allow-list clean, preview-token table closed,
      `store-images` bucket public / 2 MB / WebP, 3 owner-only storage policies, new reserved list).
- [x] 002 deployment (2026-10-19): Render web service `omnipos-storefront` from `render.yaml` (branch
      `002-tenant-online-store`, Starter, Frankfurt, edge caching "All files"); `myomnipos.com` bought at Hostinger,
      apex + wildcard Let's Encrypt certificates issued; redirects, headers and edge cache checked (validation.md).
- [ ] 002 live store check: a register on these branches signed into a **test** business opens a store → store and
      product pages, WhatsApp preview, pause, owner preview (quickstart §3–4). Then switch the Render service to
      `main` after the merge.
- [ ] 002 storefront: stock online lags the registers (≈ 60 s online, longer offline) — label it as indicative and
      re-check at order time (003). Supabase is already over the Free-plan egress quota: serve the catalog from the
      storefront with ~60 s edge caching per store/page, and long cache headers or a CDN for images.
- [x] 003 ordering: `store_listings.orderable_unit_ids` now holds unit keys ("base" / unit global id), the same on
      every register and in the cloud; legacy local ids are converted at startup (003 Slice 1, research R5).
- [x] Cloud migration (003 Slice 1) `2026-10-21_retail_ordering_s1.sql` applied 2026-10-20 and verified read-only
      (new columns, grants: public functions anon-callable, helpers internal, allow-list clean); the live storefront
      (pre-003 code) still renders the test store. Don't re-run `2026-10-19_storefront.sql` after it.
- [ ] 003 Slice 1 before release: send a 50-line Arabic cart on Android, iPhone and WhatsApp Web (validation.md §3).
- [ ] Statement: legacy balance payments (before 1.7.3) are matched from cash_flow by counterparty name; renamed or
      duplicate-name parties fall into the "Opening balance & earlier adjustments" line.
- [ ] Checkout (PaymentModal) product search: add the arrow-key selection the cart search has.
- [ ] Sync: product deletes are hard deletes locally, so they never reach the cloud.

**Housekeeping**
- [ ] [task.md](task.md) is the original July 2026 improvement plan (all items done, folded into "Foundation" below) —
      keep as history or delete.
- [ ] 1.6.2 and 1.7.x shipped without plan docs; their scope is recorded here only.
---

## Shipped

### 1.9.0 — Online store (2026-10-20)
Specs: [001](specs/001-commerce-domain-foundation/spec.md) Slice A · [002](specs/002-tenant-online-store/spec.md) ·
[003](specs/003-retail-ordering/spec.md) Slice 1. Cloud migrations 2026-10-18, 2026-10-19(b) and 2026-10-21 applied.
- **Online store (off by default):** Settings → Online store turns commerce on, creates the store (Retail / Hybrid;
  Wholesale can't be public), claims its address `<address>.myomnipos.com`, opens / pauses it, branding (logo, cover,
  colour), contact details, display settings, owner preview of a draft or paused store. Permissions store.view /
  manage / publish (admin by default).
- **Products online:** product editor "Online store" tab — publish, online title / description / category / order, up to
  4 photos (resized to WebP before upload; needs internet), orderable units and minimum quantity; bulk publish in
  Products. Price, units and stock always come from the product.
- **Public storefront** (separate web service, edge-cached): store and product pages in en / ar / fr with RTL, USD +
  local prices, indicative stock, WhatsApp / call / email buttons, link previews.
- **Order on WhatsApp:** when a shop turns it on (Settings → Online store → Ordering: pickup / delivery notes, minimum
  order), visitors fill a cart on the storefront and send it as a pre-filled WhatsApp message to the shop; payment on
  pickup or delivery; nothing about visitors or orders is stored.
- Upgrade: stores, listings and settings sync like products; listing orderable units switch from register-local ids to
  unit keys once at startup.

### 1.7.x — Cash-flow categories, POS layout, shift vs day, balance history (2026-09-29 → 2026-10-07)
- **1.7.9** (2026-10-08) — Fixes the duplicated invoices / wrong balances after 1.7.8: its one-time full
  re-download brought back day-settled invoices, cash movements and a shift whose cloud delete had failed while the
  session was dead (archived copies had new global_ids). Settlement now keeps global_ids in the archive and writes
  local `sync_tombstones`; pulls never re-insert tombstoned rows (or children of unknown parents — deferred, cursor
  held); failed cloud deletes are retried by the sync engine. One-time startup repair (`server/repair179.ts`, backup
  first) removes re-downloaded settled rows (exact match vs the archive), merges duplicate Admin / USD / Walk-in
  (created by a test login on another PC) and recomputes balances. Currencies, users and customers are soft-deleted
  (deletes now reach the cloud and stick); a new device seeds Admin/USD/Walk-in only after the first pull. POS: a
  sale priced in LBP is recorded from the LBP prices (no 0.01–0.02 residue on Walk-in), sub-cent remainders count as
  paid (same 0.01 rule as checkout and invoice status, statement folds them into the payment), LBP amount can exceed
  the total and change is shown in LBP, cart line prices 2× bigger, Walk-in found by name (not id 1), refunds and
  purchases carry the terminal name (no more "MAIN" numbering).
- **1.7.8** (2026-10-07) — Lighter, safer sync (Supabase egress ~9× lower): hot tables pulled every 60 s, cold every
  5 min (was all 16 tables every 10 s); push only when local rows are pending; child tables in one tenant-scoped
  request; keyset paging (pulls were silently truncated at 1000 rows); pulled rows no longer echoed back (fixes the
  stakeholder push ping-pong); pending local edits never overwritten by a pull; server-time `synced_at` pull cursor
  so late/offline backlogs reach every register (migration `2026-10-07_synced_at.sql`, safe on >= 1.7.6; one-time
  full re-download per register heals rows missed earlier); Live Monitor refetches on tab focus.
- **1.7.7** (2026-10-07) — Cloud sync stopped on every register from 2026-10-05 (~27 h): the Supabase session died
  (`refresh_token_already_used` / `refresh_token_not_found`) and sync skipped silently. Fixes: single-flight
  session rehydration (concurrent refreshes looked like token reuse); rotated refresh tokens persisted in the
  local `cloud_session` table; sign-out uses scope `local` on registers and the Live Monitor (the default
  `global` signed the shared business account out everywhere); replaced clients are stopped; a dead session is
  never retried and shows a "Cloud sync stopped" banner with a password-only reconnect for the current business
  (`POST /api/auth/cloud-reconnect`, `GET /api/sync/status`).
- **1.7.6** (2026-10-06)
  - POS order history: totals in USD and the local currency; order preview (lines, totals, payments in their own
    currency, refunds) with Print Receipt / Process Refund in the preview; arrow-key navigation.
  - Sale-time exchange rate: `transactions.local_rate/local_currency` frozen at creation (kept through settlement
    and invoice edits); the printed receipt shows the local-currency total.
  - Per-party exchange rate: `stakeholders.local_rate` overrides the global rate for converting local-currency
    payments and for invoices entered in the local currency (not product LBP prices; refunds keep the original
    rate; walk-in uses the global rate). Enforced server-side (`server/localCurrency.ts`); party page, badge,
    import column.
  - Sync: pull ignores cloud columns the local DB lacks; optional cloud columns are pushed only once the cloud has
    them, with automatic backfill (cloud migration pending — see To do).
- **1.7.5** (2026-10-06) — Cloud sync: products with fractional stock (kg/g, fractional unit factors) failed to
  push because `products.stock` / `reorder_point` / `units_per_package` were INTEGER in the cloud. Migration
  `2026-10-06_products_stock_numeric.sql` makes them NUMERIC (applied 2026-10-06); the push rounds these
  quantities to 6 decimals to drop floating-point noise.
- **1.7.4** (2026-10-06) — Cloud sync fix: extra product barcodes are soft-deleted and keep their global_id
  across saves (`server/barcodes.ts`). The old delete-and-reinsert made every barcode push fail on the cloud's
  UNIQUE(barcode) and retry every 10 s (~1.2M failing requests/day, project overloaded). Sync now runs one cycle
  at a time, backs off on tables that keep failing, and retires older live cloud barcode duplicates (soft
  delete). Cloud migration `2026-10-06_product_barcodes_soft_delete.sql`: step 1 applied 2026-10-06; step 2
  (duplicate cleanup) re-runnable until every register is on 1.7.4.
- **1.7.3** (2026-10-06)
  - POS: Balance Payment button in the header menu; Collect lists customers only, Pay lists suppliers only.
  - POS: barcodes sharing a prefix add the exact product; search shows up to 50 scrollable results with
    arrow-key selection; F-key shortcuts paused while a popup is open.
  - POS cart and new purchase table scroll to the last added item; tall popups scroll with buttons always visible.
  - Balance history: local-only `stakeholder_balance_log` records every balance change (before/after, source,
    reference, user); "Balance history" tab on each party and section on the statement report.
  - Statement rebuilt (`server/statement.ts`): balance payments, opening balances, manual edits, refund payouts;
    LBP payments converted to USD and shown in LL; closing balance always equals the party balance.
  - Money inputs accept at most 2 decimals (USD and LBP).
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
