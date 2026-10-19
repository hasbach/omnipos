# Research — Tenant Online Store (002)

Decisions for [plan.md](plan.md). Format: decision, rationale, alternatives.

## R1 — Rendering model

- **Decision**: Server-rendered HTML from one Vercel serverless function (Node 20), no UI framework. Each page is a
  full HTML document with Open Graph tags; a small script adds the photo gallery swipe and remembers the visitor's
  language. Search, category and paging are plain links/forms (work without JS).
- **Rationale**: FR-012 link previews — WhatsApp/Facebook crawlers don't run JavaScript, so meta tags must be in the
  HTML. Tiny pages meet SC-001 on 4G. No framework keeps the deployable small and dependency-free.
- **Alternatives**: SPA in the Live Monitor (no server meta, owner-only PWA); Next.js (heavy, new framework for a
  handful of pages); static export per store (rebuild on every price change).

## R2 — Hosting, domain and routing

- **Decision**: Separate Vercel project `omnipos-storefront` (Root Directory `storefront/`) on a commercial plan.
  Domains: apex `<storefront domain>` and wildcard `*.<storefront domain>` (wildcard needs the domain's nameservers at
  Vercel). Routing by `Host`: `<address>.<domain>` → store; apex `/s/<address>` → same store; apex `/` → redirect to
  the OmniPOS website; reserved subdomains (`www`, …) → apex.
- **Rationale**: FR-001/002; one function serves all stores; HTTPS is automatic for apex + wildcard.
- **Alternatives**: `*.vercel.app` subdomains (not ours to hand out); path-only (works, but less brandable — kept as
  the fallback form).
- **Note**: Vercel Hobby forbids commercial use → Pro plan; recorded as an accepted cost in the spec assumptions.
- **Revised 2026-10-19 (before deployment)**: hosted on **Render** instead, as a second web service in the existing
  Render workspace (no Vercel Pro subscription). Same handler (`src/http.ts`) behind a plain Node server
  (`storefront/server.ts`, `render.yaml`); Render's edge cache honours the same `Cache-Control` / `s-maxage` headers
  once Edge Caching is set to "All files", so R3 holds unchanged. Apex + wildcard custom domains use DNS records at
  the registrar (no nameserver move). Domain: `myomnipos.com` (omnipos.shop / .store taken). The store is resolved
  from `Host` only: `X-Forwarded-Host` is ignored because the edge caches by `Host`.

## R3 — Caching and freshness (protecting Supabase egress)

- **Decision**: Every public response sets `Cache-Control: public, s-maxage=240, stale-while-revalidate=60`
  (worst-case staleness ≈ 5 min, FR-022). "Not found"/"unavailable" pages: `s-maxage=60`. Preview responses:
  `private, no-store`. Static assets (`/storefront.css?v=<hash>` etc.): `max-age=31536000, immutable`. Cache key =
  full URL (host + path + query); nothing varies on cookies.
- **Rationale**: Vercel's CDN serves repeat views; Supabase is hit once per URL per ~4 min per region. A 2,000-visit
  burst on ~20 distinct URLs costs tens of RPC calls (SC-002 < 5%).
- **Alternatives**: on-demand revalidation from the desktop (needs a secret on every register); in-function memory
  cache (cold starts lose it, not shared across regions).

## R4 — Data access from the storefront

- **Decision**: `fetch` to PostgREST `POST /rest/v1/rpc/<fn>` with the public anon key (already public in the Live
  Monitor). Functions: `store_public_get`, `store_public_listings`, new `store_public_listing` (one product). All take
  an optional `p_preview` token (R8). A `DataSource` interface wraps them so tests and the preview server can plug in
  other sources.
- **Rationale**: FR-018 — the storefront never touches tables; the allow-list lives in reviewed SQL.
- **Alternatives**: `@supabase/supabase-js` in the function (extra dependency, no benefit for 3 RPC calls).

## R5 — Wholesale stores are never public (clarification A)

- **Decision**: Add `s.mode IN ('retail','hybrid')` to the cloud gate `_store_public_store` (so a Wholesale store
  answers exactly like a missing slug). Back office: `POST /stores/:id/status {active}` refused for Wholesale stores
  (`STORE_MODE_NOT_PUBLIC`); switching an open store to Wholesale is allowed but the status screen shows "Not public
  (wholesale)". Preview tokens still work for Wholesale stores (owner only).
- **Rationale**: FR-016/016a; enforcement in the cloud means even an old desktop version can't expose a Wholesale store.

## R6 — Photo upload pipeline

