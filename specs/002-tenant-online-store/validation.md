# Validation — Tenant Online Store (002)

Results of [quickstart.md](quickstart.md) §1–2 for branch `002-tenant-online-store` (phases 1–9). Recorded
2026-10-19 on the dev PC. §3–4 (cloud and deployment) are still to do — see the end.

## 1. Automated suite and gates

| Gate | Result |
|---|---|
| `npm test` | 448 / 448 pass |
| `npx tsc --noEmit` | 0 errors (storefront included) |
| `npm run build` / `npm run build:server` | both succeed |

New for 002: `storefront-render` (27), `storefront-routing` (11), `commerce-photos` (10), `commerce-sql` (8 on PGlite:
both migrations, gates incl. Wholesale, preview tokens, single-listing RPC, reserved list, storage RLS, and the
`2026-10-19_storefront_checks.sql` script itself), plus additions to `commerce-store`.

## 2. Local end-to-end (preview server, demo data, no cloud)

| Step | Result |
|---|---|
| Store home at 375 px: identity, search, category chips, 2-column grid, USD + LL, pager | OK, no sideways scroll |
| Category filter and search (title / barcode) | OK |
| Product page: gallery with dots, category, prices, stock + indicative note, description, WhatsApp / Call / Email | OK; whole page fits one phone screen |
| Product without photos | short placeholder, info stays above the fold (fixed during phase 4) |
| Price change in the back office → storefront | shows the new price (1.50 → 1.75) |
| Disable product | storefront and back office say "product disabled" |
| Arabic store: RTL layout, prices `145,000 LL` aligned right | OK (price bidi fixed during phase 5) |
| Language switch to French, then plain address | redirected to `?lang=fr` (remembered on the device) |
| Wholesale store | can't be opened; Settings shows the B2B note and "Not public: …" badge |
| Photos: upload 2 (generated WebP), thumbnails, make main | OK |
| Logo upload | shown in the storefront header and in Settings |
| Owner preview of a draft store | banner "Preview — this store is not public", products listed |
| Settings address block | full address, Copy, View store (disabled while not public), Preview |
| Cashier | Online store hidden; `/api/commerce/*` 403 |
| Text audit (rendered pages, 7 kinds × ar/fr) | no untranslated text (only shop data, language names, brand names) |
| Burst (dev server, fixture, 300 requests) | all 200, p50 9 ms, p95 24 ms (no CDN locally, so no cache figures) |

## 3. Cloud (live project, 2026-10-19)

Migrations `2026-10-19_storefront.sql` and `2026-10-19b_storefront_storage.sql` applied by the user and verified
read-only with `supabase/checks/2026-10-19_storefront_checks.sql`: all nine functions exist with the intended grants
(anon: the three `store_public_*` only; authenticated also `claim_store_slug` and `create_store_preview_token`;
helpers closed), old 001 signatures gone, Wholesale gate present, allow-list clean, `store_preview_tokens` RLS on with
no policies, bucket `store-images` public / 2 MB / WebP, three owner-only storage policies, reserved list updated.
(The first apply showed no change; after re-running both files everything is in place.)

## 3–4. Still to do (needs the user / deployment)

1. ~~Apply the 002 migrations and run the checks~~ — done 2026-10-19 (section 3).
2. ~~Buy `myomnipos.com`; create the Render web service~~ — done 2026-10-19: `myomnipos.com` (Hostinger DNS),
   Render `omnipos-storefront` from `render.yaml` on branch `002-tenant-online-store`, edge caching "All files",
   Let's Encrypt `*.myomnipos.com` certificate (apex + wildcard). Checked live: `/` → 302 to `OMNIPOS_WEBSITE_URL`
   (`s-maxage=3600`), `www.` → 301 apex, reserved `admin.` → 301 apex, `http://` → 301 `https://`, `/healthz` 200
   `no-store` (BYPASS); unknown store (host and path form) → 404 "This store isn't available", `noindex`,
   `s-maxage=60`, no cookies; `storefront.css?v=…` immutable; repeat requests `cf-cache-status: HIT`. Burst of 300
   requests over 3 URLs: 298 HIT / 2 MISS (upstream ≈ 0.7%, target < 5%); p50 94 ms, p95 749 ms from the dev PC.
   No store is open in the cloud yet, so store and product pages are still to check live (item 3).
3. A register on these branches, signed into a **test** business, opens a store, uploads photos; check the live
   storefront, a WhatsApp link preview, the unavailable states (pause, wait ≤ 5 min) and the owner preview.
4. Burst test against the deployed URL (`storefront/scripts/burst.ts`): upstream share < 5% (SC-002), Lighthouse
   mobile first contentful paint < 2 s (SC-001).
5. Before any release: merge 001 then 002, upgrade dry run on a copy of a real customer database.
