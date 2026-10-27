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
- [x] §1.5 Network header (2026-10-27, after the merge deployed the storefront): the Render log reports
      `network source: CF-Connecting-IP`, so per-network limits see each visitor's own address.

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

**Upgrade dry run (2026-10-27, `main` b2e2199):** `scripts/commerce-dryrun.ts` on a temp copy of the same real customer
database used for 1.9.0 (3 tenants, 32 parties). The copied cloud sign-in (1 row) was deleted from the work copy first
and network calls were disabled, so nothing reached the cloud. Result: all 98 measured values unchanged (counts, stock,
invoice totals, payments, 32 balances); no commerce rows created; `orders` / `order_lines` / `order_events` created
empty; `order_global_id` on live and archived sales, unset. The original file's SHA-256 was the same before and after;
the work copy was deleted.

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

## §4. End-to-end on a test store (cloud + two registers) — partly done

Only on a **test** business, never a customer tenant on the dev PC. 2026-10-27, after PR #5 was merged and deployed:
one register (`npm run dev` on the dev PC, signed in to the test business "test store", store `teststore`) and the
live storefront `teststore.myomnipos.com` opened from the same PC (made-up customer name and phone).

| Step | Result | Timing |
|---|---|---|
| 1 Turn on Online orders (expiry 1 h) → storefront shows "Review order" | ✔ setting in the cloud 5 s after saving; the live cart already ran in online mode with the new scripts | < 1 min |
| 2 Order → register sees it | ✔ W-1001 placed 09:19:09 UTC (cloud quote and submit through the gateway key); the register had it at the first check. Toast/tone, a second register and mute not checked | ≈ 10 s |
| 3 Accept → phone shows Accepted | ✔ accepted (no change); live status page "Accepted, Confirmed 1" at once. **Found and fixed:** the cloud's reply has no `tenant_id` on lines, so the register dropped them until the next pull (the open drawer showed "—" for the confirmed quantity); second register not checked | status: immediate |
| 4 WhatsApp the customer (accepted message, store language) | | |
| 5 Complete the sale | ✔ POS drawer → tab "Sale W-1001" at the order price → Quick Cash: transaction #191, stock 50 → 49; cloud order `completed` with `sale_global_id` = the transaction's `global_id`, history submitted → confirmed → completed, the sale pushed to the cloud with its `order_global_id`; a second completion refused (409); live status page "Completed". Mixed USD/LBP payment, receipt and second register not checked | |
| 6 Reject with a reason → phone shows it | ✔ (installed 1.10.0) W-1002 rejected "Out of stock today, sorry"; status page shows Rejected + reason; history shows `rejected` after the next pull | order → register ≈ 31 s |
| 7 Expiry after 1 h → Expired on phone and both registers | not run | |
| 8 Offline register B → read-only list, POS still sells | not run | |
| 9 Abuse limits: 4th order refused; blocked phone refused | ✔ phone `70 000 020`: W-1003–W-1005 created, the 4th refused `phone_limit`; W-1002's phone blocked from the order panel (cloud row `+96170000010`, note `W-1002`), a new order written `+961 70 000 010` refused `refused`. Customer cancel from the status page: W-1003–W-1005 "You cancelled this order" | |
| 10 End of Day → sale archived with `order_global_id`, link kept | ✔ W-1006 accepted (confirmed quantity shown at once — PR #6 fix in the release), marked ready, completed as sale #48 paid $500,000 cash + $73,000 card (posted with the POS request shape; the POS screen itself was checked with W-1001), stock 49 → 48, a second completion refused 409. End of Day (whole day, expected $1,073,000 = counted): both order sales archived on the register with `order_global_id`; the cloud orders stay `completed` (history submitted → confirmed → ready → completed). As always, settlement removes the settled sales from the cloud's live `transactions` (the archive is local), so `sale_global_id` then points to the register's archive | |

**Release 1.10.0 on the installed app (2026-10-27).** The PC's installed 1.5.0 was updated to 1.10.0 by hand: the
automatic offer never appeared. Cause: the update check runs once, 10 s after launch, and its result goes to a
listener in the POS hook, which only mounts after the business sign-in and the PIN, so it is usually lost (all versions).
Before updating, 1.5.0 had been signed in to the test business and pushed a duplicate Admin, USD, Walk-in and
`store_name` (seed-before-pull, fixed in 1.7.7); cleanup SQL given to the owner.