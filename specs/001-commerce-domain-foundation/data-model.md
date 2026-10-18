# Data Model — Commerce Foundation Slice A (Store & Listings)

Local SQLite tables are created additively and idempotently in `server/db.ts` and registered for the standard sync
metadata (`global_id`, `created_at`, `updated_at`, `deleted_at`, `last_synced_at` + triggers). Cloud tables mirror
them with `global_id UUID` primary keys and `tenant_id UUID` (tenant `global_id`), plus `synced_at timestamptz`
(server-time pull cursor, like every other synced table). See [research.md](research.md) for the decisions.

## Setting: `commerce_enabled`

| Key | Values | Default | Meaning |
|---|---|---|---|
| `commerce_enabled` | `'0'` / `'1'` | absent ⇒ `'0'` | Master switch. While `'0'`: store/listing screens are read-only previews (except turning it on), and public functions return nothing. Existing data is kept when switched off. |

Stored in `settings (tenant_id, key, value)`; synced.

## Entity: Store (`stores`)

| Column (local) | Type | Rules |
|---|---|---|
| `id` | INTEGER PK | |
| `tenant_id` | INTEGER NOT NULL | owning tenant; all queries scoped by it |
| `name` | TEXT NOT NULL | 1–80 chars, trimmed |
| `slug` | TEXT | lowercase, see slug rules (research R3); NULL until claimed; globally unique among non-deleted stores (cloud index) |
| `mode` | TEXT NOT NULL DEFAULT `'retail'` | `retail` \| `wholesale` \| `hybrid`. Slice A: stored and shown; public price is always retail |
| `status` | TEXT NOT NULL DEFAULT `'draft'` | `draft` \| `active` \| `paused`. Public only when `active` |
| `description` | TEXT | ≤ 1000 chars |
| `logo_path` | TEXT | Storage path (upload flow in 002) |
| `cover_path` | TEXT | Storage path |
| `primary_color` | TEXT | `#rrggbb` |
| `contact_phone` | TEXT | ≤ 30 |
| `contact_whatsapp` | TEXT | ≤ 30 |
| `contact_email` | TEXT | basic email check |
| `address` | TEXT | ≤ 300 |
| `default_language` | TEXT DEFAULT `'en'` | `en` \| `ar` \| `fr` |
| `settings` | TEXT (JSON) DEFAULT `'{}'` | keys: `show_exact_stock` (0/1, default 0), `hide_out_of_stock` (0/1, default 0), `show_local_price` (0/1, default 1), `category_order` (string[]) — unknown keys rejected |
| sync metadata | | `global_id`, `created_at`, `updated_at`, `deleted_at`, `last_synced_at` |

**Validation**: `status = 'active'` requires a claimed `slug` and `commerce_enabled = '1'` (error
`STORE_NOT_READY`). Slug change is only through the claim flow (`STORE_SLUG_NEEDS_ONLINE` offline,
`STORE_SLUG_TAKEN`, `STORE_SLUG_INVALID`, `STORE_SLUG_RESERVED`).

**State transitions**: `draft → active`, `active ↔ paused`, `paused → draft` not allowed (a used slug stays
claimed). Delete = soft delete (`deleted_at`), which frees the slug in the cloud and soft-deletes its listings.

**Relationships**: one tenant → many stores (UI shows one in Slice A); one store → many listings.

## Entity: Store Listing (`store_listings`)

| Column (local) | Type | Rules |
|---|---|---|
| `id` | INTEGER PK | |
| `tenant_id` | INTEGER NOT NULL | must equal the store's and the product's tenant (`LISTING_TENANT_MISMATCH`) |
| `store_id` | INTEGER NOT NULL → `stores.id` | |
| `product_id` | INTEGER NOT NULL → `products.id` | UNIQUE (`store_id`, `product_id`) among non-deleted rows (`LISTING_DUPLICATE`) |
| `published` | INTEGER NOT NULL DEFAULT 0 | 0/1 |
| `title` | TEXT | ≤ 120; NULL ⇒ product `name` |
| `description` | TEXT | ≤ 4000 plain text |
| `images` | TEXT (JSON) DEFAULT `'[]'` | array of ≤ 8 Storage paths |
| `store_category` | TEXT | ≤ 60; NULL ⇒ product `category` |
| `sort_order` | INTEGER DEFAULT 0 | |
| `min_quantity` | REAL | > 0 or NULL; stored only, enforced from 003 |
| `orderable_unit_ids` | TEXT (JSON) | NULL ⇒ base unit + all product units; else subset of the product's `product_units` ids (validated); stored only, enforced from 003. These are LOCAL ids of the authoring register: the back-office preview filters by them, the cloud public catalog ignores them (003 must switch to unit global ids) |
| sync metadata | | as above |

**Never stored on a listing**: price, cost, stock, unit factors, barcode (FR-011/012).

**Derived (read-time) fields**, computed by `server/commerce.ts` (back-office preview) and the cloud functions:

| Field | Rule |
|---|---|
| `display_title` | `title ?? product.name` |
| `category` | `store_category ?? product.category` |
| `visible` | `published = 1` AND listing not deleted AND product not deleted AND `product.active = 1` AND store `active` AND `commerce_enabled = '1'` (+ license valid, cloud only) |
| `stock_state` | `track_inventory = 0` ⇒ `in_stock`; `stock <= 0` ⇒ `out_of_stock`; `reorder_point > 0 AND stock <= reorder_point` ⇒ `low_stock`; else `in_stock` |
| `price` / `price_lbp` | product retail `price`, `price_lbp` (retail tier; see research R6) |
| `units[]` | non-deleted `product_units` (filtered by `orderable_unit_ids` if set): `name`, `factor`, `price`, `price_lbp` |
| `unavailable_reason` (back office only) | first failing rule: `not_published`, `product_disabled`, `product_deleted`, `store_not_active`, `commerce_off` |

**Bulk publish**: `POST /api/commerce/listings/bulk` creates missing listings and sets `published` for up to 1,000
product ids in one transaction; ids from another tenant fail the whole call (`LISTING_TENANT_MISMATCH`).

## Cloud-only objects (migration `supabase/migrations/2026-10-18_commerce_store_foundation.sql`)

- Tables `public.stores`, `public.store_listings` mirroring the local columns (UUID FKs: `tenant_id →
  tenants.global_id`, `store_id → stores.global_id`, `product_id → products.global_id`), `synced_at` + the same
  trigger used by `2026-10-07_synced_at.sql`.
- Indexes: `UNIQUE (lower(slug)) WHERE deleted_at IS NULL AND slug IS NOT NULL`; `store_listings (store_id,
  published) WHERE deleted_at IS NULL`; `store_listings (product_id)`.
- RLS: owner policies identical to products (`tenant_id::text = auth.uid()::text`) for both tables. **No `anon`
  policy.**
- Functions: `claim_store_slug`, `store_public_get`, `store_public_listings` — contract in
  [contracts/public-catalog.md](contracts/public-catalog.md).

## Existing entities touched (read-only in Slice A)

| Entity | Used for | Change |
|---|---|---|
| `products` | title/category fallback, price, stock, active, deleted | none |
| `product_units` | public unit list and unit prices | none |
| `settings` | `commerce_enabled` | new key only |
| `tenants` (cloud) | online license check in public functions | none |
| `currencies` | local rate returned with the store | none |
| `user_logs` | audit entries (research R9) | none |
