# Contract: storefront changes for Slice 2

This extends [storefront-routes.md](storefront-routes.md) (Slice 1) and the 002 contract. Everything not listed here
is unchanged. Stores in mode `off` or `whatsapp` render byte-identical pages; only the asset version changes.

## When ordering is enabled

`orderingEnabled(store)` returns true when either rule holds:
- **WhatsApp ordering (Slice 1, unchanged):** `ordering_mode === 'whatsapp'`, the store has WhatsApp digits, and
  pickup or delivery is on.
- **Online orders:** `ordering_mode === 'online'`, pickup or delivery is on, and the storefront has
  `ORDER_GATEWAY_KEY`. Without the key, an online-mode store renders as if ordering were off, and the log warns once.

`onlineOrdering(store)` returns true when the second rule holds.

## Request plumbing (`node-server.ts` → `handle()`)

`handle()` receives four values:
- `host` and `url`, as today.
- `method`: one of `GET`, `HEAD`, `POST`. Any other method gets 405 with `Allow`.
- `body` (POST only), read up to **16 KB**. A larger body gets 413 with `no-store`.
- `network`, built in `src/network.ts`: the visitor address is taken from the first present header in this order:
  `CF-Connecting-IP`, `True-Client-IP`, the **last** entry of `X-Forwarded-For`, then the socket address. The value
  sent onward is `sha256(utcDate + '|' + address + '|' + ORDER_GATEWAY_KEY)` as hex. The raw address is never logged
  or forwarded.

POST is accepted only on the routes below; a POST anywhere else gets 405.

## New routes

`<root>` is the store root:
- host form: `<address>.<domain>`;
- path form: `<domain>/s/<address>`.

| Route | Method | Request | Response | Headers |
|---|---|---|---|---|
| `<root>/order/quote` | POST | JSON `{ lines: [{ listing, unit, qty, price? }] }` | 200 JSON `{ ok, code, quote }` (cloud `order_quote`) | `Cache-Control: no-store`, `X-Robots-Tag: noindex` |
| `<root>/order` | POST | JSON `{ attempt, status_key, customer: { name, phone, fulfilment, address?, note? }, lines, expected_total_usd, website }` | 200 JSON from `order_submit` (`created` / `existing` / `changed` / `invalid` / `phone_limit` / `network_limit` / `refused` / `store_unavailable`); `created` and `existing` also get `status_url` = `<root>/o/<status_key>` | same |
| `<root>/o/<key>` | GET/HEAD | — | 200 server-rendered status page, or a 404 neutral page | `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer` |
| `<root>/o/<key>/cancel` | POST | form `confirm=1` | 303 → `<root>/o/<key>` (with `?cancelled=1` or `?not_cancellable=1`) | `no-store` |

Rules for these routes:
- `<key>` must match `[A-Za-z0-9_-]{32}`; anything else gets a 404 without calling the cloud.
- A JSON POST without `Content-Type: application/json` gets 415.
- Malformed JSON gets 400 `{ ok:false, code:'bad_request' }`.
- Cloud unreachable gets 503 JSON `{ ok:false, code:'unavailable' }` with `Retry-After: 30`. The browser then offers
  the WhatsApp fallback (FR-022).
- Preview tokens (`?preview=`) are not accepted on order routes: an owner preview never creates orders.
- No route sets cookies or `Vary`.

## Cart page in online mode (`render/cart.ts`)

The cart page keeps the Slice 1 layout and form, with these changes:
- Phone is required (`required`, `inputmode="tel"`, maxlength 30).
- A hidden trap field `website` sits in an off-screen container with `tabindex="-1"` and `autocomplete="off"`.
- The submit button reads "Review order". After a quote it becomes "Place order". The payment note says payment is
  on pickup or delivery.
- New containers:
  - `#sf-quote`: the review list, with changed lines marked.
  - `#sf-confirm`: number, status link, copy button, "Back to store".
  - `#sf-myorders`: "My orders", drawn by `order.js`.
