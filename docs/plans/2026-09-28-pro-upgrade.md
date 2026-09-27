# OmniPOS 1.2.0 — Professional Upgrade Plan

Branch: `feature/pro-upgrade-1.2`. Nothing is pushed or published; the release is built locally only
(`electron-builder --win --publish never`).

## Hard constraints (read before touching anything)

1. **Balances are derived** (`server/balance.ts`): `balance = balance_baseline + Σ effect(ACTIVE tx)`.
   Negative = stakeholder owes us. Effect: sale/purchase → `-(total − nonCreditPaidUSD)`, refund → `+(...)`.
   Archived (settled) transactions are NOT in the sum — their effect lives in `balance_baseline`.
   Anything that changes an ARCHIVED transaction must adjust `balance_baseline` by the effect delta.
2. **Settlement** moves `transactions/transaction_items/payments` → `archived_*`. Every new column added to
   a live table must also be added to its archived twin AND copied in the settlement INSERTs, and in
   `TX_LIVE_COLUMNS`/`TX_ARCHIVED_COLUMNS` in `server/routes.ts`.
3. **Sync**: new local columns are safe (push strips columns the cloud lacks; pull UPDATEs only the cloud's
   columns so local-only columns survive). New tables stay LOCAL-ONLY (do not add them to PUSH/PULL lists).
   The cloud migration SQL is written to `supabase/migrations/2026-09-28_pro_upgrade.sql` but NOT applied.
4. Money is stored in USD (`total_amount`, `unit_price`, `unit_cost`); `payments.amount` is in the payment's
   currency — always convert with `amount / exchange_rate`. `method = 'credit'` is not real money.
