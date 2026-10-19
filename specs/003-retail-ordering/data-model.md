# Data model — B2C Retail Ordering, Slice 1

No new tables (local or cloud). Slice 1 changes two existing fields and adds browser-only state.

## Store ordering settings (`stores.settings` JSON — local SQLite and cloud, synced as today)

| Key | Type | Default | Rule |
|---|---|---|---|
| `ordering_mode` | `'off' \| 'whatsapp' \| 'online'` | `'off'` | `whatsapp` needs a usable `contact_whatsapp` and a fulfilment method; `online` refused until Slice 2 |
| `pickup_enabled` | 0/1 | 1 | at least one of pickup/delivery is on when `ordering_mode ≠ off` |
| `pickup_note` | text ≤ 200 | `''` | shown at checkout under "Pickup" |
| `delivery_enabled` | 0/1 | 0 | |
| `delivery_note` | text ≤ 200 | `''` | delivery area text, shown at checkout under "Delivery" |
| `min_order_usd` | number ≥ 0, 2 decimals, ≤ 100 000, or null | null | checkout disabled below it |

Existing keys (`show_exact_stock`, `hide_out_of_stock`, `show_local_price`, `category_order`) are unchanged. Unknown keys
already present in the JSON are preserved by the server merge. Cloud `_store_public_settings` gains the same defaults.

**Invariant**: the storefront offers ordering only when `ordering_mode = 'whatsapp'` **and** the store's WhatsApp
number normalises to digits **and** a fulfilment method is on **and** the store is public under 002's gate.

## Listing orderable units (`store_listings.orderable_unit_ids` TEXT, JSON)

| Value | Meaning |
|---|---|
| `NULL` / empty | every live unit of the product is orderable, including the base unit (today) |
| `["base", "<uuid>", …]` | only these: `"base"` = the product's base unit; `<uuid>` = `product_units.global_id` |
| `[3, 5]` (legacy integers) | **local**: converted once (below). **Cloud**: ignored → all units orderable |

- Non-empty when set; every uuid must be a live unit of the listing's product (local validation).
- Local one-time conversion (idempotent, per tenant): integer array → `["base", gid(3), gid(5)]`; ids without a row or
  a `global_id` are dropped; empty → `NULL`; converted rows are marked for push.
- Units deleted later: their keys are ignored at read time; if no key remains live, the listing has no orderable unit
  and "Add to cart" is hidden (contact buttons remain).

## Listing minimum quantity (`store_listings.min_quantity`, existing)

Base-unit quantity per listing; the cart requires Σ(qty × factor) over the listing's lines ≥ `min_quantity`.

## Public catalog shapes (storefront `data.ts`)

- `PublicStore` + `ordering_mode`, `pickup_enabled`, `pickup_note`, `delivery_enabled`, `delivery_note`,
  `min_order_usd` (missing → `off` / pickup on / no minimum).
- `PublicListing` + `base_orderable: boolean` (missing → true); `units` already contains only orderable units.
  `PublicUnit.unit_id` is the unit's global id (unchanged).

## Browser state (visitor's device only)

**Cart** — `localStorage["sf-cart:v1:<address>"]`:

```json
{ "v": 1, "updated": 1760000000000,
  "lines": [ { "id": "<listing uuid>", "unit": "base|<unit uuid>", "qty": 2,
               "title": "Halloumi 250g", "img": "<path|null>", "name": "Pack of 6", "factor": 6,
               "price": 12.5, "price_lbp": null, "min": null, "dec": false } ] }
```

- A line is identified by (`id`, `unit`); adding the same pair increases `qty`.
- ≤ 50 lines; 0 < `qty` ≤ 999; `qty` integer unless `dec` (≤ 3 decimals).
- Refreshed from page data whenever the listing is seen again (research R3); lines whose unit is no longer offered are
  marked unavailable and excluded from checkout.

**Remembered details** — `localStorage["sf-buyer:v1:<address>"]` = `{ name, phone, address, fulfilment }`, only when
"remember my details" is ticked; cleared by unticking.

**Language** — `localStorage["sf-lang"]` (002, unchanged).

## State transitions

Slice 1 has no stored order. Cart lifecycle in the browser: empty → has lines → (checkout opened) → WhatsApp opened →
"sent?" yes → empty / no → has lines.
