# OmniPOS growth backlog — financial analysis, decision engines, AI (2026-11-26)

Goal: make OmniPOS "the CFO for small dual-currency shops": turn the sales, costs, cash, suppliers and customers the
POS already holds into daily decisions the owner can act on. Ideas come from reviewing OmniPulse OR on Quick Market's
real data (tenant `9c5a82d2-b9f3-4e94-ba29-df7b24ac0f0d`): drawer-only cash (~$77), ~$3,110 owed to suppliers and
invisible to OR, supplier invoices paid later through Cash Flow -> Balance Payment, 294 negative-stock products,
sales ~$150-200/day vs ~$1,150/month fixed bills.

**How to start a task:** open a new Claude Code session in this repo and paste the task's brief (the block under
"Brief"). Each brief is self-contained. Order below is the recommended build order.

House rules for every task (read before starting):
- Money is USD-based with an optional local currency (LBP); line prices are stored in USD per base piece
  (memory: currency model). Balances are derived (`server/balance.ts`); never store a balance you can compute.
- Sync: new synced tables need `server/sync.ts` PUSH/PULL lists + `fkMap`, a Supabase migration in
  `supabase/migrations/` with RLS (`tenant_id = auth.uid()`), the `set_synced_at` trigger, and the table name added
  to `sync_changed_tables`' `tenant_tables` list (else it is pulled every cycle). The Supabase MCP is read-only:
  write the migration file; the user runs it.
- OmniPulse OR rules: `memory/omnipulse-or.md` (stable global ids, derived reserves, no local integer ids synced).
- UI strings through `t()` with en/ar/fr entries; design-system components in `src/components/ui`.
- Tests in `tests/*.test.ts`, run with `npm test` (handles the better-sqlite3 ABI switch). Commit on a feature
  branch; don't push or release (the lead session versions and publishes).
- Prefer MIT/Apache/BSD libraries. GPL projects (Beancount/Fava, hledger, GnuCash, ERPNext) are design references
  only. Python-only libraries go behind the optional cloud solver slot (`OR_SOLVER_URL`,
  `server/or/solver/orToolsCloudAdapter.ts`), never required for the app to work offline.

---

## 1. Payables & receivables in OmniPulse OR  (priority 1)

Why: unpaid purchases only reach the optimizer (supplier debt / credit limit). Free spendable cash, runway, survival
mode and the briefing ignore them, so a shop owing $3,110 looks healthier than it is; money customers owe isn't
counted as coming in either.

Brief:
> Bring accounts payable and receivable into OmniPulse OR. (1) Supplier payment terms: add `payment_terms_days` to
> `or_supplier_profiles` (synced, cloud migration) editable in OR -> Settings & Presets per supplier, default 0 =
> due on delivery. (2) Due dates per open purchase invoice from its date + terms, using the open-invoice FIFO
> allocation in `server/invoiceSettlement.ts` / `buildOpenStatement` (`server/statement.ts`) so balance payments
> made later are respected. (3) Spendable cash: reserve payables due within the next 7 days (configurable) like
> bills (`server/or/spendableCash.ts`), and show "Owed to suppliers" and "Customers owe you" cards with 0-30 /
> 31-60 / 60+ day aging. (4) Briefing items: overdue supplier invoices, payables due this week, top customers to
> chase (with phone). (5) Survival mode accounts for payables due inside the runway window. Tests for allocation,
> aging buckets, reserve and briefing items. Done = OR's cash health and briefing reflect money owed both ways.

## 2. 13-week cash forecast  (priority 1)

Why: the standard treasury tool; answers "will I have cash for rent on the 7th?".

