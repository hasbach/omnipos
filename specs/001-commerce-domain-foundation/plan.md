# Implementation Plan: Commerce Domain Foundation — Slice A (Store & Listings)

**Branch**: `001-commerce-domain-foundation` | **Date**: 2026-10-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-commerce-domain-foundation/spec.md`

**Scope note**: This plan covers **Slice A** of feature 001: only the foundation that Feature 002 (Tenant Online
Store) needs. Everything for B2B relationships, orders, shipments, goods receipts and posting into the stock and money
engines is **deferred to Slice B**, which will get its own plan before Feature 003/004 starts (see
[Out of scope](#out-of-scope-for-slice-a-deferred-to-slice-b)).

## Summary

Add an opt-in commerce layer per tenant: a `commerce_enabled` setting (off by default), a **Store** (name, globally
unique slug, mode, branding, settings) and **Store Listings** that reference existing products and hold only channel
data (published flag, online title, description, image paths, store category, sort order). Price, units, stock and
the active flag always come from the product.

Store and listing records are authored in the desktop back office, stored locally (offline-first) and pushed to the
cloud through the existing sync engine, exactly like products. Public (anonymous) visitors never read the
`products` table. They read through two cloud `SECURITY DEFINER` functions that return an explicit allow-list of
fields (no cost, no min price, no exact stock unless the store opts in) and only when the tenant has commerce on,
the store is active and the online license is valid. Feature 002 builds the storefront on top of these functions.

New permissions `store.view`, `store.manage`, `store.publish`: admin has them, every other role has none until it is
granted. Existing shops see no change.

## Technical Context

**Language/Version**: TypeScript 5 (Node / Electron main process for the server, React 19 + Vite for the UI)

**Primary Dependencies**: Express, better-sqlite3 (Electron ABI), @supabase/supabase-js, existing UI kit
(`src/components/ui`), i18n provider (`src/intl`)

**Storage**: Local SQLite (`server/db.ts`, source of truth) + Supabase Postgres (cloud copy, RLS per tenant). Public
reads through Postgres functions. Listing images: Supabase Storage paths only (upload flow is Feature 002).

**Testing**: `npm test` (node:test via `scripts/run-tests.mjs`, in-memory test app `tests/helpers`). The cloud SQL
functions cannot run in the test suite; they get a SQL check script run by the user in the SQL editor
(see [quickstart.md](quickstart.md)).

**Target Platform**: Windows desktop (Electron) for authoring; Supabase for public reads.

**Project Type**: Desktop app with embedded server + cloud backend.

**Performance Goals**: Publishing or unpublishing 200 listings in one bulk call < 1 s locally. Public catalog
function returns one page (≤ 100 listings) in < 300 ms in the cloud.

**Constraints**: Offline-first (every authoring action works offline except claiming or changing the slug). No
public read of raw tables. Supabase Free plan egress is already tight: the public functions are paged and return
only the fields needed; caching is a Feature 002 decision (research R7).

**Scale/Scope**: Up to ~1 store per tenant in practice (model allows several), up to ~5,000 listings per store.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — still passing.*

| Principle | How Slice A complies | Status |
|---|---|---|
| I. Money & balance integrity | No money is written. No change to transactions, payments, balances, settlement. Listings never store a price; prices are read from the product at request time. | Pass |
| II. Tenant isolation | `stores` and `store_listings` carry `tenant_id`; every route scoped by session tenant; listing ↔ product link checked for same tenant; data reset deletes only the acting tenant's rows; new cases in `tests/multi-tenant-isolation.test.ts`. Cloud: RLS for owners, public functions filter by slug → tenant and an allow-list. | Pass |
| III. Offline-first | Everything is local first and synced by the existing engine. Only slug claim/change needs the cloud (global namespace); it fails with a clear "needs internet" error and nothing else depends on it. App works before the cloud migration is applied (sync skips missing cloud tables). | Pass |
| IV. Server authoritative | Availability and public prices are computed server-side (local server for the back-office preview, cloud function for the public). `ValidationError` codes for slug, listing and store errors. Every new route has a `ROUTE_RULES` entry. | Pass |
| V. Regression suite green | New tests: store CRUD, slug rules, listing publish/derive, availability, permissions, isolation, data reset, sync table registration, backward compatibility (commerce off ⇒ no rows, no behavior change). | Pass |
| VI. Trilingual, RTL, design system | New "Online store" settings area and product "Publish" controls use the UI kit; all strings in en/ar/fr; RTL-safe classes. | Pass |
| VII. Backward compatible | `commerce_enabled` defaults to off; no store created automatically; new permissions granted to admin only (manager's "all but…" default must explicitly exclude them — see research R5). | Pass |

No violations. Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-commerce-domain-foundation/
├── spec.md              # Feature spec (whole feature 001)
├── plan.md              # This file (Slice A)
├── research.md          # Phase 0 decisions
├── data-model.md        # Phase 1 entities (local + cloud)
├── quickstart.md        # Validation guide
├── contracts/
│   ├── backoffice-api.md    # Local Express routes (authenticated, permissioned)
│   └── public-catalog.md    # Cloud RPC contract consumed by Feature 002
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
server/
├── db.ts                 # + stores, store_listings tables (additive, idempotent), sync metadata/triggers
├── commerce.ts           # NEW: commerce flag, store CRUD, slug rules, listing publish/derive, availability
├── routes.ts             # + /api/commerce/* routes (thin, delegate to commerce.ts)
├── permissions.ts        # + 'commerce' permission group, ROUTE_RULES, manager default exclusion
├── sync.ts               # + stores, store_listings in PUSH / PULL (cold) tables, fkMap product_id/store_id
├── tenantReset.ts        # + delete store_listings (with products) and stores (with full reset)
└── errors.ts             # (reuse ValidationError; new codes only)

src/
├── lib/permissions.ts            # mirror new permission keys / defaults
├── pages/settings/OnlineStore*.tsx  # NEW: commerce toggle, store identity/branding/settings, slug claim
├── pages/products/…              # + "Online store" section in product drawer, bulk publish action
└── intl/locales/{en,ar,fr}.ts    # + commerce.* strings (or a new commerce locale area)

supabase/migrations/
└── 2026-10-18_commerce_store_foundation.sql   # NEW: tables, indexes, RLS, claim_store_slug, public functions

tests/
├── commerce-store.test.ts         # NEW
├── commerce-listings.test.ts      # NEW
├── multi-tenant-isolation.test.ts # + store/listing cases
├── permissions.test.ts            # + commerce keys & defaults
└── tenant-reset.test.ts           # + store/listing cleanup
```

