# Research — B2C Retail Ordering (003)

Decisions for [plan.md](plan.md). Format: decision, rationale, alternatives. R1–R10 are Slice 1 (WhatsApp order);
R11 records the Slice 2 direction only (it gets its own research pass before its tasks).

## R1 — Pages stay identical: cart is client-side, store-level data is server-rendered

- **Decision**: The server renders only data that is the same for every visitor of a URL: "Add to cart" controls
  (when the store's ordering mode is on), each orderable unit's price data in `data-` attributes, and one small JSON
  block per page (`<script type="application/json" id="sf-order">`) with the store's ordering settings, local-currency
  rule, WhatsApp digits and translated cart/message strings. Everything that differs per visitor — cart contents,
  cart count badge, remembered details — is drawn by JavaScript from `localStorage`. No cookies, no `Vary`.
- **Rationale**: FR-004/FR-005; the 002 cache (`s-maxage=240`, key = URL) keeps working unchanged, so SC-002 holds.
- **Alternatives**: server-side cart keyed by a cookie (breaks edge caching, stores visitor data); a client-rendered
  SPA storefront (loses link previews and page weight from 002).

## R2 — Cart storage format

- **Decision**: `localStorage["sf-cart:v1:<address>"]` = `{ v: 1, updated: <ms>, lines: [{ id, unit, qty, title, img,
  name, factor, price, price_lbp, min, dec }] }` where `id` = listing global id and `unit` = unit key (R5). One key per
  store address, so the path form (all stores share `myomnipos.com`) and the host form (one origin per store) behave
  the same. Remembered details: `localStorage["sf-buyer:v1:<address>"]` only when the visitor ticks "remember".
  Corrupt or wrong-version values are discarded. When storage throws (private mode, blocked), the cart lives in memory
  for the visit and the cart page shows a "won't be remembered" note.
- **Rationale**: FR-004, FR-011, edge case "browser storage unavailable"; versioned key allows Slice 2 to migrate.
- **Alternatives**: `sessionStorage` (loses the cart on browser restart — US1 AS4); IndexedDB (overkill, async).

## R3 — Price freshness in Slice 1

- **Decision**: A cart line keeps the price data captured when it was added. Whenever the visitor views a page that
  shows the same listing (product page or card), the script refreshes that line's name, prices and orderable state
  from the page's `data-` attributes, and drops units that are no longer offered. The cart and the WhatsApp message
  say prices are confirmed by the shop. No extra request is made.
- **Rationale**: Slice 1 stores nothing and the shop confirms every WhatsApp order by hand; a pricing endpoint would
  add cloud reads for no binding result. Binding re-pricing is Slice 2 (FR-017/FR-018, done server-side at submit).
- **Alternatives**: a cacheable `/api/listings?ids=` endpoint backed by a new RPC (cost and an extra public surface
  for an indicative number); re-fetching each product page from the cart (up to 50 requests).

## R4 — Cart page and checkout route

- **Decision**: New route `/cart` (host form) and `/s/<address>/cart` (path form). The server renders a per-store shell
  — header, empty cart container, checkout form (name, phone optional, pickup/delivery radios for what the store
  offers, address, note, remember checkbox), pickup instructions / delivery-area text, minimum order, "payment on
  pickup or delivery" — with `Cache-Control: public, s-maxage=240` like other store pages and `noindex`. The script
  fills lines and totals. Without JavaScript the page says ordering needs JavaScript and shows the contact buttons;
  "Add to cart" controls ship with the `hidden` attribute and are revealed by the script. Ordering off / store not
  public → the cart route answers like the store home would (unavailable page) or, when the store is public but
  ordering is off, redirects (302, short cache) to the store home.
- **Rationale**: FR-005, FR-009, FR-012; same handler and caching rules as 002.
- **Alternatives**: a cart drawer on every page (bigger HTML on every cached page, harder on small phones).

## R5 — Orderable units: one identifier everywhere

- **Decision**: `store_listings.orderable_unit_ids` becomes a JSON array of **unit keys**: `"base"` for the product's
  base unit or the `global_id` of a `product_units` row; `NULL` = every live unit (today's behaviour). The desktop
  server converts on write (API now takes keys) and a one-time idempotent local migration converts existing integer
  arrays: old semantics always included the base unit, so `[3,5]` → `["base", <gid 3>, <gid 5>]`; ids with no row or
  no global id are dropped; an empty result becomes `NULL`. Converted rows are marked for push like any edit. The cloud
  RPCs apply the list only when it is an array of strings; legacy integer arrays (older registers) are ignored, i.e.
  all units orderable (FR-039 fallback). At least one key is required when a restriction is set.
- **Rationale**: FR-039/FR-040; global ids already exist on `product_units` and survive sync; `"base"` covers the base
  unit, which has no `product_units` row.
- **Alternatives**: translate ids during sync (sync never rewrites JSON contents — 001 note); a join table
  `store_listing_units` (new synced table, more migration work, no extra value).

## R6 — Ordering settings live in `stores.settings`

- **Decision**: New keys in the existing settings JSON: `ordering_mode` (`off` | `whatsapp` | `online`), `pickup_enabled`,
  `pickup_note`, `delivery_enabled`, `delivery_note`, `min_order_usd`; Slice 2 adds `order_expiry_hours` and the
  blocked-phone list (separate table). Defaults: `off`, pickup on, delivery off, notes empty, no minimum. Server
  validation: `whatsapp` requires a usable WhatsApp number (`normalizeWhatsapp`) and at least one fulfilment method;
  `online` is refused with `ORDERING_MODE_UNAVAILABLE` until Slice 2; clearing the WhatsApp number while the mode is
  `whatsapp` is refused (`STORE_ORDERING_NEEDS_WHATSAPP`); notes ≤ 200 characters; minimum 0–100 000 USD, 2 decimals.
- **Rationale**: FR-016, FR-045, Constitution VII (default off); `settings` already syncs and is read by
  `_store_public_settings`, so no new column on `stores`.
- **Alternatives**: new `stores` columns (cloud + local migration for every key).

## R7 — Cloud catalog changes (migration `2026-10-21_retail_ordering_s1.sql`)

- **Decision**: `_store_public_settings` defaults gain the ordering keys. `store_public_get` returns `ordering_mode`,
  `pickup_enabled`, `pickup_note`, `delivery_enabled`, `delivery_note`, `min_order_usd`; `store_public_listings` and
  `store_public_listing` return `base_orderable boolean` and only orderable units (R5). Because `RETURNS TABLE` changes,
  each function is dropped and recreated inside one transaction with the same grants (anon + authenticated EXECUTE).
  The storefront treats missing fields as "ordering off" and "all units orderable", so deploying it before or after the
  migration is safe; the gate (`_store_public_store`) is unchanged.
- **Rationale**: FR-002, FR-040, FR-046 (settings reach the storefront through the cached pages within 5 minutes).
- **Alternatives**: a separate `store_public_ordering` RPC (one more upstream call per uncached page).

## R8 — WhatsApp message

- **Decision**: Built in the browser in the **store's** default language (the shop reads it), names as typed. Layout:
  store name and link; one line per item `qty × name (unit) — line total`; totals in USD and local currency when shown;
  "Pickup" or "Delivery: <address>"; name, phone if given; note; "Prices to be confirmed by the shop". Opened as
  `https://wa.me/<digits>?text=<encoded>`, digits from the same `whatsappDigits` rule as the contact buttons (shipped
  to the page in the `sf-order` JSON, so the rule is applied once on the server). If the encoded URL exceeds 6 000
  characters (Arabic text expands ~6× when percent-encoded), checkout is blocked with "split your order"; the 50-line /
  999 quantity cart limits (FR-007) keep normal carts well below it.
- **Rationale**: FR-013/FR-014; wa.me works on Android, iOS and WhatsApp Web without an API account; ~6 000 encoded
  characters is within what all three open reliably (validated manually in quickstart §3).
- **Alternatives**: WhatsApp Business API (paid, server-side, stores data — Slice 2 territory at best); `whatsapp://`
  scheme (fails on desktop without the app).

## R9 — "Did you send it?"

- **Decision**: After opening WhatsApp, the cart page shows a dialog "Did you send the order?" when the page becomes
  visible again (`visibilitychange`/`focus`) or after the visitor taps a fallback "Back from WhatsApp" link. "Yes"
  clears the cart (remembered details stay if chosen); "No" keeps it.
- **Rationale**: FR-015; we can't observe WhatsApp, so the visitor confirms.

## R10 — Quantities, minimums, limits and script size

- **Decision**: Integer quantities by default; up to 3 decimals when the line's unit is the base unit and the base unit
  name is a measured unit (kg, g, l, ml, m, cm — compared case-insensitively, plus their Arabic/French spellings in a
  small list). `min_quantity` is in base units per listing: the sum of `qty × factor` over that listing's lines must
  reach it (cart shows "minimum N"). Limits: 50 lines, quantity ≤ 999 per line, note ≤ 300, address ≤ 300, name ≤ 80.
  Cart logic ships as a separate `cart.js` (budget ≤ 16 KB) loaded only on stores with ordering on; `storefront.js`
  stays ≤ 10 KB; HTML budget for the home page with 48 cards rises from 60 KB to 70 KB (per-card unit data).
- **Rationale**: FR-007, FR-040, 002 SC-001 page-weight budgets (tests/storefront-routing.test.ts).
- **Alternatives**: a decimal flag on products (doesn't exist; out of scope).

## R11 — Slice 2 direction (outline, not decided in detail)

- Orders are written in the cloud only, through SECURITY DEFINER RPCs: `order_submit` (anon; re-prices from the
  catalog, idempotency key, per-phone/per-network counters, bot trap, returns number + status key), `order_status` /
  `order_cancel` (anon, by status key), and owner RPCs for accept/adjust/reject/ready/cancel/complete that check the
  current state in one statement (first action wins, FR-027).
- New cloud tables `orders`, `order_lines`, `order_events`, `order_blocked_phones`, all with `tenant_id`, RLS for the
  owner, no anon policy. Registers pull them as a hot sync table (read-only locally) and raise the notification.
- "Complete sale" opens a POS sale tab pre-filled from the order; `transactions` (and `archived_transactions`) gain
  `order_global_id`; completion is recorded through the owner RPC with the sale's global id, refusing a second sale.
- Status page `/o/<key>`: `Cache-Control: private, no-store`, `noindex`.
- The order model follows 001's single order model (state subset, ordered vs confirmed quantity) so 006 extends it.