Brief:
> Add a 13-week (91-day) day-by-day cash forecast to OmniPulse OR (new tab "Cash Forecast"). Starting balance =
> spendable cash accounts. Inflows: forecast daily sales cash (average by weekday over the last 8 weeks, times the
> cash share of payments) + expected customer collections (open receivables by age, with a collection-probability
> haircut per bucket). Outflows: fixed obligations on their due dates (`or_fixed_obligations`), payables by due date
> (task 1 if present, else open purchases spread over 30 days), locked POs on their delivery dates, average owner
> draws. Show a line chart (follow the dataviz rules: one chart, the float as a reference line), the lowest-balance
> day, and the first day the balance drops below the minimum drawer float, with a briefing warning when that is
> within 14 days. Pure TypeScript, offline. Tests for the projection math on fixture data. Done = the owner sees
> when cash will run short and why.

## 3. Supplier invoice photo -> purchase invoice (AI)  (priority 1)

Why: shops pay suppliers but don't enter purchases item by item, so stock goes negative and every analysis that
uses stock is wrong. Taking a photo is fast enough to become a habit.

Brief:
> In Purchases -> New purchase invoice, add "Scan supplier invoice": take/upload a photo or PDF, send it to the
> Claude API (vision; model per the claude-api skill, key in settings, never hard-coded), extract supplier name,
> invoice number, date, currency, lines (name, quantity, unit, unit price) and totals as structured JSON. Match
> lines to products by barcode/name (fuzzy, Arabic-aware), let the user confirm or pick products for unmatched
> lines, then fill the normal InvoiceEditor (`src/pages/invoices/InvoiceEditor.tsx`) so saving uses the existing
> POST /api/transactions purchase path (stock, weighted cost, supplier balance). Remember the supplier's item-name ->
> product mapping for next time. Works only online; clear error offline. Tests with mocked API responses for
> matching and mapping memory. Done = a photographed invoice becomes a correct purchase in under a minute.

## 4. Real profit & break-even  (priority 2)

Brief:
> Add a monthly/daily profit view (Reports or OR): revenue, cost of goods (line `unit_cost`), gross margin, expenses
> by cash-flow category, owner draws, net profit; and break-even: "you need $X sales/day to cover your bills" =
> monthly fixed obligations / gross-margin %. Show this month vs last month and the break-even line on the daily
> sales chart. Service items without cost count full price as margin (their cost is an obligation). Tests on
> fixture data. Done = the owner knows whether the shop makes money and the daily sales target.

## 5. Margin erosion alerts  (priority 2)

Brief:
> When a purchase invoice raises a product's cost (weighted average, `server/costing.ts`) so its margin at the
> current selling price drops below a category target (setting, default 20%) or falls by more than 5 points, add an
> OR briefing item "Snips chips: margin 25% -> 12% (cost $0.42 -> $0.47). Suggested price $X" and a list page of
> products under target. Include LBP price checks: flag items whose `price_lbp` at today's rate no longer covers
> cost. Tests. Done = no product silently sells below target margin after a supplier price rise.

## 6. Cash tied up in stock & dead stock  (priority 2)

Brief:
> Add an Inventory health view: stock value at cost, value by category/supplier, dead stock (tracked items with
> stock > 0 and no sale in 60/90 days) with value, inventory turns and GMROI per category, and items with negative
> stock grouped by likely cause (sold but never purchased). Suggest actions: discount/bundle dead stock (link to
> bundle creation), count negatives (queue in the cycle count). Tests. Done = the owner sees how much money sits on
> shelves and what to do about it.

## 7. Supplier scorecard  (priority 3)

Brief:
> Per supplier: price trend per product from purchase lines, cheapest supplier per product (for products bought from
> several), fill rate (`or_supplier_profiles.fill_rate_score`), payment terms (task 1), on-time delivery vs PO
> expected date, and total bought / owed. Show in Suppliers -> supplier detail and an OR "Suppliers" tab; the
> optimizer prefers the cheapest reliable supplier when a product has several. Tests. Done = buying decisions use
> supplier history.

## 8. Exchange-rate (LBP) alerts  (priority 3)

