---
description: "Task list — Commerce Domain Foundation, Slice A (store & listings for Feature 002)"
---

# Tasks: Commerce Domain Foundation — Slice A (Store & Listings)

**Input**: Design documents from `/specs/001-commerce-domain-foundation/`
([plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/backoffice-api.md](contracts/backoffice-api.md), [contracts/public-catalog.md](contracts/public-catalog.md),
[quickstart.md](quickstart.md))

**Scope**: Slice A only. Excluded (Slice B): business roles, relationships, orders, shipments, receipts, posting,
cross-tenant access logging, shared commerce data/conflicts, wholesale/hybrid buyer pricing — see plan.md
"Out of scope for Slice A".

**Tests**: Required. Constitution V: every new behaviour ships with a test in `tests/` that fails without the
change. Tests use `createTestApp` / `seedTenant` from `tests/helpers/testApp.ts` and run with `npm test`.

**Stories covered** (from spec.md): US1 — existing shops unchanged (P1); US5 — store and listings over existing
products (P2); US6 — privacy, public-visitor and tenant-isolation part (P1). US6 needs US5's data, so it runs after
US5 despite its priority.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US5 / US6

---

## Phase 1: Setup

- [X] T001 Create empty module `server/commerce.ts` with a header comment linking to `specs/001-commerce-domain-foundation/plan.md` and exporting placeholder namespaces for store, listing and availability helpers (imports `db`, `logAction` from `./db.js` and `ValidationError` from `./errors.js`)
- [X] T002 [P] Create locale file `src/intl/locales/commerce.ts` following the shape of `src/intl/locales/units.ts` (en/ar/fr objects, empty for now) and register it wherever the other per-area locale files are merged in `src/intl/index.tsx`

---

## Phase 2: Foundational (blocks every story)

- [X] T003 Add local tables in `server/db.ts` (additive, `CREATE TABLE IF NOT EXISTS`, idempotent) exactly as in data-model.md: `stores` (`id`, `tenant_id INTEGER NOT NULL`, `name TEXT NOT NULL`, `slug TEXT`, `mode TEXT NOT NULL DEFAULT 'retail'`, `status TEXT NOT NULL DEFAULT 'draft'`, `description`, `logo_path`, `cover_path`, `primary_color`, `contact_phone`, `contact_whatsapp`, `contact_email`, `address`, `default_language TEXT DEFAULT 'en'`, `settings TEXT DEFAULT '{}'`) and `store_listings` (`id`, `tenant_id INTEGER NOT NULL`, `store_id INTEGER NOT NULL REFERENCES stores(id)`, `product_id INTEGER NOT NULL REFERENCES products(id)`, `published INTEGER NOT NULL DEFAULT 0`, `title`, `description`, `images TEXT DEFAULT '[]'`, `store_category`, `sort_order INTEGER DEFAULT 0`, `min_quantity REAL`, `orderable_unit_ids TEXT`); add both to the sync-metadata table loop so they get `global_id`, `created_at`, `updated_at`, `deleted_at`, `last_synced_at` and the triggers; add a partial unique index on `store_listings(store_id, product_id) WHERE deleted_at IS NULL`
- [X] T004 [P] Add the `commerce` group (`store.view`, `store.manage`, `store.publish`) to `PERMISSION_GROUPS` in `server/permissions.ts`, and add the three keys to the `manager` exclusion list in `DEFAULT_ROLE_PERMISSIONS` (research R5) so only `admin` gets them by default
- [X] T005 [P] Mirror T004 in `src/lib/permissions.ts` (catalogue, defaults) and add the area/key labels in `src/intl/locales/permissions.ts` (en/ar/fr)
- [X] T006 Register sync in `server/sync.ts`: `fkMap.stores = { tenant_id: 'tenants' }`, `fkMap.store_listings = { tenant_id: 'tenants', store_id: 'stores', product_id: 'products' }`; add both to `PUSH_TABLES`, `PULL_TABLES` (after `product_units`, `stores` before `store_listings`) and `COLD_PULL_TABLES`
- [X] T007 Write the cloud migration `supabase/migrations/2026-10-18_commerce_store_foundation.sql` (idempotent, re-runnable): tables `public.stores` / `public.store_listings` mirroring the local columns with `global_id UUID PK`, `local_id`, UUID FKs to `tenants.global_id` / `stores.global_id` / `products.global_id`, `created_at`, `updated_at`, `deleted_at`, `synced_at timestamptz` + the same `synced_at` trigger as `supabase/migrations/2026-10-07_synced_at.sql`; indexes `UNIQUE (lower(slug)) WHERE deleted_at IS NULL AND slug IS NOT NULL`, `store_listings (store_id, published) WHERE deleted_at IS NULL`, `store_listings (product_id)`; RLS enabled with owner policies identical to products (`tenant_id::text = auth.uid()::text`, store_listings likewise); **no anon policy**. Public functions come in US5/US6 tasks.
- [X] T008 Implement the commerce flag in `server/commerce.ts`: `isCommerceEnabled(tenantId)` reads setting `commerce_enabled` (absent ⇒ off), `setCommerceEnabled(tenantId, userId, enabled)` writes `'0'`/`'1'` and calls `logAction(..., 'commerce_toggle', JSON {before, after})`

