# Implementation Plan: B2C Retail Ordering — Slice 1 (WhatsApp order)

**Branch**: `003-retail-ordering` | **Date**: 2026-10-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-retail-ordering/spec.md` (clarified 2026-10-20)

**Scope of this plan**: **Slice 1** in full — cart (US1), WhatsApp order (US2), ordering settings (US6, WhatsApp mode),
orderable units (FR-039/FR-040). **Slice 2** (online orders, US3–US5) is outlined at the end and gets its own
plan update, research pass and tasks once Slice 1 has shipped.

**Depends on**: 002 deployed (storefront on Render at `myomnipos.com`, cloud migrations `2026-10-18` / `2026-10-19` /
`2026-10-19b` applied). This branch is cut from `002-tenant-online-store` (same commit as `main` on 2026-10-20).

## Summary

Add a cart and a "Order on WhatsApp" checkout to the 002 storefront without changing how pages are cached. The server
keeps rendering one HTML per URL; it now adds "Add to cart" controls and the store's ordering settings (all store-level
data) when the store's ordering mode is WhatsApp. A new `cart.js` keeps the cart per store in `localStorage`, renders
the `/cart` page and builds the pre-filled `wa.me` message in the store's language. OmniPOS stores nothing about the
visitor or the order.

Around it: a cloud migration that exposes the ordering settings and only the orderable units through the public catalog;
orderable units switch from register-local ids to unit keys (`"base"` / unit global id) with a one-time local
conversion; Settings → Online store gets an Ordering card and the product's Online store tab gets orderable units and a
minimum quantity.

## Technical Context

**Language/Version**: TypeScript 5. Storefront: Node 22 web service (Render), no UI framework; browser script in plain
ES2017 (no build step, like `storefront.js`). Back office: existing React 19 + Express server.

**Primary Dependencies**: none new (runtime or dev). Cloud SQL tests keep using `@electric-sql/pglite`.

**Storage**: Visitor browser `localStorage` (cart, optional remembered details). Supabase Postgres: `stores.settings`
JSON (new keys), `store_listings.orderable_unit_ids` (new value format), three public catalog functions recreated.
Local SQLite: no schema change; one idempotent data conversion of `orderable_unit_ids`.

**Testing**: `npm test` (node:test). Storefront render/routing tests (cart route, controls only when ordering is on,
identical HTML for all requests, budgets); a cart-logic test that loads `cart.js` against a minimal DOM/`localStorage`
stub (message builder, limits, minimums, local-price rule, storage failure); PGlite tests for the migration (settings
defaults, orderable filtering incl. legacy integer arrays, grants); back-office tests for settings validation and the
unit-key conversion.

**Target Platform**: Phone browsers (Android Chrome, iOS Safari) and desktop; WhatsApp app or WhatsApp Web. Back office:
Windows Electron app.

**Project Type**: existing web service (`storefront/`) + desktop app + cloud migration.

**Performance Goals**: 002 SC-001 unchanged (home ≤ 2 s, product ≤ 1.5 s on 4G). Budgets: home HTML ≤ 70 KB (was 60),
`storefront.js` ≤ 10 KB, `cart.js` ≤ 16 KB (loaded only when ordering is on), CSS ≤ 24 KB (was 20).

**Constraints**: pages identical per URL, no cookies (FR-005, FR-044); cloud egress unchanged (SC-002); en/ar/fr + RTL,
360 px (FR-009); nothing stored server-side (FR-014); defaults keep every store as today (Constitution VII).

**Scale/Scope**: carts ≤ 50 lines; hundreds of stores; ordering is opt-in per store.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — still passing.*

| Principle | How Slice 1 complies | Status |
|---|---|---|
| I. Money & balance integrity | No invoice, payment, stock or balance is created or changed. Cart totals are display only, computed with the same rule as 002's prices (USD 2 decimals; own `price_lbp` or USD × store rate, whole amount). | Pass |
| II. Tenant isolation | No new table. Public catalog stays allow-listed and gated per store; the new fields are store-level ordering settings and per-listing unit keys. Unit-key conversion runs per tenant and only on the tenant's own listings/units. | Pass |
| III. Offline-first | Registers unaffected; ordering settings and units are ordinary offline edits that sync later. Storefront works before the migration (ordering simply off). | Pass |
| IV. Server authoritative | Ordering settings and unit keys validated by the local server (new error codes, translated); new/changed routes keep their ROUTE_RULES. Slice 1 has no server-side order to trust; the WhatsApp message is explicitly "to be confirmed by the shop". | Pass |
| V. Regression suite green | New tests listed in Technical Context; existing storefront/commerce suites must stay green. | Pass |
| VI. Trilingual, RTL, design system | New storefront strings in `storefront/src/i18n.ts` (key-parity test); back-office strings in `src/intl/locales/commerce.ts`; back-office UI with the kit. | Pass |
| VII. Backward compatible | `ordering_mode` defaults to `off`; storefront output for stores with ordering off is byte-identical to 002 except the asset version. Old registers keep pushing integer unit arrays, which the cloud ignores (all units orderable = today). Local conversion is idempotent and keeps the old meaning (base unit always included). | Pass |

## Project Structure

### Documentation (this feature)

```text
specs/003-retail-ordering/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0 (R1–R10 Slice 1, R11 Slice 2 outline)
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── storefront-routes.md   # cart route, controls, sf-order JSON, cart storage, WhatsApp message
│   ├── cloud-api.md           # migration 2026-10-21_retail_ordering_s1.sql
│   └── backoffice-api.md      # store ordering settings, listing unit keys
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
storefront/
├── src/
│   ├── data.ts                 # + ordering fields on PublicStore, base_orderable on PublicListing (defaults: off / true)
│   ├── router.ts               # + kind 'cart' (/cart and /s/<address>/cart)
│   ├── http.ts                 # + cart route (unavailable / redirect when ordering off), noindex
│   ├── ordering.ts             # NEW — orderingEnabled(store), orderable units of a listing, sf-order JSON payload
│   ├── render/product.ts       # + unit picker, quantity, "Add to cart" (hidden until JS)
│   ├── render/home.ts          # + card "Add" (single orderable unit) or "Choose" link
│   ├── render/cart.ts          # NEW — cart page shell + checkout form
│   ├── render/layout.ts        # + cart link with count badge, cart.js + sf-order JSON when ordering is on
│   ├── i18n.ts                 # + cart / checkout / message strings (en, ar, fr)
│   ├── assets.ts, limits.ts    # new asset version; budgets (R10)
│   └── fixture.ts              # + a store with ordering on, units with keys
├── public/
│   ├── cart.js                 # NEW — cart storage, rendering, checkout, WhatsApp message, "did you send it?"
│   └── storefront.css          # + cart, unit picker, checkout styles (logical properties)

