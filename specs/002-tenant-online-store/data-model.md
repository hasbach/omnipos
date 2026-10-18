# Data Model — Tenant Online Store (002)

No local SQLite schema change. Cloud changes are in migration `supabase/migrations/2026-10-19_storefront.sql`
(contract: [contracts/cloud-api.md](contracts/cloud-api.md)).

## Existing entities, new use

### Store (`stores`, 001)

| Field | 002 use |
|---|---|
| `slug` | the address; storefront host `<slug>.<storefront domain>` and path `/s/<slug>` |
| `mode` | `retail` / `hybrid` → may be public; `wholesale` → never public (gate + back-office rule) |
| `status` | `active` required for public view (preview tokens bypass) |
| `logo_path`, `cover_path` | Storage paths `‹tenant gid›/s/‹store gid›/logo-‹rand›.webp`, `…/cover-‹rand›.webp` (uploaded in Settings) |
| `default_language` | storefront default language |
| `settings` | `show_local_price`, `hide_out_of_stock`, `show_exact_stock`, `category_order` (unchanged) |

Validation added: opening (`draft/paused → active`) refused when `mode = 'wholesale'` → `STORE_MODE_NOT_PUBLIC`.

### Store Listing (`store_listings`, 001)

| Field | 002 use |
|---|---|
| `images` | JSON array (max **4**, was 8) of Storage paths `‹tenant gid›/l/‹listing gid›/‹rand›.webp`; index 0 = main photo |

Validation changed: `LISTING_IMAGES_INVALID` above 4; paths must match the pattern above for this tenant/listing when
written through the photo routes (the generic `PUT …/listings/:productId` no longer accepts `images` — photos change
only through the photo routes).

## New cloud entities

### Listing / store photo (Storage object, bucket `store-images`)

| Property | Rule |
|---|---|
| Bucket | `store-images`, public read, `file_size_limit` 2 MB, `allowed_mime_types` = `image/webp` |
| Path | `‹tenant global id›/l/‹listing global id›/‹22-char random›.webp` or `‹tenant gid›/s/‹store gid›/(logo|cover)-‹random›.webp` |
| Write | insert/update/delete only when the first path segment = `auth.uid()` (owner business) |
| Lifecycle | uploaded → referenced by `images`/`logo_path`/`cover_path`; deleting the reference deletes the object; objects are immutable (new photo = new name) |

### Store preview token (`store_preview_tokens`)

| Column | Type | Rule |
|---|---|---|
| `token` | text PK | 43-char URL-safe random (32 bytes) |
| `store_id` | uuid → `stores.global_id` | |
| `tenant_id` | uuid | owner, = `auth.uid()` at creation |
| `created_at` | timestamptz | default now() |
| `expires_at` | timestamptz | now() + 30 min |

RLS on, no policies (only reachable through `SECURITY DEFINER` functions). Expired rows are removed opportunistically
by `create_store_preview_token`.

## Public read models (RPC results, allow-listed)

- `store_public_get(p_slug, p_preview)` → store identity, contact, display settings, local currency, categories —
  unchanged columns plus `logo_path`, `cover_path` (already there) and `is_preview boolean`.
- `store_public_listings(p_slug, p_category, p_search, p_limit, p_offset, p_preview)` → unchanged columns.
- `store_public_listing(p_slug, p_listing uuid, p_preview)` → **new**, one row with the same columns as
  `store_public_listings` minus `total_count`; nothing when the listing isn't visible.

## Derived on the storefront (display only)

| Value | Rule |
|---|---|
| local price | `price_lbp` if set, else `round(price × local_rate)`; only if `show_local_price` and a local currency exist |
| stock label | `in_stock` / `low_stock` / `out_of_stock` → localized label + "availability is indicative" note |
| image URL | `/img/<path>`; no photo → `/placeholder.svg` |
| WhatsApp link | `https://wa.me/<digits of contact_whatsapp>?text=<localized message with product name + page URL>` |
| product URL | `/p/<listing_id>` (+ `?lang=` when not the store default) |