**Checkpoint**: schema, permissions, sync registration and flag exist; app behaves exactly as before.

---

## Phase 3: User Story 1 — Existing shops keep working unchanged (P1) 🎯 MVP gate

**Goal**: upgrading adds the new tables/settings with zero behaviour change while commerce is off.

**Independent test**: full `npm test` green; new compat test proves defaults; dry-run on a copy of a real DB shows identical counts, totals, stock and balances.

- [X] T009 [P] [US1] Write `tests/commerce-compat.test.ts`: new tenant ⇒ `commerce_enabled` absent/off, `stores` and `store_listings` empty after startup; schema setup on an existing database is covered by T013's dry run (db.ts runs once per process); existing product/sale/settlement flows in the test app return the same results with the new tables present
- [X] T010 [P] [US1] Extend `tests/permissions.test.ts`: `admin` has `store.view`/`store.manage`/`store.publish`; `manager`, `accountant`, `staff`, `cashier` defaults have none of them; a tenant with a stored `role_permissions` map gains no commerce key
- [X] T011 [P] [US1] Add a sync registration test in `tests/sync-lighter.test.ts` (done as new `tests/commerce-sync.test.ts`): `stores`/`store_listings` are in push/pull lists with the fkMap above, and a push to a cloud missing those tables marks them missing and does not block other tables
- [X] T012 [US1] Implement `GET /api/commerce/status` and `PUT /api/commerce/status` in `server/routes.ts` (thin, calling `server/commerce.ts`) returning `{ enabled, online_license_valid, store }` per contracts/backoffice-api.md; add both to `ROUTE_RULES` (`store.view` / `store.manage`); test in `tests/commerce-compat.test.ts` that cashier PUT ⇒ 403 `PERMISSION_DENIED`
- [X] T013 [US1] Write `scripts/commerce-dryrun.ts`: given a path to a copy of a real DB, record product count, stock sum, invoice totals (live + archived) and every stakeholder balance, run schema setup, record again, print any difference (exit 1 on difference); document the command in quickstart.md §2

**Checkpoint**: upgrade proven safe; commerce invisible until enabled.

---

## Phase 4: User Story 5 — Store and listings over existing products (P2)

**Goal**: an admin turns commerce on, creates a store, claims a slug, and publishes products as listings whose price/units/stock come from the product.

**Independent test**: activate a store, publish/unpublish listings, change a product's price ⇒ listing reflects it; disable a product ⇒ listing unavailable.

### Tests (write first, must fail)

