# Quickstart — Validating the Tenant Online Store (002)

Details live in the [contracts](contracts/) and [data-model.md](data-model.md); this is the run/verify guide.

## Prerequisites

- 001 Slice A merged or this branch checked out (002 is cut from it); 001 cloud migration applied (done 2026-10-18).
- `npm install` (adds the dev-only `@electric-sql/pglite`).

## 1. Automated suite

```bash
npm test
```

Expected: everything green, including `storefront-render`, `storefront-routing`, `commerce-photos`,
`commerce-sql` (PGlite: both migrations, gates incl. Wholesale, preview tokens, single-listing RPC, reserved list,
storage policy SQL) and the extended `commerce-store` tests.

## 2. Local end-to-end on the dev PC (no cloud needed)

```bash
npm rebuild better-sqlite3
```
```bash
npx tsx scripts/preview-server.ts
```

1. Sign in as the demo admin (PINs in `scripts/preview-server.ts`), Settings → Online store: turn on, create a Retail
   store, save address `beirut-market`, open it.
2. Products → publish a few; on one product open the Online store tab and add 2–4 photos (the preview server stores
   them locally instead of Supabase Storage).
3. Open `http://localhost:3100/s/beirut-market` — the storefront rendered by the real storefront handler on the local
   demo data: home, categories, search, paging, product page, WhatsApp/Call/Email buttons, Arabic/French via the
   language switch, 360 px width (browser device mode).
4. Switch the store to Wholesale → the open button is refused; set it via the database to mimic an old client →
   `/s/beirut-market` shows "store unavailable".
5. Restore the Electron build when done: `npm run rebuild`.

## 3. Storefront against the cloud (after the 002 migration)

1. User applies `supabase/migrations/2026-10-19_storefront.sql`, then runs
   `supabase/checks/2026-10-19_storefront_checks.sql` (each query lists its expected result).
2. A register on this branch, signed into a **test** business (never a customer tenant on the dev PC), turns on the
   store, opens it, publishes products and uploads photos; wait for sync.
3. `npx tsx storefront/dev-server.ts` (data source = cloud) → `http://localhost:3200/s/<address>`; check pages,
   unavailable states (pause the store, wait ≤ 5 min) and the preview link from Settings.

## 4. Deployment checks (after the storefront domain is bought and the Render service exists)

- `https://<address>.<domain>/` and `https://<domain>/s/<address>` show the same store; `www.<domain>` → apex.
- Response headers match [storefront-routes.md](contracts/storefront-routes.md) (cache headers, no cookies).
- Share a product link in WhatsApp → preview shows title, price and photo.
- Burst test (e.g. 2,000 requests over a few URLs): Supabase API request count rises by < 5% of the requests
  (SC-002); Lighthouse mobile on the home page: first contentful paint < 2 s on simulated 4G (SC-001).