server/
├── commerce.ts                 # + ordering settings keys & validation; orderable units as keys; WhatsApp-clear guard
└── db.ts                       # + one-time conversion of orderable_unit_ids (int ids → unit keys), marked for push

src/
├── lib/commerceApi.ts          # types: ordering settings, orderable_unit_keys
├── pages/settings/OnlineStoreSection.tsx   # + Ordering card (mode, pickup, delivery, notes, minimum)
├── pages/products/OnlineStoreCard.tsx      # + orderable units checkboxes, minimum quantity
└── intl/locales/commerce.ts    # + strings and error codes

scripts/preview-storefront.ts   # LocalDbSource: ordering fields + unit keys (dev preview)

supabase/migrations/2026-10-21_retail_ordering_s1.sql   # NEW
supabase/checks/2026-10-21_retail_ordering_s1_checks.sql

tests/
├── storefront-render.test.ts   # (+) controls only with ordering on, identical HTML, cart page, i18n parity, escaping
├── storefront-routing.test.ts  # (+) cart routes, cache headers, budgets
├── storefront-cart.test.ts     # NEW — cart.js logic: storage, limits, minimums, decimals, totals, message, URL cap
├── commerce-store.test.ts      # (+) ordering settings validation, WhatsApp guard
├── commerce-listings.test.ts   # (+) unit keys API, conversion of legacy ids, idempotence
└── commerce-sql.test.ts        # (+) migration on PGlite: new columns, orderable filter, legacy arrays ignored, grants
```

**Structure Decision**: everything stays in the two existing deployables (storefront web service, desktop app) plus one
cloud migration. The cart is a progressive-enhancement script beside `storefront.js`, loaded only on stores that take
orders, so stores without ordering pay nothing in page weight.

## Phase 0 — Research

See [research.md](research.md): R1–R10 settle every Slice 1 unknown; R11 records the Slice 2 direction.

## Phase 1 — Design

- [data-model.md](data-model.md)
- [contracts/storefront-routes.md](contracts/storefront-routes.md),
  [contracts/cloud-api.md](contracts/cloud-api.md),
  [contracts/backoffice-api.md](contracts/backoffice-api.md)
- [quickstart.md](quickstart.md)

## Spec coverage (Slice 1)

| Spec | Where |
|---|---|
| FR-001 slices / modes | settings `ordering_mode` (R6); `online` refused until Slice 2 |
| FR-002 only on public stores | storefront gate unchanged + `orderingEnabled()` (mode + WhatsApp digits + a fulfilment method) |
| FR-003, FR-006–FR-008 cart | product/card controls, `cart.js`, R2, R10 |
| FR-004/FR-005 browser-only, cacheable | R1, R2; render tests assert identical HTML and no cookies |
| FR-009 language/RTL/360 px | i18n.ts, CSS logical properties, render tests |
| FR-010–FR-012 checkout form | render/cart.ts + cart.js validation |
| FR-013–FR-016 WhatsApp | R8, R9; server guard `STORE_ORDERING_NEEDS_WHATSAPP` |
| FR-023 no delivery fee | message/checkout text only ("agreed with the shop") |
| FR-039/FR-040 orderable units, minimum | R5, R7, R10 |
| FR-044 no cookies/tracking | unchanged; storage only in the visitor's browser |
| FR-045/FR-046 settings | R6, R7; Ordering card |
| US6 AS1–AS4 | defaults off; validation; unit restriction everywhere; minimum order |

## Slice 2 outline (online orders — planned later)

Follows research R11. Ordered work, each step independently testable:

1. **Order model subset from 001 Slice B** — cloud tables `orders`, `order_lines`, `order_events`,
   `order_blocked_phones` (tenant-scoped, RLS owner-only, no anon policy); states New/Accepted/Ready/Completed +
   Rejected/Cancelled/Expired; ordered vs confirmed quantity; local read-only mirror via sync (hot table).
2. **Public submit/status/cancel** — anon SECURITY DEFINER RPCs with server re-pricing (FR-017/018), idempotency key
   (FR-020), abuse limits (FR-041), private status key; storefront routes `POST <store>/order` (no-store) and
   `/o/<key>` (private, no-store); WhatsApp fallback when the cloud is unreachable (FR-022).
3. **Back office "Online orders"** — list, detail with local stock, accept/adjust/reject/ready/cancel through owner RPCs
   that check state atomically (FR-027), notifications (FR-030), offline read-only (FR-032), permissions
   `orders.view` / `orders.manage` (FR-033).
4. **Complete sale** — POS sale tab pre-filled from the order; `transactions.order_global_id` + archived mirror carried
   through settlement (Constitution I); one sale per order (FR-036); customer matched by phone (FR-037).
5. **Expiry** — scheduled cloud job or lazy expiry on read (to be decided in Slice 2 research).

Settings `ordering_mode = 'online'` becomes selectable when step 3 ships.

## Complexity Tracking

| Exception | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Second browser script (`cart.js`) beside `storefront.js` | Keeps the 10 KB budget for every store and loads cart code only where ordering is on | One bigger script: every visitor of every store would download cart code |
| Page budgets raised (home HTML 60→70 KB, CSS 20→24 KB) | Per-card unit price data and cart/checkout styles | Fetching unit data on demand needs a new public endpoint and cloud reads |
| Public catalog functions dropped and recreated | `RETURNS TABLE` gains columns; Postgres can't alter that in place | A second RPC per page (more upstream calls on every cache miss) |