- [X] T014 [P] [US5] Write `tests/commerce-store.test.ts`: create store (status `draft`, slug null); field limits — `name` "1–80 chars, trimmed", `description` "≤ 1000 chars", `contact_phone`/`contact_whatsapp` "≤ 30", `address` "≤ 300", `primary_color` "`#rrggbb`", `default_language` "`en` | `ar` | `fr`", `mode` "`retail` | `wholesale` | `hybrid`"; unknown `settings` key ⇒ `STORE_SETTINGS_INVALID`; slug rules "3–40 chars, `[a-z0-9-]`, no leading/trailing or double hyphen, stored lowercase" ⇒ `STORE_SLUG_INVALID`, reserved list ⇒ `STORE_SLUG_RESERVED`, cloud stub returns taken ⇒ `STORE_SLUG_TAKEN`, no cloud session ⇒ `STORE_SLUG_NEEDS_ONLINE` with local row unchanged; status `active` without slug or with commerce off ⇒ `STORE_NOT_READY`; transitions `draft → active`, `active ↔ paused` allowed, `paused → draft` ⇒ `STORE_BAD_TRANSITION`; delete soft-deletes store and its listings; each write adds a `user_logs` entry with before/after JSON
- [X] T015 [P] [US5] Write `tests/commerce-listings.test.ts`: upsert listing references the product (no price/stock columns written); `title` "≤ 120", `description` "≤ 4000", `store_category` "≤ 60", `images` "array of ≤ 8 Storage paths", `min_quantity` "> 0 or NULL", `orderable_unit_ids` subset of the product's units else `LISTING_UNIT_INVALID`; duplicate (store, product) ⇒ `LISTING_DUPLICATE`; product price/unit price change shows in `ListingView` with no listing edit; `display_title`/`category` fallbacks; `stock_state` rules (track_inventory 0 ⇒ in_stock; stock ≤ 0 ⇒ out_of_stock; reorder_point > 0 and stock ≤ reorder_point ⇒ low_stock); `unavailable_reason` order `not_published`, `product_disabled`, `product_deleted`, `store_not_active`, `commerce_off`; bulk publish of ≤ 1000 ids creates/updates in one transaction and an id from another tenant fails the whole call with `LISTING_TENANT_MISMATCH`; responses never contain `cost`, `cost_lbp`, `min_price`

### Implementation