- **Decision**: In the back office (renderer), the chosen file is checked (JPEG/PNG/WebP, ≤ 5 MB) and resized with
  `createImageBitmap` + canvas to longest side ≤ 1600 px, encoded WebP (quality 0.82). The local server receives the
  bytes (`POST .../listings/:productId/photos`, raw `image/webp` body, ≤ 2 MB route-scoped limit), uploads to Supabase
  Storage with the tenant's active cloud session at `store-images/<tenant global id>/l/<listing global id>/<random>.webp`,
  then appends the path to `store_listings.images`. Delete removes the object and the path; reorder rewrites the array.
  Logo/cover: same flow, paths `…/<tenant>/s/<store global id>/{logo|cover}-<random>.webp`.
- **Rationale**: canvas avoids native image modules (Electron ABI pain); upload through the server keeps the session
  and the "server is authoritative" rule; random names make objects immutable (perfect caching).
- **Alternatives**: `sharp` on the local server (native module per ABI); direct upload from the renderer to Supabase
  (renderer would need the session token).
- **Offline**: no active session for this tenant → `STORE_PHOTO_NEEDS_ONLINE` (503), nothing changes.

## R7 — Image delivery

- **Decision**: Bucket `store-images` is public-read (objects are product photos meant to be public). The storefront
  never links Supabase directly: it renders `/img/<path>` which the function proxies from
  `…/storage/v1/object/public/store-images/<path>` with `Cache-Control: public, max-age=31536000, immutable`. Only
  paths matching `^[0-9a-f-]{36}/(l|s)/[0-9a-f-]{36}/[A-Za-z0-9_-]+\.webp$` are proxied.
- **Rationale**: Supabase egress happens once per image per CDN region; names never change, so caches never go stale.
- **Alternatives**: Supabase CDN URLs directly (all traffic counts as Supabase egress); Vercel Image Optimization
  (paid per transformation; images are already resized).

## R8 — Owner preview of draft/paused/wholesale stores

- **Decision**: Table `store_preview_tokens (token text PK, store_id uuid, expires_at timestamptz)`; RPC
  `create_store_preview_token(p_store uuid)` (authenticated, owner only) returns a random 32-byte token valid 30 min.
  The gate accepts `p_preview`: a valid unexpired token for that store bypasses status/mode checks (license and
  commerce-on still required). Storefront: `?preview=<token>` → render with a "Preview — not public" banner and
  `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`. Back office: "Preview" button calls the local server,
  which calls the RPC with the tenant's session and opens the URL.
- **Rationale**: FR-028; no shared secret on registers; tokens expire and are per store.
- **Alternatives**: local preview rendered in the desktop app (duplicate renderer); signed URLs (needs a secret on
  every register).

## R9 — Languages

- **Decision**: Storefront strings in `storefront/src/i18n.ts` (en/ar/fr). Default = store language; `?lang=xx`
  overrides and is kept in all generated links; `storefront.js` remembers the visitor's choice in `localStorage` and
  redirects once on load when it differs. `<html lang dir>` set server-side; CSS uses logical properties.
- **Rationale**: FR-020 while keeping the cache key URL-only (no cookie variance).

## R10 — Local currency display

- **Decision**: local price = product/unit `price_lbp` when set; otherwise USD × `local_rate` from `store_public_get`,
  rounded to a whole local amount; shown only when `show_local_price` and a local currency exist. Formatting mirrors
  the back office's money formatting (USD 2 decimals, LBP whole with thousands separators).
- **Rationale**: spec edge case + FR-010; display only (Constitution I untouched).

## R11 — Reserved addresses and the 8→4 photo limit

- **Decision**: One reserved list (FR-004) in `server/commerce.ts` (`RESERVED_SLUGS`) and in `claim_store_slug`;
  a test asserts both lists are identical (parses the migration). Photo limit `LISTING_IMAGES_MAX = 4` in the server;
  bucket `file_size_limit` 2 MB, `allowed_mime_types` `image/webp`.
- **Rationale**: one rule, enforced locally and in the cloud.

## R12 — Testing the cloud SQL in `npm test`

- **Decision**: Add devDependency `@electric-sql/pglite`; `tests/commerce-sql.test.ts` creates stub Supabase tables/
  roles (as validated during 001), applies both migrations and asserts gates, allow-list, preview tokens, single-listing
  RPC, reserved list and privileges. Storage policies are created in a stub `storage.objects` table and checked by
  evaluating their `USING`/`WITH CHECK` expressions for owner vs other tenant.
- **Rationale**: 001's PGlite harness caught nothing wrong but proved valuable; making it a permanent test protects the
  privacy rules (Constitution V).
- **Alternatives**: manual SQL-editor checks only.
