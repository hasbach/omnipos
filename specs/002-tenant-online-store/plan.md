# Implementation Plan: Tenant Online Store (Public Storefront)

**Branch**: `002-tenant-online-store` | **Date**: 2026-10-19 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-tenant-online-store/spec.md`

**Depends on**: 001 Slice A (branch `001-commerce-domain-foundation`, not merged yet; cloud migration
`2026-10-18_commerce_store_foundation.sql` applied 2026-10-18). This branch is cut from it; merge 001 first.

## Summary

Build the public, read-only storefront as a **small server-rendered web app** (`storefront/`), deployed as its own
Vercel project. Every request is resolved from the host (`<address>.<storefront domain>`) or path (`/s/<address>`),
data comes only from the 001 public catalog RPCs (allow-listed, retail prices), and every response carries CDN cache
headers so repeat views never reach Supabase (≤ 5 min freshness). Pages are plain HTML + one stylesheet + a few lines
of JS (gallery, language memory), so link previews work and phones load fast.

Around it: a cloud migration (Wholesale stores never public, extended reserved addresses, a single-listing RPC,
owner-only preview tokens, a public `store-images` bucket with per-business write rules), and back-office changes
(photo upload with in-browser resize to ≤ 1600 px WebP, limit 4; logo/cover upload; real public address + Copy / Open
store / Preview; Wholesale stores cannot be opened). Images are served through a long-cached proxy route on the
storefront, not directly from Supabase, to protect the egress quota.

## Technical Context

**Language/Version**: TypeScript 5. Storefront: Node 20 serverless function (Vercel), no UI framework. Back office:
existing React 19 + Express server.

**Primary Dependencies**: none new for the storefront at runtime (uses `fetch` to Supabase PostgREST/Storage).
Back office: existing stack; image resize uses the browser canvas (no native module). Dev only: `@electric-sql/pglite`
(new devDependency) to run the cloud SQL in the test suite.

**Storage**: Supabase Postgres (public catalog RPCs, preview tokens) and Supabase Storage (bucket `store-images`).
Local SQLite unchanged in schema (listing `images`, store `logo_path` / `cover_path` already exist).

**Testing**: `npm test` (node:test). New: storefront render/route tests with an in-memory data source; cloud SQL
tests on PGlite (migration + RPC behaviour + storage policies' SQL); back-office upload tests with a stubbed storage
client.

**Target Platform**: Storefront on Vercel (commercial plan; wildcard + apex of the storefront domain). Back office:
Windows Electron app.

**Project Type**: Web service (new, `storefront/`) + desktop app changes + cloud migration.

**Performance Goals**: SC-001 — store home ≤ 2 s, product page ≤ 1.5 s on 4G (95th pct). HTML ≤ 60 KB, CSS ≤ 20 KB,
JS ≤ 10 KB; images lazy-loaded at card size.

**Constraints**: Supabase Free-plan egress (SC-002: DB reads < 5% of page views under a 2,000-visit burst);
freshness ≤ 5 min (FR-022); no visitor data collected (FR-019); en/ar/fr + RTL (FR-020); 360 px wide (FR-021).

**Scale/Scope**: hundreds of stores, up to ~5,000 listings each; bursts of thousands of visits per store per hour.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — still passing.*

| Principle | How 002 complies | Status |
|---|---|---|
| I. Money & balance integrity | Read-only display of retail prices; no invoices, payments or balances touched. Local price shown = product LBP price or USD × the store's local rate, display only. | Pass |
| II. Tenant isolation | Storefront reads only the allow-listed RPCs (no table access). Storage writes allowed only under the caller's own `auth.uid()` folder. Preview tokens are per store and owner-created. Back-office upload routes scoped by session tenant; isolation tests added. | Pass |
| III. Offline-first | Registers unaffected. Photo/logo upload needs the cloud and says so (`STORE_PHOTO_NEEDS_ONLINE`); every other edit stays offline. App keeps working before the 002 migration (upload refused cleanly; storefront simply not deployed). | Pass |
| IV. Server authoritative | Photo count/type/size enforced by the local server and by the bucket limits; Wholesale-not-public enforced by the server and the cloud gate. New routes get ROUTE_RULES entries. | Pass |
| V. Regression suite green | New tests for storefront rendering/routing/caching headers/allow-list, cloud SQL (PGlite), uploads, wholesale rule, reserved list; existing suite must stay green. | Pass |
| VI. Trilingual, RTL, design system | Storefront strings in en/ar/fr with `dir="rtl"`; back-office additions in `src/intl/locales/commerce.ts` using the UI kit. Storefront has its own light design (public, not the back-office kit) — justified below. | Pass (see Complexity) |
| VII. Backward compatible | Nothing changes for shops that don't use the store. Photo limit 8→4 only affects listings that already hold >4 images: none exist (no upload existed). Wholesale stores were never publicly served (no storefront existed). | Pass |

## Project Structure

### Documentation (this feature)

```text
specs/002-tenant-online-store/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── storefront-routes.md   # public URLs, responses, cache headers
│   ├── cloud-api.md           # RPC + storage changes (migration 2026-10-19_storefront.sql)
│   └── backoffice-api.md      # local Express routes for photos, logo/cover, preview, status
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
storefront/                         # NEW — its own Vercel project (Root Directory = storefront)
├── api/index.ts                    # single function: route by host/path, render, set cache headers
├── src/
│   ├── router.ts                   # host/path → {kind: home|product|img|notFound|apex, address, params}
│   ├── data.ts                     # DataSource interface + Supabase RPC implementation (fetch, anon key)
│   ├── render/{layout,home,product,status}.ts   # HTML strings, all text escaped
│   ├── i18n.ts                     # en / ar / fr storefront strings
│   ├── format.ts                   # money (USD + local), stock labels, WhatsApp/mailto/tel links
│   └── seo.ts                      # <title>, description, Open Graph tags
├── public/{storefront.css,storefront.js,placeholder.svg}
├── dev-server.ts                   # local: same handler on http, DataSource = cloud or fixture
├── vercel.json                     # rewrites everything to api/index.ts; static assets long-cached
└── package.json                    # name/engines only (no runtime deps)