- [X] T016 [US5] Implement store service in `server/commerce.ts`: `listStores`, `createStore`, `updateStore` (validation per data-model.md, `settings` keys `show_exact_stock`, `hide_out_of_stock`, `show_local_price`, `category_order` only), `setStoreStatus` (transition rules + `STORE_NOT_READY`), `deleteStore` (soft delete store + listings), each with `logAction` (`store_create`, `store_update`, `store_status_change`) and `ValidationError` codes from contracts/backoffice-api.md — Done note: all store/listing writes also require commerce on (`COMMERCE_OFF`, 409), matching data-model "read-only while off".
- [X] T017 [US5] Implement slug claim in `server/commerce.ts`: `validateSlug` (format + reserved list from research R3), `claimSlug(tenantId, userId, storeId, slug)` that requires the active cloud session (`getActiveSession()` from `server/session.ts`), calls RPC `claim_store_slug(p_store, p_slug)`, maps `invalid`/`reserved`/`taken`/`not_owner` to error codes, updates the local row only on `ok`, logs `store_slug_change`; injectable RPC caller for tests
- [X] T018 [US5] Add `claim_store_slug(p_store uuid, p_slug text)` to `supabase/migrations/2026-10-18_commerce_store_foundation.sql` per contracts/public-catalog.md (owner check via `auth.uid()`, placeholder row when not yet pushed, same format/reserved validation, returns `{ ok, code }`, `SECURITY DEFINER`, `REVOKE EXECUTE FROM anon`, `GRANT EXECUTE TO authenticated`)
- [X] T019 [US5] Implement listing service in `server/commerce.ts`: `upsertListing`, `deleteListing` (soft), `bulkPublish` (≤ 1000, single transaction, tenant check on every product), `listListings(storeId, filters)` and `productListings(productId)` returning `ListingView` with derived fields computed by one shared `deriveListing(row, product, units, store, enabled)` function (rules in data-model.md "Derived fields"); public price = retail tier via `tierUnitPrice(product, 'retail')` / `uomUnitPrice(product, unit, 'retail')` from `server/pricing.ts`; logs `listing_publish`, `listing_unpublish`, `listing_update`, `listing_bulk_publish`
- [X] T020 [US5] Add the store and listing routes to `server/routes.ts` exactly as listed in contracts/backoffice-api.md, thin wrappers over `server/commerce.ts`, and the matching 11 entries in `ROUTE_RULES` in `server/permissions.ts` — Done note: routes live in `setupCommerceRoutes` (server/commerce.ts), registered from server/routes.ts like setupCashFlowRoutes.
- [X] T021 [US5] Add a parity comment next to `tierUnitPrice` and `uomUnitPrice` in `server/pricing.ts` (and `src/lib/pricing.ts`) noting the retail rule is mirrored in the cloud function `store_public_listings`
- [X] T022 [US5] Include store data in tenant reset in `server/tenantReset.ts`: when products are wiped, delete that tenant's `store_listings` first; when the full reset runs, delete `stores` too; extend `tests/tenant-reset.test.ts` to cover both and to prove another tenant's stores/listings survive — Done note: the reset has no "full" scope, so stores are always kept; the products scope deletes the tenant's listings locally and in the cloud (before products, cloud FK), and `hasSyncedData` counts synced listings.
- [X] T023 [P] [US5] Add API client helpers for the commerce routes in `src/lib/api.ts` (or a new `src/lib/commerceApi.ts`) and map the new error codes in `src/lib/serverErrors.ts` — Done note: `src/lib/commerceApi.ts`; serverErrors maps every COMMERCE_/STORE_/LISTING_/PRODUCT_NOT_FOUND code to `commerce_err_<code>`.
- [X] T024 [P] [US5] Fill `src/intl/locales/commerce.ts` (en/ar/fr): section title, toggle, store fields, modes, statuses, settings labels, slug help and every error code from contracts/backoffice-api.md, availability states and unavailable reasons
- [X] T025 [US5] Build `src/pages/settings/OnlineStoreSection.tsx` with `src/components/ui` (no `alert`/`confirm`): commerce toggle (confirmation dialog), store identity/branding/contact/settings form, slug field with "Claim" button and offline message, status control, public URL copy; register it in `src/pages/Settings.tsx` as section `online-store`, visible with `store.view`, editable with `store.manage` — Done note: section key `onlinestore`.
- [X] T026 [US5] Add an "Online store" card to `src/pages/products/ProductEditorDrawer.tsx`: per-store published switch, title, description, category, sort order, availability badge with reason; visible with `store.view`, editable with `store.publish` — Done note: shown as an "Online store" tab for saved products, component `src/pages/products/OnlineStoreCard.tsx`.
- [X] T027 [US5] Add bulk "Publish / Unpublish to store" actions to the product list in `src/pages/ProductManagement.tsx` calling the bulk route, gated by `store.publish`, hidden while commerce is off

**Checkpoint**: back office can run a store end to end locally; tests from T014/T015 pass.

> Ahead of Phase 5: `tests/commerce-listings.test.ts` already covers the isolation cases of T028 (as a
> listings test, not yet in `multi-tenant-isolation.test.ts`) and the field allow-list of T029.

---

## Phase 5: User Story 6 — Privacy holds for public visitors and other tenants (P1)

**Goal**: nobody outside the tenant reads anything except the allow-listed public catalog, and only when every gate holds.

**Independent test**: isolation tests for every `/api/commerce/*` route; SQL checks in quickstart.md §4 show gates and allow-list hold; anon cannot read raw tables.

