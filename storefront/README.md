# OmniPOS storefront

Public, read-only online-store pages for OmniPOS businesses — feature
[002](../specs/002-tenant-online-store/spec.md). Server-rendered HTML from one function; every page is cacheable at
the CDN so visitor traffic barely touches Supabase.

- `api/index.ts` — the only function (Vercel). Routes by host (`<address>.<domain>`) or path (`/s/<address>`).
- `src/` — router, data source (public catalog RPCs), page renderers, i18n.
- `public/` — stylesheet, small script, placeholder image (immutable caching).
- `dev-server.ts` — run locally: `npx tsx storefront/dev-server.ts [--source=fixture|cloud]` → http://localhost:3200/s/<address>.

The storefront reads only the allow-listed public functions (`store_public_get`, `store_public_listings`,
`store_public_listing`); it never touches tables and never writes.

## Checks

- `npm test` (repo root) covers routing, rendering, privacy and caching headers (`tests/storefront-*.test.ts`) and
  the cloud SQL on PGlite (`tests/commerce-sql.test.ts`).
- Burst test against a deployed store: `npx tsx storefront/scripts/burst.ts https://<address>.<domain> / /p/<id>
  --requests=2000 --concurrency=20` — reports latency and Vercel's cache mix (`x-vercel-cache`); upstream share should
  stay under 5%. In Git Bash prefix the command with `MSYS_NO_PATHCONV=1` (it rewrites arguments that start with `/`).
- After editing anything in `public/`, update `ASSET_VERSION` in `src/assets.ts` (a test prints the new value).

## Vercel project (deployment)

- Separate project, **Root Directory** `storefront`, on a plan that allows commercial use.
- Environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the public anon key), `STOREFRONT_DOMAIN`
  (e.g. `omnipos.shop`), `OMNIPOS_WEBSITE_URL` (where the bare domain redirects).
- Domains: apex `<STOREFRONT_DOMAIN>` and wildcard `*.<STOREFRONT_DOMAIN>` (wildcard needs the domain's nameservers
  at Vercel).
- The cloud migrations `2026-10-18_commerce_store_foundation.sql`, `2026-10-19_storefront.sql` and
  `2026-10-19b_storefront_storage.sql` (or its dashboard equivalent) must be applied
  (then run `supabase/checks/2026-10-19_storefront_checks.sql`).

Step by step:

1. Buy the storefront domain; in Vercel → Domains, add it and switch its nameservers to Vercel (needed for the
   wildcard certificate).
2. New project from this repository: Root Directory `storefront`, no build command, Node 20.
3. Environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `STOREFRONT_DOMAIN`, `OMNIPOS_WEBSITE_URL`.
4. Project → Domains: add `<domain>` and `*.<domain>`.
5. If the domain isn't `omnipos.shop`, change the default in `server/commerce.ts` (`STOREFRONT_DOMAIN`, used for the
   public addresses shown in the desktop app's Settings) and in `storefront/src/config.ts`, then release the app.
6. Check `https://<domain>/` redirects to the website, `https://www.<domain>/` to the apex, and a test store opens at
   `https://<address>.<domain>/`.
