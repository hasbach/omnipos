# Quickstart: validating Slice 2 (online orders)

The contracts give the details: [cloud-api-s2](contracts/cloud-api-s2.md),
[storefront-routes-s2](contracts/storefront-routes-s2.md) and [backoffice-api-s2](contracts/backoffice-api-s2.md).
Never sign the dev PC into a customer tenant. Use a **test** business only.

## 1. One-time setup (owner)

1. **Apply the migration.** Run `supabase/migrations/2026-10-23_retail_ordering_s2.sql` in the Supabase SQL editor,
   then run it a second time. Running it twice must not fail, because the migration is designed to be re-runnable.
   Then run `supabase/checks/2026-10-23_retail_ordering_s2_checks.sql`. Every check should report its expected
   result. The gateway-key count will be 0 until step 3.
2. **Generate the gateway key.** Run `node scripts/gateway-key.mjs` locally. It prints a key and its SHA-256.
3. **Store the hash in Supabase.** In the SQL editor, run
   `INSERT INTO storefront_gateway_keys (key_hash, label) VALUES ('<sha256>', 'render-YYYY-MM')`. Re-run the checks;
   the key count is now 1.
4. **Give Render the key.** Add the env var `ORDER_GATEWAY_KEY` to the `omnipos-storefront` service on Render (it is
   declared `sync: false` in `render.yaml`) and redeploy.
5. **Confirm the network header.** Find out which header carries the visitor's address on Render: open the logs and
   look for the single "network source: CF-Connecting-IP | True-Client-IP | X-Forwarded-For(last) | socket" line that
   the storefront writes at the first order request. If it says `socket`, per-network limits count every visitor as
   one network. In that case fix the header choice before going live.

## 2. Automated checks

```bash
npm test
```

Expect all of these to pass:
- `orders-sql`: the migration on PGlite, run twice. This suite covers:
  - gateway refusal without a key;
  - SC-004: altered browser prices never stored;
  - SC-008: duplicate attempts give one order;
  - SC-009: limits refused beyond 5/hour and 3 New; three orders a day are always accepted;
  - every state transition and refusal;
  - SC-006: first action wins;
  - expiry through the sweep;
  - the public view hides phone and note;
  - grants.
- `orders-sync`, `orders-routes`, and `orders-sale` (SC-007: order sale = hand-typed sale, live and settled).
- `storefront-orders` and `storefront-order-js`.
- The existing `storefront-*`, `commerce-*`, `permissions` and `multi-tenant-isolation` suites.

Also run these; they must succeed with no new errors:
- `npx tsc --noEmit`
- `npm run build`
- `npm run build:server` followed by `node --check dist-server/server.js`

## 3. Storefront against the fixture (no cloud)

```bash
npx tsx storefront/dev-server.ts --source=fixture --ordering=online
```

The fixture source uses an in-memory fake gateway that implements the four public functions with the same codes.
Test at 360 px wide, in en, ar and fr:

1. **Review.** Fill the cart, open the cart page and choose "Review order". The quote lists the lines. Change a
   fixture price between add and review: the changed line is highlighted and "Place order" uses the new price.
2. **Place the order.** You get W-1001 and a link, and the order appears under My orders. Reload the status page: it
   says "waiting", the response headers are `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`, and the
   page sets no cookie.
3. **Retry safety.** Repeat the same submit, simulating a lost response with the dev "drop next response" switch.
   You get the same number and the link works.
4. **Cancel.** Cancel from the status page. It then says "cancelled by you".
5. **Fallback.** Set the fake gateway to "unavailable". The cart is kept and "Send on WhatsApp instead" opens the
   Slice 1 message.
6. **Unaffected stores.** A WhatsApp-mode store and an off store render exactly as before.

## 4. End-to-end on a test store (cloud + two registers)

Use two registers (A and B) signed into the **test** business and the store's address on `myomnipos.com`.

1. **Turn on Online orders.** On A, go to Settings → Online store → Ordering → Online orders, set pickup and delivery
   on and expiry to 1 hour, and save. Within 5 minutes the storefront shows "Review order".
2. **Place an order from a phone** (pickup, phone `71 315 744`). Within 1 minute, A and B show a toast with a tone,
   and the badge reads 1. Mute B and place another order: B shows the toast silently.
3. **Accept with a change.** On A, open the order, lower one line from 6 to 4 with "Out of stock", and accept. On B,
   accept the same order a moment later: B is told it was already handled, and the detail now shows Accepted. On the
   phone, the status page shows Accepted with 4 within 1 minute.
4. **WhatsApp the customer.** Tap "WhatsApp customer". The message is pre-filled for the accepted state in the store
   language.
5. **Complete the sale.** In A's POS window, open Online orders and choose Complete sale. A tab "W-1001" opens with
   the confirmed lines at the quoted prices and the customer matched by phone (or Walk-in). Pay 45 USD in cash and
   the rest in LBP, then finish the sale.
   - The stock goes down.
   - The receipt prints.
   - The order shows Completed, linked to the sale.
   - On B, try to complete it: refused.
6. **Reject.** Reject an order with a reason. The phone shows Rejected and the reason.
7. **Expiry.** Leave an order unanswered for over an hour. It shows Expired on the phone and on both registers.
8. **Offline register.** Unplug B's network and open Online orders. The list is read-only with the offline message,
   and selling at the POS still works.
9. **Abuse limits.** Place 4 orders with the same phone within an hour without answering them. The 4th is refused as
   "too many orders". Block that phone in settings: the next order is refused.
10. **Settlement.** Run End of Day on A. Then check that the completed order's sale is archived with its
    `order_global_id`, the order still links to it, and the totals and balances equal the same sale typed by hand.

Record the results and timings (notification delay, status delay) in `validation.md`, under "Slice 2".
