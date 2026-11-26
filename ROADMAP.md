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
| 003 | B2C retail ordering (cart, checkout, sales order, pickup/delivery) | [spec](specs/003-retail-ordering/spec.md) · [plan S1](specs/003-retail-ordering/plan.md) · [tasks S1](specs/003-retail-ordering/tasks.md) · [validation](specs/003-retail-ordering/validation.md) | **Slice 1 merged** to `main` 2026-10-20 (PR #3, 37/37 tasks) and the **storefront deployed** (Render, from `main`): browser-only cart on the storefront (pages still cached per URL), checkout → pre-filled WhatsApp message to the shop in its language, nothing stored; back office: Ordering card (WhatsApp mode, pickup/delivery notes, minimum order) and orderable units as unit keys (startup conversion of local ids). Cloud migration applied 2026-10-20. Ordering stays off until a shop turns it on, which needs the next desktop release. Pending: desktop release, real-phone check. **Slice 2** (online orders → back office → POS sale) **merged** 2026-10-27 (PR #5, fixes PR #6) and released in **1.10.0** (54/54 tasks, [plan S2](specs/003-retail-ordering/plan-s2.md) · [tasks S2](specs/003-retail-ordering/tasks-s2.md)): storefront review → place order → status page and My orders, cancel while New; registers get the orders within 30 s (toast, tone, badge), accept with per-line changes, reject, ready, cancel (first action wins, online only); Complete sale in the POS turns an order into an ordinary sale, cloud-first (one sale per order); per-store expiry hours and blocked phones. Cloud migration applied and gateway key set 2026-10-23; storefront deployed, first live order on the test store passed. Pending: the rest of the end-to-end check (second register, reject, expiry, limits, End of Day) |
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
- [x] Commerce before release: upgrade dry run (`scripts/commerce-dryrun.ts`, v1.9.0 code) on a copy of a real customer
      database (3 tenants, 44 products, 32 parties, 39 open + 106 settled invoices, 10 day closings, no commerce tables
      yet) on 2026-10-20: all 98 measured values unchanged (counts, stock, invoice totals, payments, 32 balances).
- [x] Startup log noise (since 1.7.7): the sync-metadata loop in `server/db.ts` tried `ADD COLUMN created_at ... DEFAULT
      CURRENT_TIMESTAMP` on `_migrations` and `cloud_session` at every start and logged "Cannot add a column with
      non-constant default". Fixed 2026-10-22 (branch `fix/1.9.1-small-fixes`): local-only tables are skipped.
- [x] Cloud migrations (002) `2026-10-19_storefront.sql` + `2026-10-19b_storefront_storage.sql` applied 2026-10-19 and verified
      read-only (all 9 functions with the intended grants, Wholesale gate, allow-list clean, preview-token table closed,
      `store-images` bucket public / 2 MB / WebP, 3 owner-only storage policies, new reserved list).
- [x] 002 deployment (2026-10-19): Render web service `omnipos-storefront` from `render.yaml` (branch
      `002-tenant-online-store`, Starter, Frankfurt, edge caching "All files"); `myomnipos.com` bought at Hostinger,
      apex + wildcard Let's Encrypt certificates issued; redirects, headers and edge cache checked (validation.md).
- [x] Storefront moved from Render to the Contabo VPS (2026-11-12): Coolify application (Base Directory `/storefront`)
      behind Cloudflare (zone `myomnipos.com`, tunnel `contabo-vps`, SSL Flexible, cache rule); `render.yaml` removed,
      wildcard route in `storefront/deploy/omnipos-wildcard.yaml`; live check on the test store: quote, order W-1007
      placed and cancelled, `cf-cache-status: HIT`, `network source: cf-connecting-ip`. Setup: storefront/README.md.
      Open: GitHub webhook for auto-deploy; delete the old Render service.
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
- [x] 003 Slice 2 owner setup (2026-10-23): migration `2026-10-23_retail_ordering_s2.sql` applied and its checks
      verified read-only; gateway key generated, only its hash in `storefront_gateway_keys`; `ORDER_GATEWAY_KEY` set
      on Render (takes effect at the next deploy).
- [x] 003 Slice 2: merged to `main` (PR #5) and deployed; the Render log reports `network source: CF-Connecting-IP`.
      First live order on the test store (2026-10-27): placed, seen by the register in ≈ 10 s, accepted, completed as
      a POS sale; two fixes from it (reply lines dropped by the register; dev watcher reloading on database writes).
- [x] 003 Slice 2: desktop release — 1.10.0 published 2026-10-27; checked live on the installed app (validation.md §4).
- [ ] Rollout: registers on 1.10.0 or older don't offer updates by themselves (fixed in 1.10.1). Ask shops to run
      back office → Settings → Updates → Check for updates once to reach 1.10.1.
- [ ] 003 Slice 2: quickstart-s2 §4 on a **test** business with two registers; record the notification and status
      timings in validation.md.
- [ ] Statement: legacy balance payments (before 1.7.3) are matched from cash_flow by counterparty name; renamed or
      duplicate-name parties fall into the "Opening balance & earlier adjustments" line.
- [x] Checkout (PaymentModal) product search: closed 2026-10-22, nothing to fix. The only product search in
      PaymentModal is an old "price checker" overlay that nothing opens (`isPriceChecker` is never set to true); the
      real Price Checker window (`src/PriceChecker.tsx`) is barcode-only. Housekeeping: remove that dead overlay.
- [x] Sync: product deletes never reached the cloud (local hard delete), so other registers kept the product and its
      online listing stayed visible. Fixed 2026-10-22 (branch `fix/1.9.1-small-fixes`): the delete leaves a
      `products` tombstone and the sync soft-deletes the cloud row (sales still reference it); other registers delete
      it locally on pull and never re-insert it; the storefront already hides products with `deleted_at`. Listings
      stay ("product deleted" in the back office). No cloud migration. Known gap: a register that edits the product
      offline and pushes before pulling the deletion clears the cloud `deleted_at` again. Products deleted before
      the fix stay live in the cloud.
- [x] Cloud migration (OmniPulse OR) `supabase/migrations/2026-11-24_omnipulse_or.sql` applied 2026-11-25 (14 synced
      `or_*` tables with RLS + `or_license_type`/`or_license_expiry` on `tenants` + updated `admin_update_tenant_license`
      RPC); Web Monitor / Super Admin deployed to Vercel (`omnipos-monitor.vercel.app`).
- [x] Cloud migration `supabase/migrations/2026-11-25_omnipulse_or_fixes.sql` applied 2026-11-25 (set_synced_at triggers +
      indexes on the 14 `or_*` tables, `or_owner_draws.core_cash_global_id`, old 5-arg `admin_update_tenant_license`
      dropped, `trg_tenants_guard_protected` blocks tenants from editing their own email/license columns).
- [x] Cloud migration `supabase/migrations/2026-11-25b_sync_changed_tables.sql` applied 2026-11-25 (`sync_changed_tables`
      RPC used by 1.13.3 registers; older registers keep polling every table until updated).
- [x] Cloud migration `supabase/migrations/2026-11-25c_sync_changed_tables_exact.sql` applied 2026-11-25 (exact keyset
      cursors; 1.13.3 overlap-string cursors are corrected server-side).
- [x] Cloud migrations applied 2026-11-26: `2026-11-26_or_owner_stakeholder.sql` (or_tenant_config.owner_stakeholder_id),
      `2026-11-26b_users_active.sql` (users.active), `2026-11-26_product_bundles.sql` (products.is_bundle,
      product_bundle_items, transaction_items bundle_* columns, sync_changed_tables knows product_bundle_items).
- [ ] OmniPulse OR future: Restaurant recipe/BOM deduction (`enable_recipe_deduction`) once a Recipes module exists, and
      optional Python Google OR-Tools cloud microservice (`OR_SOLVER_URL`) for VRP/shift scheduling via
      `server/or/solver/orToolsCloudAdapter.ts`.

**Housekeeping**
- [ ] [task.md](task.md) is the original July 2026 improvement plan (all items done, folded into "Foundation" below) —
      keep as history or delete.
- [ ] 1.6.2 and 1.7.x shipped without plan docs; their scope is recorded here only.
---

## Shipped

### 1.13.6 — Real app version in Settings (2026-11-26)
- Settings -> Updates, the dashboard and the POS update notice showed "v2.5.0" forever: they read
  `tenants.current_version`, a placeholder from the old pre-electron-updater update system (DB default '2.5.0').
  The app now reports its real version from package.json (`server/appVersion.ts`); the legacy
  `available_version` prompt is retired, and each register writes its version to its cloud tenant row at sign-in so
  the Live Monitor / Super Admin show which version each shop runs.

### 1.13.5 — Product bundles, disable users, OR on real data, logo (2026-11-26)
- **Product bundles:** a product flagged as a bundle (own barcode, price, photo) made of existing products with
  quantities; sold at the POS like any product and stored as one line per component (stock, unit cost, reports and
  OmniPulse OR keep working), the bundle price split over components by list price; refunds, invoice edit, receipts
  and statements group the bundle; synced via `product_bundle_items`. Design: `docs/superpowers/specs/2026-11-26-product-bundles-design.md`.
- **Disable users** instead of deleting them: disabled users keep their history but can't sign in and leave the
  POS pickers; Users shows a Status column and Disable/Enable (last active admin and yourself are protected).
- **OmniPulse OR on Quick Market data:** runway uses the net daily burn (bills + owner draws - 30-day average gross
  profit), so a shop whose profit covers its bills is no longer in permanent CRISIS; the optimizer orders whole
  supplier packs (box unit, else the shop's usual purchase quantity); the PO cash-lock warning uses the app's dialog.
- **Invoices paid later through Balance Payment show as paid** (oldest invoice first, like the statement) in the
  Purchases and Invoices lists, purchase detail and the invoice report.
- **Logo:** the POS header and dashboard sidebar use the posicon artwork (same as the window / taskbar icon).

### 1.13.4 — Change check uses exact cursors (2026-11-25)
- 1.13.3 sent "cursor minus the 2-minute pull overlap" to `sync_changed_tables`, so the last pulled rows always looked
  new and tables with recent data were pulled every cycle anyway (the overlap re-read was also ~1 row per table per
  poll of avoidable egress). The check now sends exact keyset cursors (synced_at, global_id); the cloud function also
  corrects 1.13.3's strings. A full pull (with the overlap) every 15 minutes still catches late-committed rows.

### 1.13.3 — Lighter sync: Supabase log ingestion & egress (2026-11-25)
- Supabase Free plan log ingestion was at 142% (1.42 / 1 GB): 99% were API-gateway request logs from registers polling
  ~17 endpoints every minute, almost always for nothing.
- A due pull now first calls `sync_changed_tables` (one request with the register's cursors) and fetches only the tables
  with newer rows; idle registers send ~1 request a minute instead of ~17.
- Online-order tables and `orders_sweep` are only polled by tenants that have a store.
- After 10 empty checks in a row the hot pull slows to every 3 minutes; any local change or pulled change restores 60 s.

### 1.13.2 — OmniPulse OR review fixes (2026-11-25)
Review of 1.13.0/1.13.1 by Claude + Codex; every must-fix item and improvement addressed.
- **Stock & cash correctness:** cycle-count approval applies the counted *difference* measured at count time (sales after
  the count are kept); PO receiving requires item lines (amount-only POs go through Purchases with the PO linked), derives
  every total from the delivered lines, validates products/costs/overpayment, uses Core weighted-average cost and
  `track_inventory`, and supports explicit partial deliveries; the OpEx reserve is derived from each obligation's due
  date instead of accumulating forever; SKU revenue no longer divides USD prices by the LBP rate; owner cash draws are
  counted once from `cash_flow` and linked by global id.
- **Purchase invoice ↔ PO link** is opt-in (default "None") with a "last delivery" choice; PARTIALLY_RECEIVED POs can be
  linked; received quantities are tracked on itemized POs.
- **Permissions:** the v4 role-map migration no longer re-grants `orders.*` removed by owners; OR defaults are granted
  once. Blind cycle counts are enforced server-side (`or.manage` only sees system quantities).
- **Sync & multi-register:** deterministic global ids for per-tenant OR rows, the daily cycle count and briefing items;
  pull adopts a local twin by natural key; device-local Core ids (`core_*_tx_id`, `account_id`) are no longer synced;
  briefing items are updated in place / soft-deleted; tenant reset purges OR rows in the cloud too.
- **Optimizer:** HiGHS runs in a worker thread with an 8 s time limit (one solve at a time); "Apply" uses the reviewed
  `plan_id` once, atomically; products with no known supplier are no longer assigned to an arbitrary one.
- **Cloud security:** tenants can no longer change their own email or license columns (is_super_admin trusted the email).

### 1.13.1 — Purchase Invoice ↔ Locked PO link & negative-stock briefing alerts (2026-11-25)
- **Purchase Invoice ↔ PO Cash-Lock link:** `InvoiceEditor` (`Purchases → New Purchase`) detects open `APPROVED_LOCKED`
  POs for the selected supplier and lets staff link & settle the lock atomically inside `POST /api/transactions`
  (`or_po_commitment_id`), updating stock/payments/supplier balance while releasing any unused locked cash with zero
  double counting. Amount-only Receive modal in OmniPulse OR also directs staff to Purchases for itemized receiving.
- **Negative-stock Class A briefing alerts:** Class A items with negative `products.stock` now display a clear
  *Negative stock — physical count & stock adjustment required* alert (instead of negative Days of Supply) and are
  auto-queued into `or_stock_anomalies` for the next 5-minute Cycle Count.

### 1.13.0 — OmniPulse OR paid add-on module & HiGHS WASM MILP optimizer (2026-11-25)
- **Paid add-on licensing & RBAC:** `or_license_type` (`none`/`monthly`/`year`/`lifetime`) + `or_license_expiry` on
  `tenants` (SQLite + Supabase migration `2026-11-24_omnipulse_or.sql`), `requireOrLicense` server gate (`403
  OR_LICENSE_REQUIRED`), locked add-on preview for unlicensed tenants, Super Admin license controls on both desktop
  (`SuperAdminDashboard.tsx`) and web (`SuperAdminWeb.tsx`, deployed to `omnipos-monitor.vercel.app`), and `or.*`
  role permissions (`ROLE_PERMISSIONS_VERSION = 4`).
- **Real Spendable Cash & survival modes:** derived live from `cash_accounts` (Drawer + Savings/Safe + Bank) minus
  `min_drawer_float`, virtual `OPEX_RESERVE` bucket (`or_fixed_obligations` daily accrual), and active PO locks, with
  automatic 14-day runway survival mode switching (`CRISIS` / `RECOVERY` / `GROWTH`) and industry presets
  (`RETAIL`, `RESTAURANT`, `SERVICE`, `HYBRID`).
- **Unified Owner Draws:** aggregates all historical + new Core `cash_flow` / `archived_cash_flow` outflows with
  `category = 'owner_withdrawal'` plus at-cost POS sales to a designated **Business Owner Customer**
  (`or_tenant_config.owner_stakeholder_id`), enforced against daily/monthly survival-mode caps with override logging.
- **PO Cash-Lock & partial receiving:** pre-delivery `or_po_commitments` + `or_po_commitment_items`, cash-collision
  warning on approval, partial/full receiving that creates Core `transactions(type='purchase')`, releases unused locks
  immediately, and tracks supplier `fill_rate_score`.
- **5-Minute Blind Cycle Count & Stock anomalies:** auto-flags negative-stock POS sales, adds a **Shelf Empty** button
  next to **Adjust** on `StockManagement`, hides system quantities during blind counting, routes variances above
  `variance_alert_pct` to owner approval, and posts adjustments to Core `stock_adjustments`.
- **Hybrid Dynamic MILP Optimizer (`server/or/solver/`):** offline-first `HighsWasmAdapter` (`highs` WASM) solving
  tenant-specific cash-constrained restocking, supplier MOQ, cash-vs-credit split, debt paydown, and marginal cash ROI
  shadow prices using recency-weighted 7d/14d/30d demand and ABC safety stock — behind a pluggable `SolverAdapter`
  with `OrToolsCloudAdapter` (`OR_SOLVER_URL`) ready for future cloud OR-Tools models.

### 1.12.0 — Cash accounts & savings, combined Money Out report, Arabic printing & POS/monitor fixes (2026-11-23)
- **Cash accounts & savings:** named accounts (`Cash Drawer` built-in default plus custom Savings / Safe / Bank accounts)
  with derived continuous multi-currency balances that persist across End-of-Day settlements; atomic internal transfers
  (`Drawer ↔ Savings`, zero P&L impact); source account selector on Cash In/Out, balance payments, and cash purchases;
  admin edits on transfers update both linked legs atomically with an audit trail. Cloud migration
  `supabase/migrations/2026-11-23_cash_accounts.sql` is additive and optional until applied.
- **Money Out report & Dashboard KPIs:** combined real-money outflows (direct purchase payments + supplier payments +
  expenses & other cash-flow outs + cash refunds, excluding unpaid credit and internal transfers) on Dashboard Today /
  This Month, Reports → Overview, and a new **Reports → Money Out** tab with category breakdown, account filter, and
  Excel / PDF / Print export.
- **Live Monitor (mobile):** responsive header that truncates long business names, keeps Logout and language controls
  always visible, and stacks the Live Monitor / Make a Sale switcher cleanly on narrow screens.
- **Arabic printing & X-reports:** fixed Arabic text-mode receipt `kv()` / `labeled()` spacing (spaces no longer reversed
  to the wrong side of Arabic labels; CP864 `لإ` fallback); End-of-Day and Cash-Out X-reports now print through the
  configured ESC/POS thermal printer (image-mode and text-mode Arabic) via `POST /api/print/xreport`, falling back to
  silent HTML only when no ESC/POS printer is configured.
- **Receipt & invoice numbers:** receipts print both the permanent invoice number and terminal sequence (`#ID (T1-0005)`);
  Invoices list, detail drawer, and search support both `#ID` and `T1-0005`.
- **Receipt toggles (restaurants):** Settings → Printers toggles to show/hide customer balance (`receipt_show_balance`)
  and payment breakdown (`receipt_show_payments`) on receipts (both on by default).
- **POS category size:** adjustable Category button size (`Small` / `Medium` / `Large`) in the POS layout menu.
- **Purchases LBP cost fix:** applying suggested selling prices after a new purchase now preserves the updated `cost_lbp`
  and updates local-currency selling prices instead of overwriting them with pre-purchase values.

### 1.11.0 — POS fixes: void, LL discounts, loyalty discount, photos, updater (2026-11-13)
- **POS:** "Void Order" button next to Quick Cash / Checkout (clears the whole sale after a confirmation).
- **POS:** a fixed discount (line or whole sale) can be typed in the local currency: 5,000 LL is exactly 5,000 LL.
  The sale discount no longer carries into the next sale; a percentage is capped at 100.
- **Loyalty:** a customer can have a standing discount (%) that the POS applies when the customer is picked; a
  cashier without the discount right may apply exactly that discount. Cloud migration
  `2026-11-13_stakeholder_discount.sql` is needed for it to sync between registers.
- **POS look:** darker sale canvas so cart lines, tiles and search results stand out; one colour per category.
- **POS photos:** Settings → Printers "Show Product Photos in the POS" shows the online-store photo on the catalog
  tile; each register keeps its own copy (offline, not part of sync).
- **Costs:** purchase and product costs keep 6 decimals of USD, so a cost keyed in LL converts back to the same
  LL amount (195,000 stays 195,000).
- **Updater:** "Install Now" in the update popup downloads the update first (with real progress) instead of
  showing "Installing" forever.

### 1.10.4 — POS scan beeps (2026-11-07)
- **POS:** a short high beep when an item goes into the cart (scan, barcode, search pick, "+" on a line) and a low
  double tone whenever a scan or entry is refused (unknown barcode, disabled product, not enough stock, unit change
  over stock, server or network error), so the cashier hears it without looking at the screen.
- **Settings → Printers:** "Beep when scanning" switch (on by default).

### 1.10.3 — Detailed End-of-Day X-report (2026-11-06)
- **X-report:** the End-of-Day report now prints the whole business day: period and report number, sales by payment
  method with counts, refunds and purchases, the cash drawer with cash received per currency, counted cash per
  currency with over/short, each cashier Cash Out, cash in/out by category, and sales by category and by cashier.
- **Accuracy:** the report prints what the settlement saved, not the figures the Settlement page loaded earlier (a
  sale made while the page was open used to be missing from the printout). Reprints from History and the details
  panel print the same full report; older settlements fill the new sections from their archived rows.
- **Printing:** X-reports (End of Day and Cash Out) print straight to the Windows default printer like receipts, with
  no print dialog, and show an error when printing fails.

### 1.10.2 — Quick Market fixes (2026-10-27)
- **Balance payment edits:** editing a customer collection or supplier payment in the cash-flow log now corrects the
  party's balance too (audited in the balance history, settled rows included). Payments recorded before 1.10.2 are
  matched by party name only when exactly one party has it; a wrong payment already on a balance is corrected when
  the admin opens and saves that cash-flow row again.
- **Balance Payment window:** USD and local-currency buttons when a local currency is enabled; the amount's
  equivalent and the party's balance are shown in both currencies.
- **POS:** the payment method goes back to cash after every checkout, and credit is never kept on Walk-in.
- **Purchases:** a purchase (create, edit, delete) now updates the LBP cost with the USD cost, at the global rate.
  A hand-typed LBP cost is overwritten by the next purchase of that product.

### 1.10.1 — Update offer fix (2026-10-27)
- **Updates:** a register now offers a new version once the POS opens. Before, the only check ran 10 s after launch,
  while the lock screen was still up, and its result was lost, so registers never offered an update by themselves.
  Registers on 1.10.0 or older still need one manual check to reach 1.10.1 (back office → Settings → Updates).

### 1.10.0 — Online orders (2026-10-27)
Spec: [003](specs/003-retail-ordering/spec.md) Slice 2 ([plan S2](specs/003-retail-ordering/plan-s2.md) ·
[validation](specs/003-retail-ordering/validation.md)). Cloud migration 2026-10-23 applied; storefront deployed from
`main` (PR #5). Includes the held 1.9.1 fixes (PR #4) and the first-live-order fixes (PR #6).
- **Online orders (off until a shop picks it):** Settings → Online store → Ordering → "Online orders" (needs pickup or
  delivery). Customers review server-priced carts on the storefront, place the order and follow it on a private status
  page and "My orders"; they can cancel while it is New. Per-store expiry hours (1–72, default 24) and blocked phones;
  abuse limits per phone and per network.
- **Registers:** new orders arrive within 30 s with a toast, tone (mutable per register) and badge. The Online orders
  page lets admins and managers accept with per-line quantities and reasons, reject, mark ready or cancel (online
  only; first action wins); other roles view. WhatsApp / call the customer, block their phone.
- **POS sale from an order:** POS → Online orders → Complete sale opens a sale tab pre-filled from the order. The sale is
  an ordinary transaction priced from the order by the server, completed in the cloud first, so one order makes at most
  one sale; refunds, edits and settlement are unchanged.
- **Fixes:** product deletes now reach the cloud and other registers (and drop off the online store); no more
  "non-constant default" log noise at startup; order lines update right after an action (not at the next pull).
- Permissions orders.view / orders.manage (admin + manager manage; cashier, staff and accountant view).

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