- [ ] T028 [P] [US6] Extend `tests/multi-tenant-isolation.test.ts`: tenant B cannot list, read, edit, publish, bulk-publish, claim slug for or delete tenant A's stores/listings (404/`STORE_NOT_FOUND`, never data); listing B's store with A's product ⇒ `LISTING_TENANT_MISMATCH`
- [ ] T029 [P] [US6] Add an allow-list test in `tests/commerce-listings.test.ts`: serialise every `ListingView` and store response and assert none of `cost`, `cost_lbp`, `min_price`, `price_wholesale`, `price_wholesale_lbp`, `price_super_wholesale`, `price_super_wholesale_lbp` appear
- [ ] T030 [US6] Add `store_public_get(p_slug text)` to `supabase/migrations/2026-10-18_commerce_store_foundation.sql` per contracts/public-catalog.md: `SECURITY DEFINER`, `STABLE`, `SET search_path = public`; gates (active non-deleted store, `commerce_enabled = '1'`, license `online_license_type = 'lifetime'` or `online_license_expiry > now()`, tenant not deleted); returns only the listed fields incl. local currency (non-USD `currencies` row) and `categories` `[{name, count}]` ordered by `settings.category_order` then name; `GRANT EXECUTE TO anon, authenticated`
- [ ] T031 [US6] Add `store_public_listings(p_slug, p_category, p_search, p_limit, p_offset)` to the same migration: same gates; visible-listing rule; `p_limit` clamped "1–100", default 48; `p_search` trimmed "≤ 60 chars", matches display title or barcode case-insensitively; order `sort_order`, display title; excludes out-of-stock when `hide_out_of_stock = 1`; `stock` only when `show_exact_stock = 1`; returns exactly the field list of contracts/public-catalog.md incl. `units` JSON filtered by `orderable_unit_ids` and `total_count`; retail prices only; grants as T030
- [ ] T032 [US6] Write `supabase/checks/2026-10-18_commerce_store_checks.sql`: read-only queries the user runs after the migration — function result columns contain none of the "never returned" fields; each gate returns zero rows (paused store, commerce off, expired license, disabled product); `has_function_privilege('anon', ...)` true for the two public functions and false for `claim_store_slug`; `pg_policies` shows no anon policy on `stores`, `store_listings`, `products`

**Checkpoint**: Slice A complete; Feature 002 can build the storefront on the two public functions.

---

## Phase 6: Polish & cross-cutting

- [ ] T033 [P] Arabic/RTL audit of the new Online store section and product card (DOM scan for Latin text in Arabic mode, as done for 1.2.1) in the preview server; fix any untranslated string in `src/intl/locales/commerce.ts`
- [ ] T034 Run the gates: `npm test`, `npx tsc --noEmit` (no new errors), `npm run build`, `npm run build:server`
- [ ] T035 Run quickstart.md §3 walk-through in the preview server (`omnipos-preview`) and §2 dry-run on a copy of a real tenant DB; record results in the PR description
- [ ] T036 [P] Update `ROADMAP.md` (001 Slice A status, cloud migration `2026-10-18_commerce_store_foundation.sql` pending for the user) and note the stock-lag and egress caveats for 002

---

## Dependencies & execution order

- Phase 1 → Phase 2 → stories.
- **US1** (Phase 3) needs Phase 2 only. It is the release gate: nothing ships unless US1 holds.
- **US5** (Phase 4) needs Phase 2; T012 (status route) is reused by the settings UI (T025).
- **US6** (Phase 5) needs US5's service (T016–T020) for the isolation tests and US5's migration file (T018) to extend; T030/T031 can be written in parallel with US5 UI tasks.
- Within US5: T014/T015 (tests) → T016 → T017/T018 → T019 → T020 → T022; UI T023–T027 after T020.
- Same-file serialisation: `server/commerce.ts` (T008, T016, T017, T019), `server/routes.ts` (T012, T020), the migration file (T007, T018, T030, T031), `server/permissions.ts` (T004, T020).

## Parallel examples

```text
Phase 2:  T004 (server/permissions.ts) ‖ T005 (src/lib/permissions.ts) ‖ T007 (migration)
US1:      T009 ‖ T010 ‖ T011   (three different test files)
US5:      T014 ‖ T015          (tests first), later T023 ‖ T024 (client api ‖ locales)
US6:      T028 ‖ T029, then T030 → T031 → T032
```

## Implementation strategy

1. **MVP gate**: Phases 1–3 (US1). Merge-safe on its own: schema + flag + permissions, no visible change.
2. **Increment 2**: Phase 4 (US5). Back-office store management usable locally; cloud copy syncs once the user applies the migration.
3. **Increment 3**: Phase 5 (US6). Public functions + privacy proof; this is what Feature 002 consumes.
4. Phase 6 before any release. Cloud migration is applied by the user in the Supabase SQL editor (MCP is read-only); the app keeps working before it is applied.
