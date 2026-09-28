# Stock / price guards and disabled products (1.4.0, on branch feature/units-of-measure)

Settings are tenant key/value rows (`settings` table, read server-side with `getSettingsMap`, client-side via
`src/lib/useSettings.ts`, edited in `src/pages/settings/SalesPricingSection.tsx`). Every new setting's DEFAULT
reproduces today's behaviour.

| key | values | default | meaning |
|---|---|---|---|
| `allow_below_cost` | '1' / '0' | '1' | '0' = a SALE line may not be priced below the product's cost per piece |
| `allow_negative_stock` | '1' / '0' | '1' | '0' = an operation may not leave a tracked product's stock below 0 |
| `hide_out_of_stock` | '1' / '0' | '0' | '1' = POS catalog grid + POS search suggestions hide tracked products with stock <= 0 |

Product: new column `products.active INTEGER DEFAULT 1` (1 active, 0 disabled). Add to
`supabase/migrations/2026-09-29_units_of_measure.sql` (`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS active INTEGER DEFAULT 1;`).

## Server rules
Errors use `ValidationError` → `{error, code, field, ...}` (400 unless noted).

1. **Below cost** (`allow_below_cost === '0'`): for `type === 'sale'` lines in POST /api/transactions and sale edits in
   PUT /api/transactions/:id (server/invoiceEdit.ts): if `product.cost > 0` and the final per-piece price after the
   line's own discount (`lineTotal / pieces`) is `< product.cost - 1e-9` → code `BELOW_COST`, field
   `items.<i>.unit_price`, extra `cost` (per unit of the line's UoM = cost × factor). Invoice-level global discount is
   NOT considered (keep it simple, document it). Refunds and purchases unaffected. The `enforce_min_price` check
   stays as is.
2. **Negative stock** (`allow_negative_stock === '0'`), products with `track_inventory !== 0` only:
   - POST sale: sum pieces per product across all lines of the request (units × factor); if `stock - sum < 0` →
     code `INSUFFICIENT_STOCK`, field `items.<i>.quantity` (first line of that product), extras `available`
     (current stock in pieces), `product_id`. Status 409.
   - PUT edit (sale or purchase) and invoice DELETE (whatever route deletes/voids an invoice and reverses stock):
     after computing the new stock, reject if a product ends `< 0` AND its stock went down because of this
     operation (don't block edits that don't worsen an already-negative product). Same code/field (field
     `items.<i>.quantity` when a line can be identified, else no field).
   - POST /api/stock/adjust (and any other manual stock set/count endpoint): reject a target `< 0`, code
     `INSUFFICIENT_STOCK`, field `qty` or whatever the endpoint's field is.
   - Refunds and purchases (which add stock) are never blocked.
3. **Disabled product** (`active = 0`):
   - POST sale with a disabled product → code `PRODUCT_DISABLED`, field `items.<i>.id`.
   - GET /api/products/:query (barcode/name lookup used by the POS scanner): if the match is disabled, respond 404
     `{error, code: 'PRODUCT_DISABLED', product_id, name}`.
   - GET /api/products keeps returning ALL products (with `active`), the client filters.
   - Purchases, refunds and edits of existing invoices keep working for disabled products (editing a sale may keep
     an existing line of a now-disabled product but may not ADD a new one — optional, only if simple).
   - POST/PUT /api/products accept `active` (absent on PUT = unchanged; `UpdateSellingPricesModal` doesn't send it).
   - Importer (server/importer.ts): optional `active` column (yes/no/1/0/true/false/نعم/لا/oui/non; invalid →
     `INVALID_VALUE`), applied on create and, when present, on update.
   - Settings: make sure the three new keys are accepted by the settings save endpoint (check whether it
     whitelists keys).

Tests (`tests/stock-price-guards.test.ts`): each rule on and off (defaults keep old behaviour), units case (2 cartons
= 48 pcs vs stock 40 → 409 with available 40), line discount pushing below cost, edit that increases qty beyond stock,
edit that doesn't worsen a negative product is allowed, stock adjust to negative, disabled product sale / lookup /
purchase still OK, importer active column, settings round-trip.

## Client
- **Settings → Sales & Pricing** (`SalesPricingSection.tsx`): three switches with helper text, alongside
  `enforce_min_price` / `enable_price_levels`. Labels: "Allow selling below cost", "Allow negative stock",
  "Hide out-of-stock products in the POS".
- **POS** (`usePos.ts`, `CartPanel.tsx`, `ProductGrid.tsx`, `PaymentModal.tsx` search if any):
  - Catalog grid + search suggestions exclude `active === 0` always, and exclude tracked stock <= 0 when
    `hide_out_of_stock` is on.
  - Scanning a disabled product: toast "This product is disabled" (use code PRODUCT_DISABLED from the 404).
  - `allow_negative_stock` off: adding / increasing / typing a quantity / changing a line's unit must not make the
    product's total pieces in the cart (all its lines, units × factor) exceed its stock; clamp and toast
    "Only N pcs in stock". Out-of-stock tiles are not addable.
  - `allow_below_cost` off: a line whose per-piece price (after its own discount / price override) is below cost
    shows a red "Below cost" warning like the existing below-min warning; checkout is blocked with a toast until
    fixed. Server errors BELOW_COST / INSUFFICIENT_STOCK / PRODUCT_DISABLED are shown translated
    (`translateServerError`).
- **Invoice editor** (`InvoiceEditor.tsx`): sale product search excludes disabled products (purchases include them
  with a "Disabled" badge); inline field errors for BELOW_COST / INSUFFICIENT_STOCK (existing field-error mapping).
- **Products**: editor General tab gets an "Active" switch (helper: "Disabled products can't be sold and are hidden
  from the POS; purchases and history keep working"); list shows a "Disabled" badge and the row is muted; list
  filter gains Status: All / Active / Disabled (default All); export includes `active`.
- **Import wizard**: `active` field in `src/pages/import/fields.ts` (+ aliases en/ar/fr e.g. active, enabled,
  status, نشط, فعال, actif), template column, locale label.
- All strings en/ar/fr.
