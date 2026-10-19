# OmniPOS storefront

Public, read-only online-store pages for OmniPOS businesses — feature
[002](../specs/002-tenant-online-store/spec.md). Server-rendered HTML from one function; every page is cacheable at
the CDN so visitor traffic barely touches Supabase.

- `server.ts` — production entry (Render web service, `render.yaml` at the repo root); `src/node-server.ts` serves
  `public/` and `/healthz` and hands every page to `src/http.ts`, which routes by host (`<address>.<domain>`) or
  path (`/s/<address>`).
- `src/` — router, data source (public catalog RPCs), page renderers, i18n.
- `public/` — stylesheet, small script, placeholder image (immutable caching).
- `dev-server.ts` — run locally: `npx tsx storefront/dev-server.ts [--source=fixture|cloud]` → http://localhost:3200/s/<address>.

The storefront reads only the allow-listed public functions (`store_public_get`, `store_public_listings`,
`store_public_listing`); it never touches tables and never writes.

## Checks

- `npm test` (repo root) covers routing, rendering, privacy and caching headers (`tests/storefront-*.test.ts`) and
  the cloud SQL on PGlite (`tests/commerce-sql.test.ts`).
- Burst test against a deployed store: `npx tsx storefront/scripts/burst.ts https://<address>.<domain> / /p/<id>
  --requests=2000 --concurrency=20` — reports latency and the edge cache mix (`cf-cache-status`); upstream share should
  stay under 5%. In Git Bash prefix the command with `MSYS_NO_PATHCONV=1` (it rewrites arguments that start with `/`).
- After editing anything in `public/`, update `ASSET_VERSION` in `src/assets.ts` (a test prints the new value).

## Render web service (deployment)

The service is described by `render.yaml` (repo root): web service `omnipos-storefront`, Root Directory
`storefront`, Node 22, `npm install --omit=dev` / `npm start` (`tsx server.ts`), health check `/healthz`, region
Frankfurt, Starter instance, auto-deploy only when `storefront/**` changes. It is billed as its own instance next to
the other services in the workspace.

Before deploying, the cloud migrations `2026-10-18_commerce_store_foundation.sql`, `2026-10-19_storefront.sql` and
`2026-10-19b_storefront_storage.sql` must be applied (then run `supabase/checks/2026-10-19_storefront_checks.sql`).

Step by step:

1. Buy `myomnipos.com` at any registrar. Its DNS can stay there (or move to Cloudflare); Render does not need the
   nameservers.
2. Render → New → Blueprint → this repository, on the branch that has the storefront (`main` once 002 is merged).
   Render reads `render.yaml` and asks for the two `sync: false` values:
   - `SUPABASE_ANON_KEY`: the public anon key (same as `src/lib/supabase.ts`);
   - `OMNIPOS_WEBSITE_URL`: where `https://myomnipos.com/` redirects (the OmniPOS website).
3. Service → Settings → **Edge Caching**: turn it on with cacheable type **All files**. Every response sets its own
   `Cache-Control` (`public, s-maxage=240` for store pages, `private, no-store` for owner previews, immutable for
   assets and photos), so pages are cached per URL and previews never are. Each deploy purges the edge cache.
4. Service → Settings → Custom Domains: `myomnipos.com` and `*.myomnipos.com` come from the Blueprint (add them by
   hand if not). At the registrar, create exactly the records Render shows, typically:
   - apex `myomnipos.com`: `A` → Render's IP (or `ALIAS`/`ANAME` → `omnipos-storefront.onrender.com`);
   - `*`: `CNAME` → `omnipos-storefront.onrender.com`;
   - `_acme-challenge` and `_cf-custom-hostname`: the `CNAME` values Render gives for the wildcard certificate.
   The apex must point at Render too, or the wildcard fails verification. Wait until both domains show as verified
   with a certificate issued.
5. If the domain ever changes from `myomnipos.com`, update `STOREFRONT_DOMAIN` in `render.yaml` and the defaults in
   `server/commerce.ts` (public addresses shown in the desktop app's Settings) and `storefront/src/config.ts`, then
   release the app.
6. Check `https://myomnipos.com/` redirects to the website, `https://www.myomnipos.com/` to the apex, a test store
   opens at `https://<address>.myomnipos.com/`, and a second request for the same page returns
   `cf-cache-status: HIT`. Then run the burst test above.
