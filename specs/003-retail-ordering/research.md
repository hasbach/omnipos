# Research — B2C Retail Ordering (003)

Decisions for [plan.md](plan.md). Format: decision, rationale, alternatives. R1–R10 are Slice 1 (WhatsApp order);
R11 records the Slice 2 direction; R12–R25 are the Slice 2 research pass for [plan-s2.md](plan-s2.md) (2026-10-22).

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

---

# Slice 2 research pass (2026-10-22)

Inputs: R11, the code as merged in v1.9.0 + PR #4, and two code surveys (storefront/cloud and desktop). Findings that
shaped the decisions: the storefront holds **no server-side secret** (only the public anon key); `node-server.ts`
ignores the HTTP method and never reads a body (a POST today gets the cached page); `cart.js` is 92 bytes under its
16 KB budget; there is **no post-pull hook** to tell the UI about pulled rows; no cloud call from the desktop has a
**timeout**; there is no way to open a POS sale tab **pre-filled**; customer phones are free text and never normalised;
`pg_cron` is available but not installed in the cloud project; `pgcrypto` is installed.

## R12 — Storefront-only order gateway (shared key) and the visitor's network

- **Decision**: The public order RPCs (`order_quote`, `order_submit`, `order_status`, `order_cancel`) are callable by
  `anon` but refuse every call that does not carry a valid **gateway key**. The key is a random 32-byte secret held only
  by the storefront service (Render env var `ORDER_GATEWAY_KEY`, `sync: false` in `render.yaml`); the cloud stores only
  its SHA-256 in a private table `storefront_gateway_keys` (RLS on, no policy, functions only), inserted once by the
  owner in the Supabase SQL editor. The storefront derives the visitor's network from the address its edge reports
  (checked in order: `CF-Connecting-IP`, `True-Client-IP`, the **last** `X-Forwarded-For` hop, the socket address —
  the exact header is confirmed on Render in quickstart-s2 §1) and sends only `network = sha256(day || ip || key)`, so
  the cloud never sees an IP and the hash rotates daily. Rotation: insert a new hash, change the env var, revoke the
  old row (`revoked_at`).
- **Rationale**: FR-041 asks for per-network limits; with only the public anon key anyone could call the RPC directly
  and invent the network. User decision 2026-10-22: gateway (recommended option). No secret enters the repository.
- **Alternatives**: per-phone limits only (no setup, but per-network limits become fake — rejected by the user);
  service-role key in the storefront (a far more powerful secret than needed); Supabase Edge Function in front of the
  RPC (a second deployable for the same check).

## R13 — Order tables are cloud-authoritative; 001-compatible subset

- **Decision**: New cloud tables `orders`, `order_lines`, `order_events` (synced shape: `global_id`, `tenant_id` =
  tenant UUID, `updated_at`, `synced_at` + trigger, `deleted_at`; RLS with an owner **SELECT** policy only — every
  write goes through SECURITY DEFINER functions) plus private `order_counters`, `order_blocked_phones`,
  `storefront_gateway_keys` (RLS on, no policy). States are stored as 001 names so 006 extends the same model:
  `submitted` (UI "New"), `confirmed` ("Accepted"), `ready`, `completed`, `rejected`, `cancelled`, `expired`;
  `cancelled_by` = `customer` | `shop`. Lines keep `ordered_qty` and `confirmed_qty` separately (001 FR-015; shipped /
  received are not used in B2C and are not created), with `shortfall_reason` from 001 FR-016's list restricted to
  Out of stock (`supplier_out_of_stock` in 001 terms → stored `out_of_stock`), `damaged`, `customer_request`, `other`.
  All lines confirmed at 0 ⇒ the accept is refused and the user is told to reject (001 edge case; spec US4 AS4).
