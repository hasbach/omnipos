---
description: "Task list — Tenant Online Store (public storefront), feature 002"
---

# Tasks: Tenant Online Store (Public Storefront)

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/storefront-routes.md](contracts/storefront-routes.md), [contracts/cloud-api.md](contracts/cloud-api.md),
[contracts/backoffice-api.md](contracts/backoffice-api.md), [quickstart.md](quickstart.md)

**Tests**: Required (Constitution V). Node tests run with `npm test`; storefront code is plain TypeScript imported by
tests directly. Server-module imports in tests must be dynamic, after `createTestApp()` (see the 001 note about the
repo `pos.db`).

**Stories** (spec.md): US1 browse (P1), US2 product page + contact (P1), US3 language & mobile (P1), US4 gates &
privacy (P1), US5 photos & sharing (P2), US6 speed & cost (P2). Custom domains are out (ROADMAP 012).

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 Create `storefront/` skeleton: `storefront/package.json` (`{"name":"omnipos-storefront","private":true,"type":"module","engines":{"node":">=20"}}`, no runtime deps), `storefront/vercel.json` (rewrite every path except `/storefront.css`, `/storefront.js`, `/placeholder.svg` to `/api/index`; headers for those three: `Cache-Control: public, max-age=31536000, immutable`), empty `storefront/api/index.ts`, `storefront/src/`, `storefront/public/`, and `storefront/README.md` (what it is, how to run locally, Vercel project settings: Root Directory `storefront`, env `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `STOREFRONT_DOMAIN`, `OMNIPOS_WEBSITE_URL`)
- [X] T002 [P] Add devDependency `@electric-sql/pglite` to `package.json` (exact version) and make sure `tsconfig.json` type-checks `storefront/**/*.ts` (add to `include` if needed) without adding it to the Vite/esbuild app bundles
- [X] T003 [P] Create `storefront/src/escape.ts` (`html()` escaping `& < > " '`, `attr()`, `url()` builders) and `storefront/src/config.ts` (reads `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `STOREFRONT_DOMAIN`, `OMNIPOS_WEBSITE_URL` from env with safe defaults; `RESERVED_SUBDOMAINS` imported from a shared list, see T008) — Done note: anon key default copied from src/lib/supabase.ts (verified `role: anon`).

---

## Phase 2: Foundational (blocks every story)

- [X] T004 Write cloud migration `supabase/migrations/2026-10-19_storefront.sql` per contracts/cloud-api.md: replace `_store_public_store(text)` with `_store_public_store(p_slug text, p_preview text DEFAULT NULL)` adding **`s.mode IN ('retail','hybrid')`** (bypassed, together with status, only by a valid unexpired preview token for that store; commerce on, license valid, not deleted still required); table `store_preview_tokens (token text PK, store_id uuid REFERENCES stores(global_id), tenant_id uuid, created_at timestamptz DEFAULT now(), expires_at timestamptz)` with RLS on and no policies; DROP + recreate `store_public_get(p_slug text, p_preview text DEFAULT NULL)` (+ `is_preview boolean` column) and `store_public_listings(..., p_preview text DEFAULT NULL)`; new `store_public_listing(p_slug text, p_listing uuid, p_preview text DEFAULT NULL)` returning the listings columns minus `total_count` and honouring `hide_out_of_stock` / `show_exact_stock`; `create_store_preview_token(p_store uuid)` (authenticated, owner only, 32 random bytes base64url, `expires_at = now() + interval '30 minutes'`, deletes the caller's expired tokens); `claim_store_slug` with the FR-004 reserved list; bucket `store-images` (`public = true`, `file_size_limit = 2097152`, `allowed_mime_types = '{image/webp}'`) and `storage.objects` policies for role `authenticated`: INSERT `WITH CHECK (bucket_id = 'store-images' AND (storage.foldername(name))[1] = auth.uid()::text)`, UPDATE/DELETE `USING` the same; REVOKE from PUBLIC/anon and GRANT exactly as in the contract; idempotent and re-runnable — Done note: preview check factored into internal `_store_public_is_preview`; tokens built from two `gen_random_uuid()` (strong random), not `random()`.
- [X] T005 Write `tests/commerce-sql.test.ts` on PGlite: stub Supabase roles (`anon`, `authenticated`), `auth.uid()` from a session setting, default EXECUTE grant on public functions, stub tables `tenants`, `products`, `product_units`, `settings`, `currencies`, stub `storage` schema (`buckets`, `objects`, `foldername()`); apply `2026-10-18_commerce_store_foundation.sql` then `2026-10-19_storefront.sql` (twice); assert: Wholesale store invisible to all three public functions, Retail and Hybrid visible; preview token for the store shows draft/paused/wholesale stores and sets `is_preview`, expired or other-store token doesn't; `create_store_preview_token` returns nothing for a non-owner; `store_public_listing` returns one visible listing and nothing for unpublished/disabled/other-store ids; reserved list refuses every FR-004 name; privileges (anon: the three public functions only); storage policy expressions allow the owner's folder and refuse another tenant's — Done note: 7 tests; storage policies checked with real RLS inserts/deletes on a stub `storage.objects`.
- [X] T006 Create `storefront/src/data.ts`: `DataSource` interface (`getStore(address, preview?)`, `listListings(address, {category, search, limit, offset}, preview?)`, `getListing(address, listingId, preview?)`) with result types mirroring the RPC columns, and `SupabaseRpcSource` calling `POST {SUPABASE_URL}/rest/v1/rpc/<fn>` with `apikey`/`Authorization: Bearer <anon key>`; a missing store returns `null`; network/5xx errors throw a typed `UpstreamError`
- [X] T007 Create `storefront/src/router.ts`: resolve `{kind: 'store'|'apexRoot'|'reservedRedirect'|'asset'|'img'|'notFound', address, path, form: 'host'|'path', params}` from `Host` + URL: `<address>.<STOREFRONT_DOMAIN>` → host form; apex `/s/<address>/…` → path form; apex `/` → `apexRoot`; reserved subdomain → `reservedRedirect`; address lowercased; `/p/<uuid>[/<slug>]` → product; `/img/<path>` → img; params `c` (≤ 60), `q` (trimmed, ≤ 60), `page` (int ≥ 1), `lang` (en|ar|fr), `preview` (≤ 64)
- [X] T008 Make the reserved list one source: export `RESERVED_SLUGS` (FR-004 list, see contracts/cloud-api.md) from `server/commerce.ts`, import it in `storefront/src/config.ts` as `RESERVED_SUBDOMAINS`, and add a test in `tests/commerce-store.test.ts` that parses the `claim_store_slug` array out of `supabase/migrations/2026-10-19_storefront.sql` and asserts it equals `RESERVED_SLUGS` — Done note (deviation): the list lives in dependency-free `storefront/src/reserved.ts` (the storefront deploys from its folder alone and must not import server/db); `server/commerce.ts` re-exports it.
- [X] T009 Create `storefront/src/http.ts` + `storefront/api/index.ts`: Vercel handler `(req, res)` → router → page render (stories) → response with headers from contracts/storefront-routes.md (`public, s-maxage=240, stale-while-revalidate=60` for pages; `s-maxage=60` for not-found/unavailable; `private, no-store` + `X-Robots-Tag: noindex` when `preview`; `nosniff`, `Referrer-Policy`; never `Set-Cookie`); apex root → 302 to `OMNIPOS_WEBSITE_URL`; reserved subdomain → 301 to apex; `UpstreamError` → 503 page with `Cache-Control: no-store` — Done note: an unknown address and a non-public store both answer the same neutral 404 page (cache 60 s) because the public catalog never reveals which; spec FR-017 / storefront-routes.md updated accordingly.
- [X] T010 Implement `/img/<path>` in `storefront/src/img.ts`: only paths matching `^[0-9a-f-]{36}/(l|s)/[0-9a-f-]{36}/[A-Za-z0-9_-]+\.webp$`, fetched from `{SUPABASE_URL}/storage/v1/object/public/store-images/<path>` and streamed with `Content-Type: image/webp`, `Cache-Control: public, max-age=31536000, immutable`; anything else → 404
- [X] T011 Create `storefront/src/render/layout.ts` (document shell: `<html lang dir>`, meta viewport, stylesheet/script with version query, header with logo/name, footer "Powered by OmniPOS") and `storefront/public/storefront.css` base (CSS logical properties only, system font stack + Arabic fallback, 360 px-first grid, focus styles, ≥ 44 px tap targets) — content filled by stories — Done note: `storefront/src/assets.ts` holds the asset version (sha256 of the public files, LF-normalised); the check test comes with T037.
- [X] T012 Create `storefront/dev-server.ts`: Node `http` server on port 3200 calling the same handler; `--source=cloud` (default, SupabaseRpcSource) or `--source=fixture` (in-memory demo store from `storefront/src/fixture.ts`, also used by tests); maps `localhost:3200/s/<address>` to path form

**Checkpoint**: migration + SQL tests green, handler answers every route kind with the right headers (pages still minimal).

---

## Phase 3: User Story 1 — Browse a store (P1) 🎯 MVP

**Goal**: a visitor opens the address and browses identity, categories, products, search and pages.

**Independent test**: fixture store with 60 listings → home, category filter, search, paging work without JS.

- [X] T013 [P] [US1] Write `tests/storefront-render.test.ts` (home): with the fixture source, home shows store name/description/logo, categories in `category_order` then name plus "All products", first 48 cards (photo or placeholder, title, USD price, local price when shown, stock label), pager; `?c=` filters and is preserved in pager links; `?q=` matches title/barcode and shows "no products found" when empty; out-of-range `page` shows the empty state with a link to page 1; all store-provided text is HTML-escaped (a title with `<script>` renders as text)
- [X] T014 [P] [US1] Write `tests/storefront-routing.test.ts`: host vs path form resolve the same store and generate links in their own form; `ABC-Market` host matches `abc-market`; unknown address → 404 not-found page; apex root → 302; `www.` → 301; header table from contracts/storefront-routes.md per route kind
- [X] T015 [US1] Implement `storefront/src/render/home.ts`: identity block, category chips (horizontal scroll on phones), product grid cards, search form (`GET`, input `q`, keeps `c`/`lang`), pager (prev/next + page numbers), empty states ("No products available yet", "No products found"); card links to `/p/<listing_id>`
- [X] T016 [US1] Implement `storefront/src/format.ts` money/stock helpers: USD with 2 decimals; local = `price_lbp` or `round(price × local_rate)` formatted with thousands separators and the currency symbol, only when `show_local_price` and a local currency exist; stock label keys `in_stock|low_stock|out_of_stock`; exact quantity only when `stock` is non-null — Done note: implemented in Phase 2 alongside the handler (`storefront/src/format.ts`).
- [X] T017 [US1] Add `LocalDbSource` for the preview server in `scripts/preview-server.ts` (dev only): builds `getStore/listListings/getListing` results from `server/commerce.ts` (`listStores`, `listListings` derive functions) with the same gates as the cloud (active, retail/hybrid, commerce on) and the same field allow-list, and mounts the storefront handler at `/s/*` so `http://localhost:3100/s/<address>` renders the real storefront on demo data — Done note: `scripts/preview-storefront.ts` (`LocalDbSource`), mounted in `scripts/preview-server.ts` with the storefront assets; verified at 375 px: no sideways scroll, category and search filters work.

**Checkpoint**: MVP browse works on fixture and on the preview server.

---

## Phase 4: User Story 2 — Product page and contact (P1)

**Goal**: product page with photos, prices, units, stock, contact buttons and link previews.

**Independent test**: open `/p/<id>` directly; compare every value with the back-office listing preview; use each button.

- [X] T018 [P] [US2] Extend `tests/storefront-render.test.ts` (product): title, description with line breaks, category, USD + local price, each unit (name, contents, price), stock label + "indicative" note, photo gallery (main first) or placeholder; WhatsApp link `https://wa.me/<digits>?text=` with product name + page URL in the store language; `tel:` and `mailto:` (subject = product name) only when those contact fields exist; no buttons when none; Open Graph tags (`og:title`, `og:description` with price, `og:image` absolute `/img/…` URL, `og:url`); unknown/unpublished listing id → 404 "no longer available" page with a store link — Done note: 8 tests added to storefront-render (product page, gallery order, contact links incl. 00/+ numbers, home contact row, link previews in path form, 404 product, exact stock).
- [X] T019 [US2] Implement `storefront/src/render/product.ts` using `DataSource.getListing` (`store_public_listing`); gallery markup (scroll-snap, works without JS) and `storefront/public/storefront.js` swipe/indicator enhancement (≤ 10 KB total JS) — Done note: products without photos get a short placeholder (2:1, max 160 px) so price and contact buttons stay on the first phone screen; photos capped at 60vh.
- [X] T020 [P] [US2] Implement `storefront/src/contact.ts` (WhatsApp/tel/mailto builders; WhatsApp number digits only, leading `00` → none, `+` stripped) and use it on home (store link message) and product pages (product message) — FR-010a/FR-011 — Done note: numbers with fewer than 6 digits give no WhatsApp/Call button.
- [X] T021 [P] [US2] Implement `storefront/src/seo.ts` (`<title>`, description, Open Graph, `og:locale` per language, canonical URL in host form) and wire into layout; add `storefront/public/placeholder.svg` (neutral, no text) — Done note: `seo.ts` also emits `og:locale` and `twitter:card`; placeholder.svg was created in Phase 2.

---

## Phase 5: User Story 3 — Language and phones (P1)

**Goal**: storefront in en/ar/fr, RTL for Arabic, usable at 360 px.

**Independent test**: same store in each language at 360 px and desktop; no untranslated label; no sideways scroll.

- [X] T022 [P] [US3] Create `storefront/src/i18n.ts` with en/ar/fr for every storefront label, empty state, error page, stock label, "indicative" note, contact button, WhatsApp message template, pager, search placeholder, language names; `t(lang, key, vars)`; a test in `tests/storefront-render.test.ts` asserts all three languages have the same keys and no empty values — Done note: keys and `{placeholders}` checked identical across en/ar/fr; language names in their own script (`LANG_NAMES`).
- [X] T023 [US3] Apply language: default = store `default_language`; `?lang=` overrides and is kept in every generated link; `<html lang dir="rtl">` for Arabic; language switcher links in the footer; `storefront.js` stores the chosen language in `localStorage` and, on load, redirects once to `?lang=<saved>` when it differs from the page (no cookies) — Done note: switcher links carry an explicit `?lang=` and keep category/search/page/preview; verified in the preview: picking French then opening the plain address redirects to `?lang=fr`.
- [X] T024 [US3] Finish `storefront/public/storefront.css` for 360 px → desktop (2-column grid on phones, 3–4 on larger screens, long names clamped to 2 lines on cards, images `aspect-ratio` fixed, no horizontal overflow) and add a render test asserting Arabic pages carry `dir="rtl"` and no layout uses `left`/`right` properties (grep the stylesheet for physical properties) — Done note: prices are left-to-right islands (`direction: ltr; unicode-bidi: isolate`) aligned to the start edge, so Arabic cards read "145,000 LL" on the right; verified at 375 px in Arabic and French, no sideways scroll.

---

## Phase 6: User Story 4 — Only open stores are public; nothing private shows (P1)

**Goal**: neutral unavailable page for every gated state; Wholesale never public; allow-list proven.

**Independent test**: each gated state → unavailable page; HTML contains no forbidden field.

- [X] T025 [P] [US4] Extend `tests/storefront-render.test.ts`: fixture variants for paused, draft, wholesale, commerce off, license expired → one identical "store unavailable" page (no reason shown, no products, `s-maxage=60`); never-claimed address → "store not found"; allow-list scan of every rendered page for `cost`, `min_price`, `wholesale`, `reorder`, `tenant_id`, product global ids, barcode text — Done note: one identical neutral 404 for unknown + all five gated states (incl. product links); allow-list scan over home, filtered, product (en/ar), out-of-range and gone pages; barcode searchable but never printed in cards.
- [X] T026 [US4] Implement `storefront/src/render/status.ts` (store unavailable, store not found, product no longer available, temporarily unavailable 503), all translated, with OmniPOS website link — Done note: built in Phase 2 (`storefront/src/render/status.ts`) and translated in Phase 5.
- [X] T027 [US4] Back office: in `server/commerce.ts` `setStoreStatus`, refuse `active` for `mode = 'wholesale'` with 409 `STORE_MODE_NOT_PUBLIC` (field `mode`); extend `commerceStatus().store` with `publicly_visible` and `not_public_reason` (`draft|paused|wholesale|commerce_off|license|null`); tests in `tests/commerce-store.test.ts` (wholesale can't open; hybrid can; switching an open store to wholesale keeps status but `not_public_reason = 'wholesale'`) — Done note: reason priority commerce_off > license > draft > paused > wholesale (a draft wholesale store reports `draft`; the Settings note explains wholesale).
- [X] T028 [US4] Settings UI `src/pages/settings/OnlineStoreSection.tsx`: show "Not public" badge with the localized reason; for Wholesale stores replace "Open the store" with the note that private B2B stores come with business relationships; strings in `src/intl/locales/commerce.ts` (en/ar/fr) incl. `commerce_err_store_mode_not_public` — Done note: "Visible to customers" / "Not public: …" badge refreshed after every action; Wholesale stores show the B2B note instead of the open button; verified in English and Arabic in the preview.

---

## Phase 7: User Story 5 — Photos, logo/cover, public address and preview (P2)

**Goal**: owners add up to 4 photos per product, a logo and cover, copy/open the public address, preview drafts.

**Independent test**: upload/reorder/remove photos (stub storage) and see them in the storefront order; preview link works for a draft store.

- [X] T029 [P] [US5] Write `tests/commerce-photos.test.ts` (stub storage client via an injectable `__setStorageClient`): upload creates the listing if missing and appends a path `‹tenant gid›/l/‹listing gid›/‹22-char random›.webp`; 5th photo → `LISTING_IMAGES_INVALID`; non-WebP or > 2 MB body → `LISTING_IMAGES_INVALID`; offline (no session) → 503 `STORE_PHOTO_NEEDS_ONLINE` and nothing changes; reorder/remove via `PUT …/photos` accepts only a subset/permutation of current paths and deletes removed objects; `PUT …/listings/:productId` with `images` → 400 `LISTING_FIELD_INVALID`; cashier → 403; another tenant → 404; logo/cover replace deletes the old object; every change audited — Done note: 10 tests; hook is `__setCommerceCloud` (one fake for upload, remove and preview tokens).
- [X] T030 [US5] Create `server/commerceStorage.ts`: `uploadImage(tenantId, path, bytes)` / `deleteImages(tenantId, paths)` using the tenant's active cloud session (`getActiveSession()`, must match tenant) against bucket `store-images`; injectable client for tests; returns `null` when offline — Done note: `CommerceCloud` with upload / remove / previewToken, results `{ ok, value?, reason: offline|failed }` (flat shape: the project isn't in strict mode).
- [X] T031 [US5] In `server/commerce.ts`: `LISTING_IMAGES_MAX = 4` (was 8) in `listingFields`; drop `images` from the generic listing PUT; add `addListingPhoto`, `setListingPhotos`, `setStoreBranding(kind)`, `clearStoreBranding(kind)` per contracts/backoffice-api.md; routes with a route-scoped `express.raw({ type: 'image/webp', limit: '2mb' })` mounted before the global JSON parser (same pattern as the import wizard in `server.ts`, `tests/helpers/testApp.ts`, `scripts/preview-server.ts`); ROUTE_RULES for the five new routes in `server/permissions.ts` — Done note: raw parser limit 3 MB so a 2–3 MB file gets the translated `LISTING_IMAGES_INVALID` instead of a bare 413; a new listing created for an upload is soft-deleted again if the upload fails.
- [X] T032 [US5] Preview: `POST /api/commerce/stores/:id/preview` in `server/commerce.ts` calling `create_store_preview_token` with the tenant session (injectable for tests) and returning `{ url }` (`STORE_PREVIEW_NEEDS_ONLINE`, `STORE_NOT_READY`); `commerceStatus()` adds `storefront_origin` and `store.public_url = https://<slug>.<domain>`; domain from a single constant `STOREFRONT_DOMAIN` in `server/commerce.ts` mirrored in `src/lib/storefront.ts`; tests in `tests/commerce-store.test.ts` — Done note (deviation): no client constant — `status` carries `storefront_origin` and `image_base` (thumbnails load from the public bucket), and the preview server points both at itself via `STOREFRONT_PATH_BASE` / `STOREFRONT_IMAGE_BASE`.
- [X] T033 [P] [US5] Create `src/lib/imageResize.ts`: accept JPEG/PNG/WebP ≤ 5 MB, decode with `createImageBitmap`, scale so the longest side ≤ 1600 px, encode `image/webp` quality 0.82 via `OffscreenCanvas` (fallback `<canvas>`), reject other types/sizes with error codes mapped in `src/intl/locales/commerce.ts` — Done note: retries quality 0.82 → 0.7 → 0.55 to stay under 2 MB.
- [X] T034 [US5] Product editor photo grid in `src/pages/products/OnlineStoreCard.tsx`: thumbnails (from `<storefront origin>/img/<path>`, local preview server serves `/img` too), add button (hidden at 4), drag or arrow buttons to reorder, "Make main", remove with confirmation, offline message; read-only without `store.publish`; strings in `src/intl/locales/commerce.ts`; API helpers in `src/lib/commerceApi.ts` — Done note: grid in its own component `src/pages/products/ListingPhotos.tsx`; verified in the preview (upload, thumbnails, make main).
- [X] T035 [US5] Settings `src/pages/settings/OnlineStoreSection.tsx`: logo and cover upload/remove (same resize), public address with "Copy" and "Open store" (opens `public_url` when publicly visible), "Preview" (calls the preview route, opens the URL) for draft/paused/wholesale; strings en/ar/fr — Done note: link button named "View store" so it isn't confused with the "Open the store" status action.
- [X] T036 [US5] Preview server: in `scripts/preview-server.ts` replace the storage client with a local folder (temp dir) and serve `/img/*` from it, and replace the preview-token call with a local token map, so the full photo + preview flow works on the dev PC — Done note: also fixed the local data source to list published products of a not-yet-open store during a preview (same as the cloud query).

---

## Phase 8: User Story 6 — Fast and affordable (P2)

**Goal**: pages cached at the edge; images immutable; freshness ≤ 5 min.

**Independent test**: header assertions per route; burst script shows upstream calls ≪ requests.

- [ ] T037 [P] [US6] Extend `tests/storefront-routing.test.ts`: identical URLs produce identical bodies and cache headers; no response varies on cookies or sets cookies; static asset URLs carry a content-hash version query (`?v=<hash>` computed at build/start from file contents)
- [ ] T038 [US6] Add `storefront/scripts/burst.ts` (dev tool): fires N requests over a URL list against a base URL and reports status mix, p95 latency and, with `--count-upstream` against the dev server, how many DataSource calls were made — for SC-001/SC-002 checks in quickstart §4
- [ ] T039 [US6] Add `storefront/src/limits.ts` page-weight guard used in a test: rendered home HTML ≤ 60 KB with 48 cards, CSS ≤ 20 KB, JS ≤ 10 KB

---

## Phase 9: Polish & cross-cutting

- [ ] T040 [P] Write `supabase/checks/2026-10-19_storefront_checks.sql` (read-only: function signatures + grants incl. `store_public_listing` and `create_store_preview_token`, wholesale gate present in `_store_public_store` source, bucket settings, storage policies, `store_preview_tokens` RLS on with no policies)
- [ ] T041 [P] Arabic/French audit of the storefront (fixture source via `storefront/dev-server.ts --source=fixture`) and of the new back-office strings in the preview server (DOM scan as in 001)
- [ ] T042 Gates: `npm test`, `npx tsc --noEmit`, `npm run build`, `npm run build:server`; storefront type-checks
- [ ] T043 Run quickstart §1–2 and record results in `specs/002-tenant-online-store/validation.md`
- [ ] T044 [P] Update `ROADMAP.md` (002 status, pending: 002 cloud migration, storefront domain purchase, Vercel project + plan, deployment checks) and `storefront/README.md` deployment steps (Vercel project, env vars, apex + wildcard domains with Vercel nameservers)

---

## Dependencies & execution order

- Phase 1 → Phase 2 → stories. T004 before T005; T006/T007/T009 before any render task.
- **US1** (T013–T017) needs Phase 2. **US2** needs US1's layout/format (T015, T016). **US3** can start after T011
  and is applied across pages, so do it after US1/US2. **US4**: storefront part (T025–T026) after T009; back-office
  part (T027–T028) independent of the storefront. **US5** needs T004 (bucket, tokens) and T010 (`/img`); back-office
  tasks are independent of US1–US4 rendering. **US6** after US1/US2 pages exist.
- Same-file serialisation: `server/commerce.ts` (T008, T027, T031, T032), `scripts/preview-server.ts` (T017, T036),
  `OnlineStoreSection.tsx` (T028, T035), `storefront.css` (T011, T024), `tests/storefront-render.test.ts`
  (T013, T018, T022, T025).

## Parallel examples

```text
Setup:      T002 ‖ T003
Phase 2:    T006 ‖ T007 ‖ T010 (after T004/T005: T008 ‖ T011 ‖ T012)
US1:        T013 ‖ T014 (tests first), then T015 → T016 → T017
US2:        T018 first, then T020 ‖ T021, T019
US5:        T029 ‖ T033 first, then T030 → T031 → T032, then T034 ‖ T035, T036
Polish:     T040 ‖ T041 ‖ T044
```

## Implementation strategy

1. **MVP**: Phases 1–3 (browse) + Phase 6 back-office rule (T027) — a store can be browsed on the preview server and
   Wholesale can't go public.
2. **Increment 2**: Phases 4–5 (product page, contact, languages) — the storefront is shippable as read-only.
3. **Increment 3**: Phase 6 remainder + Phase 7 (photos, preview, public address) — what shops need to share it.
4. **Increment 4**: Phase 8 + 9 — performance proof, checks, deployment notes.
5. Deployment (outside these tasks): user applies `2026-10-19_storefront.sql`, buys the storefront domain, creates
   the Vercel project on a commercial plan; then quickstart §3–4.
