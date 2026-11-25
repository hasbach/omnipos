# Product bundles — design (2026-11-26)

## Intent

The owner sells existing products together at a package price (a $10 item + a $5 item for $13).
The cashier sells the bundle exactly like a product (search, barcode, grid). Stock, cost and every
report must stay correct for the products that actually leave the shelf.

## Goals / non-goals / anti-goals

- Goals: define bundles in the back-office product editor (components + quantities, the saving
  shown); sell them at the POS; stock taken from the components; per-component unit cost; the
  bundle price split over the components by list price; refunds, invoice edit, receipts,
  statements; cloud sync of the definition.
- Non-goals: nested bundles, bundles with units of measure, bundles in purchases / stock
  adjustments / cycle counts, "pick any 3 of" mix-and-match, online-store bundle availability.
- Anti-goals: a sale whose report revenue differs from what was charged; stock moving on the
  bundle product itself; OmniPulse OR proposing to reorder a bundle.

## Approaches considered

1. **Expand at sale time into component lines (chosen).** The bundle line becomes one
   `transaction_items` row per component, each carrying its share of the bundle price
   (`unit_price` per base piece), its own `unit_cost`, and a snapshot of the bundle
   (`bundle_id`, `bundle_name`, `bundle_qty`, `bundle_line`). Every existing per-line query —
   stock, WAC/COGS, sales by product/category, OR velocity, statements — keeps working unchanged
   because the lines ARE the components. Display code groups rows by `bundle_line`.
   This mirrors the units-of-measure invariant (stored lines always describe base pieces).
2. Store one bundle line plus zero-priced component child lines. Revenue would land on the
   bundle (wrong category, wrong OR margins) and every report would need bundle awareness.
3. Store one bundle line only and resolve components in every consumer. Most invasive; the
   component cost at sale time would be lost.

## Data

- `products.is_bundle INTEGER DEFAULT 0`. A bundle has its own barcode(s), price (USD + LBP and
  tiers), photo, category. It is forced to `track_inventory = 0`, stock 0, no units of measure.
- `product_bundle_items (id, tenant_id, bundle_id, component_id, quantity REAL, sort_order)`,
  synced like `product_units` (global_id/updated_at/deleted_at, soft-deleted, fkMap translates
  `bundle_id` / `component_id` to UUIDs). Pushed/pulled with the hot product tables.
- `transaction_items` + `archived_transaction_items`: `bundle_id`, `bundle_name`, `bundle_qty`
  (bundles sold, for that group), `bundle_line` (group key, 1-based position of the bundle in
  the request). Settlement copies them. `bundle_id` travels as a product UUID.
- Cloud: `supabase/migrations/2026-11-26_product_bundles.sql` (not applied automatically; the
  sync tolerates the missing table/columns until it is).

## Selling (server is authoritative)

- POST /api/transactions, sale: a request item whose product is a bundle is priced like any
  product (tier chain, LBP-priced carts, manual override, line discount), then expanded.
  Shares come from `bundleShares` (component retail price × quantity; equal by quantity when all
  list prices are 0). Component per-piece price = bundle unit price × share / component qty.
  A percentage line discount is copied to every component row; a fixed one is split by share.
  The transaction total uses the bundle line total exactly as before.
- Guards: `min_price` and below-cost apply to the bundle as a whole (bundle line total vs the
  sum of component costs); negative-stock check runs on the expanded component rows, so it
  respects `track_inventory` and `allow_negative_stock` per component. Disabled/missing
  components, an empty bundle, a unit of measure on a bundle, or a bundle in a purchase are
  rejected with codes.
- Refunds: unchanged math (per original line). The UI shows bundle groups with a bundle-quantity
  stepper that fills each component's quantity; refund rows copy the bundle snapshot.
- Invoice edit: the editor shows a bundle group as one line (product = bundle, quantity =
  bundles, price per bundle); the server expands it with the same helper as checkout.

## Shared math

`bundleShares`, `allocateBundleAmount`, `bundleSaving` and `groupBundleLines` live in a marked
"Bundles" section that is byte-identical in `server/pricing.ts` and `src/lib/pricing.ts`
(test-enforced, plus behavioural parity).

## Display

Receipts (ESC/POS and browser fallback), POS order history, invoice detail, refund dialogs and
the statement show one bundle line with its components listed under it. The product editor gets
a "Bundle" card: component picker, quantities, list total, bundle price and saving. The POS grid
shows bundle availability (min over tracked components of stock / quantity).

## Calls made by the builder (not decided by the owner)

- Saving shown = Σ(component retail price × qty) − bundle retail price.
- A bundle may have a single component (multi-buy, e.g. 3 for $5).
- Deleting a component product leaves the bundle unsellable with a clear error instead of
  blocking the delete.
- OR pipeline, cycle counts, stock adjustment and purchase entry skip bundle products.
