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

## Vercel project (deployment)

- Separate project, **Root Directory** `storefront`, on a plan that allows commercial use.
- Environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the public anon key), `STOREFRONT_DOMAIN`
  (e.g. `omnipos.shop`), `OMNIPOS_WEBSITE_URL` (where the bare domain redirects).
- Domains: apex `<STOREFRONT_DOMAIN>` and wildcard `*.<STOREFRONT_DOMAIN>` (wildcard needs the domain's nameservers
  at Vercel).
- The cloud migrations `2026-10-18_commerce_store_foundation.sql` and `2026-10-19_storefront.sql` must be applied.