**Structure Decision**: Follow the existing single-repo layout: one new domain module `server/commerce.ts` (like
`server/cashFlow.ts`, `server/settlement.ts`), thin routes in `server/routes.ts`, UI inside the existing Settings and
Products pages. No new package, no new service.

## Phase 0 — Research

See [research.md](research.md). All Technical Context unknowns resolved (R1–R10).

## Phase 1 — Design

- Entities: [data-model.md](data-model.md)
- Contracts: [contracts/backoffice-api.md](contracts/backoffice-api.md), [contracts/public-catalog.md](contracts/public-catalog.md)
- Validation: [quickstart.md](quickstart.md)

## Spec requirements covered by Slice A

| Requirement | Coverage |
|---|---|
| FR-002 commerce off by default | `commerce_enabled` setting, default `'0'` |
| FR-010 stores | `stores` table, one or more per tenant, unique slug, mode, branding, settings; none auto-created |
| FR-011 listings reference products | `store_listings.product_id`, channel-only columns |
| FR-012 derived price/units/availability | computed at request time (local `commerce.ts`, cloud functions) — retail tier only in Slice A |
| FR-013 disabled/deleted ⇒ unavailable | availability rule (`products.active`, `deleted_at`) |
| FR-031/032 allow-list, never expose cost/stock | public functions return allow-listed fields; exact stock only if `show_exact_stock` |
| FR-033 permissions (store part) | `store.view`, `store.manage`, `store.publish` |
| FR-034 audit (store part) | `logAction` entries with before/after JSON for store settings, slug, publish/unpublish |
| FR-039/040/041 compatibility, i18n | additive schema, defaults reproduce today, en/ar/fr strings |
| US1, US5, US6 (public-visitor part) | acceptance scenarios mapped in quickstart |

## Out of scope for Slice A (deferred to Slice B)

- FR-001 business roles (descriptive only; add when B2B discovery needs it).
- FR-003 – FR-009 business relationships, terms, business customer/supplier kind.
- FR-014 – FR-030 orders, lines, quantity lifecycle, state machine, expiry, shipments, goods receipts, posting
  policy, inventory/invoice/payment posting, outstanding balances.
- FR-035 logging refused cross-tenant attempts (no authenticated cross-tenant path exists yet in Slice A).
- FR-036 – FR-038 shared authoritative commerce data, offline read-only commerce screens, sync conflicts.
- Wholesale / Hybrid store pricing per buyer (needs relationships). In Slice A, `mode` is stored and shown, but
  public visitors always get the retail tier (US5 scenario 5, public-visitor half).
- Listing minimum quantity / orderable-unit restrictions are stored but only enforced once ordering exists (003).
- US2, US3, US4, US7 and SC-002 – SC-004, SC-006 – SC-008.

## Complexity Tracking

None.
