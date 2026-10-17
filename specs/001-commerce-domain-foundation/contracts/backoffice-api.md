# Contract — Back-office API (local Express server)

All routes are authenticated (tenant session), scoped by the session tenant and listed in `ROUTE_RULES`
(`server/permissions.ts`). Errors use the existing body `{ error, code, field }` from `ValidationError`; the UI maps
`code` with `translateServerError` (en/ar/fr). Every write records a `logAction` entry (research R9).

## Commerce flag

| Method & path | Permission | Body / result |
|---|---|---|
| `GET /api/commerce/status` | `store.view` | → `{ enabled: boolean, online_license_valid: boolean, store: StoreSummary \| null }` |
| `PUT /api/commerce/status` | `store.manage` | `{ enabled: boolean }` → `{ enabled }`. Turning off keeps stores and listings; public reads stop. |

## Stores

| Method & path | Permission | Body / result |
|---|---|---|
| `GET /api/commerce/stores` | `store.view` | → `Store[]` (non-deleted, this tenant) |
| `POST /api/commerce/stores` | `store.manage` | `{ name, mode?, description?, contact_*?, address?, primary_color?, default_language?, settings? }` → `Store` (status `draft`, slug `null`). Works offline. |
| `PUT /api/commerce/stores/:id` | `store.manage` | same fields as POST except `slug`/`status` → `Store` |
| `POST /api/commerce/stores/:id/slug` | `store.manage` | `{ slug }` → `Store`. Validates locally, then calls cloud `claim_store_slug`; saves locally only on success. Codes: `STORE_SLUG_INVALID`, `STORE_SLUG_RESERVED`, `STORE_SLUG_TAKEN`, `STORE_SLUG_NEEDS_ONLINE`. |
| `POST /api/commerce/stores/:id/status` | `store.manage` | `{ status: 'active' \| 'paused' }` → `Store`. `STORE_NOT_READY` when no slug or commerce off; `STORE_BAD_TRANSITION` otherwise. |
| `DELETE /api/commerce/stores/:id` | `store.manage` | soft delete store + its listings → `{ ok: true }` |

`Store` = data-model columns except sync metadata, plus `global_id`, `public_url` (null until slug claimed).
`settings` unknown keys → `STORE_SETTINGS_INVALID` with `field`.

## Listings

| Method & path | Permission | Body / result |
|---|---|---|
| `GET /api/commerce/stores/:id/listings?published=&category=&search=&limit=&offset=` | `store.view` | → `{ rows: ListingView[], total }` |
| `GET /api/commerce/products/:productId/listings` | `store.view` | → `ListingView[]` (one per store) — used by the product drawer |
| `PUT /api/commerce/stores/:id/listings/:productId` | `store.publish` | upsert `{ published?, title?, description?, images?, store_category?, sort_order?, min_quantity?, orderable_unit_ids? }` → `ListingView` |
| `POST /api/commerce/stores/:id/listings/bulk` | `store.publish` | `{ product_ids: number[] (≤ 1000), published: boolean }` → `{ created, updated }`; all-or-nothing |
| `DELETE /api/commerce/stores/:id/listings/:productId` | `store.publish` | soft delete → `{ ok: true }` |

`ListingView` = listing channel fields + derived fields from [data-model.md](../data-model.md): `display_title`,
`category`, `visible`, `unavailable_reason`, `stock_state`, `price`, `price_lbp`, `units[]`, and — back office only —
`product: { id, name, barcode, active, stock }`. Never includes `cost`, `cost_lbp`, `min_price` (they are not needed
here either, keeping the allow-list identical in spirit to the public one).

Error codes: `LISTING_TENANT_MISMATCH`, `LISTING_DUPLICATE`, `LISTING_UNIT_INVALID`, `LISTING_IMAGES_INVALID`,
`LISTING_FIELD_TOO_LONG` (with `field`), `STORE_NOT_FOUND`, `PRODUCT_NOT_FOUND`.

## Permission rules to add (`ROUTE_RULES`)

```text
GET    /api/commerce/status                        store.view
PUT    /api/commerce/status                        store.manage
GET    /api/commerce/stores                        store.view
POST   /api/commerce/stores                        store.manage
PUT    /api/commerce/stores/:id                    store.manage
POST   /api/commerce/stores/:id/slug               store.manage
POST   /api/commerce/stores/:id/status             store.manage
DELETE /api/commerce/stores/:id                    store.manage
GET    /api/commerce/stores/:id/listings           store.view
GET    /api/commerce/products/:productId/listings  store.view
PUT    /api/commerce/stores/:id/listings/:productId store.publish
POST   /api/commerce/stores/:id/listings/bulk      store.publish
DELETE /api/commerce/stores/:id/listings/:productId store.publish
```
