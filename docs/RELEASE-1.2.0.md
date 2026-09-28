# OmniPOS 1.2.0 — Professional upgrade

Built locally only (`release/OmniPOS-Setup.exe`, `release/OmniPOS-Portable.exe`). **Not published** — no git push,
no GitHub release. Publishing is a separate, deliberate step (see README).

## Before you publish
1. Run `supabase/migrations/2026-09-28_pro_upgrade.sql` in the Supabase SQL editor. Until then the app still works,
   but price tiers, customer price levels / credit limits, invoice notes/references and cost snapshots stay local to
   each register (sync strips columns the cloud doesn't have yet).
2. Back up `%APPDATA%\OmniPOS\pos.db` on the live register before installing (routine for any upgrade). The
   migration was dry-run on a copy of this machine's real database: all counts, totals, stock and all stakeholder
   balances were unchanged.

## What's new
**Pricing — مفرق / جملة / جملة الجملة**
- Each product has Retail, Wholesale and Super-wholesale prices (USD + local currency), plus an optional minimum price.
- Customers carry a default price level and an optional credit limit. The POS switches prices automatically when a
  customer is selected; the cashier can change the level per sale.
- Bulk price update by selection/category: % change, markup on cost, or fixed, with rounding and a preview.
- Settings → Sales & Pricing: default price level, allow cashier price override, enforce minimum price, enforce
  credit limit.

**Costing & profit**
- Weighted-average cost updated on every purchase (and reversed when a purchase is edited or deleted).
- Every invoice line stores its unit cost at the time of sale, so COGS and gross profit are historically correct.
- After saving a purchase, optionally update selling prices keeping each tier's markup.

**Invoices — review and edit current and old (settled) invoices**
- One list for sales, refunds and purchases, including settled ones, with paid / partial / unpaid status.
- Edit lines, quantities, prices, discounts, customer, date, notes, reference and payments in place — the invoice
  keeps its number. Stock, cost and customer/supplier balances are adjusted automatically; editing a settled invoice
  adjusts the carried balance, and new cash payments on it go into today's cash register.
- Every edit requires a reason and is kept in an audit history (before → after).
- Refund screen (from any sale, including settled ones): pick quantities per line, see what was already
  refunded and what remains, refund in cash or card (USD or local currency) or as credit to the customer's
  account, with a required reason. Refunds link back to their original sale.

**Reports**
- KPIs, P&L, sales trend, and analysis by product, category, customer, supplier, cashier and payment method.
- Inventory valuation (cost and retail), low stock with suggested order, slow movers, receivables/payables aging.
- Excel / PDF / print export on every table. All reports include settled data and use local-time days.

**Inventory**
- Stock adjustments with reasons (count, damage, expiry, loss, return…) and a per-product movement ledger.
- Product edits no longer overwrite stock (a sale made while the edit form was open is no longer lost).

**UI / UX**
- New design system across the back office and the POS: grouped sidebar, data tables with search/sort/pagination
  and bulk actions, drawers for details, toasts and confirmations instead of browser pop-ups, skeleton loading,
  dark mode, full Arabic (RTL) and French, bundled offline fonts (Inter + IBM Plex Sans Arabic).

## Bugs fixed
- POS sales skipped server-side pricing (the checkout never sent `type`), so package prices and tiers were not
  applied to the recorded invoice and the line cost equalled the selling price.
- Unpaid-sales / unpaid-purchases / custom report builder treated LBP payment amounts as dollars and counted
  on-account ("credit") payments as paid.
- Daily sales reports used UTC days (sales after 9 pm / midnight local landed on the wrong day).
- Yearly report ignored settled transactions and refunds.
- Purchases screen hid settled purchases.
- Refunds ignored the original invoice's global discount and tax, so a partial refund from a discounted
  invoice paid back more than the customer paid (POS and back office now both use the charged amount).
