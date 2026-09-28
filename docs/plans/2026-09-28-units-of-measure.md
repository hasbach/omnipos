# Units of measure (packs, cartons) with their own barcodes

Goal: a product is stocked in a **base unit** (`products.unit`, e.g. "pcs") and can be sold / bought /
refunded in extra **units of measure** (UoM) such as "Pack ×6", "Carton ×24", each with its own
barcode(s) and prices. Stock, costing (WAC), COGS and reports stay in base pieces.

## 1. Data model

### New table `product_units` (synced)
```
id INTEGER PRIMARY KEY AUTOINCREMENT,
tenant_id INTEGER NOT NULL,
product_id INTEGER NOT NULL,
name TEXT NOT NULL,              -- "Pack", "Carton", "علبة"...
factor REAL NOT NULL,            -- base pieces in one unit, > 1
barcode TEXT,                    -- optional, unique per tenant across ALL product + unit barcodes
price REAL NOT NULL,             -- retail price of ONE unit (USD), > 0
price_lbp REAL,
price_wholesale REAL, price_wholesale_lbp REAL,
price_super_wholesale REAL, price_super_wholesale_lbp REAL,
sort_order INTEGER DEFAULT 0
```
Indexes: `(tenant_id, product_id)`, `(tenant_id, barcode)`. Create it BEFORE the sync-metadata block in
`server/db.ts` so it gets `global_id/created_at/updated_at/deleted_at/last_synced_at` + triggers.
Rows are **soft-deleted** (`deleted_at = CURRENT_TIMESTAMP`) when removed from a product; every read
filters `deleted_at IS NULL`. Updates happen in place by id (so global_id is stable for sync).

### New columns on `transaction_items` AND `archived_transaction_items`
```
uom_id INTEGER,          -- product_units.id, NULL = base unit
uom_name TEXT,           -- snapshot, NULL for base unit
uom_factor REAL,         -- snapshot, NULL/1 for base unit
uom_qty REAL,            -- quantity in the line's unit (NULL for base-unit lines = quantity)
original_item_id INTEGER -- refunds only: the sale line (transaction_items.id, live or archived) being refunded
```
**Invariant (do not break):** `quantity` stays in BASE PIECES and `unit_price` / `unit_cost` stay PER BASE
PIECE, so every existing stock / WAC / COGS / report / movement query keeps working unchanged.
For a UoM line: `quantity = uom_qty * uom_factor`, `unit_price = uomUnitPrice / uom_factor`.
Settlement's explicit column copy (`server/routes.ts` ~600, INSERT INTO archived_transaction_items)
and `server/invoiceEdit.ts` item INSERT must include the new columns.

### Migration of legacy package pricing (one-time, `_migrations` name `uom_from_package_v1`)
For every product with `package_price > 0 AND units_per_package > 1` and no live units: insert a unit
`name = 'Pack'`, `factor = units_per_package`, `price = package_price`, `price_lbp = package_price_lbp`.
Keep the legacy columns. From now on, on product save the server writes `package_price`,
`package_price_lbp`, `units_per_package` from the unit with the smallest factor (or NULL/1 when no units),
so older devices/cloud still see something sensible.

### Sync
Add `product_units` to `PUSH_TABLES` and `PULL_TABLES` in `server/sync.ts`, fkMap
`product_units: { tenant_id: 'tenants'?, product_id: 'products' }` — follow however other tenant-scoped
tables are declared (it has its own tenant_id so generic tenant filtering should apply). If the cloud
table does not exist yet (PostgREST `PGRST205` / `42P01` / 404), push and pull of that table must be
skipped with a single warning, NOT fail the sync. Add
`supabase/migrations/2026-09-29_units_of_measure.sql`: create `public.product_units` (mirror columns,
`global_id UUID PK`, `local_id`, `tenant_id` like other tenant tables, `product_id UUID REFERENCES
products(global_id)`, timestamps + deleted_at, same RLS policy pattern as product_barcodes/products)
and `ALTER TABLE public.transaction_items ADD COLUMN IF NOT EXISTS` the five new columns
(`original_item_id` as BIGINT local id is fine — document it; or omit it from cloud; push strips unknown
columns anyway).

## 2. Pricing (server/pricing.ts and its 1:1 mirror src/lib/pricing.ts)

`uom` = `{ factor, price, price_lbp?, price_wholesale?, price_wholesale_lbp?, price_super_wholesale?, price_super_wholesale_lbp? }`.

**Price of ONE unit at a level** (`uomUnitPrice(product, uom, level)`), a value counts only if > 0:
- retail: `uom.price`
- wholesale: `uom.price_wholesale` → `product.price_wholesale * factor` → `uom.price`
- super_wholesale: `uom.price_super_wholesale` → `product.price_super_wholesale * factor` →
  `uom.price_wholesale` → `product.price_wholesale * factor` → `uom.price`
- LBP variant `uomUnitPriceLbp(product, uom, level, rate)`: same chain on the `_lbp` columns
  (product `_lbp` × factor), each step falling back to its USD value × rate before moving on.
