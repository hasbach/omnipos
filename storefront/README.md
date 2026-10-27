# OmniPOS storefront

Public, read-only online-store pages for OmniPOS businesses — feature
[002](../specs/002-tenant-online-store/spec.md). Server-rendered HTML from one function; every page is cacheable at
the CDN so visitor traffic barely touches Supabase.

- `server.ts` — production entry (Render web service, `render.yaml` at the repo root); `src/node-server.ts` serves
  `public/` and `/healthz` and hands every page to `src/http.ts`, which routes by host (`<address>.<domain>`) or
  path (`/s/<address>`).
- `src/` — router, data source (public catalog RPCs), page renderers, i18n.
- `public/` — stylesheet, small script, placeholder image, and the 003 cart scripts (immutable caching):
  `cart.js` (loaded only on stores that take orders) and `checkout.js` (cart page only).
- `dev-server.ts` — run locally: `npx tsx storefront/dev-server.ts [--source=fixture|cloud] [--ordering]` →
  http://localhost:3200/s/<address> (`--ordering`: the fixture store takes WhatsApp orders).

## Ordering (feature [003](../specs/003-retail-ordering/spec.md), Slice 1 — WhatsApp order)

When a store's ordering mode is "Order on WhatsApp" (Settings → Online store → Ordering), pages get "Add to cart"
controls, a header cart link and a `/cart` page. Pages stay the same for every visitor (still cached per URL): the
cart lives in the visitor's browser (`localStorage`, one key per store) and `checkout.js` turns it into a
pre-filled `wa.me` message to the shop in the store's language. Nothing about visitors or orders reaches OmniPOS.
Store-level data (ordering settings, local-currency rule, WhatsApp digits, strings) is in the page's
`<script type="application/json" id="sf-order">` block. Contracts: `specs/003-retail-ordering/contracts/`.

The storefront reads only the allow-listed public functions (`store_public_get`, `store_public_listings`,
`store_public_listing`); it never touches tables and never writes. Without migration
`2026-10-21_retail_ordering_s1.sql` those functions don't return the ordering fields, and the storefront simply treats
every store as "ordering off" — so the storefront and the migration can be deployed in either order.

## Online orders (003 Slice 2)

In `online` mode, with pickup or delivery enabled and `ORDER_GATEWAY_KEY` configured, `public/order.js` reviews
server-priced cart lines, requires a separate confirmation to place the order, and reuses attempt/status keys on
retry. It keeps up to 20 private links in this device's My orders, updates their state on status pages, and offers
the WhatsApp fallback on a cloud failure when the store has a WhatsApp number. Tests enforce a 12,288-byte script
budget (LF). Orders go through the four cloud order RPCs; the storefront still never accesses tables directly.

`<root>` is either `https://<address>.<domain>` or `https://<domain>/s/<address>`:

| Route | Method | Returns |
|---|---|---|
| `<root>/order/quote` | POST JSON `{ lines }` | 200 JSON with the cloud quote and validation problems. |
| `<root>/order` | POST JSON `{ attempt, status_key, customer, lines, expected_total_usd, website }` | 200 JSON from `order_submit`; `created` / `existing` include `status_url`. |
| `<root>/o/<key>` | GET/HEAD | Server-rendered status page, or 404 for an unknown key or another store's order. |
| `<root>/o/<key>/cancel` | POST form `confirm=1` | 303 back to the status page with `cancelled=1` or `not_cancellable=1`, preserving `lang`. |

Status and cancellation do not require the store to remain open or in online mode; they still need the gateway
key. Cancellation is allowed only while submitted. Keys must be 32 characters `[A-Za-z0-9_-]`. Order responses are
not cached or indexed; status pages also set `Referrer-Policy: no-referrer`. Cloud failures return 503 with
`Retry-After: 30`: JSON for quote/submit, HTML for status/cancel. Preview tokens are refused.

`ORDER_GATEWAY_KEY` is the server-only secret authorising the four public order RPCs. Only its SHA-256 is stored
in the cloud table `storefront_gateway_keys`. Run `node scripts/gateway-key.mjs` to print a new key and hash; it
writes nothing. Set the key on Render (`sync: false` in `render.yaml`); never commit it. Without it, online-mode
stores render with ordering off and startup logs a warning.

For POSTs, `src/network.ts` chooses `CF-Connecting-IP`, then `True-Client-IP`, then the last `X-Forwarded-For`
hop, then the socket address. It hashes `UTC date + '|' + address + '|' + ORDER_GATEWAY_KEY` with SHA-256, rotating
daily. Only the hash is sent as `p_network` on order submission; the raw IP is never forwarded to the cloud or
logged. Check the once-per-process `network source: ...` log on Render to verify which source production uses.

Deploy in this order (owner setup):

1. Apply `supabase/migrations/2026-10-23_retail_ordering_s2.sql` after Slice 1, then run
   `supabase/checks/2026-10-23_retail_ordering_s2_checks.sql` (the key-count check needs the next step).
2. Generate the gateway key and insert only its hash into `storefront_gateway_keys`; recheck the key count.
3. Set `ORDER_GATEWAY_KEY` on Render.
4. Merge to `main` and deploy the storefront.
5. Release the desktop app.

## Checks

- `npm test` (repo root) covers routing, rendering, privacy and caching headers (`tests/storefront-*.test.ts`) and
  the cloud SQL on PGlite (`tests/commerce-sql.test.ts`).
- Burst test against a deployed store: `npx tsx storefront/scripts/burst.ts https://<address>.<domain> / /p/<id>
  --requests=2000 --concurrency=20` — reports latency and the edge cache mix (`cf-cache-status`); upstream share should
  stay under 5%. In Git Bash prefix the command with `MSYS_NO_PATHCONV=1` (it rewrites arguments that start with `/`).
- After editing anything in `public/`, update `ASSET_VERSION` in `src/assets.ts` (a test prints the new value).
- Page weight (`src/limits.ts`): home ≤ 60 KB with 48 cards (also with ordering on), CSS ≤ 20 KB, `storefront.js`
  ≤ 10 KB, `cart.js` ≤ 16 KB, `checkout.js` ≤ 10 KB.

## Render web service (deployment)

The service is described by `render.yaml` (repo root): web service `omnipos-storefront`, Root Directory
`storefront`, Node 22, `npm install --omit=dev` / `npm start` (`tsx server.ts`), health check `/healthz`, region
Frankfurt, Starter instance, auto-deploy only when `storefront/**` changes. It is billed as its own instance next to
the other services in the workspace.

Before deploying, the cloud migrations `2026-10-18_commerce_store_foundation.sql`, `2026-10-19_storefront.sql` and
`2026-10-19b_storefront_storage.sql` must be applied (then run `supabase/checks/2026-10-19_storefront_checks.sql`).
For ordering (003), apply `2026-10-21_retail_ordering_s1.sql` and run its checks file; don't re-run
`2026-10-19_storefront.sql` after it (the public functions' columns changed).

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