- `order.js` is loaded with `defer` after `cart.js` and `checkout.js`, only when `onlineOrdering(store)`.
- The `#sf-order` JSON gains:
  - `mode: 'online'`;
  - `api: { quote: '<base>/order/quote', submit: '<base>/order' }`;
  - the order UI strings (`ORDER_UI_KEYS`, en/ar/fr).

## `order.js` behaviour (browser)

- **Review.** POST `order/quote` with the available cart lines (listing, unit, qty, price shown). Show the returned
  lines with these markings:
  - price changed: old price struck through, new price highlighted;
  - unit no longer orderable, out of stock, or listing gone: the line is greyed out with the reason and left out of
    the order;
  - below a listing or store minimum: the message from Slice 1.

  The visitor must press "Place order" on this exact quote.
- **Attempt and status keys.** The browser makes two keys: an attempt UUID (`crypto.randomUUID()`, with a fallback
  built on `getRandomValues`) and a status key (24 random bytes as base64url, 32 chars). Both are stored in
  `sf-attempt:v1:<address>` together with a hash of the cart lines. New keys are made only when the lines change. The
  same pair is sent on every retry, so a retry after a dropped connection ends with the same order and a working link.
- **Place.** POST `order` with the quote's line prices and `expected_total_usd`. The browser handles each response:

| Response | Browser action |
|---|---|
| `created` | Store `{number, key, at, state:'submitted'}` in My orders, clear the cart and attempt key, show the confirmation with `status_url`. |
| `existing` | Same as `created`: the order was already received, and the browser holds its status key. |
| `changed` | Re-render the review with the new quote. Nothing is sent until the visitor confirms again. |
| `invalid` | Show the message next to the field. |
| `phone_limit` / `network_limit` | Show "too many orders, contact the shop" with the contact buttons. |
| `refused` | Show the generic error. |
| `unavailable` / network error | Show the FR-022 message. If the store has WhatsApp, also offer "Send on WhatsApp instead", which uses `OmniCheckout`'s Slice 1 message. The cart is kept. |

- **My orders.** Show up to 20 entries, each with its number, date, last known state, and a link to `<root>/o/<key>`.
  The list is only on this device and can be removed with "Forget".
- **Limits.** The script is plain ES2017 with no dependencies and at most **12 KB** (LF). Network requests use
  `fetch` with a 15 s timeout through `AbortController`.

## Status page (`render/status.ts`)

The status page is server-rendered. Every request calls `order_status`, and nothing is cached. It shows:
- the store name and logo;
- the order number and state, as a badge plus a sentence per state: waiting / accepted / ready / completed / rejected
  with the shop's reason / cancelled by you or by the shop with the reason / expired;
- the lines with ordered and confirmed quantities and their shortfall reasons;
- the totals: confirmed when the order is accepted, ordered otherwise;
- pickup (with the store's pickup note) or delivery (with the address);
- the customer's first name;
- the contact buttons (002).

While the state is `submitted`, `confirmed` or `ready`, the page has `<meta http-equiv="refresh" content="60">`
(FR-028).

"Cancel order" (a form POST to `cancel`) appears only in `submitted`. After acceptance the page says to contact the
shop.

The page works without JavaScript. When `order.js` is present (it is loaded on the status page too, for My orders), it
updates the visitor's My orders state.

## Budgets and assets

- `order.js` ≤ 12 KB, enforced in `tests/storefront-routing.test.ts`. It is added to `ASSETS` in `node-server.ts` and
  to the `ASSET_VERSION` hash.
- Status page HTML ≤ 30 KB. CSS stays ≤ 24 KB, the Slice 1 limit.
- The pages of `off` and `whatsapp` stores are unchanged.

## Implementation notes

- Status and customer cancel bypass the store gate, so existing orders remain accessible after a store is paused
  or stops taking orders. A status link under another store address returns 404.
- On cloud failure, status/cancel return a 503 HTML page; quote/submit return the documented 503 JSON. Both set
  `Retry-After: 30`. Cancel redirects preserve `lang` as well as the result flag; `created` / `existing`
  `status_url` also preserves `lang`, and so do the My orders links that `order.js` builds (payload `lang`), so an
  Arabic shopper does not land on a status page in the store's default language.
- The network hash is computed only for POSTs, and only submission sends it to the cloud as `p_network`.
