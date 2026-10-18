# Contract — Public catalog (Supabase RPC, consumed by Feature 002)

Defined in `supabase/migrations/2026-10-18_commerce_store_foundation.sql`. Called with the public anon key, e.g.
`supabase.rpc('store_public_listings', { p_slug: 'abc-market', p_limit: 48 })`.

All public functions are `SECURITY DEFINER`, `STABLE`, `SET search_path = public`, `GRANT EXECUTE ... TO anon,
authenticated`, and **return zero rows** unless every gate holds:

1. a store with `lower(slug) = lower(p_slug)`, `deleted_at IS NULL`, `status = 'active'`;
2. that tenant's `settings` row `commerce_enabled = '1'` (not deleted);
3. that tenant's online license is valid: `online_license_type = 'lifetime'` OR `online_license_expiry > now()`;
4. tenant not deleted.

A missing, paused or unlicensed store is indistinguishable from a non-existent slug (no information leak).

## `store_public_get(p_slug text)` → one row or none

| Field | Source |
|---|---|
| `slug`, `name`, `description`, `mode`, `logo_path`, `cover_path`, `primary_color` | `stores` |
| `contact_phone`, `contact_whatsapp`, `contact_email`, `address`, `default_language` | `stores` |
| `show_local_price`, `hide_out_of_stock`, `show_exact_stock` | `stores.settings` |
| `local_currency_code`, `local_currency_symbol`, `local_rate` | tenant's non-USD `currencies` row (null if none) |
| `categories` | JSON array `[{ name, count }]` of visible listings, ordered by `settings.category_order` then name |

## `store_public_listings(p_slug text, p_category text default null, p_search text default null, p_limit int default 48, p_offset int default 0)` → rows

`p_limit` is clamped to 1–100. `p_search` matches display title or product barcode (case-insensitive, trimmed,
≤ 60 chars). Ordering: `sort_order`, then display title. Only **visible** listings (data-model rule); out-of-stock
ones are excluded when the store has `hide_out_of_stock = 1`.

| Field | Source |
|---|---|
| `listing_id` | `store_listings.global_id` |
| `title` | `title ?? products.name` |
| `description`, `images` (json), `category` (`store_category ?? products.category`) | listing / product |
| `price`, `price_lbp` | product retail columns |
| `unit` | `products.unit` (base unit label) |
| `units` | JSON `[{ unit_id, name, factor, price, price_lbp }]` from every non-deleted `product_units` row; `unit_id` is the unit's global id. `orderable_unit_ids` is **not** applied in Slice A: it holds the authoring register's local unit ids (sync doesn't translate ids inside JSON). Ordering (003) must store unit global ids before enforcing it. |
| `stock_state` | `in_stock` \| `low_stock` \| `out_of_stock` |
| `stock` | exact stock **only** when `show_exact_stock = 1`, else null |
| `min_quantity` | listing |
| `total_count` | total matching rows (same value on every row, for paging) |

## Never returned (FR-032, allow-list test)

`cost`, `cost_lbp`, `min_price`, `price_wholesale*`, `price_super_wholesale*`, `reorder_point`, `track_inventory`,
any `stakeholders`, `transactions`, `payments`, `users`, `settings` other than those listed, tenant `email`,
`password`, license fields, local ids.

## `claim_store_slug(p_store uuid, p_slug text)` → `{ ok: boolean, code: text }` (authenticated only)

- Caller must own the store: `stores.tenant_id::text = auth.uid()::text`, or (store row not yet pushed) the
  function inserts a placeholder row for `p_store` owned by `auth.uid()` that the next push upserts.
- Validates format + reserved list (same rules as the local server), then sets `slug` if no other non-deleted store
  has it. Codes: `ok`, `invalid`, `reserved`, `taken`, `not_owner`.
- `REVOKE EXECUTE ... FROM anon`.

## Freshness

Data reflects the last push from the shop's registers (≈ 60 s when online). Feature 002 must label stock as
indicative and may cache responses (research R7).
