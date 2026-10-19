# Quickstart — validating Slice 1 (WhatsApp order)

## 1. Automated

```bash
npm test
```

In a `.claude/worktrees/*` checkout `npm test` can't switch the native module: run `npm rebuild better-sqlite3` in the
main checkout, then `npx tsx --test tests/*.test.ts` here, then `npm run rebuild` in the main checkout.

Expect green, including `storefront-cart`, `storefront-render`, `storefront-routing`, `commerce-store`,
`commerce-listings` and `commerce-sql` (migration `2026-10-21_retail_ordering_s1.sql` on PGlite). Also
`npx tsc --noEmit` (no new errors), `npm run build`, `npm run build:server`.

## 2. Local storefront (no cloud)

```bash
npx tsx storefront/dev-server.ts --source=fixture --ordering
```

(or the `storefront-fixture-ordering` launch configuration). Open `http://localhost:3200/s/beirut-market` at 360 px
wide and in ar/fr/en:

1. Add a product from a card and another in a pack unit from its product page → badge counts, confirmation shown.
2. Open `/s/<address>/cart` → lines, totals in USD + LL, notes; change quantities, remove a line; reload and restart the
   browser → cart kept. A second store keeps its own cart.
3. Fill name, choose delivery without address → blocked with a message; add the address → WhatsApp opens with the
   message of [storefront-routes.md](contracts/storefront-routes.md#whatsapp-message-store-default-language-example-in-english).
4. Come back → "Did you send the order?" → No keeps the cart, Yes empties it.
5. Below the minimum order / below a listing minimum → submit disabled with the remaining amount.
6. Fixture store with ordering off (run without `--ordering`) → pages identical to 002 (no cart link, no controls, no `cart.js`); `/cart` → 302
   to the home.
7. Disable JavaScript → controls hidden, cart page shows the `noscript` message and contact buttons.

## 3. Real devices (after deploy)

On Android Chrome (WhatsApp app), iOS Safari (WhatsApp app) and a desktop browser (WhatsApp Web): send a 50-line cart
with Arabic product names and an Arabic note → the full message arrives in WhatsApp. Record results in
`validation.md`.

## 4. Back office + cloud (test business only — never a customer tenant on the dev PC)

1. Apply `supabase/migrations/2026-10-21_retail_ordering_s1.sql`, run its checks file.
2. In a register signed into a **test** business: Settings → Online store → Ordering = "Order on WhatsApp" without a
   WhatsApp number → refused; add the number, pickup on, delivery on with an area, minimum 10 USD → saved.
3. Product → Online store: restrict a product to its pack unit, minimum 6 → within 5 minutes the storefront offers only
   the pack and enforces the minimum.
4. Burst test from 002 (`storefront/scripts/burst.ts`) on the store home and a product page → upstream share still
   < 5%; `cf-cache-status: HIT` on the second request; two different browsers with different carts get the same cached
   page.
5. Turn ordering Off → within 5 minutes the storefront is back to the 002 look.