server/
├── commerce.ts                     # + photo/logo/cover upload & delete, preview link, wholesale rule,
│                                   #   reserved list, photo limit 4, public address in status
├── commerceStorage.ts              # NEW — Supabase Storage upload/delete via the tenant's cloud session (injectable)
└── permissions.ts                  # + ROUTE_RULES for the new routes

src/
├── lib/commerceApi.ts, lib/storefront.ts (public origin + address helpers), lib/imageResize.ts (canvas → WebP)
├── pages/settings/OnlineStoreSection.tsx   # public address, Copy / Open / Preview, logo & cover, wholesale note
├── pages/products/OnlineStoreCard.tsx      # photo grid: add (≤4), reorder, main, remove
└── intl/locales/commerce.ts                # new strings

scripts/preview-server.ts           # + mounts the storefront handler at /s/* with a LocalDbSource (demo)

supabase/migrations/2026-10-19_storefront.sql   # NEW
supabase/checks/2026-10-19_storefront_checks.sql

tests/
├── storefront-render.test.ts       # pages, allow-list, escaping, RTL, empty/unavailable states
├── storefront-routing.test.ts      # host/path resolution, reserved, case, cache headers
├── commerce-photos.test.ts         # upload/delete/reorder, limit 4, offline, permissions, isolation
├── commerce-store.test.ts (+)      # wholesale can't open; reserved list; public address
└── commerce-sql.test.ts            # PGlite: 001 + 002 migrations, gates (incl. wholesale), preview tokens,
                                    #   single-listing RPC, claim reserved list, storage policy SQL
```

**Structure Decision**: a separate `storefront/` web service in the same repo (shared tests, one PR flow), deployed
as a second Vercel project next to the Live Monitor. It has no runtime dependency on the desktop code; the only shared
contract is the cloud RPCs. The preview server reuses the storefront handler with a local data source so the full
flow (publish in back office → see storefront) is testable on the dev PC without the cloud.

## Phase 0 — Research

See [research.md](research.md): R1–R12, no open unknowns.

## Phase 1 — Design

- [data-model.md](data-model.md)
- [contracts/storefront-routes.md](contracts/storefront-routes.md),
  [contracts/cloud-api.md](contracts/cloud-api.md),
  [contracts/backoffice-api.md](contracts/backoffice-api.md)
- [quickstart.md](quickstart.md)

## Spec coverage

| Spec | Where |
|---|---|
| FR-001–003 addresses | router.ts (host + `/s/` path, lowercase) |
| FR-004 reserved list | server/commerce.ts + `claim_store_slug` (same list) |
| FR-005 public address in Settings | `public_url` in status + OnlineStoreSection |
| FR-006–015 pages | render/*, format.ts, seo.ts; data from `store_public_get` / `_listings` / `_listing` |
| FR-016/016a gates, wholesale | cloud `_store_public_store` (mode retail/hybrid) + back-office status rule |
| FR-017 not found | router + status page |
| FR-018/019 allow-list, no visitor data | RPC allow-list; no cookies/analytics; tests |
| FR-020/021 language, layout | i18n.ts, `dir`, CSS logical properties, 360 px |
| FR-022/023 freshness, cost | `Cache-Control: s-maxage=240, stale-while-revalidate=60`; image proxy immutable |
| FR-024–027 photos | backoffice-api photo routes, imageResize.ts, bucket + policies |
| FR-028 preview | preview tokens (owner-created, 30 min), `Cache-Control: private, no-store` |
| FR-032 scope | no cart/orders/accounts/custom domains |

## Complexity Tracking

| Exception | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| New deployable (`storefront/`, 2nd Vercel project) | Public traffic must be served from the edge with caching, never from registers or the owner PWA | Adding pages to the Live Monitor SPA: no server-rendered meta tags (WhatsApp previews need them), PWA scope is owner-only, and its bundle is large |
| Storefront not built with the back-office UI kit | Public pages must be tiny and framework-free for speed and link previews | Reusing React + the kit would ship ~200 KB of JS to every visitor |
| New devDependency `@electric-sql/pglite` | Lets `npm test` run the cloud SQL (gates, policies) instead of trusting manual checks | Manual SQL-editor checks only: no regression protection for privacy rules |