- **Rationale**: FR-024–FR-027, FR-019; spec dependency on 001 Slice B ("defines this B2C subset so that 006 extends
  the same model"). Owner-only SELECT keeps the sync pull working (it reads with the user's session) while making
  atomic, validated RPCs the only write path (first action wins).
- **Alternatives**: write orders locally and push them (the storefront has no local database; two registers could
  diverge); full 001 order model with relationships (not needed for B2C, R11).

## R14 — Quote and submit: server re-pricing, validation, idempotency

- **Decision**: `order_quote(key, slug, lines)` (read-only) and `order_submit(...)` both run one validation routine
  over the store's **current public catalog** through the same visibility gate as the storefront (`_store_public_store`
  + `ordering_mode = 'online'` + a fulfilment method on). Per line (listing id, unit key, qty): listing published and
  product live/active; unit key orderable (`_store_orderable_keys` rules, base unit by default); not `out_of_stock`;
  qty > 0, ≤ 999, integer unless the unit is the base unit of a measured product (≤ 3 decimals); listing minimum
  (base units, summed over its lines); ≤ 50 lines; store minimum order. Prices: retail tier only (`products.price` /
  `product_units.price`), local unit price = the unit's own `price_lbp` when > 0, else `round(usd × rate)` with the
  store's local currency (first non-USD currency, as `store_public_get`); line USD = `round(price × qty, 2)`, line
  local = `round(local_unit × qty)`; totals are sums — exactly `cart.js` `lineAmounts`/`totals`. The browser sends the
  quote it showed (`expected_total_usd` + per-line prices); if anything differs, `order_submit` returns
  `code = 'changed'` with the fresh quote and creates nothing (FR-017/FR-018, SC-004). Idempotency: the browser keeps a
  random UUID per checkout attempt (reset when the cart changes); `UNIQUE (store_id, idempotency_key)`; a repeat
  returns the first order's number and status key (FR-020, SC-008).
- **Rationale**: Constitution IV (prices never from the browser); one routine for quote and submit means the visitor
  confirms exactly what will be stored.
- **Alternatives**: storefront computes prices (it only has cached pages, which may be 4 minutes old); accept the
  browser's prices within a tolerance (violates SC-004).

## R15 — Order number and private status key

- **Decision**: Order number per store from `order_counters (store_id PK, last_no)` with
  `INSERT … ON CONFLICT DO UPDATE SET last_no = last_no + 1 RETURNING` (atomic, gap-free enough), shown as `W-<n>`
  starting at 1001. Status key = 24 random bytes as base64url (32 chars), **generated by the
  browser** (`crypto.getRandomValues`) together with the attempt key and sent with the submission; the cloud checks
  the format and stores only its SHA-256 (`status_key_hash`, unique). A retry of the same attempt (dropped connection)
  sends the same key, so the visitor always ends up with a working link; the replay is answered only when the hash
  matches the stored one. A key generated in the cloud would be lost exactly in the dropped-connection case FR-020
  exists for, unless it were stored in plain text. Status URL:
  `<store>/o/<key>` (host form `abc.myomnipos.com/o/<key>`, path form `/s/abc/o/<key>`).
- **Rationale**: FR-021 (short human number, unguessable link); a stolen database dump does not reveal working links.
- **Alternatives**: sequence per tenant (numbers jump between stores); UUID as public number (not human-readable).

## R16 — Abuse limits

- **Decision**: Checked inside `order_submit`, in this order, each refusal with its own code: bot trap (hidden field
  `website` must be empty → `refused`, shown by the storefront as a generic "could not send" error); blocked phone for this
  store → `refused`; per phone per store: ≤ 5 orders in the last hour and ≤ 3 in state `submitted` → `phone_limit`;
  per network per store ≤ 10 / hour and per network across all stores ≤ 30 / hour → `network_limit`; field limits
  (name 1–80, phone 8–15 digits after normalisation, address ≤ 300 and required for delivery, note ≤ 300) →
  `invalid` with the field. Counters are `COUNT(*)` over `orders` with indexes on `(store_id, customer_phone,
  submitted_at)` and `(network_hash, submitted_at)`; refused attempts are not stored. Phones are normalised with the
  storefront's rule (`storefront/src/phone.ts`: 7–8 local digits → +961, leading 0/00/+ handled) in the storefront
  **and** re-checked in SQL (digits only, 8–15).
