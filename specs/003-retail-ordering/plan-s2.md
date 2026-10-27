# Implementation Plan: B2C Retail Ordering — Slice 2 (Online orders)

**Branch**: `003-retail-ordering-s2` | **Date**: 2026-10-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification `/specs/003-retail-ordering/spec.md` (clarified 2026-10-20), Slice 1 plan
[plan.md](plan.md) ("Slice 2 outline") and research R11.

**Scope of this plan**: **Slice 2** in full — online order submission and status (US3), shop handling (US4), conversion
into a POS sale (US5), and the Slice 2 parts of the ordering settings (US6: `online` mode, expiry, blocked phones).
Slice 1 (cart, WhatsApp order, orderable units) is shipped in v1.9.0 and is reused unchanged.

**Depends on**: v1.9.0 on `main` (001 Slice A, 002, 003 Slice 1; cloud migrations up to `2026-10-21` applied) and
PR #4 (product deletes reach the cloud). Branch cut from `main` at `f4d9adb`.

**User decisions (2026-10-22)**: storefront-only order gateway with a shared key (R12); orders roles — admin + manager
manage, cashier / staff / accountant view (R23).

## Summary

Turn the Slice 1 checkout into real orders when a store's ordering mode is **Online orders**. The storefront posts the
cart to new cloud functions that re-price it from the live catalog, apply abuse limits and store a **sales order**
(001's order model, B2C subset) with a per-store number and a private status link. Orders live in the cloud; registers
pull them every 30 s into a read-only local mirror, notify (toast, tone, badge), and act on them through atomic owner
RPCs (accept with adjusted quantities, reject, ready, cancel — first action wins, online only). At handover the POS
opens a sale tab pre-filled from the order; the sale is an ordinary transaction, priced from the order by the server,
and the order is marked completed in the cloud **before** the sale is committed so one order can never make two sales.

## Technical Context

**Language/Version**: TypeScript 5. Storefront: Node 22 web service (Render), plain ES2017 browser scripts, no build
step. Back office: React 19 + Express. Cloud: Postgres 17 (Supabase), plpgsql.

**Primary Dependencies**: none new. `pgcrypto` (already installed) for random keys and hashes; `@electric-sql/pglite`
(devDependency) for SQL tests.

**Storage**:
- **Cloud (new)**: `orders`, `order_lines`, `order_events` (synced shape, owner SELECT-only RLS); private
  `order_counters`, `order_blocked_phones`, `storefront_gateway_keys`; `transactions.order_global_id`; settings key
  `order_expiry_hours`.
- **Local SQLite**: read-only mirrors `orders`, `order_lines`, `order_events`; `transactions.order_global_id` and
  `archived_transactions.order_global_id`.
- **Visitor browser**: `sf-orders:v1:<address>` ("My orders"), idempotency key per checkout attempt.
- **Register**: `localStorage` mute flag.

**Testing**: `npm test`, with these suites:
- PGlite suite for the migration: gateway, re-pricing with altered prices, idempotency, limits, state machine,
  concurrency, expiry, privacy, grants.
- Sync tests: pull-only mirror, cloud-authoritative overwrite, sweep, post-pull broadcast.
- Back-office route tests with a fake RPC client: permissions, offline, timeout, error mapping.
- Sale-from-order tests: compared with a hand-typed sale on live and settled data, one sale per order, compensation,
  settlement carries `order_global_id`.
- Storefront tests: POST routing, body cap, no-store, status page, network extraction, `order.js` logic in `vm` with
  a `fetch` stub, budgets, i18n parity.
- Permission tests.

**Target Platform**: phone and desktop browsers (storefront); Windows Electron registers (back office and POS).

**Project Type**: existing storefront web service + desktop app + one cloud migration.

**Performance Goals**:
- **SC-005**: new order notified on every online register within 1 minute in 95% of cases (30 s orders pull).
- **SC-002**: page caching unchanged; only quote, submit, status and cancel reach the cloud.
- **Budgets**: `order.js` ≤ 12 KB; existing budgets unchanged.

**Constraints**:
- No cookies or tracking (FR-044).
- The POS never waits on orders (FR-032 / Constitution III).
- Every shop action is online and atomic (FR-027).
- Prices only from the server (FR-018 / Constitution IV).
- en / ar / fr + RTL.
- Defaults unchanged until a shop selects Online orders (SC-010 / Constitution VII).

**Scale/Scope**: hundreds of stores, tens of orders per store per day, ≤ 50 lines per order.

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 design — still passing.*

| Principle | How Slice 2 complies | Status |
|---|---|---|
| I. Money & balance integrity | Submitting, accepting, adjusting, readying, rejecting, cancelling and expiring an order touch no stock, invoice, payment or balance (FR-038). The only money event is the POS sale, made by the ordinary `POST /api/transactions` path (stock, payments, balances, rates unchanged). New column `transactions.order_global_id` is mirrored on `archived_transactions` and added to the settlement copy and to the live/archived column lists. Tests compare an order sale with a hand-typed sale, live and after settlement (SC-007). | Pass |
| II. Tenant isolation | Every cloud table carries `tenant_id`. Owner RPCs derive the tenant from `auth.uid()`. Public RPCs reach one store through the 002 gate and one order through its status key. Local mirrors are pulled per tenant and scoped by `tenant_id`. New tables get isolation cases in `tests/multi-tenant-isolation.test.ts` and the PGlite suite. | Pass |
| III. Offline-first | The POS and back office keep working offline. The mirror shows the last-synced orders read-only. Shop actions need internet by spec (FR-027) and say so. A sale never waits on orders: an order sale needs the cloud only to claim the order, and the cashier can always sell the goods as a normal sale. Storefront and registers work before the migration (mode `online` is refused by the desktop until the cloud functions answer; the mirror tables are skipped while missing). | Pass — the online requirement for order actions is mandated by FR-027 |
| IV. Server authoritative | Order prices and totals come from the cloud catalog at submit. Sale prices for order lines come from the order mirror on the local server, never from the POS client. All new routes have `ROUTE_RULES`. New error codes go through `ValidationError` and are translated. | Pass |
| V. Regression suite green | Suites listed above. Money, settlement and sync changes are tested on live and archived data. | Pass |
| VI. Trilingual, RTL, design system | Storefront strings are added to `storefront/src/i18n.ts` (parity test). Back-office strings go in `src/intl/locales`. The new page and drawer are built from the UI kit (`DataTable`, `Drawer`, `Badge`, `Modal`, toasts), with no `alert` / `confirm`. | Pass |
| VII. Backward compatible | `ordering_mode` stays `off` by default. New permissions only matter once Online orders is selected. Mirror tables stay empty for shops without orders. Stores in WhatsApp mode or off render byte-identical pages, apart from the asset version. | Pass |

## Project Structure

### Documentation (this feature)

```text
specs/003-retail-ordering/
├── spec.md
├── plan.md / plan-s2.md          # Slice 1 / Slice 2 (this file)
├── research.md                   # R1–R11 Slice 1, R12–R25 Slice 2
├── data-model.md / data-model-s2.md
├── quickstart.md / quickstart-s2.md
├── contracts/
│   ├── storefront-routes.md / storefront-routes-s2.md
│   ├── cloud-api.md / cloud-api-s2.md
│   └── backoffice-api.md / backoffice-api-s2.md
└── tasks.md (Slice 1) / tasks-s2.md (Slice 2, /speckit-tasks)
```

### Source Code (repository root)

```text
supabase/migrations/2026-10-23_retail_ordering_s2.sql   # NEW — tables, RLS, functions, grants, transactions column
supabase/checks/2026-10-23_retail_ordering_s2_checks.sql

storefront/
├── src/node-server.ts        # + method, POST body (16 KB cap), visitor network for handle()
├── src/http.ts               # + order/quote, order, o/<key>, o/<key>/cancel; 405 for wrong methods; no-store
├── src/router.ts             # + kinds 'orderQuote' | 'orderSubmit' | 'orderStatus' | 'orderCancel'
├── src/data.ts               # + OrderGateway (RPC calls with the gateway key); fixture gateway for tests/dev
├── src/config.ts             # + ORDER_GATEWAY_KEY (optional: online mode off without it)
├── src/network.ts            # NEW — visitor address from edge headers → daily hashed network id
├── src/ordering.ts           # + orderingEnabled() for 'online'; sf-order JSON gains mode + order strings
├── src/render/cart.ts        # + online-mode form (phone required, quote step, confirmation, My orders)
├── src/render/status.ts      # NEW — server-rendered order status page
├── src/i18n.ts               # + order strings (en/ar/fr)
├── src/limits.ts, assets.ts  # order.js budget, asset version
├── src/fixture.ts            # + online-mode store, fake gateway
└── public/order.js           # NEW — quote, submit, fallback, confirmation, My orders
render.yaml                   # + ORDER_GATEWAY_KEY (sync: false)
scripts/gateway-key.mjs       # NEW — prints a new gateway key + its SHA-256 (owner setup; writes nothing)

server/
├── db.ts                     # + orders/order_lines/order_events mirror tables; transactions + archived order_global_id
├── sync.ts                   # + CLOUD_AUTHORITATIVE set, order tables in fkMap/PULL/HOT, 30 s orders pull + sweep,
│                             #   pull counts + onPulled callback
├── cloudCall.ts              # NEW — withTimeout(), CloudResult helpers shared by orders and commerce
├── orders.ts                 # NEW — mirror reads, owner-RPC actions, error mapping, phone match, sale lines
├── routes.ts                 # POST /api/transactions: validation/commit split, order_global_id, cloud-first
│                             #   completion; settlement copy + TX_* column lists
├── commerce.ts               # 'online' mode allowed; order_expiry_hours; blocked-phone routes
├── permissions.ts            # + orders.view / orders.manage, defaults, ROUTE_RULES
└── server.ts                 # startSyncEngine({ onPulled }) → broadcast ORDERS_UPDATED

src/
├── pages/OnlineOrders.tsx                 # NEW — list (filters, New first) + detail drawer + actions
├── pages/orders/OrderDetailDrawer.tsx     # NEW
├── components/pos/OnlineOrdersDrawer.tsx  # NEW — POS-window list + "Complete sale"
├── components/PosHeader.tsx               # + Online orders button with badge
├── hooks/usePos.ts                        # + newSaleTabFromOrder(), tab.orderGlobalId, checkout sends it
├── hooks/useOrderNotifications.ts         # NEW — toast + Web Audio tone + badge + mute
├── lib/ordersApi.ts                       # NEW — types and calls
├── lib/permissions.ts, lib/serverErrors.ts
├── pages/settings/OnlineStoreSection.tsx  # + Online orders mode, expiry hours, blocked phones
├── components/shell/Sidebar.tsx, Dashboard.tsx, TopBar.tsx   # page registration + badge
└── intl/locales/orders.ts                 # NEW — strings and error codes (en/ar/fr)

tests/
├── orders-sql.test.ts          # NEW — PGlite: migration, gateway, pricing, limits, states, expiry, privacy, grants
├── orders-sync.test.ts         # NEW — mirror pull, authoritative overwrite, sweep, onPulled
├── orders-routes.test.ts       # NEW — actions, permissions, offline/timeout, mapping, blocked phones
├── orders-sale.test.ts         # NEW — sale from order vs manual (live + settled), one sale, compensation
├── storefront-orders.test.ts   # NEW — routes, methods, body cap, no-store, status page, network hash
├── storefront-order-js.test.ts # NEW — order.js in vm (quote/changed/submit/idempotency/fallback/My orders)
├── storefront-routing.test.ts  # (+) budgets, asset version
├── storefront-render.test.ts   # (+) online-mode cart form, i18n parity
├── permissions.test.ts         # (+) orders keys, defaults, rules
├── commerce-store.test.ts      # (+) online mode, expiry hours validation
└── multi-tenant-isolation.test.ts  # (+) order mirrors
```

**Structure Decision**: same three deployables as Slice 1 (cloud migration, storefront service, desktop app). Order
logic lives in the cloud functions (single source of truth across registers and the storefront); the desktop gets one
new server module (`orders.ts`) and one shared helper (`cloudCall.ts`); the storefront gets one new browser script
loaded only for online-mode stores.

## Phase 0 — Research

See [research.md](research.md) R12–R25. All unknowns from the outline are settled, including:
- the gateway key and network hashing (R12);
- the table model (R13);
- pricing (R14);
- numbers and keys (R15);
- limits (R16);
- expiry without `pg_cron` (R17);
- mirror and notifications (R18, R21);
- action RPCs (R19);
- sale completion (R20);
- storefront routes and budget (R22);
- permissions (R23);
- phone match (R24);
- blocked phones (R25).

## Phase 1 — Design

- [data-model-s2.md](data-model-s2.md)
- [contracts/cloud-api-s2.md](contracts/cloud-api-s2.md), [contracts/storefront-routes-s2.md](contracts/storefront-routes-s2.md),
  [contracts/backoffice-api-s2.md](contracts/backoffice-api-s2.md)
- [quickstart-s2.md](quickstart-s2.md)

## Delivery order (for tasks-s2.md)

Each step is independently testable and leaves `main` releasable (mode `online` stays refused until step 3 ships):

1. **Cloud model + functions** — migration, checks file, PGlite suite. Applied by the owner; the gateway key is
   inserted by the owner.
2. **Storefront submit and status** — POST plumbing, network hash, routes, status page, `order.js`, render, i18n,
   budgets, `ORDER_GATEWAY_KEY` on Render. Testable against the fixture and then a test store; only stores in
   `online` mode are affected.
3. **Registers: mirror, notifications, Online orders page, actions** — sync changes, `orders.ts`, permissions, page,
   drawer, notifications. The desktop allows `online` mode from here.
4. **Complete sale** — transactions column and settlement, validation/commit split, cloud-first completion, POS
   drawer, pre-filled tab, phone match.
5. **Settings polish + validation** — expiry hours, blocked phones UI, quickstart run on a real test store with two
   registers, validation.md, ROADMAP.

## Spec coverage (Slice 2)

| Spec | Where |
|---|---|
| FR-001 mode Online orders | R25; `ordering_mode = 'online'` accepted (step 3) |
| FR-010 phone required in Slice 2 | `order.js` + `order_submit` validation (R16) |
| FR-017 re-check before submit | `order_quote` + quote step in `order.js` (R14, R22) |
| FR-018 prices from the catalog | `order_submit` re-prices; `changed` returns the fresh quote (R14); SC-004 test |
| FR-019 order and line fields | data-model-s2 |
| FR-020 idempotency | `UNIQUE (store_id, idempotency_key)` (R14); SC-008 test |
| FR-021 number + private link | R15; status page `private, no-store, noindex` (R22) |
| FR-022 cloud unreachable → WhatsApp | `order.js` fallback using Slice 1's message (R22) |
| FR-023 no delivery fee | unchanged texts; no fee fields anywhere |
| FR-024/FR-025 states (001 subset) | R13; state machine in the owner RPCs |
| FR-026 history | `order_events` written by every RPC (R13, R19) |
| FR-027 atomic, online | owner RPCs with row lock and expected-state check (R19); SC-006 tests |
| FR-028 status within 1 minute | status page no-store + 60 s refresh (R22) |
| FR-029 list | Online orders page (backoffice-api-s2) |
| FR-030 notification | R18 (30 s pull, onPulled) + R21 (toast, tone, badge, mute) |
| FR-031 detail + actions | detail drawer; WhatsApp/Call message per state (Slice 1 phone normaliser) |
| FR-032 offline read-only | mirror + session status (R18) |
| FR-033 permissions | R23 |
| FR-034–FR-036 conversion, one sale | R20; `order_complete` first-wins + local unique index |
| FR-037 customer by phone | R24 |
| FR-038 no money effect before the sale | order RPCs touch only order tables (PGlite test) |
| FR-041 abuse limits | R12 (network), R16, R25 |
| FR-042/FR-043 privacy | public RPCs return one order by key; status page shows first name only |
| FR-044 no cookies | unchanged; `order.js` uses `localStorage` only |
| FR-045/FR-046 settings | R25; settings sync as in Slice 1 |
| SC-002 cache unchanged | order routes are no-store and separate; page routes untouched (routing test) |
| SC-005–SC-009 | tests listed in Technical Context |

## Complexity Tracking

| Exception | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Shared gateway key (Render env var + hash in a private cloud table) | Per-network limits (FR-041) need a network value the visitor can't forge; only the storefront sees it | Per-phone only: limits trivially bypassed with the public anon key (user chose the gateway) |
| `POST /api/transactions` split into validation and commit phases (async between them) | The order must be claimed in the cloud after the sale is known to be valid and before it is written, so one order never makes two sales | Claim before validation: a sale refused for stock/credit would leave the order completed; complete locally and sync: two offline registers can both sell |
| `CLOUD_AUTHORITATIVE` set replacing the `tenants` special case | Pull-only tables must always take the cloud's row | Per-table `if` checks: the existing pattern already caused a trap where touched rows stopped updating |
| Third browser script (`order.js`) | `cart.js` is at its 16 KB budget; online-only code shouldn't load for WhatsApp stores | Raise `cart.js` budget: every ordering store pays for code it doesn't use |
| Faster orders-only pull (30 s) while a store is in online mode | SC-005 (1 minute, 95%) with the 60 s hot pull leaves no margin | Supabase Realtime: persistent sockets per register, reconnect logic, more egress on a Free plan already over quota |