When price levels are disabled (`settings.enable_price_levels === '0'`) level is always retail (already
handled by callers).

**Base-piece lines keep the automatic pack break (retail only, as today) but generalized to units:**
greedy, largest factor first, over the product's units (retail `price`): e.g. pack6=1.10, carton24=4.00,
qty 31 pcs → 1 carton + 1 pack + 1 pc. If a product has no units but has the legacy
`package_price/units_per_package`, use that as a single unit (backward compat). Only whole-number
factors take part in the break. `saleLineUnitPrice(product, level, qty, units?)` gains the `units` arg.

Line total for a UoM line = `lineTotal(uomUnitPrice, uom_qty, discount)` (fixed discounts are per line
as today). min_price check compares the per-piece price (`uomUnitPrice / factor`) with `product.min_price`.

## 3. API

### Products
- `GET /api/products` and `/api/products/export`: each product gets `units: ProductUnit[]` (live only,
  ordered by sort_order, factor). Load all units in ONE query and group (don't add N+1).
- `GET /api/products/:query`: resolution order becomes: products.barcode → product_barcodes →
  **product_units.barcode** → exact name → LIKE. When a unit barcode matched, the response carries
  `matched_uom_id: <unit id>`; otherwise `matched_uom_id: null`. Response always includes `units`.
- `POST /api/products` / `PUT /api/products/:id`: accept `units: [{id?, name, factor, barcode?, price,
  price_lbp?, price_wholesale?, price_wholesale_lbp?, price_super_wholesale?, price_super_wholesale_lbp?}]`
  (absent `units` on PUT = leave units untouched). Validate: name required, factor > 1, price > 0,
  factors unique per product, barcodes unique within the payload and **within the tenant across
  products.barcode, product_barcodes and product_units** (excluding this product's own rows). Also
  validate the product's own `barcodes` the same way. Errors use the existing
  `ValidationError` shape `{error, code, field}` with codes `BARCODE_TAKEN` (field `barcodes` or
  `units.<i>.barcode`), `UOM_FACTOR_INVALID`, `UOM_FACTOR_DUPLICATE`, `UOM_PRICE_REQUIRED`,
  `UOM_NAME_REQUIRED`. Wrap the whole create/update (product row + barcodes + units) in `db.transaction`
  so a failure changes nothing. Return 409 for BARCODE_TAKEN, 400 for the others.
- `DELETE` product: soft-delete its units too (follow how product delete works today).

### Transactions (POST /api/transactions)
Item fields: `id` (product id), `quantity`, optional `uom_id`, `unit_price`/`price`, `discount`, `tax`,
and for refunds optional `original_item_id`.
- If `uom_id` is given: load the unit (must belong to that product + tenant, not deleted, else 400
  `UOM_INVALID` field `items.<i>.uom_id`). `quantity` in the payload is in UNITS. The server derives
  pieces = quantity × factor from the DB (never trust a client factor).
- Sale: price per unit = `uomUnitPrice(...)` unless an allowed override (`unit_price`, interpreted
  PER UNIT of the line's UoM). Purchase: `price` is the cost PER UNIT of the line's UoM; WAC uses
  pieces and cost-per-piece = price / factor. Refund: see below.
- Store `quantity` (pieces), `unit_price` (per piece), `unit_cost` (per piece), `uom_id`, `uom_name`,
  `uom_factor`, `uom_qty`. Stock delta uses pieces (unchanged code path).
- Base-unit lines behave exactly as today (plus the generalized auto-break).

### Refunds — per original LINE (fixes the existing product_id collision)
- Refund items should carry `original_item_id`. The server finds that line on the original sale (live
  or archived items), takes its price/discount/unit_cost/uom from it, and the quantity is in that line's
  UoM (`uom_qty` units; converted to pieces via the line's `uom_factor`). The refund row stores
  `original_item_id` and the same uom snapshot.
- Remaining per line = line `quantity` − pieces already refunded against that line. Pieces refunded
  against a line = refund items with that `original_item_id` + legacy refund items (no original_item_id)
  of the same product allocated to that product's lines in id order.
- Items without `original_item_id` (old clients) keep working: resolve to the first line of that
  product with remaining qty (then the next), quantity in pieces as today.
- `GET /api/transactions/:id/refundable`: one entry per original line with `item_id`, `product_id`,
  `product_name`, `barcode`, `uom_id`, `uom_name`, `uom_factor` (1 if none), and `sold_qty`,
  `refunded_qty`, `remaining_qty`, `unit_price`, `unit_refund` **expressed in the line's UoM** (units,
  price per unit). Keep existing fields/semantics otherwise (charged factor etc.).

### Invoice edit (PUT /api/transactions/:id, server/invoiceEdit.ts)
Line input gains `uom_id?`; `quantity` and `unit_price` are in that UoM. Convert to pieces/per-piece the
same way as POST. Old-line lookup for `unit_cost` keyed by `product_id + uom_id` (fallback product_id).
Refund floor stays per product in pieces. Preserve uom columns on insert.
`GET /api/transactions/:id` (buildTransactionDetail) and purchase detail: items include the uom fields
plus convenience `display_qty` (= uom_qty ?? quantity) and `display_unit_price`
(= unit_price × (uom_factor || 1)).

### Printing
`server/printing/receipt.ts`: a UoM line prints the name with the unit, e.g. `Water 0.5L - Carton x24`,
qty = uom_qty, total = line total. `POST /api/print/receipt` passes the uom fields. Base-unit lines unchanged.

### Importer (server/importer.ts)
`package_price` / `package_price_lbp` / `units_per_package` columns now upsert a unit named `Pack`
(match an existing live unit of the same factor, else insert) in addition to the legacy columns. New
optional column `package_barcode` (field key `package_barcode`) sets that unit's barcode, with the same
tenant-wide uniqueness checks the importer already does for barcodes (`BARCODE_TAKEN`,
`DUPLICATE_IN_FILE`). Add the field to `src/pages/import/fields.ts` + template + locales (en/ar/fr).

## 4. UI (React)

- **Types** (`src/types.ts`): `ProductUnit`; `Product.units?: ProductUnit[]`; `CartItem` gets
  `line_key: string` (`${productId}:${uomId ?? 'base'}`), `uom_id?: number|null`, `uom_name?`, `uom_factor?`.
- **POS cart** (`usePos.ts`, `CartPanel.tsx`): cart lines keyed by `line_key` (all updaters —
  quantity, set qty, discount, override, remove, editors — switch from `item.id` to `item.line_key`).
  `addToCart(product, uomId?)`; barcode scan uses `matched_uom_id`. Scanning a carton barcode twice
  → 2 cartons. Each line with units shows a compact **unit selector** (Piece / Pack ×6 / Carton ×24);
  changing it moves the line to that key (merging if that line exists). Line shows
  `2 × Carton (24 pcs) · 4.00 / carton`, plus a subtle "= 48 pcs". Pricing via `uomUnitPrice` /
  `uomUnitPriceLbp`; checkout payload sends `uom_id` and quantity in units, `unit_price` override per
  unit. Search suggestions also match unit barcodes (add `units.barcode` to Fuse keys) and add that unit.
  Fix the browser-print fallback to print resolved line prices and the unit name.
- **POS refund** (`PaymentModal.tsx` refund part + `handleRefund` in usePos): use `/refundable` lines
  (per line, in the line's unit), send `original_item_id`, `uom_id`, quantity in units.
- **Back-office refund** (`src/pages/invoices/RefundModal.tsx`): state keyed by `item_id`, show unit,
  send `original_item_id`.
- **Invoice editor** (`src/pages/invoices/InvoiceEditor.tsx`, `types.ts`): `LineDraft` gets
  `uom_id/uom_name/uom_factor`; a unit select per line when the product has units (sales AND
  purchases); purchase default cost for a unit = product.cost × factor; sale default = uomUnitPrice.
  Loading an existing invoice maps `display_qty` / `display_unit_price`. Product search also matches
  unit barcodes and extra barcodes.
- **Invoice detail / purchase detail / print HTML** (`InvoiceDetailDrawer.tsx` etc.): show `2 Carton
  (×24)` and the per-unit price.
- **Product editor** (`ProductEditorDrawer.tsx`): replace the "Package price / Units per package" grid with a
  **"Units of measure" card**: base unit label (existing `unit` field), then rows: Name, Contains
  (factor, in base units), Barcode, Retail price (USD) with LBP auto from rate (editable), Wholesale and
  Super-wholesale (hidden when price levels disabled), a hint showing the per-piece price and the saving vs
  selling pieces (e.g. "0.183 / pc · saves 8%"), delete row; "Add unit" button with quick presets
  (Pack, Box, Carton, Dozen=12). Inline field errors from the server (`units.<i>.barcode`, …) as the
  editor already does for other fields.
- **Products list**: small chip listing units (e.g. `Pack ×6 · Carton ×24`) in the product row.
- All new strings in en/ar/fr locale files (per-area files in `src/intl/locales/*.ts`), plus
  `translateServerError` codes.

## 5. Tests (tests/units-of-measure.test.ts + updates)
Server tests: unit CRUD + validation + barcode collision (409, nothing changed); lookup by unit barcode
returns matched_uom_id; sell 2 cartons → stock −48, unit_price per piece, totals, tier fallback chain
(unit tier, product tier × factor, retail); price levels disabled → retail; min_price per piece;
purchase 3 cartons at 20.00 → stock +72, WAC on per-piece 0.8333; refund per line when the same product
was sold as pieces AND as a carton (correct amounts, remaining per line, legacy refund without
original_item_id still works); invoice edit of a carton line (qty change → stock delta in pieces);
settlement copies uom columns to archive and refund of an archived carton line; legacy package
migration creates a unit; generalized auto-break on base lines; receipt prints unit name.
Pure tests for pricing mirror parity (server vs src/lib pricing give identical results for a matrix).
All existing 144 tests must stay green (`npm test`), `npx tsc --noEmit` clean, `npm run build` OK.