- **Rationale**: FR-041 / SC-009 (a customer with 3 orders a day is never refused); no OTP (clarification).
- **Alternatives**: a counters table with windows (more writes, same effect at this volume); CAPTCHA (third-party
  script, cookies — FR-044).

## R17 — Expiry without a scheduler

- **Decision**: `expires_at = submitted_at + order_expiry_hours` (store setting, 1–72, default 24) is set at submit.
  An internal `_orders_expire(tenant)` turns overdue `submitted` orders into `expired` (+ history entry, actor
  `system`) and is called at the start of every order RPC that touches the tenant (submit, status, cancel, every owner
  action) **and** by the desktop through `orders_sweep()` right before each orders pull, so registers see Expired
  within one pull. Every reader also treats `submitted` with `expires_at < now()` as expired, so a page is never wrong
  between sweeps. Owner actions on an overdue order return `code = 'expired'`.
- **Rationale**: FR-024/US4 AS8 without enabling `pg_cron` (not installed; another moving part to monitor).
- **Alternatives**: `pg_cron` job every 5 minutes (works, but needs the extension and leaves the same gap between
  runs); expiry computed only on read (rows never change state, so history and counts lie).

## R18 — Registers mirror orders read-only; faster orders pull; post-pull broadcast

- **Decision**: Local SQLite gets `orders`, `order_lines`, `order_events` (same columns; created before the
  sync-metadata loop). They are added to `fkMap` (`tenant_id`, `store_id → stores`, `order_id → orders`,
  `product_id → products`, `sale_id` stays a global id text), `PULL_TABLES` and `HOT_PULL_TABLES`, **never** to
  `PUSH_TABLES`. The `tenants` special cases in `sync.ts` (skip the "pending local edit" guard, skip the clean-only
  fallback filter) become a `CLOUD_AUTHORITATIVE = {tenants, orders, order_lines, order_events}` set, so the cloud
  always wins. Child tables carry their own `tenant_id` (no `EMBED_PARENT`). While any store of the tenant is in
  `online` mode, an orders-only pull runs every **30 s** (after `orders_sweep()`); otherwise orders ride the 60 s hot
  pull. `pullFromCloud` returns per-table counts of inserted/updated rows, and `startSyncEngine({ onPulled })` lets
  `server.ts` broadcast `ORDERS_UPDATED { newSubmitted }` to the tenant's sockets when order rows changed.
- **Rationale**: FR-030/SC-005 (notification within 1 minute in 95%: 30 s pull + render); FR-032 (offline read-only
  view comes for free); the generalised set fixes the found trap where a locally-touched row would never be
  overwritten again.
- **Alternatives**: Supabase Realtime subscription (websocket per register, more egress and reconnect logic);
  pulling orders on the cold 5-minute cycle (misses SC-005).

## R19 — Shop actions go through owner RPCs with a timeout, then update the mirror

- **Decision**: Back-office routes `POST /api/orders/:id/{accept,reject,ready,cancel}` call owner RPCs
  (`order_accept`, `order_reject`, `order_ready`, `order_cancel_by_shop`) with the active session, wrapped in a 10 s
  timeout (`withTimeout`, new helper in `server/cloudCall.ts`, also used by completion). Each RPC locks the order row
  (`SELECT … FOR UPDATE`), checks the expected current state, applies the change, writes history (actor = user name +
  register id passed by the desktop) and returns `jsonb {ok, code, order, lines}`; on success the desktop writes the
  returned rows into its mirror immediately (marked synced) and broadcasts `ORDERS_UPDATED`. Mapping: no session /
  timeout / network → `ORDER_NEEDS_ONLINE` (503); `handled` → `ORDER_ALREADY_HANDLED` (409, with the current state);
  `expired`, `invalid_transition`, `confirm_exceeds`, `reason_required`, `all_zero` → 400/409 codes. Codes start with
  `ORDER_` and are added to the commerce prefix in `src/lib/serverErrors.ts`.
