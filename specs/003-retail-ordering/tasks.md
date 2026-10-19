---
description: "Task list — B2C Retail Ordering, Slice 1 (WhatsApp order), feature 003"
---

# Tasks: B2C Retail Ordering — Slice 1 (WhatsApp order)

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/storefront-routes.md](contracts/storefront-routes.md), [contracts/cloud-api.md](contracts/cloud-api.md),
[contracts/backoffice-api.md](contracts/backoffice-api.md), [quickstart.md](quickstart.md)

**Tests**: Required (Constitution V). `npm test` runs `tests/*.test.ts`; storefront code is plain TypeScript imported by
tests directly. Server-module imports in tests must be dynamic, after `createTestApp()` (001 note about the repo
`pos.db`). Browser code (`storefront/public/cart.js`) is tested by evaluating it with `node:vm` against a minimal
`document` / `localStorage` / `window` stub.

**Scope**: Slice 1 only — spec US1 (cart, P1), US2 (WhatsApp order, P1), US6 (ordering settings + orderable units, P2;
mode `online` stays refused). US3–US5 (online orders) are Slice 2: outlined in plan.md, tasked later.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 Confirm the baseline: `npm test` green and `npx tsc --noEmit` error count noted on branch `003-retail-ordering` before any change (record both in the commit message of T002) — Done note: baseline 48/48 storefront + SQL tests, `tsc` 0 errors (worktree has no node_modules: full suite run via the main checkout's rebuild workaround at the end — 473/473).
- [X] T002 [P] Create empty `storefront/public/cart.js` with the 002 header style (`(function () { 'use strict'; … })();`, plain ES2017, no build step) and `tests/storefront-cart.test.ts` with a reusable harness: loads `cart.js` source into `node:vm` with stubs for `document` (querySelector/All, createElement, addEventListener, `hidden`/attributes), `window` (`open`, `location`, `addEventListener`, `visibilityState`), and a `localStorage` stub that can be switched to throw on every call — Done note: the harness (FakeEl DOM, memory/throwing storage, vm runner) lives at the top of `tests/storefront-cart.test.ts`; `cart.js` exposes its logic as `window.OmniCart`.

---

## Phase 2: Foundational (blocks every story)

- [X] T003 Write cloud migration `supabase/migrations/2026-10-21_retail_ordering_s1.sql` per contracts/cloud-api.md, inside `BEGIN; … COMMIT;`, re-runnable: replace `_store_public_settings(text)` so defaults are `{"show_exact_stock":0,"hide_out_of_stock":0,"show_local_price":1,"category_order":[],"ordering_mode":"off","pickup_enabled":1,"pickup_note":"","delivery_enabled":0,"delivery_note":"","min_order_usd":null}`; new internal IMMUTABLE `_store_orderable_keys(text) RETURNS text[]` (array of strings → the array; integer arrays, invalid JSON, empty array → NULL); DROP + CREATE `store_public_get(p_slug text, p_preview text DEFAULT NULL)` with the 2026-10-19 columns plus `ordering_mode text` (only `off`/`whatsapp`/`online`, anything else → `off`), `pickup_enabled boolean`, `pickup_note text` (≤ 200), `delivery_enabled boolean`, `delivery_note text` (≤ 200), `min_order_usd numeric` (NULL when absent, ≤ 0 or not a number) placed before `is_preview`; DROP + CREATE `store_public_listings(...)` and `store_public_listing(...)` with the same arguments/columns plus `base_orderable boolean`, where keys NULL → base orderable and every live unit, otherwise `base_orderable = 'base' = ANY(keys)` and only live units with `global_id::text = ANY(keys)`; gate `_store_public_store` untouched; REVOKE from PUBLIC, GRANT EXECUTE on the three public functions to `anon, authenticated`, internal helpers revoked from `anon` and `authenticated` — Done note: unit keys read with a LATERAL lookup on `store_listings` (no change to `_store_public_rows`); extra internal helper `_store_setting_on(jsonb)` reads 1/"1"/true switches. Re-running 2026-10-19 after this file is not supported (header says so).
- [X] T004 Extend `tests/commerce-sql.test.ts`: apply 2026-10-18 → 2026-10-19 → 2026-10-19b → `2026-10-21_retail_ordering_s1.sql` (twice); assert `settings = '{}'` → `ordering_mode = 'off'`, pickup on, delivery off, `min_order_usd` NULL; unknown mode → `off`; notes trimmed to 200; `["base"]` → `base_orderable` true and no units; `["<u2 gid>"]` → `base_orderable` false and only u2; `[3,5]` → all units, base orderable; key of a soft-deleted unit not returned; non-public store → no row, valid preview token → row with ordering fields; anon may EXECUTE only the three public functions (no new grants, no table access) — Done note: 6 new tests (14 total); migrations now applied file by file twice (each re-runnable on its own).
- [X] T005 Write `supabase/checks/2026-10-21_retail_ordering_s1_checks.sql` (read-only queries for the SQL editor: function signatures and new columns present, grants as in the contract, `_store_orderable_keys` results on sample literals)
- [X] T006 [P] Extend `storefront/src/data.ts`: `PublicStore` gains `ordering_mode: 'off'|'whatsapp'|'online'`, `pickup_enabled`, `pickup_note`, `delivery_enabled`, `delivery_note`, `min_order_usd: number|null`; `PublicListing` gains `base_orderable: boolean`; `normalizeStore` / `normalizeListing` default missing fields to `off` / pickup on / delivery off / empty notes / null minimum / `base_orderable = true` (so the storefront works before the migration)
- [X] T007 [P] Create `storefront/src/ordering.ts`: `orderingEnabled(store)` = `ordering_mode === 'whatsapp'` && `whatsappDigits(contact_whatsapp)` && (`pickup_enabled` || `delivery_enabled`); `orderableUnits(listing)` → ordered list of `{ key: 'base'|unit_id, name, factor, price, price_lbp }` (base first when `base_orderable`, using `listing.unit`/`price`/`price_lbp`, factor 1); `isMeasuredUnit(name)` (kg, g, l, ml, m, cm, case-insensitive, plus Arabic/French spellings — research R10); `canOrder(listing)` (not `out_of_stock` and at least one orderable unit); `orderPayload(ctx, lang)` → the `sf-order` JSON object of contracts/storefront-routes.md (address, home, cart path, store name, `wa` digits, local `{show, code, symbol, rate}`, pickup/delivery `{on, note}`, `minOrderUsd`, `ui` strings in the page language, `msg` strings in the store default language) and `orderJsonScript(payload)` escaping `<` as `<`
- [X] T008 [P] Extend `storefront/src/fixture.ts`: `demoFixture` options for an ordering store (`ordering_mode: 'whatsapp'`, WhatsApp `71 315 744`, pickup + delivery with notes, `min_order_usd: 10`), listings with several units (with keys), one listing restricted to a pack (`base_orderable: false`), one measured-unit (kg) listing, one out-of-stock listing, one with `min_quantity: 6`; keep the existing default fixture unchanged (ordering off) — Done note: `demoFixture(count, { ordering: true })`; dev server gets `--ordering` and a `storefront-fixture-ordering` launch config.
- [X] T009 Add route kind `cart` in `storefront/src/router.ts` (`/cart` in host form, `/s/<address>/cart` in path form; `lang` and `preview` params kept) and the handler branch in `storefront/src/http.ts`: store not public → same neutral unavailable page and cache as the home; public but `!orderingEnabled` → 302 to the store home with `Cache-Control: public, s-maxage=60`; otherwise render the cart page (T016) with `CACHE_PAGE` (or `CACHE_PREVIEW` for previews) and `noindex`; language links for the cart page point at `/cart?lang=xx` — Done note: 302 Location is the store home link as built by `ctx.link('/')` (path form keeps its trailing slash).
- [X] T010 Update `scripts/preview-storefront.ts` (`LocalDbSource`) to return the new store fields from the local `stores.settings` and `base_orderable` / filtered units from the listing's unit keys (same rules as the cloud functions in T003), so the preview server renders ordering on demo data — Done note: unit ids still local until T027 switches `deriveListing` to unit keys.

**Checkpoint**: migration + SQL tests green; storefront compiles with the new fields; `/cart` routes answer with the right status and headers (page body still a stub).

---

## Phase 3: User Story 1 — A visitor builds a cart (P1) 🎯 MVP

**Goal**: add to cart from product pages and cards, change quantities, keep the cart per store across visits, while
every page stays identical and cacheable.

**Independent test**: fixture ordering store at 360 px: add a pack and a single item, open `/cart`, change and remove
lines, reload/restart → cart kept; ordering-off store renders exactly as 002; two requests for the same URL return
identical HTML.

- [X] T011 [P] [US1] Extend `tests/storefront-render.test.ts`: with ordering off, home/product HTML contains no `sf-order`, no `cart.js`, no cart link and no order controls (byte-identical to rendering with the 002 fields only); with ordering on: header cart link + hidden badge, product page form `.sf-order` with `hidden` attribute listing only orderable units (base first when `base_orderable`; pack-only listing has no base option) with `data-unit`/`data-name`/`data-factor`/`data-price`/`data-price-lbp` and form `data-id`/`data-title`/`data-img`/`data-min`/`data-dec`; quantity `step` 1 or 0.001 for the kg listing; no form for out-of-stock listing; card shows "Add" only for single-unit listings without a minimum above 1, "Choose" link otherwise; `sf-order` JSON parses, contains no `</script>`, and matches the contract fields; a product title with `<script>` and quotes stays escaped in attributes and JSON; two renders of the same URL are identical and no response sets `Set-Cookie` or `Vary: Cookie`
- [X] T012 [P] [US1] Write cart tests in `tests/storefront-cart.test.ts` (harness from T002): add merges by (`id`, `unit`); quantities must be > 0 and ≤ 999, integers unless `dec` (≤ 3 decimals); 51st line refused with the limit message; cart saved under `sf-cart:v1:<address>` with `v: 1`, separate carts for two addresses; corrupt JSON or other version discarded; storage that throws keeps an in-memory cart and shows the "won't be remembered" note; refresh from page data updates title/prices and marks lines whose unit is no longer offered as unavailable (excluded from totals); line local amount = `price_lbp × qty` when set else `round(price × qty × rate)`, totals = sum of lines, no local total when `local.show` is false; listing minimum = Σ(qty × factor) per listing ≥ `min`
- [X] T013 [US1] Render order controls: `storefront/src/render/product.ts` adds the `.sf-order` form after the units section when `orderingEnabled(store) && canOrder(listing)` (unit `<select>` from `orderableUnits`, quantity input with `inputmode="decimal"` only for measured base units, "Add to cart" button, `role="status"` confirmation slot); `storefront/src/render/home.ts` `productCard` adds the "Add"/"Choose" control outside the card link (no nested interactive elements); both use `hidden` so pages without JS show nothing — Done note: form and card controls also carry `data-base` (base unit name, for the minimum message).
- [X] T014 [US1] Update `storefront/src/render/layout.ts`: when the page's store has ordering enabled, add the header cart link (`ctx.link('/cart')`) with `<span class="sf-cart-count" hidden>`, the `sf-order` JSON block (from `orderPayload`) and `<script src="/cart.js?v=<asset version>" defer>` after `storefront.js`; layout input gains an optional `order` payload so status pages stay unchanged
- [X] T015 [US1] Implement cart core in `storefront/public/cart.js`: read `#sf-order` (exit when absent); load/save cart (research R2, `try/catch` around every storage call); reveal `[hidden]` `.sf-order` / card controls; header badge = number of lines (hidden when 0); add handler with validation (limits, decimals, minimum hint) and a short `role="status"` confirmation; refresh known lines from any `.sf-order`/card data on the page (research R3) — Done note: line local amount = unit local price (own `price_lbp`, else round(USD × rate)) × qty, rounded — matches the unit price the visitor sees.
- [X] T016 [US1] Create `storefront/src/render/cart.ts` (cart page shell per contracts/storefront-routes.md: heading, `#sf-cart-lines`, totals area, notes "Prices and availability are confirmed by the shop", "Payment on pickup or delivery", "Any delivery charge is agreed with the shop", empty-cart state with a link to the store, `<noscript>` message + `contactButtons`) and the cart-page part of `cart.js`: render lines (photo, name, unit, quantity stepper, unit price, line total, remove, unavailable marker), totals in USD and local currency, per-listing minimum messages, store-closed message when the stored cart's store no longer offers a line
- [X] T017 [US1] Add US1 strings to `storefront/src/i18n.ts` in en/ar/fr with identical keys/placeholders (`add_to_cart`, `choose_options`, `added_to_cart`, `cart`, `cart_empty`, `quantity`, `unit`, `remove`, `line_total`, `total`, `unavailable_line`, `cart_limit_lines`, `cart_limit_qty`, `minimum_qty`, `storage_unavailable`, `prices_confirmed_note`, `pay_on_handover_note`, `delivery_charge_note`, `needs_javascript`, `continue_shopping`) and pass the subset the script needs through `ui` in `orderPayload`
- [X] T018 [US1] Add cart styles to `storefront/public/storefront.css` (logical properties only, RTL-safe): header badge, product order form, card "Add" button, cart lines grid with ≥ 44 px steppers, totals, notes; no horizontal scroll at 360 px; update `ASSET_VERSION` in `storefront/src/assets.ts` — Done note: `cart.js` added to the asset hash and served by `storefront/src/node-server.ts` and `scripts/preview-server.ts`. Home with 48 cards and ordering on is 36 KB, so the 60 KB budget stands (no raise needed). Also fixed a 002 bug: card images were 400 px tall on phones (the `height` attribute beat `aspect-ratio`; `.sf-card img { block-size: auto }`).

**Checkpoint**: US1 independent test passes on the fixture store and on the preview server (`/s/<address>`).

---

## Phase 4: User Story 2 — Send the order on WhatsApp (P1)

**Goal**: checkout turns the cart into a pre-filled WhatsApp message to the shop; nothing is stored by OmniPOS.

**Independent test**: fixture ordering store: fill the cart and the form (pickup and delivery), check the `wa.me` URL
opened, the message content and the "did you send it?" flow; network log shows no request to OmniPOS on submit.

- [X] T019 [P] [US2] Write message/checkout tests in `tests/storefront-cart.test.ts`: form validation — name required (≤ 80), phone optional (≤ 30, digits/spaces/`+`), fulfilment required among enabled methods and preselected when only one, address required for delivery (≤ 300), note ≤ 300; submit disabled when cart empty, total below `minOrderUsd`, a listing below its minimum, or encoded text > 6 000 characters ("split your order" message); message text exactly as contracts/storefront-routes.md (header with store name and home link, `qty × name (unit) — $line`, fractional quantities up to 3 decimals, total in USD and local when shown, `Pickup — <note>` or `Delivery: <address>`, name, phone only when given, note only when given, "Prices to be confirmed by the shop") using `msg` strings (store language) while UI strings follow `ui`; `window.open` called with `https://wa.me/<wa>?text=<encodeURIComponent(text)>`; after return (`visibilitychange` to visible) the "sent?" dialog appears — Yes clears the cart, No keeps it; "remember my details" saves/clears `sf-buyer:v1:<address>` and prefills the next checkout; no `fetch`/XHR is made at any point — Done note: 8 checkout tests in `tests/storefront-cart.test.ts` (18 total) + 2 render tests tying the cart-page markup to the script and checking message strings follow the store language.
- [X] T020 [US2] Add the checkout form to `storefront/src/render/cart.ts` per contracts/storefront-routes.md (name, phone, fulfilment radios with pickup note / delivery-area text, address shown for delivery, note with counter, remember checkbox, minimum-order notice, "Order on WhatsApp" submit; `maxlength` attributes 80 / 30 / 300 / 300) and a `<dialog>`-style "Did you send the order?" block (plain element with `role="dialog"`, no browser `confirm`)
- [X] T021 [US2] Implement checkout in `storefront/public/cart.js`: validation messages next to fields, minimum checks, message builder (research R8), 6 000-character encoded cap, `window.open(waUrl, '_blank', 'noopener')` with fallback link when blocked, "sent?" dialog on `visibilitychange`/`focus` (research R9), remembered details (research R2) — Done note (deviation): checkout lives in its own `storefront/public/checkout.js` (8 KB), loaded only on the cart page after `cart.js`, so `cart.js` stays under its 16 KB budget (16.3 KB) and product pages never download checkout code. `window.open(…, 'noopener')` can't report a blocked popup, so the "If WhatsApp didn't open, tap here" link is always shown after sending. `cart.js` calls `OmniCart.onChange` after every change so the checkout re-checks minimums and message length.
- [X] T022 [US2] Add US2 strings to `storefront/src/i18n.ts` (en/ar/fr, same keys): UI (`checkout`, `your_name`, `your_phone`, `optional`, `pickup`, `delivery`, `delivery_address`, `note`, `remember_details`, `order_on_whatsapp`, `minimum_order`, `amount_to_minimum`, `order_too_long`, `field_required`, `sent_question`, `sent_yes`, `sent_no`, `back_from_whatsapp`, `whatsapp_blocked`) and message (`msg_new_order`, `msg_total`, `msg_pickup`, `msg_delivery`, `msg_name`, `msg_phone`, `msg_note`, `msg_prices_confirmed`); `orderPayload` sends `msg` in the store default language
- [X] T023 [US2] Checkout styles in `storefront/public/storefront.css` (form fields, radio cards, error text, dialog, RTL) and bump `ASSET_VERSION` in `storefront/src/assets.ts` — Done note: `checkout.js` added to the asset hash and served by node-server / preview-server.

**Checkpoint**: US1 + US2 = a complete WhatsApp ordering flow on any store whose settings are set in the cloud/fixture.

---

## Phase 5: User Story 6 — Owner sets up ordering; orderable units (P2)

**Goal**: shops turn WhatsApp ordering on, set pickup/delivery/minimum, and restrict orderable units — with
validation, sync, and defaults that change nothing.

**Independent test**: register on a test business: mode refused without WhatsApp, saved with it; restrict a product to
its pack with minimum 6 → preview server / storefront offer only the pack and enforce the minimum; existing listings
with integer unit ids are converted once and keep their meaning.

- [ ] T024 [P] [US6] Extend `tests/commerce-store.test.ts`: new settings keys accepted and merged (defaults returned for stores created before 003); `ordering_mode` must be `off`/`whatsapp`/`online`; `online` → `ORDERING_MODE_UNAVAILABLE`; `whatsapp` without a usable WhatsApp number → `STORE_ORDERING_NEEDS_WHATSAPP` (field `contact_whatsapp`); clearing or invalidating the number while mode is `whatsapp` → same code, nothing saved; mode not `off` with pickup and delivery both off → `STORE_ORDERING_NEEDS_FULFILMENT`; notes > 200 → `STORE_SETTINGS_INVALID`; `min_order_usd` < 0, > 100 000 or > 2 decimals → `STORE_SETTINGS_INVALID`; tenant isolation (another tenant's store id → not found)
- [ ] T025 [P] [US6] Extend `tests/commerce-listings.test.ts`: `orderable_unit_keys` accepts `"base"` and this product's unit global ids, refuses an empty array, unknown keys and another product's/tenant's unit (`LISTING_UNIT_INVALID`); `null` = all units; legacy `orderable_unit_ids: number[]` input converted to keys; `ListingView` returns `orderable_unit_keys` and `units[].key` with a `"base"` row first; startup conversion turns `[3,5]` into `["base", gid3, gid5]`, drops ids without a row/global id, turns an empty result into NULL, bumps `updated_at` so the row syncs, runs per tenant only, and is a no-op on the second run
- [ ] T026 [US6] Implement ordering settings in `server/commerce.ts`: add `ordering_mode`, `pickup_enabled`, `pickup_note`, `delivery_enabled`, `delivery_note`, `min_order_usd` to the settings allow-list and `STORE_SETTING_DEFAULTS` (`'off'`, 1, `''`, 0, `''`, null); validation and error codes per contracts/backoffice-api.md, checked against the merged result (so a contact-number change alone also triggers `STORE_ORDERING_NEEDS_WHATSAPP`), using `normalizeWhatsapp` from `storefront/src/phone.ts`
- [ ] T027 [US6] Implement unit keys in `server/commerce.ts`: `orderable_unit_keys` input/validation (live units of this product in this tenant, by `global_id`), legacy integer input converted, stored JSON array of strings; `deriveListing` returns `orderable_unit_keys`, `units[].key`, and filters units/base by keys (local preview matches the cloud rule); keep reading legacy integer arrays as "all units" until converted
- [ ] T028 [US6] Add the one-time conversion in `server/db.ts` (idempotent block after the commerce tables): for each `store_listings` row whose `orderable_unit_ids` parses as an integer array, map ids → `product_units.global_id` within the same tenant and product, prepend `"base"`, drop unknown ids, NULL when empty, set `updated_at` so the change is pushed; log the converted count once
- [ ] T029 [P] [US6] Update `src/lib/commerceApi.ts` types (`StoreSettings` ordering keys; `ListingView.orderable_unit_keys`, `units[].key`; `ListingInput.orderable_unit_keys`) and add strings + error codes (`ORDERING_MODE_UNAVAILABLE`, `STORE_ORDERING_NEEDS_WHATSAPP`, `STORE_ORDERING_NEEDS_FULFILMENT`) in en/ar/fr to `src/intl/locales/commerce.ts`, mapped by `translateServerError`
- [ ] T030 [US6] Add the **Ordering** card to `src/pages/settings/OnlineStoreSection.tsx` with the UI kit (`src/components/ui`): mode select (Off / Order on WhatsApp / Online orders — disabled with "coming soon"), pickup switch + instructions (≤ 200), delivery switch + area text (≤ 200), minimum order (USD, 2 decimals), warning + link to the WhatsApp field when the number is missing; server errors shown next to the field; disabled for users without `store.manage`
- [ ] T031 [US6] Add "Orderable units" (All units / pick: base unit + each unit as checkboxes, at least one) and "Minimum quantity (in <base unit>)" to `src/pages/products/OnlineStoreCard.tsx`; read-only for users without `store.publish`
- [ ] T032 [US6] Verify in the preview server (`.claude/launch.json` preview config): set ordering on a demo store, restrict a product to its pack with minimum 6, then open `/s/<address>` at 375 px in en and ar — only the pack is offered, minimum enforced in the cart, Ordering card and Online store tab render RTL correctly; capture screenshots for the PR

**Checkpoint**: Slice 1 complete end-to-end on the dev PC (back office → preview storefront → WhatsApp message).

---

## Phase 6: Polish & cross-cutting

- [ ] T033 [P] Update `tests/storefront-routing.test.ts` budgets and `storefront/src/limits.ts`: home HTML with 48 cards (ordering on) ≤ 70 KB, `storefront.js` ≤ 10 KB, `cart.js` ≤ 16 KB, CSS ≤ 24 KB; cart route cache headers (public/redirect/preview/unavailable); asset-version test passes
- [ ] T034 [P] Confirm the i18n key-parity test in `tests/storefront-render.test.ts` covers the new keys (en/ar/fr same keys and placeholders) and add an Arabic cart-page render check (`dir="rtl"`, no untranslated English labels)
- [ ] T035 [P] Update `storefront/README.md` (cart.js, ordering settings, deploy order: migration `2026-10-21_retail_ordering_s1.sql` before or after the storefront is safe) and `specs/003-retail-ordering/quickstart.md` if any step changed
- [ ] T036 Run the full gate: `npm test`, `npx tsc --noEmit` (no new errors vs T001), `npm run build`, `npm run build:server`; fix anything red
- [ ] T037 Create `specs/003-retail-ordering/validation.md` with quickstart §1–2 results (and placeholders for §3 devices / §4 cloud, to be filled after deployment), and update `ROADMAP.md` row 003 (Slice 1 implemented, not merged; pending: apply migration, device check, live test) plus a To-do line for the migration

---

## Dependencies & execution order

- Phase 1 → Phase 2 → stories. T003 before T004/T005. T006/T007 before any render task; T009 before T016.
- **US1** (T011–T018) needs Phase 2. **US2** (T019–T023) needs US1's cart page shell (T016) and cart core (T015).
  **US6** back-office tasks (T024–T031) need only T003 semantics (unit-key rule) and can run in parallel with US1/US2;
  T032 needs US1, US2 and T026–T031.
- Same-file serialisation: `storefront/public/cart.js` (T015, T016, T021), `storefront/src/render/cart.ts` (T016, T020),
  `storefront/src/i18n.ts` (T017, T022), `storefront/public/storefront.css` + `assets.ts` (T018, T023),
  `tests/storefront-cart.test.ts` (T002, T012, T019), `tests/storefront-render.test.ts` (T011, T034),
  `server/commerce.ts` (T026, T027), `tests/commerce-sql.test.ts` (T004).

## Parallel examples

```text
Phase 2:  T006 ‖ T007 ‖ T008 (after T003 → T004 ‖ T005), then T009, T010
US1:      T011 ‖ T012 (tests first), then T013 → T014 → T015 → T016, T017, T018
US2:      T019 first, then T020 → T021, T022, T023
US6:      T024 ‖ T025 ‖ T029 first, then T026 → T027 → T028, T030 ‖ T031, then T032
Polish:   T033 ‖ T034 ‖ T035, then T036 → T037
```

US6 back-office work (T024–T031) touches only `server/`, `src/` and their tests, so it can run in its own session
alongside the storefront work (T011–T023).

## Implementation strategy

1. **MVP**: Phases 1–3 — cart on a fixture/preview store whose ordering is set in data (no back-office UI yet).
2. **Increment 2**: Phase 4 — WhatsApp checkout; with the migration applied and settings written by T026, this is
   shippable for shops.
3. **Increment 3**: Phase 5 — back-office Ordering card, orderable units, conversion (needs a desktop release).
4. **Increment 4**: Phase 6 — budgets, docs, full gate, validation.
5. Deployment (outside these tasks, user-run): apply `2026-10-21_retail_ordering_s1.sql` and its checks; storefront
   deploys from the branch the Render service tracks; desktop release with T026–T031; then quickstart §3–4 on a
   **test** business only.

**Totals**: 37 tasks — Setup 2, Foundational 8, US1 8, US2 5, US6 9, Polish 5.
