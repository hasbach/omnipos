---
description: "Task list — B2C Retail Ordering, Slice 2 (Online orders), feature 003"
---

# Tasks: B2C Retail Ordering — Slice 2 (Online orders)

**Input**: [plan-s2.md](plan-s2.md), [spec.md](spec.md), [research.md](research.md) (R12–R25),
[data-model-s2.md](data-model-s2.md), [contracts/cloud-api-s2.md](contracts/cloud-api-s2.md),
[contracts/storefront-routes-s2.md](contracts/storefront-routes-s2.md),
[contracts/backoffice-api-s2.md](contracts/backoffice-api-s2.md), [quickstart-s2.md](quickstart-s2.md)

**Tests**: Required (Constitution V). `npm test` runs `tests/*.test.ts`. Rules for writing them:
- **Imports:** server-module imports in tests must be dynamic, after `createTestApp()`.
- **Cloud SQL:** runs on PGlite (`@electric-sql/pglite`), the same way `tests/commerce-sql.test.ts` does. Each
  migration runs twice.
- **Browser scripts:** run in `node:vm` with DOM, `localStorage`, `window` and `fetch` stubs (harness from
  `tests/storefront-cart.test.ts`).
- **Coverage:** money, settlement, sync and permission changes are tested on live and archived data.

**Scope**: Slice 2 only:
- **US3**, online order and status (P1)
- **US4**, shop handles orders (P1)
- **US5**, order becomes a POS sale (P1)
- the Slice 2 parts of **US6**: `online` mode, expiry hours, blocked phones

Slice 1 (`tasks.md`) is done and unchanged.

**Delivery order** (plan-s2): Phase 2 = cloud model (step 1) · US3 = storefront (step 2) · US4 = registers (step 3)
· US5 = complete sale (step 4) · US6 + Polish = step 5. Each phase leaves `main` releasable. Shops can't select
`online` until T035.

**Owner-run steps** (not tasks for an agent): apply the migration and its checks, generate the gateway key, insert its
hash, and set `ORDER_GATEWAY_KEY` on Render (quickstart-s2 §1). Agents never touch the cloud project or Render.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 Confirm the baseline on branch `003-retail-ordering-s2`. Record both results in the commit message of T002:
  - `npm test` is green (expected 497/497);
  - the `npx tsc --noEmit` error count.
  - **Done note:** baseline = the 2026-10-22 run on the same code (`f4d9adb` + docs only): 497/497, `tsc` 0 errors.
- [X] T002 [P] Create `scripts/gateway-key.mjs` (plain Node, no dependencies).
  - It prints a new key, `crypto.randomBytes(32).toString('base64url')`.
  - It prints the key's SHA-256 as lowercase hex.
  - It prints a one-line reminder: "paste the key into Render ORDER_GATEWAY_KEY; insert only the hash into
    storefront_gateway_keys".
  - It writes nothing to disk, reads no env vars, and has no network access.
- [X] T003 [P] Create `tests/helpers/fakeSupabase.ts`, a reusable fake Supabase client for the new tests. Existing tests
  keep their own fakes.
  - `from(table)` returns a chainable, thenable query builder: `select`, `eq`, `gte`, `gt`, `or`, `order`, `limit`,
    `in`, `is`, `not`, `upsert`, `update`, `delete`. It records every request and returns programmable rows per table.
  - `rpc(name, args)` records calls and returns programmable results per function name: a value, `{ error }`, a thrown
    network error, or a never-resolving promise (for timeout tests).
  - It exports `makeFakeSupabase()` and helpers `setRows(table, rows)`, `onRpc(name, fn)` and `calls()`.

---

## Phase 2: Foundational — cloud model, shared helpers, permissions, local mirrors (blocks every story)

- [X] T004 Create `supabase/migrations/2026-10-23_retail_ordering_s2.sql` (part 1: tables).
  - **Structure:** inside `BEGIN; … COMMIT;`, and safe to run twice (`IF NOT EXISTS`, `DROP POLICY IF EXISTS` before
    `CREATE POLICY`). Header comment: it runs after `2026-10-21_retail_ordering_s1.sql`, and the gateway key hash is
    inserted separately by the owner.
  - **Synced tables** per data-model-s2: `orders`, `order_lines`, `order_events`, each with `global_id uuid PK
    DEFAULT gen_random_uuid()`, `tenant_id uuid NOT NULL REFERENCES tenants(global_id)`, `created_at` / `updated_at`
    (default now()), `deleted_at`, and `synced_at timestamptz NOT NULL DEFAULT now()` with the `set_synced_at()`
    trigger and the `(tenant_id, synced_at, global_id)` index.
  - **`orders` checks and constraints:**
    - `state` IN `('submitted','confirmed','ready','completed','rejected','cancelled','expired')`;
    - `cancelled_by` IN `('customer','shop')` or null;
    - `fulfilment` IN `('pickup','delivery')`;
    - `customer_name` 1–80 chars, `address` ≤ 300, `note` ≤ 300, `reason` ≤ 300;
    - `UNIQUE (store_id, number)`, `UNIQUE (store_id, idempotency_key)`, `UNIQUE (status_key_hash)`;
    - indexes `(store_id, customer_phone, submitted_at)`, `(network_hash, submitted_at)`, `(tenant_id, state)`.
  - **`order_lines` checks:** `line_no` 1–50 with `UNIQUE (order_id, line_no)`; `ordered_qty > 0 AND ordered_qty <=
    999`; `confirmed_qty IS NULL OR (confirmed_qty >= 0 AND confirmed_qty <= ordered_qty)`; `shortfall_reason` IN
    `('out_of_stock','damaged','customer_request','other')` or null.
  - **`order_events` checks:** `kind` IN `('submitted','confirmed','adjusted','ready','rejected','cancelled','expired',
    'completed','completion_undone')`; `actor_kind` IN `('customer','user','system')`.
  - **RLS:** enabled on the three tables, with exactly one policy each, `"<Table> owner read" FOR SELECT TO
    authenticated USING (tenant_id::text = auth.uid()::text)`.
  - **Private tables** (RLS on, no policy): `order_counters (store_id uuid PK, last_no int NOT NULL)`,
    `order_blocked_phones (tenant_id, store_id, phone, note ≤ 120, created_at, PK (store_id, phone))`,
    `storefront_gateway_keys (key_hash text PK, label text, created_at timestamptz default now(), revoked_at
    timestamptz)`.
  - **Existing tables:**
    - `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS order_global_id uuid`.
    - Replace `_store_public_settings` so its defaults also contain `"order_expiry_hours":24`. Keep every Slice 1
      default byte-identical.
  - **Done note:** hashes use the core `sha256()` function, so the migration needs no extension (pgcrypto not required). Table privileges are also revoked on top of RLS: anon has none; authenticated has SELECT only on the three synced tables and nothing on the private ones.