- **Rationale**: FR-027 (atomic, first action wins, online only), SC-006; the existing `commerceStorage` pattern
  (`CloudResult`) and seams (`__set…`) make it testable with a fake client.
- **Alternatives**: optimistic local state + push (two registers could both "win").

## R20 — Completing the sale: POS-window drawer, server-priced lines, cloud-first completion

- **Decision**:
  1. **Where**: "Complete sale" lives in the **POS window** (the cashier is there at handover): a new "Online orders"
     button with a badge in `PosHeader` opens a drawer listing Accepted/Ready orders (and New ones read-only);
     "Complete sale" opens a **new sale tab** pre-filled (`newSaleTab` + `loadSale`) with the confirmed lines and the
     customer, labelled with the order number, and remembers `orderGlobalId` in the tab. The back-office order detail
     shows "Complete at the POS" (POS and back office are different windows).
  2. **Lines**: each confirmed line → product (local id via the mirror's `product_id`), unit (`unit_key`: `base` or
     the unit's global id → local `product_units` row; a unit deleted since → base unit with `qty × factor` and
     price ÷ factor), quantity = `confirmed_qty`. Lines whose product no longer exists are left out and listed in a
     warning (spec edge case).
  3. **Prices are server-side**: `POST /api/transactions` accepts `order_global_id`; when present, the server looks
     up the order in the mirror and, for every sale line that matches an order line (product + unit), uses the
     order's quoted unit price as the line's price **without** requiring the price-override setting (the shop already
     accepted that price). Quantities may be lower than confirmed; anything else (higher quantity, other products,
     other prices, discounts) follows the normal POS permissions.
  4. **One sale per order, cloud first**: the handler is split into a validation phase and a commit phase. With
     `order_global_id`, after validation it (a) refuses if a live or archived transaction already has that order
     (`ORDER_ALREADY_COMPLETED`), (b) requires a session, (c) pre-generates the sale's `global_id`, (d) calls
     `order_complete(order, sale_global_id, sale_total_usd, actor)` (first wins; refuses unless `confirmed`/`ready`),
     then (e) commits the sale with that `global_id` and `order_global_id`. If the commit throws after the cloud
     accepted, it calls `order_complete_undo(order, sale_global_id)` (reverts only if that sale id is the recorded
     one), best effort, and logs. Offline → `ORDER_NEEDS_ONLINE`; the cashier can still sell the same goods as an
     ordinary sale.
  5. **Storage**: `transactions.order_global_id TEXT` and the same on `archived_transactions`, added to the
     settlement copy (`routes.ts`), `TX_LIVE_COLUMNS`/`TX_ARCHIVED_COLUMNS`, a local partial unique index, and
     `OPTIONAL_CLOUD_COLUMNS.transactions` (cloud column added by the Slice 2 migration). Refunds, edits and settlement
     run unchanged (FR-035, US5 AS7).
- **Rationale**: FR-034–FR-036, SC-007 (the sale is an ordinary transaction through the ordinary path),
  Constitution I (new column mirrored and carried through settlement) and IV (order prices from the server).
- **Alternatives**: complete in the back office and push a "pending sale" to the POS window (cross-window hand-off,
  ambiguous on multi-terminal installs); complete the order locally and sync the completion later (two offline
  registers could each make a sale — violates FR-036); reserve the order when the tab opens (lease/expiry logic for no
  real gain).

## R21 — Notifications on the register

- **Decision**: On `ORDERS_UPDATED` with `newSubmitted > 0`, both windows (POS socket in `usePos`, Dashboard socket via
  `pos-sync`) show a toast (`useToast`, info, 8 s, "New online order W-1042 — 3 items"), play a short tone generated
  with the Web Audio API (no audio file; first user interaction unlocks audio), and refresh the badge
  (`GET /api/orders/summary` → `{ submitted }`). Mute is per register in `localStorage` (`omnipos.orders.mute`), toggled
  from the Online orders page. Only users with `orders.view` subscribe (the summary route is permission-guarded and
  the hook checks `can('orders.view')`).
