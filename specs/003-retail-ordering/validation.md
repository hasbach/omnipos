# Validation — B2C Retail Ordering, Slice 1 (WhatsApp order)

Results of [quickstart.md](quickstart.md) §1–2 for branch `003-retail-ordering` (tasks T001–T037). Recorded
2026-10-20 on the dev PC. §3–4 (real phones, cloud, deployment) are still to do — see the end.

## 1. Automated suite and gates

| Gate | Result |
|---|---|
| Full suite (`tests/*.test.ts`, worktree workaround of quickstart §1) | 493 / 493 pass |
| `npx tsc --noEmit` | 0 errors |
| `npm run build` / `npm run build:server` (+ `node --check dist-server/server.js`) | all succeed (Vite chunk-size warning only, as before) |

New for 003: `storefront-cart` (18: cart logic, page wiring, checkout rules, WhatsApp message, "sent?" flow, remembered
details, no network), `storefront-render` (+10: controls only with ordering on, unit data, cards, escaping, identical
pages, cart page, checkout markup, message language, ar/fr labels), `storefront-routing` (+2: budgets with ordering
on, cart route headers), `commerce-sql` (+6 on PGlite: migration `2026-10-21_retail_ordering_s1.sql`, settings
defaults and clean-up, unit-key filtering incl. legacy integer ids, preview, privileges, the checks script),
`commerce-store` (+4: ordering settings rules), `commerce-listings` (+3: unit keys, legacy input, startup conversion).

## 2. Local end-to-end (no cloud)

Storefront dev server with the ordering fixture (`--source=fixture --ordering`), 375 px:

| Step | Result |
|---|---|
| Product page: unit picker + quantity + "Add to cart", only orderable units | OK (pack-only product has no piece option) |
| Add a pack (×2) and 1.25 kg of a by-the-kg product; badge | OK, badge 2 → 3 after a card "Add" |
| Cart page: lines, steppers, totals in USD + LL, notes | OK; Arabic RTL with amounts kept left-to-right (fixed during phase 3) |
| Card images on phones | were 400 px tall (002 bug: `height` attribute beat `aspect-ratio`) — fixed in phase 3 |
| Checkout: empty submit → "Required." under name and fulfilment | OK |
| Delivery → address field appears; note counter | OK (10/300) |
| WhatsApp message (window.open stubbed) | exact: lines, `$25.38 · 2,271,063 LL`, delivery address, name, phone, note, confirmation line |
| Fallback "If WhatsApp didn't open" link, "Did you send the order?" on return (Arabic) | OK; No keeps the cart |
| Console errors / sideways scroll | none |

Back office on the preview server (demo data):

| Step | Result |
|---|---|
| Ordering card: WhatsApp mode without a store number | warning shown; save refused (`STORE_ORDERING_NEEDS_WHATSAPP`) |
| Number added; WhatsApp mode, pickup note, delivery on + area, minimum $10 saved through the card | stored exactly as entered |
| Product restricted to its pack, minimum 6 | storefront offers only the pack (by unit global id), "Minimum order: 6 pcs." |
| Out-of-stock product | no order form, contact buttons stay |
| Product tab: orderable units | "Only these units" with pack checked, piece unchecked; minimum shows 6 |

## 3. Still to do (needs the user / deployment)

- [x] Applied `supabase/migrations/2026-10-21_retail_ordering_s1.sql` and its checks file (user, 2026-10-20). Verified
      read-only afterwards: the three public functions return the new columns (`ordering_mode` … `min_order_usd`,
      `base_orderable`) and stay anon-callable; `_store_public_settings`, `_store_setting_on`, `_store_orderable_keys`
      are not callable by anon/authenticated; one version of each function; allow-list clean; the live storefront
      (pre-003 code) renders `teststore` uncached (200, 12 products). Don't re-run `2026-10-19_storefront.sql` afterwards.
- [ ] Deploy the storefront (Render service tracks its branch; safe before or after the migration — ordering simply
      stays off until the fields exist).
- [ ] Desktop release with the back-office changes (Ordering card, orderable units, startup conversion of unit ids).
- [ ] Quickstart §3 on real devices: Android + WhatsApp app, iPhone + WhatsApp app, desktop + WhatsApp Web; a 50-line
      cart with Arabic names and note arrives complete.
- [ ] Quickstart §4 on a **test** business only (never a customer tenant on the dev PC): settings → storefront within
      5 minutes; burst test still < 5% upstream with ordering on.
