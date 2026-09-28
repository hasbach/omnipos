# Data import wizard — products, customers, suppliers

## Goal
A merchant moving to OmniPOS fills an Excel template (or brings their own sheet/CSV), and a guided wizard
validates and imports it: products with all pricing/stock details, customers and suppliers with opening balances.
Safe by default: a full dry-run preview with row-level errors before anything is written; one transaction per
import; re-runnable (update existing records instead of duplicating).

## Backend (server/importer.ts, registered from server/routes.ts)
Routes (tenant-scoped, `authenticate`), mounted with `express.json({ limit: '25mb' })` on these paths only
(the global parser defaults to 100 KB; register the route-level parser BEFORE the handlers and make sure the
global one doesn't reject first — e.g. `app.use('/api/import', express.json({limit:'25mb'}))` placed before
`app.use(express.json())` in server.ts AND in tests/helpers/testApp.ts + scripts/preview-server.ts, or skip the
global parser for /api/import).

`POST /api/import/:entity` — entity = `products` | `customers` | `suppliers`
Body: `{ rows: Array<Record<string, any>>, mode: 'create_only' | 'upsert', dry_run: boolean, user_id? }`
Rows use CANONICAL field keys (the client maps sheet columns → keys). Limit 20 000 rows.
Response (same shape for dry run and real run):
```
{ entity, dry_run, total, created, updated, skipped, errors: [{ row, field?, message, code }],
  warnings: [{ row, field?, message, code }], results: [{ row, action: 'create'|'update'|'skip'|'error', id?, key }] }
```
`row` = 1-based index in the submitted `rows` array (the client adds the sheet's header offset when displaying).
Real run (`dry_run:false`): if ANY row has an error → nothing is written, 422 with the same body (all-or-nothing).
Otherwise everything runs in ONE db.transaction; logAction('Data Import', `${entity}: +created ~updated`);
broadcast PRODUCTS_UPDATED / STAKEHOLDERS_UPDATED.

### Products — canonical keys
| key | required | notes |
|---|---|---|
| name | yes | trimmed, ≤ 200 chars |
| barcode | no | primary barcode; `barcodes` may hold extra ones separated by `,` `;` or `|` |
| barcodes | no | extra barcodes |
| category | no | default 'General' |
| unit | no | default 'pcs' |
| cost | no | USD, ≥ 0 |
| price | yes | retail USD, ≥ 0 |
| price_lbp | no | ≥ 0 |
| price_wholesale, price_wholesale_lbp, price_super_wholesale, price_super_wholesale_lbp | no | ≥ 0 |
| package_price, package_price_lbp | no | ≥ 0 |
| units_per_package | no | integer ≥ 1 |
| min_price | no | ≥ 0 |
| stock | no | number; opening/counted stock |
| reorder_point | no | ≥ 0 |
| track_inventory | no | yes/no/1/0/true/false/نعم/لا/oui/non; default yes |
Number parsing: accept "1,234.50", "1234,5" (single comma, no dot → decimal), strip currency symbols ($ LL ل.ل), empty → null.
Matching (upsert): by primary barcode, else any extra barcode, else exact case-insensitive name when the row
has no barcode. Duplicate keys INSIDE the file → error on the later rows (`DUPLICATE_IN_FILE`).
Barcode already used by a DIFFERENT product (in DB or file) → error `BARCODE_TAKEN`.
create_only + existing match → `skip` with a warning `EXISTS`.
Update semantics: only columns PRESENT in the row (non-empty) are changed; empty cells never blank out data.
Stock: on create, stock = value (0 if absent) and, when > 0, a `stock_adjustments` row reason 'Import: opening
stock'. On update, if `stock` present and different → adjust to that count via a `stock_adjustments` row
(reason 'Import: stock count') — never write products.stock directly without the adjustment row.
Warnings (not errors): price < cost (`BELOW_COST`), wholesale > retail (`TIER_ABOVE_RETAIL`),
price < min_price (`BELOW_MIN`).

### Customers / Suppliers — canonical keys
| key | required | notes |
|---|---|---|
| name | yes | |
| phone, email, address | no | email format warning only |
| price_level | no (customers) | retail/wholesale/super_wholesale + aliases مفرق/جملة/جملة الجملة, détail/gros/super gros |
| credit_limit | no | ≥ 0 |
| opening_balance | no | amount the party OWES (customer owes us / we owe the supplier) as a positive number; a negative number = credit in their favour. Stored in the derived-balance model as `balance_baseline -= opening_balance` then recompute (see server/balance.ts: negative balance = owes) |
| notes | no | ignored if no column exists (don't add schema) |
Matching (upsert): exact case-insensitive name + same type; if the row has a phone, name+phone. Never match or
modify the 'Walk-in Customer' record (`RESERVED_NAME` error).
opening_balance on UPDATE of an existing party: only applied if the party has NO transactions yet
(else error `HAS_HISTORY` — changing an established balance must go through a balance payment); on create always.

## Frontend — Import wizard (`/dashboard/import`, sidebar Admin group "Import data"; also buttons
"Import" on Products and Customers & Suppliers pages that open the wizard preset to that entity)
Steps (stepper, fully translated en/ar/fr, RTL):
1. **What to import**: Products / Customers / Suppliers cards + "Download template" (xlsx).
2. **Upload**: drag & drop or pick .xlsx/.xls/.csv; choose sheet if several (template's sheet for the entity
   preselected); parse client-side with the existing `xlsx` package (first non-empty row = header).
3. **Map columns**: each canonical field → a sheet column (auto-matched by header aliases: canonical key,
   English label, Arabic label, French label, common variants like "Selling price", "سعر المبيع", "Code",
   "باركود"); required fields highlighted; "Ignore" option; mapping remembered per entity in localStorage
   (try/catch). Preview first 5 mapped rows.
4. **Review**: mode choice (Add new only / Add new and update existing — default upsert), call the API with
   `dry_run:true`, show counters (to create / to update / skipped / errors / warnings) and a DataTable of rows
   with status badge + message, filter by status; errors show the SHEET row number (header row offset) and field.
   "Download error report" (xlsx: original row + error column). Import button disabled while errors exist.
5. **Import**: call with `dry_run:false`, progress/loading, final summary with links (go to Products /
   Customers), "Import another file".
Template (generated client-side with `xlsx`, file `OmniPOS-import-template.xlsx`): sheets `Products`,
`Customers`, `Suppliers`, `Instructions`. Header row = column labels in the CURRENT UI language (the importer's
aliases recognise all three languages), a second-row example record per sheet (clearly an example the user
overwrites — the parser skips a row whose first cell starts with "e.g." / "مثال" / "ex." ), column widths set,
Instructions sheet explaining each column (required, format, units: USD, LBP, what opening balance means,
yes/no values, multiple barcodes separator) in the current language. Price-level columns omitted when
`enable_price_levels` is off.