- **Rationale**: FR-030; per-register mute is a device preference (same pattern as the POS layout).
- **Alternatives**: OS notifications through Electron (permission prompts; later if shops ask); bundled sound file
  (asset weight, licensing).

## R22 — Storefront: POST handling, status page, browser script budget

- **Decision**: `node-server.ts` passes `method` and, for `POST`, a body read with a **16 KB cap** (413 beyond) into
  `handle()`. New routes under a store root: `POST order/quote`, `POST order` (JSON in/out,
  `Cache-Control: no-store`, `Content-Type` must be `application/json`), `GET o/<key>` (server-rendered status page,
  `private, no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`, `<meta refresh content=60>` while the
  order is open), `POST o/<key>/cancel` (plain form post → 303 back to the page). Every other method on every route →
  405. Online-mode client code goes into a **new `order.js`** (budget 12 KB, loaded only on stores in online mode,
  beside `cart.js` + `checkout.js`; `cart.js` stays untouched because it is at its budget): quote step with changed
  lines highlighted, submit with the idempotency key, the FR-022 fallback (reuses `OmniCheckout`'s WhatsApp message),
  confirmation with number + link, and "My orders" (`localStorage["sf-orders:v1:<address>"]`, ≤ 20 entries:
  number, key, date, last known state). The cart page in online mode renders the same form with phone required and an
  "Order" button.
- **Rationale**: FR-017–FR-022, FR-028, FR-042–FR-044; status pages are never shared-cached; stores in WhatsApp mode
  or off pay nothing.
- **Alternatives**: client-rendered status page calling a JSON endpoint (needs JS for a page people open from a chat);
  putting order code in `cart.js` (breaks its budget for every ordering store).

## R23 — Permissions and defaults

- **Decision**: New area `orders` with `orders.view` and `orders.manage` in `PERMISSION_GROUPS` (server + client
  mirror + i18n + roles matrix + `PAGE_PERMISSIONS`). Defaults (user decision 2026-10-22): admin and manager get both;
  cashier, staff and accountant get `orders.view` (they see orders and notifications and can complete a sale at the
  POS with their normal sale permission). Stored role maps gain the keys with these defaults on first read. Rules:
  `GET /api/orders*` → `orders.view`; `POST /api/orders/:id/*` and blocked-phone routes → `orders.manage`;
  `POST /api/transactions` with `order_global_id` → the sale rule **and** `orders.view`; store ordering settings stay
  `store.manage`.
- **Rationale**: FR-033; Constitution VII holds because nothing is visible until a shop turns ordering to Online.
- **Alternatives**: admin-only defaults like `store.*` (cashiers would miss notifications until the owner edits roles —
  not chosen).

## R24 — Customer match by phone

- **Decision**: At "Complete sale", the server normalises the order phone and every live customer phone of the tenant
  with the same `whatsappDigits` rule (server-side helper reusing `storefront/src/phone.ts`); exactly one match →
  proposed, otherwise Walk-in. No index needed at shop scale (hundreds of parties); no customer is ever created.
- **Rationale**: FR-037; phones in `stakeholders` are free text typed in many formats.
- **Alternatives**: normalise phones on save (changes existing data; out of scope).

## R25 — Blocked phones and the expiry setting

- **Decision**: `order_blocked_phones (tenant_id, store_id, phone, note, created_at)` is cloud-only, reached through
  owner RPCs `order_block_phone`, `order_unblock_phone`, `order_blocked_phones(store)`; the back office manages it
  online (Settings → Online store → Ordering, and "Block this phone" in an order's detail), guarded by
  `orders.manage`. `order_expiry_hours` (integer 1–72, default 24) joins `stores.settings`; `ordering_mode = 'online'`
  becomes valid and requires pickup or delivery (WhatsApp optional; the FR-022 fallback is offered only when the store
  has a number).
- **Rationale**: FR-041, FR-045; a blocked list is only useful where submissions are checked (the cloud).
- **Alternatives**: syncing the list down (no register needs it offline).