Brief:
> When the tenant's LBP rate changes (or a party rate), list products whose LBP price no longer reflects USD price at
> the new rate within a tolerance, with a one-click "update LBP prices" using the existing rounding rules; show the
> share of sales collected in LBP vs costs in USD for the last 30 days. Tests. Done = rate moves never leave stale
> LBP prices.

## 9. Seasonal demand forecast  (priority 3)

Brief:
> Replace the 7/14/30-day weighted velocity in `server/or/pipeline.ts` with a forecast that captures weekday
> seasonality and monthly salary-day peaks (Holt-Winters / seasonal naive in TypeScript; optionally Nixtla
> StatsForecast (Apache-2.0) behind `OR_SOLVER_URL`). Holiday/Ramadan multipliers as a tenant setting. Feed
> forecast demand and its error into safety stock and the optimizer. Backtest on the last 8 weeks and show forecast
> accuracy per ABC class. Tests. Done = reorder quantities follow the shop's weekly rhythm.

## 10. "Frequently bought together" -> bundle suggestions  (priority 2, builds on 1.13.5 bundles)

Brief:
> Mine the last 90 days of sale transactions for product pairs/triples bought together (apriori / FP-growth in
> TypeScript; support, confidence, lift). Show an OR "Bundle ideas" list: products, how often bought together,
> combined regular price, suggested bundle price for a target margin, and a "Create bundle" button that opens the
> product editor pre-filled as a bundle (`src/pages/products/ProductEditorDrawer.tsx`, `BundleCard`). Prefer
> including slow movers with fast movers to clear dead stock (task 6). Tests on fixture baskets. Done = bundle
> creation is data-driven.

## 11. Price suggestions  (priority 4)

Brief:
> Estimate price sensitivity per product/category from price changes and sales history (log-log regression where
> there is enough variation; otherwise category targets). Suggest prices to reach target margin without losing
> volume; show expected profit impact; respect LBP rounding. Advisory only, owner applies. Tests. Done = pricing
> decisions have numbers behind them.

## 12. Cashier risk alerts  (priority 3)

Brief:
> Per cashier and shift: voids, refunds, manual discounts, price overrides, cash differences at close, no-sale
> drawer opens if logged. Flag outliers vs the cashier's own history and vs other cashiers (simple z-score / median
> absolute deviation; PyOD (BSD) optional in the cloud slot). OR briefing item + a per-cashier page. Permission:
> admin only. Tests. Done = unusual cashier activity is visible the next morning.

## 13. "Ask your shop" assistant (AI)  (priority 4)

Brief:
> Add an assistant panel (Arabic/English/French) that answers questions about the shop's own data ("how much did I
> make this week?", "which supplier raised prices?") using the Claude API with tool calls onto a small set of
> read-only, tenant-scoped server functions (sales summary, product lookup, supplier prices, balances, OR metrics)
> — never raw SQL from the model. Show the numbers it used. Admin/manager only, online only. Tests for the tools
> and permission scoping. Done = the owner can ask questions instead of reading reports.

## 14. Daily WhatsApp summary in Arabic  (priority 2)

Brief:
> Each morning (after the OR pipeline) build a short owner summary: yesterday's sales and profit, cash on hand,
> bills/payables due this week, top 3 reorder items, customers to chase, and any alerts (tasks 1, 4, 5, 12). Send
> it to the owner's WhatsApp number (setting) via the existing WhatsApp integration if available, else show it as
> a shareable text in OR with a "Send via WhatsApp" link. Arabic default, en/fr selectable. Tests for the summary
> builder. Done = the owner gets the key numbers without opening the app.

---

Open-source references: Nixtla StatsForecast (Apache-2.0), Prophet (MIT), statsmodels (BSD), Google OR-Tools
(Apache-2.0), HiGHS (MIT, already used), stockpyl (MIT, inventory policies), mlxtend (BSD, apriori), PyOD (BSD);
design references only: Beancount + Fava, hledger, GnuCash, ERPNext (GPL).
