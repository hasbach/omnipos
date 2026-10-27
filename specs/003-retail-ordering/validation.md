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

---

# Validation — Slice 2 (online orders)

Branch `003-retail-ordering-s2` (not merged). Steps refer to [quickstart-s2](quickstart-s2.md).

## §1. One-time setup (owner)

- [x] Migration `2026-10-23_retail_ordering_s2.sql` applied by the user 2026-10-23; the checks file was then verified
      read-only: RLS and policies, privileges, the 19 function grants, `transactions.order_global_id`, the
      `order_expiry_hours` default, triggers.
- [x] Gateway key generated with `node scripts/gateway-key.mjs`; only its hash inserted into `storefront_gateway_keys`
      (1 live row, checked via table statistics because the read-only role can't see RLS-only rows).
- [x] `ORDER_GATEWAY_KEY` set on the Render service `omnipos-storefront` (2026-10-23). It takes effect at the next
      deploy, i.e. when this branch is merged to `main`.
- [ ] §1.5 Network header: after that deploy, read the one-time `network source: …` log line on Render at the first
      order. `socket` means every visitor counts as one network: fix the header choice before going live.

## §2. Automated checks (2026-10-27)

| Check | Result |
|---|---|
| `npm test` | 592 / 592 pass (baseline before Slice 2: 497) |
| `npx tsc --noEmit` | 0 errors (same as the T001 baseline) |
| `npm run build` | ok (the existing chunk-size warning only) |
| `npm run build:server` + `node --check dist-server/server.js` | ok |
| `tests/orders-sql.test.ts` | 14 tests on PGlite: migration run twice, gateway refusal, SC-004 prices, SC-008 duplicate attempts, SC-009 limits, transitions, SC-006 first action wins, expiry sweep, public view privacy, grants |
| `orders-sync`, `orders-routes`, `orders-sale` | mirror sync and deferral, routes and permissions, SC-007 (an order sale equals the same sale typed by hand in USD, LBP and mixed, live and settled), refusals, compensation |
| Storefront suites | `storefront-orders`, `storefront-order-js` and the existing `storefront-*` (101 tests, key parity en/ar/fr) |
| Back-office locale `orders.ts` | 92 keys in each of en/ar/fr; none missing, empty, or left in Latin script in Arabic |

## §3. Storefront against the fixture (no cloud)

| Step | Result |
|---|---|
| 1–2 Review and place an order (Phase 3 review, 2026-10-23, en/ar/fr) | quote listed the lines; W-1001 and a link; listed under My orders |
| 2 Arabic cart, order and status page (2026-10-27) | all labels Arabic (English only in the shop's own data). **Found and fixed:** the status link and the My orders links dropped `?lang=`, so an Arabic shopper landed on a status page in the store's default language |
| 4 Cancel | covered by `storefront-orders` (redirect keeps `lang`, result flag) |
| 3 Retry safety, 5 WhatsApp fallback, 360 px widths, response headers | covered by `storefront-order-js` / `storefront-orders`; not re-run by hand |
| 6 WhatsApp-mode and off stores unchanged | covered by `storefront-orders` |

Back office and POS on the preview server (seeded orders, fake cloud session, 2026-10-27): list and badge, accept
with a reduced line and reason, complete W-1003 at the POS as cashier (paid $10 + 984,500 LBP; transaction #223
linked; stock down; second completion refused; back office shows the sale), blocked phones add / remove / block
from an order, Arabic RTL. The fake cloud doesn't write order history or recompute confirmed totals.

## §4. End-to-end on a test store (cloud + two registers) — to do

Only on a **test** business, never a customer tenant on the dev PC. Needs the merge (storefront deploy) and a
desktop build of this branch on two registers.

| Step | Result | Timing |
|---|---|---|
| 1 Turn on Online orders (expiry 1 h) → storefront shows "Review order" | | ≤ 5 min expected |
| 2 Order from a phone → toast + tone on A and B, badge 1; muted B shows the toast silently | | notification delay: |
| 3 Accept with a change on A; B refused as already handled; phone shows Accepted with 4 | | status delay: |
| 4 WhatsApp the customer (accepted message, store language) | | |
| 5 Complete the sale on A (45 USD cash + LBP); stock, receipt, Completed + link; B refused | | |
| 6 Reject with a reason → phone shows it | | |
| 7 Expiry after 1 h → Expired on phone and both registers | | |
| 8 Offline register B → read-only list, POS still sells | | |
| 9 Abuse limits: 4th order refused; blocked phone refused | | |
| 10 End of Day → sale archived with `order_global_id`, link kept, totals equal a hand-typed sale | | |