- [X] T005 Migration part 2: internal helpers in `supabase/migrations/2026-10-23_retail_ordering_s2.sql`, all revoked
  from `PUBLIC`, `anon` and `authenticated`.
  - `_gateway_ok(text)`: sha256 hex matched against non-revoked `storefront_gateway_keys`.
  - `_order_phone(text)`: digits only, `00` prefix dropped, 7–8 digits → `961` + digits, `+<digits>` when 8–15 digits,
    else NULL. Must match `storefront/src/phone.ts`.
  - `_order_quote(p_store uuid, p_lines jsonb)`, research R14 verbatim:
    - **Line checks:** retail tier only; `base` unit or a live unit whose global id is in `_store_orderable_keys`;
      listing published and the product live with `active = 1`; not `out_of_stock` (`track_inventory=1 AND stock<=0`);
      qty > 0 and ≤ 999; qty integer unless it's the base unit of a measured product (≤ 3 decimals, `isMeasuredUnit`
      rules from Slice 1); listing `min_quantity` in base units summed over the listing's lines; ≤ 50 lines; store
      `min_order_usd`.
    - **Pricing:** local unit price = unit `price_lbp` when > 0, else `round(usd × rate)`, where the rate is the first
      non-USD currency by `local_id`. Line USD = `round(price × qty, 2)`, line local = `round(local_unit × qty)`.
    - **Problem codes** as listed in the contract.
  - `_orders_expire(p_tenant uuid)`: overdue `submitted` → `expired`, `closed_at = now()`, plus an `expired` event with
    actor `system`.
  - Also `_order_event(...)`, `_order_owner(p_order uuid)` (`FOR UPDATE`, tenant = `auth.uid()`) and
    `_order_public(orders)` (public view fields exactly as in contracts/cloud-api-s2.md: first name only, no phone,
    note or hashes).
  - **Done note:** extra internal helpers `_order_sha256`, `_order_measured`, `_order_lines_json`, `_order_owner_result`, `_order_owner_check`, `_order_lock` (shared preamble of the owner functions). An empty cart gives the order-level problem `empty`.
