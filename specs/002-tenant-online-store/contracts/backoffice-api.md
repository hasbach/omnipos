# Contract — Back-office additions (local Express server)

Extends [001 backoffice-api](../../001-commerce-domain-foundation/contracts/backoffice-api.md). Same error body and
ROUTE_RULES conventions; every write is audited with `logAction`.

## Status

`GET /api/commerce/status` gains:

| Field | Meaning |
|---|---|
| `storefront_origin` | e.g. `https://omnipos.shop` (build-time constant until the domain is bought) |
| `store.public_url` | `https://<slug>.<domain>` when a slug is claimed, else null |
| `store.publicly_visible` | local estimate: active + retail/hybrid + commerce on + license valid |
| `store.not_public_reason` | `draft` \| `paused` \| `wholesale` \| `commerce_off` \| `license` \| null |

## Store rules

- `POST /api/commerce/stores/:id/status {status:'active'}` on a Wholesale store → 409 `STORE_MODE_NOT_PUBLIC`.
- Reserved list = FR-004 (shared constant `RESERVED_SLUGS`).

## Photos (permission `store.publish`)

| Route | Body / result |
|---|---|
| `POST /api/commerce/stores/:id/listings/:productId/photos` | raw `image/webp` body ≤ 2 MB (already resized in the renderer) → `ListingView`. Creates the listing (unpublished) if missing. Codes: `LISTING_IMAGES_INVALID` (5th photo, wrong type, > 2 MB), `STORE_PHOTO_NEEDS_ONLINE` (503), `STORE_PHOTO_UPLOAD_FAILED` (502) |
| `PUT /api/commerce/stores/:id/listings/:productId/photos` | `{ images: string[] }` — a permutation / subset of the current paths (reorder, remove; index 0 = main) → `ListingView`; removed paths are deleted from Storage (needs online; offline → `STORE_PHOTO_NEEDS_ONLINE`, nothing changes) |

`PUT …/listings/:productId` no longer accepts `images` (400 `LISTING_FIELD_INVALID`, field `images`).

## Logo / cover (permission `store.manage`)

| Route | Body / result |
|---|---|
| `POST /api/commerce/stores/:id/branding/:kind` (`kind` = `logo` \| `cover`) | raw `image/webp` ≤ 2 MB → `Store`; replaces the previous object (old one deleted) |
| `DELETE /api/commerce/stores/:id/branding/:kind` | → `Store` with the path cleared; object deleted |

## Preview (permission `store.view`)

| Route | Result |
|---|---|
| `POST /api/commerce/stores/:id/preview` | `{ url }` = `<public or path url>?preview=<token>`; needs online (`STORE_PREVIEW_NEEDS_ONLINE`) and a claimed address (`STORE_NOT_READY`) |

## ROUTE_RULES to add

```text
POST   /api/commerce/stores/:id/listings/:productId/photos   store.publish
PUT    /api/commerce/stores/:id/listings/:productId/photos   store.publish
POST   /api/commerce/stores/:id/branding/:kind                store.manage
DELETE /api/commerce/stores/:id/branding/:kind                store.manage
POST   /api/commerce/stores/:id/preview                       store.view
```

(The `…/listings/:productId/photos` rules must sit above the `…/listings/:productId` rules — first match wins.)