5. Dates: compare with `date(created_at, 'localtime')` (created_at is UTC). Use `localToday()` for "today".
6. Every query is scoped by `tenant_id`.
7. `npm test` (tests/*.test.ts, node:test via tsx) must stay green. Add tests for every new behavior.

## Schema additions (server/db.ts — done first, by the lead)

| Table | Column | Notes |
|---|---|---|
| products | `price_wholesale`, `price_wholesale_lbp`, `price_super_wholesale`, `price_super_wholesale_lbp` REAL | Tier prices (جملة / جملة الجملة). NULL/0 = not set |
| products | `min_price` REAL | Optional floor (USD) — warn/block selling below |
| stakeholders | `price_level` TEXT DEFAULT 'retail' | `retail`\|`wholesale`\|`super_wholesale` |
| stakeholders | `credit_limit` REAL | NULL/0 = unlimited |
| transactions + archived_transactions | `price_level` TEXT, `notes` TEXT, `reference` TEXT, `edited_at` DATETIME, `edit_count` INTEGER DEFAULT 0 | reference = supplier invoice no / PO ref |
| transaction_items + archived_transaction_items | `unit_cost` REAL | USD cost snapshot at time of the line (COGS) |
| NEW transaction_edits | id, tenant_id, transaction_id, archived, user_id, reason, before_json, after_json, created_at | Local-only audit trail |
| NEW stock_adjustments | id, tenant_id, product_id, user_id, qty_before, qty_after, delta, reason, unit_cost, created_at | Local-only |

One-time guarded migration `unit_cost_backfill_v1`: `unit_cost = products.cost` where NULL (live + archived).

## Backend modules

### server/pricing.ts (new, pure functions, shared by POST and PUT)
- `type PriceLevel = 'retail'|'wholesale'|'super_wholesale'`; `normalizeLevel(x)`.
- `tierUnitPrice(product, level)` (USD): super → `price_super_wholesale` || `price_wholesale` || `price`;
  wholesale → `price_wholesale` || `price`; retail → `price`. (value counts only if > 0)
- `saleLineUnitPrice(product, level, qty)`: if level resolves to a real tier price (non-retail and that
  tier set) → flat tier price. Otherwise retail logic incl. existing package-break
  (`package_price` + `units_per_package > 1`) → blended per-unit price.
- `lineTotal(unitPrice, qty, discount)` and `computeTotals(lines, discount, tax)` — exactly the current
  POST math (per-line % or fixed discount, then global discount clamped, then tax, floor 0).
- Mirror in `src/lib/pricing.ts` (same functions + LBP variants using `*_lbp` columns) for the UI.

### server/costing.ts (new)
- Weighted average cost on purchase receipt: `newCost = (max(stock,0)*oldCost + qty*unitCost)/(max(stock,0)+qty)`;
  if old cost null/0 or stock<=0 → `unitCost`. Called per purchase line BEFORE the stock increment.
- `reversePurchaseCost(product, qty, unitCost)`: `(stock*cost − qty*unitCost)/(stock−qty)` if `stock−qty>0`
  and result ≥ 0, else leave cost unchanged. Used by purchase edit/delete.
- Sales/refunds snapshot `unit_cost = products.cost` (refund lines copy the original line's unit_cost).

### POST /api/transactions changes
- Accept `price_level` (default: stakeholder's `price_level`, else retail), `notes`, `reference`.
- Sales price from `saleLineUnitPrice`. If setting `allow_price_override === '1'` and a line has a finite
  `unit_price >= 0`, use it. If `min_price` set and unit price < min_price and setting
  `enforce_min_price === '1'` → 400.
- Store `unit_cost` on each line; purchases update WAC cost (and optional `update_sale_price` is NOT done).
- Credit limit: if stakeholder has `credit_limit > 0` and resulting balance < −credit_limit and setting
  `enforce_credit_limit === '1'` → 400 `{ error, code: 'CREDIT_LIMIT' }`.

### PUT /api/transactions/:id (new — edit current AND settled invoices, sale & purchase)
Body: `{ stakeholder_id?, items:[{product_id, quantity, unit_price, discount?}], payments:[{id?} | {amount, method, currency, exchange_rate}], discount?, tax?, notes?, reference?, price_level?, created_at?, reason?, user_id? }`
- Finds tx in live or archived tables (tenant-scoped). Refund edits → 400 (refund the delta instead).
- Validation as POST (qty > 0, price ≥ 0, discount bounds). For a sale, a product's new qty must be ≥ qty
  already refunded against it; products that were refunded cannot be removed.
- Payments: existing payments listed by `id` are kept untouched; existing ones omitted are deleted; entries
  without `id` are inserted (created_at = now). For an ARCHIVED invoice, each newly-added non-credit cash
  payment also writes a `cash_flow` row (sale → 'in', purchase → 'out', reason `Payment on invoice #id`)
  so the open cash register sees the money.
- Stock: reverse old lines, apply new ones (track_inventory respected). Purchases: reverse old WAC
  contribution then apply new.
- Totals recomputed server-side with `computeTotals`. Lines keep their old `unit_cost` for the same
  product, else current cost.
- Balances: live → `recomputeStakeholderBalance` for old and new stakeholder. Archived → compute the single
  tx's effect before/after (from archived payments) and adjust `balance_baseline`
  (old stakeholder −= oldEff, new stakeholder += newEff), then recompute.
- Live synced tx: before the local write, best-effort cloud delete of removed item/payment global_ids
  (same pattern as `purgeCloudTransaction`). The tx row keeps id/global_id; updated_at trigger pushes it.
- Sets `edited_at`, `edit_count+1`; inserts `transaction_edits` (before/after JSON snapshot); logAction.
- Returns the full updated transaction (same shape as GET /api/transactions/:id).
- `GET /api/transactions/:id/edits` → audit list.
- DELETE of a purchase reverses WAC as well.

### Inventory
- `POST /api/stock/adjust` `{ product_id, new_qty | delta, reason }` → stock_adjustments row + update.
- `GET /api/stock/adjustments?product_id&from&to`.
- `GET /api/stock/movements/:productId` → unified ledger: sales, refunds, purchases (live+archived) and
  adjustments with running balance.

### Reports — server/reports.ts (new, registered from routes.ts), all `from`/`to` (YYYY-MM-DD, local),
live UNION archived, USD
- `/api/reports/summary` → revenue (sales), refunds, net sales, discounts given, COGS, gross profit,
  margin %, purchases, cash in/out (cash_flow incl. archived), expenses (cash out), tx count, avg ticket,
  receivables (Σ negative customer balances), payables (Σ negative supplier balances), inventory value.
- `/api/reports/sales-trend?group=day|week|month` → [{period, sales, refunds, net, cogs, profit, count}]
- `/api/reports/by-product` → qty, revenue, cogs, profit, margin, sort + limit
- `/api/reports/by-category`, `/api/reports/by-customer`, `/api/reports/by-cashier`,
  `/api/reports/by-payment-method` (USD-converted, credit separated), `/api/reports/by-supplier` (purchases)
- `/api/reports/inventory-valuation` → per product stock, cost, value at cost, value at retail, potential profit
- `/api/reports/low-stock`, `/api/reports/slow-movers?days=30`
- `/api/reports/aging?type=customer|supplier` → open balances with 0-30/31-60/61-90/90+ buckets based
  on the oldest unpaid live invoice (fallback: all in "current" when only baseline).
- Fix existing bugs: `unpaid-sales`/`unpaid-purchases`/`custom-builder` subtract raw `amount` (must be
  `amount/exchange_rate`, excluding credit); `daily-sales*` and `reports/sales` use UTC dates → localtime;
  yearly report ignores archived.

## Frontend

Design system (ui-ux-pro-max → Data-Dense Dashboard): see `design-system/omnipos/MASTER.md` (overridden by
the lead's spec section below). Delivered as `src/components/ui/*` + tokens in `src/index.css`.

Pages:
1. **Shell**: grouped sidebar (Sales / Inventory / Purchasing / Finance / Reports / Admin), top bar with page
   title, breadcrumbs, search, theme, language; RTL when Arabic (`dir="rtl"` on `<html>`); collapsible.
2. **Products**: data table (sort, filter, pagination, bulk actions), product drawer with tabs
   (General / Pricing / Inventory / Barcodes). Pricing tab: cost, retail/wholesale/super-wholesale (USD+LBP),
   package price, live margin & markup per tier, "set price from markup %" helper, min price.
   Bulk price update tool (by category/selection: +/− % or markup-over-cost per tier).
3. **Invoices** (sales/purchases unified list incl. settled): filters, status chips (paid/partial/unpaid,
   settled, edited), invoice detail drawer with lines, payments, audit history, print; **Edit** opens a full
   editor (lines, prices, qty, discounts, customer, date, notes, reference, payments add/remove) calling
   PUT. Works for settled invoices.
4. **Purchases**: list + create/edit purchase invoice (supplier, reference, lines at cost, optional
   "update selling prices by markup"), payments, receive.
5. **Stock**: stock levels, adjustment dialog with reason, movement ledger per product.
6. **Customers/Suppliers**: price level, credit limit, balance, statement, aging.
7. **Reports**: dashboard with KPI cards + trend chart + tabs (P&L, Products, Categories, Customers,
   Cashiers, Payments, Suppliers, Inventory valuation, Low stock, Aging); date-range presets; Excel/PDF export.
8. **Overview**: KPI cards for today/month, trend, top products, low stock, receivables.
9. **POS**: price-level selector (defaults to customer's level), tier price shown on cards/cart, credit-limit
   warning, visual refresh using the same tokens (layout/flows preserved — cashiers know it).
10. **Settings**: new toggles `allow_price_override`, `enforce_min_price`, `enforce_credit_limit`,
    `default_price_level`.

## Release
- Version 1.2.0. `npm test`, `npx tsc --noEmit` (no NEW errors), `npm run build`, `npm run build:server`,
  `node --check dist-server/server.js`, `npx electron-builder --win --publish never`, smoke-launch
  `release/win-unpacked` and check the log for `[Server Error]`. No git push, no GitHub release.
