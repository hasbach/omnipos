# Contract — Storefront changes (Slice 1)

Extends [002 storefront-routes](../../002-tenant-online-store/contracts/storefront-routes.md). Everything not listed
here is unchanged.

## Ordering enabled

`orderingEnabled(store)` = `ordering_mode === 'whatsapp'` && `whatsappDigits(contact_whatsapp)` && (`pickup_enabled` ||
`delivery_enabled`). When false, every page renders exactly as in 002 (no cart link, no controls, no `cart.js`, no
`sf-order` block).

## Routes

| Route | Ordering enabled | Ordering off | Store not public |
|---|---|---|---|
| `<address>.<domain>/cart`, `<domain>/s/<address>/cart` (`?lang=` kept, `?preview=` honoured) | 200 cart page, `Cache-Control: public, s-maxage=240, stale-while-revalidate=60`, `<meta name="robots" content="noindex">` | 302 → store home, `Cache-Control: public, s-maxage=60` | same neutral "store unavailable" page as the home (002 FR-016/017) |

Preview requests keep `private, no-store` on every route.

## Page additions when ordering is enabled

All values are store- or listing-level, identical for every visitor of the URL.

- **Header**: cart link to `<base>/cart` with an empty badge `<span class="sf-cart-count" hidden>` (filled by script).
- **Product page**: a form `.sf-order` with `hidden` attribute: unit `<select>` (only orderable units: base unit when
  `base_orderable`, then `units`), quantity input (`step` 1, or 0.001 for measured base units — research R10; `min` =
  1 or the listing minimum when ordering in base unit), "Add to cart" button. Each `<option>` carries
  `data-unit` (`base` | unit uuid), `data-name`, `data-factor`, `data-price`, `data-price-lbp`. The form carries
  `data-id`, `data-title`, `data-img`, `data-min`, `data-dec`. Not rendered when the listing is out of stock or has no
  orderable unit.
- **Product card**: when the listing has exactly one orderable unit and no minimum above 1 → a small "Add" button with
  the same data attributes (`hidden` until script); otherwise a "Choose" link to the product page. Out of stock → none.
- **`<script type="application/json" id="sf-order">`** (escaped for `</script>`):

```json
{ "address": "abc-market", "home": "https://abc-market.myomnipos.com/", "cart": "/cart",
  "storeName": "ABC Market", "wa": "96171315744",
  "local": { "show": true, "code": "LBP", "symbol": "LL", "rate": 89500 },
  "pickup": { "on": true, "note": "Back door after 4 pm" },
  "delivery": { "on": true, "note": "Achrafieh and Gemmayzeh only" },
  "minOrderUsd": 10,
  "ui": { "...": "cart/checkout strings in the page language" },
  "msg": { "...": "WhatsApp message strings in the store's default language" } }
```

- `<script src="/cart.js?v=<asset version>" defer>` after `storefront.js`.

## Cart page (`render/cart.ts`)

Server-rendered shell: heading, `<div id="sf-cart-lines">` (script fills), totals area, notes ("Prices and availability
are confirmed by the shop", "Payment on pickup or delivery", "Any delivery charge is agreed with the shop"), and the
checkout form:

| Field | Rule |
|---|---|
| Name | required, ≤ 80 |
| Phone | optional in Slice 1, ≤ 30, digits/spaces/`+` |
| Fulfilment | radio for each enabled method; preselected when only one; pickup note / delivery note shown under it |
| Address | required for delivery, ≤ 300 |
| Note | optional, ≤ 300, character counter |
| Remember my details | checkbox (research R2) |
| Submit | "Order on WhatsApp" — disabled when the cart is empty, below `minOrderUsd`, a listing is below its minimum, or the encoded message exceeds the cap |

`<noscript>`: "Ordering needs JavaScript" + 002 contact buttons.

## `cart.js` behaviour

1. Reads `sf-order`; does nothing if absent.
2. Loads/saves the cart (research R2); reveals `[hidden]` order controls; updates the header badge.
3. Add: validates quantity (limits, decimals), merges by (`id`, `unit`), shows a short confirmation (`role="status"`).
4. On every page: refreshes known lines from any listing data on the page (research R3).
5. Cart page: renders lines (quantity stepper, remove), per-line and cart totals in USD and local currency
   (local = `price_lbp × qty` when set, else `round(price × qty × rate)`; totals = sum of line amounts), minimum
   messages, prefill from remembered details.
6. Submit: validates the form, builds the message (below), opens `https://wa.me/<wa>?text=<encoded>` in a new
   tab/window, then asks "Did you send the order?" on return (research R9).

## WhatsApp message (store default language; example in English)

```text
New order — ABC Market
https://abc-market.myomnipos.com/

2 × Halloumi 250g (Pack of 6) — $25.00
1 × Water 1.5L (Piece) — $0.75

Total: $25.75 · 2,304,625 LL
Pickup — Back door after 4 pm
Name: Rana
Phone: 71 315 744
Note: ring the bell twice

Prices to be confirmed by the shop.
```

Delivery replaces the pickup line with `Delivery: <address>`. Lines with fractional quantities show up to 3 decimals.
If `encodeURIComponent(text)` is longer than 6 000 characters the submit is blocked with "This order is too long for
one WhatsApp message — please split it".

## Budgets (tests/storefront-routing.test.ts)

Home HTML with 48 cards ≤ 70 KB; `storefront.js` ≤ 10 KB; `cart.js` ≤ 16 KB; CSS ≤ 24 KB. Bump `ASSET_VERSION`.