- [X] T006 Migration part 3: public functions `order_quote`, `order_submit`, `order_status`, `order_cancel`, with the
  signatures and step order from contracts/cloud-api-s2.md.
  - **`order_submit` check order:** gateway → store gate + `ordering_mode='online'` + pickup or delivery on → expire →
    idempotency replay (hash match → `existing`, else `refused`) → trap → fields (`status_key` must match
    `^[A-Za-z0-9_-]{32}$`) → blocked phone → phone limits ("≤ 5 orders in the last hour and ≤ 3 in state
    `submitted`", per store) → network limits ("per network per store ≤ 10 / hour and per network across all stores ≤
    30 / hour") → quote / `changed` → insert.
  - **Order number:** from `order_counters` via `INSERT … ON CONFLICT DO UPDATE SET last_no = order_counters.last_no +
    1 RETURNING`, first number 1001, shown as `W-<number>`.
  - **Storage:** `status_key_hash` = sha256 hex of `p_status_key`; `expires_at = now() + order_expiry_hours`.
  - **Races:** a unique violation on the idempotency key becomes `existing`.
  - **Results:** every function returns `jsonb` with `ok` and `code`, and never raises for expected refusals.
- [X] T007 Migration part 4: owner functions per contracts/cloud-api-s2.md: `order_accept`, `order_reject`,
  `order_ready`, `order_cancel_by_shop`, `order_complete`, `order_complete_undo`, `orders_sweep`,
  `order_blocked_phones`, `order_block_phone` and `order_unblock_phone`.
  - **Every function:** calls `_orders_expire(auth.uid())`, locks the order, and checks `state = p_expected_state AND
    state IN (allowed)`. A mismatch returns `handled` with the current row. Each result is `{ok, code, order, lines}`.
  - **`order_accept`:** unlisted lines confirm at `ordered_qty`; a reason is required when confirmed < ordered; all
    zero → `all_zero`; it sets `confirmed_total_usd` / `_local` with R14 rounding; it writes `confirmed`, plus
    `adjusted` when any line was reduced.
  - **`order_complete`:** idempotent for the same sale id; a different sale id → `handled`.
  - **`order_complete_undo`:** only when `sale_global_id` matches. It restores the pre-completion state (from the last
    event's `from_state`) and writes `completion_undone`.
  - **No money effects:** none of these functions writes to `transactions`, `products` or any money table (FR-038).
  - **Done note:** `order_accept` also returns `invalid` (with `line_no`) for a non-numeric or negative quantity; `order_complete` returns `invalid` without a sale id.
- [X] T008 Migration part 5: grants exactly as in the contract table.
  - Every function: `REVOKE ALL … FROM PUBLIC`.
  - Public functions: `GRANT EXECUTE` to `anon, authenticated`.
  - Owner functions: `authenticated` only.
  - Helpers: revoked from all.
  - Tables: no anon grants. Confirm that the default privileges don't leak, as the 2026-10-18 file does.
- [X] T009 Write `tests/orders-sql.test.ts` on PGlite.
  - **Setup:** reuse the stub schema and role/`auth.uid()` emulation of `tests/commerce-sql.test.ts` (copy the helper
    or extract it to `tests/helpers/pgliteCommerce.ts`), add `transactions` to the stubs, and apply every migration
    through `2026-10-23` twice.
  - **Gateway:** no or wrong key → `gateway` on all four public functions, and nothing written.
  - **Pricing (SC-004):** an altered browser price or total → `changed` with server prices, and no row.
  - **Idempotency (SC-008):** the same attempt key twice → one order, `existing`. A different status key with the same
    attempt key → `refused`.
  - **Limits (SC-009):** the 6th order per phone per hour and the 4th in `submitted` are refused; three orders in a day
    are accepted; network limits behave the same way; trap and blocked phone → `refused`.
  - **Fields:** `invalid` per field; delivery without an address is refused.
  - **Numbering:** numbers per store start at 1001.
  - **Transitions:** every allowed transition works and every other one returns `invalid_transition`.
  - **Concurrency (SC-006):** with expected-state mismatches, the second accept gets `handled` and the current row.
  - **Accept:** `confirm_exceeds`, `reason_required`, `all_zero`; confirmed totals are correct.
  - **Complete:** idempotent for the same sale; another sale → `handled`; undo restores `ready` or `confirmed`.
  - **Expiry:** an order past `expires_at` becomes `expired` through `orders_sweep` and on `order_status`, and owner
    actions on it return `expired`.
  - **Privacy:** the public view has no phone, note, network, idempotency key or hash.
  - **Isolation:** tenant B's owner functions return `not_found` on tenant A's orders. RLS: authenticated sees only its
    own rows; anon sees nothing.
  - **Grants:** `has_function_privilege` matrix.
  - **No money effects:** order functions never change `transactions` or `products`.
  - **Done note:** 14 tests, all green (runs on PGlite only; no native module needed, so `npx tsx --test tests/orders-sql.test.ts` works on its own). The stub schema is inlined instead of extracted to a helper.
- [X] T010 [P] Write `supabase/checks/2026-10-23_retail_ordering_s2_checks.sql` per the contract's checks list. All
  queries are read-only; the gateway keys are reported as a count only. Run it in `tests/orders-sql.test.ts` the way
  the Slice 1 checks file is run.
  - **Done note:** every check returns `ok = true`; the gateway-key row is a count only.
- [X] T011 [P] Create `server/cloudCall.ts`.
  - `withTimeout<T>(p, ms)` rejects with `CloudTimeoutError` after `ms`.
  - `callRpc(tenantId, fn, args, { timeoutMs = 10000 })` returns `CloudResult<T> = { ok: true, value } | { ok: false,
    reason: 'offline' | 'failed', error? }`, using `getActiveSession()`. These count as `offline`: no session, a
    different tenant, a timeout, or a thrown network error. An RPC `error` counts as `failed`.
  - Test seam `__setRpcCaller(fn | null)`.
  - Tests in `tests/cloud-call.test.ts` (with T003's fake): ok, RPC error → failed, throw → offline, hang → offline
    after the timeout (use a 50 ms timeout in the test), wrong tenant → offline.
- [X] T012 [P] Add the permissions.
  - **Keys:** `server/permissions.ts` `PERMISSION_GROUPS` gets `{ area: 'orders', keys: ['orders.view',
    'orders.manage'] }`.
  - **Role defaults** (research R23): admin and manager get both; cashier, staff and accountant get `orders.view`.
    Stored role maps gain these defaults on first read.
  - **Client mirror:** `src/lib/permissions.ts`, plus `PAGE_PERMISSIONS.onlineOrders = ['orders.view']`.
  - **i18n:** `perm_area_orders`, `perm_orders_view`, `perm_orders_manage` in en/ar/fr in
    `src/intl/locales/permissions.ts`.
  - **Roles matrix:** shows the new area (`src/pages/settings/RolesSection.tsx`).
  - **Tests** in `tests/permissions.test.ts`: the defaults per role; stored maps gain the keys with the defaults; the
    client mirror deep-equals the server.
- [X] T013 Add the local mirrors in `server/db.ts`.
  - **Tables:** create `orders`, `order_lines` and `order_events` before the sync-metadata loop, with the columns from
    data-model-s2's "Local SQLite mirrors" section: local `id INTEGER PK`, `tenant_id`, `store_id`, `order_id` and
    `product_id` as local ids, the global-id text fields `sale_global_id`, `unit_key` and `listing_id`, and no FK
    constraints. `network_hash`, `idempotency_key` and `status_key_hash` are not created.
  - **Columns and index:** add `order_global_id TEXT` to `transactions` and `archived_transactions` through the existing
    column loops, plus `CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_order ON transactions(order_global_id)
    WHERE order_global_id IS NOT NULL`.
  - **Tests:** extend `tests/multi-tenant-isolation.test.ts` so that order mirrors of tenant B are never returned to
    tenant A (assert via T032's routes once they exist; mark the case `todo` until then).

**Checkpoint**: the migration passes the PGlite suite twice; `cloudCall`, the permission keys and the mirror tables
exist; `npm test` is green. **Owner action**: apply the migration and its checks (quickstart-s2 §1.1).

---

## Phase 3: User Story 3 — The visitor places an online order and follows it (P1) 🎯 MVP

**Goal**: in an online-mode store the visitor reviews a server-priced quote, places the order once (even on retry),
gets `W-<n>` and a private status link, sees the status change, can cancel while it's New, and falls back to WhatsApp
when the cloud is down.

**Independent test**: quickstart-s2 §3 on the fixture: review with a changed price, place, retry after a dropped
response (same order), status page headers, cancel, unavailable → WhatsApp fallback. Off and WhatsApp stores render
unchanged.

- [ ] T014 [P] [US3] Write `tests/storefront-orders.test.ts`, calling `handle()` with the fixture gateway.
  - **Methods and bodies:** POST only on `order/quote`, `order` and `o/<key>/cancel`; any other method → 405 with
    `Allow`; a body over 16 KB → 413; a JSON route without `application/json` → 415; malformed JSON → 400
    `bad_request`.
  - **Headers:** every order response is `Cache-Control: no-store` with `X-Robots-Tag: noindex`; `o/<key>` is
    `private, no-store`, `noindex`, `Referrer-Policy: no-referrer`, with no `Set-Cookie` and no `Vary`.
  - **Keys and modes:** a key not matching `[A-Za-z0-9_-]{32}` → 404 without calling the gateway; a preview token on
    an order route is refused; a store not in online mode → `store_unavailable`; a missing `ORDER_GATEWAY_KEY` →
    online stores render as ordering off.
  - **Errors:** an unreachable gateway → 503 `{ok:false, code:'unavailable'}` with `Retry-After: 30`.
  - **Status page:** state sentences per state; first name only; `meta refresh` 60 only while `submitted`, `confirmed`
    or `ready`; the cancel form only in `submitted`; cancel → 303 with `?cancelled=1` or `?not_cancellable=1`.
  - **Network id:** `network.ts` picks `CF-Connecting-IP` > `True-Client-IP` > last `X-Forwarded-For` hop > socket,
    the hash changes with the date and the key, and the raw IP never appears in the output.
  - **Unchanged stores:** off and WhatsApp stores render byte-identical pages, apart from the asset version.
- [ ] T015 [P] [US3] Write `tests/storefront-order-js.test.ts`, extending the `vm` harness of
  `tests/storefront-cart.test.ts` with a programmable `fetch` stub, `crypto.getRandomValues` / `randomUUID` and
  `AbortController`.
  - **Review:** posts available lines with the shown prices, renders changed / unavailable / below-minimum markings,
    and "Place order" posts the quote's prices with `expected_total_usd`.
  - **Keys:** the attempt key and status key are created once per cart hash and reused on retry; a cart change makes
    new keys. The status key is 32 chars `[A-Za-z0-9_-]`.
  - **`created` / `existing`:** My orders gains `{number, key, at, state}` (≤ 20, newest first), the cart and the
    attempt are cleared, and the confirmation shows the link.
  - **`changed`:** re-renders the review and sends nothing more.
  - **Errors:** `invalid` → message by the field; `phone_limit` / `network_limit` → contact message; `unavailable`,
    a network error or a 15 s abort → the cart is kept and the WhatsApp fallback is offered only when `wa` is set
    (reusing `OmniCheckout`'s message).
  - **Privacy:** no cookies; no request other than the two order endpoints.
- [ ] T016 [P] [US3] Read `ORDER_GATEWAY_KEY` (optional) in `storefront/src/config.ts`, and declare it in
  `render.yaml` with `sync: false` (no value). Log one warning at startup when it is missing; that is not an error.
- [ ] T017 [P] [US3] Create `storefront/src/network.ts`. `visitorNetwork(headers, socketAddress, key, now)` takes the
  address from `CF-Connecting-IP`, then `True-Client-IP`, then the last `X-Forwarded-For` entry, then the socket, and
  returns `{ hash: sha256hex(utcDate + '|' + address + '|' + key), source }`. Log the `source` once per process ("network
  source: …") for quickstart-s2 §1.5. The address itself is never logged.
- [ ] T018 [US3] Extend `storefront/src/node-server.ts`.
  - `handle()` receives `method`, the body (POST only, read with a 16 KB cap → 413 `no-store`) and `network` from T017.
  - Methods other than GET, HEAD and POST → 405.
  - Add `order.js` to `ASSETS`.
  - Add cases to `tests/storefront-node-server.test.ts`: a real POST through the HTTP server, the size cap, and that a
    client-sent `X-Forwarded-Host` is still ignored.
- [ ] T019 [US3] Add route kinds `orderQuote`, `orderSubmit`, `orderStatus` (`o/<key>`) and `orderCancel`
  (`o/<key>/cancel`) under both store-root forms in `storefront/src/router.ts`. The key regex is
  `^[A-Za-z0-9_-]{32}$`; `lang` is kept.
- [ ] T020 [US3] Add the gateway in `storefront/src/data.ts` and `storefront/src/fixture.ts`.
  - **Interface:** `OrderGateway` with `quote`, `submit`, `status` and `cancel`.
  - **`SupabaseOrderGateway`:** calls the four RPCs with `p_gateway = ORDER_GATEWAY_KEY` and maps network or non-2xx
    errors to `UpstreamError`.
  - **`FixtureOrderGateway`:** in memory, with the same codes and rules (re-pricing from fixture listings, idempotency
    by attempt + status-key hash, limits, states). Dev switches `unavailable` and `dropNextResponse` exist for
    quickstart-s2 §3.
  - **Fixture store:** `demoFixture(n, { ordering: 'online' })` gives an online-mode store.
  - **Dev server:** `storefront/dev-server.ts` accepts `--ordering=online` (and keeps `--ordering` meaning WhatsApp).
- [ ] T021 [US3] Implement the order route handlers in `storefront/src/http.ts` exactly as in
  contracts/storefront-routes-s2.md.
  - JSON in and out, content-type and body checks, the headers listed in T014, and `status_url` =
    `<root>/o/<status_key>` on `created` and `existing`.
  - The status page renders through T024. Cancel posts to the gateway and redirects with 303.
  - A gateway `UpstreamError` → 503 JSON with `Retry-After: 30`.
- [ ] T022 [US3] Update `storefront/src/ordering.ts`.
  - `orderingEnabled()` also returns true for `ordering_mode === 'online'` with pickup or delivery on and the gateway
    key configured. Add `onlineOrdering(store)`.
  - `orderPayload` adds `mode`, `api: { quote, submit }`, and `ui` order strings from a new `ORDER_UI_KEYS`
    allow-list.
  - The WhatsApp rule for Slice 1 is unchanged.
- [ ] T023 [US3] Add the online-mode cart page to `storefront/src/render/cart.ts`.
  - Phone `required` with `inputmode="tel"` and maxlength 30.
  - The trap field `website` sits in an off-screen container with `tabindex="-1"` and `autocomplete="off"`.
  - The "Review order" / "Place order" button and the payment note.
  - Containers `#sf-quote`, `#sf-confirm` and `#sf-myorders`.
  - Load `<script src="/order.js?v=…" defer>` after `checkout.js`, only when `onlineOrdering(store)`.
  - WhatsApp-mode output stays byte-identical.
- [ ] T024 [US3] Create `storefront/src/render/status.ts`, the status page per contracts/storefront-routes-s2.md.
  - It shows the store header and logo, the number and state badge, a sentence per state (with the shop's reason for
    rejected or shop-cancelled), the lines with ordered and confirmed quantities and shortfall reasons, and the totals
    (confirmed totals once accepted).
  - It shows pickup with the store's pickup note, or delivery with the address, plus the first name and the 002
    contact buttons.
  - `<meta http-equiv="refresh" content="60">` while open; a cancel form only in `submitted`; it works without
    JavaScript; `order.js` is included only to update My orders.
  - The HTML must stay ≤ 30 KB.
- [ ] T025 [US3] Create `storefront/public/order.js` (plain ES2017, IIFE, `window.OmniOrder`) implementing the
  "`order.js` behaviour" section of contracts/storefront-routes-s2.md.
  - Review, place, the attempt and status keys in `sf-attempt:v1:<address>`, and My orders in
    `sf-orders:v1:<address>` (≤ 20).
  - The FR-022 fallback through `OmniCheckout`.
  - `fetch` with a 15 s `AbortController` timeout, and `try/catch` around every storage call.
  - It must stay ≤ 12 KB (LF).
- [ ] T026 [US3] Add order strings to `storefront/src/i18n.ts` in en/ar/fr, with identical keys and placeholders.
  - UI keys: `review_order`, `place_order`, `phone_required`, `quote_changed`, `price_was`, `line_unavailable`,
    `order_placed`, `order_number`, `status_link`, `copy_link`, `my_orders`, `forget_order`, `too_many_orders`,
    `order_failed`, `cloud_unreachable`, `send_whatsapp_instead`, `pay_on_handover_note`.
  - State keys: `state_submitted`, `state_confirmed`, `state_ready`, `state_completed`, `state_rejected`,
    `state_cancelled_customer`, `state_cancelled_shop`, `state_expired`.
  - Status-page keys: `cancel_order`, `cancel_confirm`, `cannot_cancel_contact`, `ordered_qty`, `confirmed_qty`,
    `shortfall_out_of_stock`, `shortfall_damaged`, `shortfall_customer_request`, `shortfall_other`.
  - Wire the client subset through `ORDER_UI_KEYS`.
- [ ] T027 [US3] Styles and budgets.
  - **Styles:** review list, changed-price marking, confirmation, My orders and the status page in
    `storefront/public/storefront.css`. Logical properties only, RTL-safe, no horizontal scroll at 360 px, CSS
    ≤ 24 KB.
  - **Asset version:** `order.js` is added to the `ASSET_VERSION` hash in `storefront/src/assets.ts`.
  - **Budgets:** `orderJsBytes` 12 KB and `statusHtmlBytes` 30 KB in `storefront/src/limits.ts`, with tests in
    `tests/storefront-routing.test.ts`.
  - **Preview:** `scripts/preview-server.ts` serves `order.js`.

**Checkpoint**: the US3 independent test passes on the fixture. **Owner action**: generate the gateway key, insert its
hash, set `ORDER_GATEWAY_KEY` on Render, and deploy (quickstart-s2 §1.2–1.5).

---

## Phase 4: User Story 4 — The shop sees, accepts or rejects online orders (P1)

**Goal**: orders reach every online register within 1 minute with a toast, a tone and a badge. Users with
`orders.manage` accept (with per-line confirmed quantities and reasons), reject, mark ready or cancel, atomically and
online only. Offline registers show the orders read-only. Shops can now select Online orders.

**Independent test**: quickstart-s2 §4 steps 1–4, 6–8 with two registers on a **test** business. In the automated
suites: mirror pull, first-action-wins mapping, offline/timeout, permissions.

- [ ] T028 [P] [US4] Write `tests/orders-sync.test.ts` with T003's fake.
  - **Pull:** order tables are pulled (hot, and the 30 s orders pull when a store of the tenant has `ordering_mode =
    'online'`) and are never pushed. FK translation: `store_id` → local store, `order_id` → local order, `product_id`
    → local product or null when unknown.
  - **Authority:** a mirror row touched locally (its `updated_at` bumped) is still overwritten by the next pull
    (`CLOUD_AUTHORITATIVE`). The `tenants` behaviour is unchanged.
  - **Sweep:** `orders_sweep` RPC is called before each orders pull, and its failure doesn't block the pull.
  - **Counts:** `pullFromCloud` returns per-table inserted and updated counts, and `onPulled` receives `{ newSubmitted,
    changed }` only when order rows changed.
  - **Cleanup:** a missing cloud table is skipped with one warning; a tenant reset clears the mirrors and their
    cursors.
- [ ] T029 [P] [US4] Write `tests/orders-routes.test.ts` (createTestApp + T011's seam).
  - **Reads:** `GET /api/orders` sorts submitted orders first (oldest first), then by date descending; filters `state`,
    `store`, `from`/`to` and `q` (number, name, phone); `effective_state` is `expired` past `expires_at`.
    `GET /api/orders/summary` excludes overdue orders. The detail shows lines with local stock, history and
    `actions` per state, permission and online status.
  - **Actions:** each action sends `p_expected_state` and `p_actor {name, terminal}`, applies the returned rows to the
    mirror and broadcasts.
  - **Error mapping:** per contracts/backoffice-api-s2.md (`ORDER_NEEDS_ONLINE` 503 on no session / timeout / throw;
    `handled` → `ORDER_ALREADY_HANDLED` 409 with the state, and the mirror is updated; `confirm_exceeds`,
    `reason_required`, `all_zero`, `expired`, `invalid_transition`, `not_found`, `ORDER_CLOUD_FAILED`). Local body
    validation runs before any RPC.
  - **Permissions:** without `orders.view` → 403 on reads; without `orders.manage` → 403 on actions; cashier defaults
    can read but not act.
  - **Isolation:** tenant isolation on every route.
- [ ] T030 [US4] Extend `server/sync.ts`.
  - Add `fkMap` entries for `orders`, `order_lines` and `order_events` (data-model-s2) and add the tables to
    `PULL_TABLES` (after `products`/`stores`) and `HOT_PULL_TABLES`, not to `PUSH_TABLES`.
  - Replace the `tableName !== 'tenants'` checks (pending-edit guard, `fallbackStart` clean-only filter) with a
    `CLOUD_AUTHORITATIVE` set.
  - Add an orders-only pull every 30 s while any of the tenant's stores has `ordering_mode = 'online'`, preceded by
    `orders_sweep` via `cloudCall`.
  - `pullFromCloud` returns counts. `startSyncEngine({ onPulled })` is called with the order counts.
  - `clearSyncCursors` and `server/tenantReset.ts` also cover the mirrors.
- [ ] T031 [US4] In `server.ts`, pass `onPulled` to `startSyncEngine`. It broadcasts `{ type: 'ORDERS_UPDATED',
  newSubmitted, changed }` to the tenant.
- [ ] T032 [US4] Create `server/orders.ts` (reads) and register the routes in `server/routes.ts`, all scoped by tenant.
  - **List:** `GET /api/orders`.
  - **Summary:** `GET /api/orders/summary`.
  - **Detail:** `GET /api/orders/:id`, with lines joined to local products and units, unit keys resolved, the
    `actions` object and `online` from the session status.
  - **Rules:** add `ROUTE_RULES` (`orders.view`) in `server/permissions.ts`.
  - **Isolation test:** enable the `todo` case from T013.
- [ ] T033 [US4] Add the actions to `server/orders.ts`: `POST /api/orders/:id/{accept,reject,ready,cancel}`.
  - Local validation first: quantities ≥ 0 and ≤ ordered; a reason (`out_of_stock` | `damaged` | `customer_request` |
    `other`) is required below ordered; reject and cancel need a reason of 1–300 chars.
  - Call the RPC through `cloudCall` (10 s), apply the returned rows to the mirror marked synced
    (`last_synced_at = updated_at`), and broadcast `ORDERS_UPDATED`.
  - Map the codes with `ValidationError`, add `ROUTE_RULES` (`orders.manage`), and give the routes the `broadcast`
    function (unlike `setupCommerceRoutes` today).
- [ ] T034 [P] [US4] Client types and strings.
  - Create `src/lib/ordersApi.ts` with the types and calls.
  - Create `src/intl/locales/orders.ts` with all page, drawer, state, reason, notification and error strings in
    en/ar/fr, registered like the other locale modules.
  - Extend the `translateServerError` prefix in `src/lib/serverErrors.ts` to `ORDER_`.
- [ ] T035 [US4] Allow Online orders in `server/commerce.ts`.
  - `ordering_mode = 'online'` is accepted (remove `ORDERING_MODE_UNAVAILABLE`). It requires pickup or delivery
    (`STORE_ORDERING_NEEDS_FULFILMENT`); WhatsApp is not required.
  - In `src/pages/settings/OnlineStoreSection.tsx`, the Online orders option is enabled (no "coming soon"), with a
    hint that the WhatsApp fallback needs a number.
  - Update `tests/commerce-store.test.ts`: `online` is accepted with a fulfilment method and refused without one.
- [ ] T036 [US4] Create the Online orders page, `src/pages/OnlineOrders.tsx` with `src/pages/orders/OrderDetailDrawer.tsx`,
  built from the UI kit (`PageHeader`, `Toolbar`, state chips, store filter, `DateRangePicker`, `SearchInput`,
  `DataTable`, `Drawer`, `Badge`; pattern of `src/pages/InvoiceManagement.tsx`).
  - **Detail:** customer, fulfilment, note, lines with local stock, history.
  - **Accept dialog:** per-line confirmed quantity, plus a reason select when reduced.
  - **Other actions:** reject, ready and cancel with a reason; buttons enabled from `actions`.
  - **Offline:** a banner with read-only actions.
  - **Conflicts:** `ORDER_ALREADY_HANDLED` shows a toast with the new state and refreshes.
  - Refetch on `pos-sync` `ORDERS_UPDATED`.
  - No `alert` or `confirm`.
- [ ] T037 [US4] Register the page.
  - Route `guard('onlineOrders', …)` in `src/Dashboard.tsx`.
  - Sidebar item in `src/components/shell/Sidebar.tsx` with an icon and a badge (submitted count from
    `/api/orders/summary`).
  - TopBar title in `src/components/shell/TopBar.tsx`.
- [ ] T038 [US4] Create `src/hooks/useOrderNotifications.ts`, mounted in the Dashboard and in the POS (`usePos` socket
  `ORDERS_UPDATED`) only when `can('orders.view')`.
  - On `newSubmitted > 0`: an info toast for 8 s ("New online order W-…"), a Web Audio tone (~200 ms, generated, no
    file; unlocked on the first user interaction) unless `localStorage['omnipos.orders.mute'] === '1'`, and a badge
    refresh.
  - Add a mute toggle on the Online orders page.
  - Test the pure parts (mute flag, which events trigger) in `tests/order-notifications.test.ts` with a tiny DOM-free
    harness.
- [ ] T039 [US4] Add "WhatsApp customer" and "Call customer" to the detail drawer.
  - The message is pre-filled for the order's state (accepted with the confirmed total and the pickup note, ready,
    rejected with the reason) in the **store's** language, from `src/intl/locales/orders.ts`.
  - The phone is normalised with the Slice 1 rule; the detail response includes `customer_wa_digits` computed
    server-side with `storefront/src/phone.ts`.
  - Links open `wa.me` or `tel:` without blocking the UI.
- [ ] T040 [US4] Verify in the preview server (Node-ABI rebuild in the main checkout, restored afterwards).
  - Seed mirror orders in `scripts/preview-server.ts` (New, Accepted, Ready, Expired).
  - Check the list, filters, detail, the accept dialog in en and ar (RTL), the offline banner, and the badge.
  - Simulate `ORDERS_UPDATED` for the toast.
  - Capture screenshots.

**Checkpoint**: shops can turn on Online orders; with the owner steps done, quickstart-s2 §4 steps 1–4 and 6–8 pass on
a test business.

---

## Phase 5: User Story 5 — The accepted order becomes a POS sale at handover (P1)

**Goal**: "Complete sale" in the POS window opens a tab pre-filled from the order. The finished sale is an ordinary
transaction priced from the order by the server. The order is completed in the cloud first, so one order makes at most
one sale. Settlement and refunds are unchanged.

**Independent test**: quickstart-s2 §4 steps 5 and 10. Automated: an order sale equals the same sale typed by hand
(stock, invoice, payments, balance, cash drawer, settlement), live and settled; a second completion is refused.

- [ ] T041 [P] [US5] Write `tests/orders-sale.test.ts` (createTestApp, T003's fake via T011's seam).
  - **Sale draft:** `GET /api/orders/:id/sale-draft` returns confirmed lines with local product and unit; a removed
    unit converts to base (qty × factor, price ÷ factor); a deleted product → `skipped`; the single phone match →
    that customer, 0 or 2+ matches → Walk-in; a non-completable state → `ORDER_NOT_COMPLETABLE`.
  - **Sale with `order_global_id` (SC-007):** compared with the same sale posted without it, stock, the invoice lines
    (`unit_price` = the quoted price even when `allow_price_override = '0'`), payments in USD, LBP and mixed, the
    customer balance and the cash drawer must all be equal. Lines above the confirmed quantity or with other prices
    follow the normal rules.
  - **Completion:** `order_complete` is called before the commit with the pre-generated `global_id` and the sale total.
  - **Refusals:** offline → `ORDER_NEEDS_ONLINE` and nothing written; `handled` → `ORDER_ALREADY_COMPLETED` and nothing
    written; a second sale for the same order, live or after settlement, is refused locally.
  - **Compensation:** a commit failure after a cloud `ok` calls `order_complete_undo`.
  - **Settlement:** it archives the sale with `order_global_id` (`archived_transactions`), the UNION reads return it,
    and refunds and edits of the sale work unchanged.
  - **Permissions:** a sale needs the sale rule plus `orders.view`.
- [ ] T042 [US5] Carry `order_global_id` through settlement and sync in `server/routes.ts` and `server/sync.ts`.
  - Add `order_global_id` to the settlement `INSERT INTO archived_transactions … SELECT` column list and to
    `TX_LIVE_COLUMNS` / `TX_ARCHIVED_COLUMNS`.
  - Add it to `OPTIONAL_CLOUD_COLUMNS.transactions`, so it is pushed once the cloud has the column.
  - It is not editable in `server/invoiceEdit.ts` (an edit keeps it).
- [ ] T043 [US5] Add the sale draft to `server/orders.ts`: `GET /api/orders/:id/sale-draft` per
  contracts/backoffice-api-s2.md.
  - Resolve lines, the unit conversion and skipped lines.
  - Phone match (research R24): normalise the order phone and every live customer phone of the tenant with
    `whatsappDigits` from `storefront/src/phone.ts`; exactly one match → its id, otherwise Walk-in.
  - Rule: `orders.view` plus the POS sale permission.
- [ ] T044 [US5] Refactor `POST /api/transactions` in `server/routes.ts` into a validation phase and a commit phase,
  with the handler made `async`. This is the riskiest change of the slice. Without `order_global_id` it must be
  byte-identical in effects and responses; the existing suites must stay green at every step.
  - **Order checks:** with `order_global_id`, refuse refunds and other types, check the mirror state
    (`confirmed`/`ready`, effective) and that no live or archived transaction carries it.
  - **Pricing:** price matching lines from the order's `unit_price_usd` (converted to the line's unit) without the
    override setting.
  - **Completion:** after validation, require a session, pre-generate `global_id`, `await order_complete(…)` through
    `cloudCall` (10 s), then commit with `global_id` and `order_global_id`. On a commit exception, call
    `order_complete_undo` (best effort, logged).
  - **Response and broadcast:** apply the returned order row to the mirror, broadcast `ORDERS_UPDATED` and
    `TRANSACTIONS_UPDATED`, and respond with `order: { number, state }`.
  - **Rules:** update `ROUTE_RULES` for the extra `orders.view`.
- [ ] T045 [US5] Extend the POS sale tabs in `src/hooks/usePos.ts`.
  - `SaleTab` gains `orderGlobalId?` and `orderNumber?`.
  - `newSaleTabFromOrder(draft)` builds cart lines (product, `uom_id`, quantity, `unit_price`), sets the stakeholder,
    labels the tab with the order number, and shows the skipped and converted warnings.
  - Checkout sends `order_global_id`.
  - On `ORDER_NEEDS_ONLINE`, offer "Sell without the order", which clears the link from the tab.
  - On `ORDER_ALREADY_COMPLETED`, show a toast and keep the tab.
  - Tabs persist with the new fields (localStorage key unchanged, missing fields tolerated).
- [ ] T046 [US5] Add the POS window UI.
  - Create `src/components/pos/OnlineOrdersDrawer.tsx`: confirmed and ready orders first, New orders read-only, and a
    "Complete sale" button calling the sale draft and then `newSaleTabFromOrder`.
  - In `src/components/PosHeader.tsx`, add an "Online orders" button with the submitted badge, visible only with
    `orders.view`.
  - The back-office detail drawer shows "Complete at the POS" for confirmed and ready orders, plus a link to the sale
    once completed.
- [ ] T047 [US5] Verify in the preview server: complete a seeded accepted order from the POS drawer with a fake RPC
  (`__setRpcCaller` hooked in `scripts/preview-server.ts` behind a `PREVIEW_FAKE_ORDERS=1` env flag). The tab is
  pre-filled, the sale finishes with mixed USD/LBP payment, the stock goes down, and the order shows Completed with
  the sale link. Check en and ar, and capture screenshots.

**Checkpoint**: Slice 2's main flow (order → accept → sale) works end to end on the dev PC with faked cloud calls.

---

## Phase 6: User Story 6 (Slice 2 parts) — Owner sets order expiry and blocked phones (P2)

**Goal**: per store, expiry hours (1–72, default 24) and a blocked-phone list managed online by `orders.manage`.

**Independent test**: set the expiry to 1 hour and check that an unanswered order expires; block a phone and check
that its next order is refused; invalid hours are refused with the field error.

- [ ] T048 [P] [US6] Extend the tests.
  - `tests/commerce-store.test.ts`: `order_expiry_hours` is an integer 1–72 (0, 73, 1.5 and text →
    `STORE_ORDER_EXPIRY_INVALID`), the default is 24, and stores created before the slice return 24.
  - `tests/orders-routes.test.ts`: the blocked-phone routes (list, add with normalisation, `ORDER_PHONE_INVALID`,
    remove, `orders.manage` required, offline → `ORDER_NEEDS_ONLINE`).
- [ ] T049 [US6] Implement the settings and routes in `server/commerce.ts`.
  - `order_expiry_hours` joins the settings allow-list and `STORE_SETTING_DEFAULTS` (24), with its validation.
  - Blocked-phone routes `GET` / `POST /api/commerce/stores/:id/blocked-phones` and `DELETE …/:phone` go through
    `cloudCall` to `order_blocked_phones`, `order_block_phone` and `order_unblock_phone`, with `ROUTE_RULES`
    (`orders.manage`).
- [ ] T050 [US6] Add the UI.
  - In `src/pages/settings/OnlineStoreSection.tsx` (Ordering card): "Orders expire after (hours)" when the mode is
    online, and a "Blocked phones" list with add and remove, online only, hidden without `orders.manage`.
  - In `OrderDetailDrawer`, a "Block this phone" action with a confirmation dialog.
  - Strings in en/ar/fr.

---

## Phase 7: Polish & cross-cutting

- [ ] T051 [P] Update the docs.
  - `storefront/README.md`: `order.js`, the order routes, `ORDER_GATEWAY_KEY`, the network header check, and the
    deploy order (migration → gateway key → env var → storefront deploy → desktop release).
  - Record any deviation from the contracts in the contract files.
- [ ] T052 [P] Check i18n and RTL.
  - The storefront key-parity test covers the new keys.
  - The back-office `orders.ts` locale has the same keys in en/ar/fr.
  - An Arabic status page and cart page render with no English labels.
- [ ] T053 Run the full gate and fix anything red: `npm test`, `npx tsc --noEmit` (no new errors vs T001),
  `npm run build`, `npm run build:server` and `node --check dist-server/server.js`.
- [ ] T054 Record the results.
  - Add a "Slice 2" section to `specs/003-retail-ordering/validation.md` with the quickstart-s2 §2–3 results and
    placeholders for §1 (owner setup) and §4 (two registers on a test business, notification and status timings).
  - Update the `ROADMAP.md` 003 row (Slice 2 implemented, not merged; pending: migration, gateway key, Render env,
    desktop release, end-to-end check) and add To-do lines for the owner steps.

---

## Dependencies & execution order

- **Phases:** 1 → 2 → stories.
  - In Phase 2: T004 → T005 → T006 → T007 → T008 (one migration file, in order); then T009 and T010. T011, T012 and
    T013 are independent of the migration.
  - **US3** (T014–T027) needs T004–T008 for the contract shape only: the storefront tests use the fixture gateway.
  - **US4** (T028–T040) needs T011–T013 and the migration semantics.
  - **US5** (T041–T047) needs US4's mirror, reads and `cloudCall` (T030, T032, T011).
  - **US6** (T048–T050) needs T035 and T011. Polish comes last.
- **Same-file serialisation:**
  - `supabase/migrations/2026-10-23_retail_ordering_s2.sql`: T004–T008
  - `storefront/src/http.ts`: T021
  - `storefront/src/render/cart.ts`: T023
  - `storefront/src/i18n.ts`: T026
  - `storefront/public/storefront.css` + `assets.ts`: T027
  - `server/sync.ts`: T030, T042
  - `server/orders.ts`: T032, T033, T043
  - `server/routes.ts`: T032 (registration), T042, T044
  - `server/commerce.ts`: T035, T049
  - `server/permissions.ts`: T012, T032, T033, T044, T049
  - `src/pages/settings/OnlineStoreSection.tsx`: T035, T050
  - `src/pages/orders/OrderDetailDrawer.tsx`: T036, T039, T046, T050
  - `src/hooks/usePos.ts`: T038, T045
  - `tests/orders-routes.test.ts`: T029, T048
  - `tests/commerce-store.test.ts`: T035, T048

## Parallel examples

```text
Phase 2:  T004→T005→T006→T007→T008 → T009 ‖ T010;   in parallel: T011 ‖ T012 ‖ T013
US3:      T014 ‖ T015 ‖ T016 ‖ T017 first, then T018 → T019 → T020 → T021, T022 → T023, T024, T025, T026, T027
US4:      T028 ‖ T029 ‖ T034 first, then T030 → T031, T032 → T033, T035, T036 → T037, T038, T039, then T040
US5:      T041 first, then T042, T043 → T044 → T045 → T046, then T047
US6:      T048 first, then T049 → T050
Polish:   T051 ‖ T052, then T053 → T054
```

The storefront work (US3) touches only `storefront/`, `render.yaml` and its tests. It can run in its own session in
parallel with the register work (US4/US5: `server/`, `src/`), once Phase 2 is done.

## Implementation strategy

1. **MVP:** Phases 1–3. The cloud model plus storefront ordering with status pages. Customers can order, but shops
   can't select Online orders until US4 ships, so in practice this lands together with step 3.
2. **Increment 2:** Phase 4. Registers see, get notified about, and answer orders. This is the first increment a shop
   can switch on; it needs a desktop release.
3. **Increment 3:** Phase 5. Orders become POS sales, closing the loop on stock and money.
4. **Increment 4:** Phases 6–7. Expiry and blocked-phone settings, docs, the full gate, validation.
5. **Owner deployment** (outside these tasks):
   - apply `2026-10-23_retail_ordering_s2.sql` and its checks;
   - generate the gateway key, insert its hash, set `ORDER_GATEWAY_KEY` on Render;
   - deploy the storefront from `main` after merging;
   - desktop release;
   - quickstart-s2 §4 on a **test** business only.

**Totals**: 54 tasks — Setup 3, Foundational 10, US3 14, US4 13, US5 7, US6 3, Polish 4.
