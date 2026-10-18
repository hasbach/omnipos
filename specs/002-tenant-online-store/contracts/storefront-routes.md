# Contract — Public storefront routes (`storefront/`)

Host forms: `<address>.<storefront domain>` (store host) and `<storefront domain>` (apex). `<address>` is matched
lowercase. All HTML responses: `Content-Type: text/html; charset=utf-8`, `<html lang dir>` per language,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, no cookies set.

| Request | Response | Cache-Control |
|---|---|---|
| store host `/` (`?c=<category>&q=<search>&page=<n>&lang=<en|ar|fr>`) | 200 store home: identity, contact buttons, categories, product grid (48/page), pager | `public, s-maxage=240, stale-while-revalidate=60` |
| store host `/p/<listing uuid>[/<any-slug>]` | 200 product page; 404 "no longer available" page (with store link) when not visible | same as above (404: `s-maxage=60`) |
| apex `/s/<address>[/...]` | same pages as the store host (path form); links stay in path form | same |
| apex `/` | 302 → OmniPOS website | `public, s-maxage=3600` |
| reserved subdomain host (`www.` …) | 301 → apex | `public, s-maxage=3600` |
| unknown address, or store gated off (paused, draft, wholesale, commerce off, license expired, deleted) | 404, one identical neutral "store isn't available" page, no product data, `noindex` | `public, s-maxage=60` |
| unknown path inside a store host | 404 "page not found" | `public, s-maxage=60` |
| any page `?preview=<token>` | page with "Preview — not public" banner if token valid for this store, else as without token | `private, no-store` + `X-Robots-Tag: noindex` |
| `/img/<tenant>/<l|s>/<id>/<name>.webp` | proxied image bytes, `Content-Type: image/webp`; 404 for paths not matching the pattern | `public, max-age=31536000, immutable` |
| `/storefront.css`, `/storefront.js`, `/placeholder.svg` (versioned query) | static | `public, max-age=31536000, immutable` |

## Page content (allow-list)

Only fields returned by the public RPCs ([cloud-api.md](cloud-api.md)) may appear. The HTML and any inline data MUST
NOT contain: cost, cost_lbp, min_price, wholesale / super-wholesale prices, reorder point, track_inventory, tenant or
local ids, product global ids, barcode text (search may match it but it is never printed), email/phone of anyone but
the store's own public contact fields.

## Meta tags (FR-012)

`<title>`: product title — store name (product) / store name (home). `og:title`, `og:description` (price for products,
store description for home), `og:image` (`/img/…` absolute URL of the main photo or logo), `og:url`, `og:locale`.

## Query parameters

| Param | Rule |
|---|---|
| `c` | category name, ≤ 60 chars |
| `q` | search, trimmed, ≤ 60 chars, plain text |
| `page` | integer ≥ 1 (offset = (page-1)×48); out of range → empty page with link to page 1 |
| `lang` | `en`/`ar`/`fr`; anything else ignored |
| `preview` | opaque token, ≤ 64 chars |
