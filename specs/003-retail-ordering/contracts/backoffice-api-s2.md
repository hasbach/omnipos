# Contract: back-office API for Slice 2 (local Express server)

This extends [backoffice-api.md](backoffice-api.md) (Slice 1).

All routes are scoped to `req.session.tenantId`. Failures throw `ValidationError` with `{ error, code, field }`. Codes
start with `ORDER_` and are translated through the commerce prefix in `src/lib/serverErrors.ts`. Every route has a
`ROUTE_RULES` entry.

## Reads (from the local mirror; work offline)

| Route | Permission | Response |
|---|---|---|
| `GET /api/orders?state=&store=&from=&to=&q=` | `orders.view` | `{ rows: [{ id, global_id, store: {id, name}, number: 'W-1042', state, effective_state, submitted_at, customer_name, customer_phone, fulfilment, total_usd, total_local, confirmed_total_usd, local_currency, line_count }], online: boolean, last_pull_at }` |
| `GET /api/orders/summary` | `orders.view` | `{ submitted: n, open: n }`, used for badges (`submitted` excludes overdue orders) |
| `GET /api/orders/:id` | `orders.view` | `{ order: {…all mirror fields}, lines: [{…, local_product: {id, name, stock, unit} \| null, local_unit: {id, name, factor} \| 'base' \| null}], events: [...], sale: {id, total_amount} \| null, matched_customer: {id, name} \| null, actions: { accept, reject, ready, cancel, complete } }` |

Notes on the reads:
- `GET /api/orders` sorts submitted orders first (oldest first), then the rest by `submitted_at` descending. `q`
  matches the number, name or phone.
- `effective_state` is `expired` when `state = 'submitted'` and `expires_at < now`.
- In the detail response, `actions` reflects the state, the user's permissions and `online` (the session status). The
  UI disables buttons from it, and the server re-checks on POST.

## Actions (cloud RPC, online only)

| Route | Permission | Body | Cloud function |
|---|---|---|---|
| `POST /api/orders/:id/accept` | `orders.manage` | `{ expected_state, lines: [{ line_no, confirmed_qty, reason? }] }` | `order_accept` |
| `POST /api/orders/:id/reject` | `orders.manage` | `{ expected_state, reason }` | `order_reject` |
| `POST /api/orders/:id/ready` | `orders.manage` | `{ expected_state }` | `order_ready` |
| `POST /api/orders/:id/cancel` | `orders.manage` | `{ expected_state, reason }` | `order_cancel_by_shop` |

Each action:
1. validates the body locally: quantities ≥ 0 and ≤ ordered, reason required when a line is reduced or for
   reject/cancel, reason ≤ 300;
2. calls the RPC with `p_actor = { name: user.name, terminal: terminalId }` through `withTimeout(10 s)`;
3. on `ok`, writes the returned order, lines and the new events into the mirror, then broadcasts `ORDERS_UPDATED`;
4. responds `{ order, lines }`.

| Outcome | Code | Status |
|---|---|---|
| no session / timeout / network | `ORDER_NEEDS_ONLINE` | 503 |
| `handled` | `ORDER_ALREADY_HANDLED` (+ `state`, and the mirror is updated with the returned row) | 409 |
| `expired` | `ORDER_EXPIRED` | 409 |
| `invalid_transition` | `ORDER_INVALID_TRANSITION` | 409 |
| `confirm_exceeds` | `ORDER_CONFIRM_EXCEEDS` (field `lines[i]`) | 400 |
| `reason_required` | `ORDER_REASON_REQUIRED` (field `reason` or `lines[i]`) | 400 |
| `all_zero` | `ORDER_ALL_ZERO` | 400 |
| `not_found` | `ORDER_NOT_FOUND` | 404 |
| other RPC error | `ORDER_CLOUD_FAILED` | 502 |

## Sale from an order

### `GET /api/orders/:id/sale-draft`

Permission: `orders.view` and the POS sale permission. The response feeds `newSaleTabFromOrder()`:

```json
{ "order_global_id": "…", "number": "W-1042",
  "stakeholder_id": 12,
  "lines": [{ "product_id": 5, "uom_id": null, "quantity": 4, "unit_price": 12.5 }],
  "skipped": [{ "line_no": 3, "product_name": "…", "reason": "product_deleted" }],
  "converted": [{ "line_no": 2, "reason": "unit_removed" }] }
```

Rules:
- Only `confirmed` and `ready` orders qualify; anything else returns `ORDER_NOT_COMPLETABLE` (409).
- An order that already has a sale, live or archived, returns `ORDER_ALREADY_COMPLETED` (409).
- `stakeholder_id` is the single customer whose phone matches (research R24), otherwise Walk-in.

### `POST /api/transactions` (extended)

The existing body accepts an optional `order_global_id`. When it is present:
- **Permissions:** the existing sale rule applies, plus `orders.view`.
- **Order check:** the order must exist in the mirror for this tenant, with an effective state of `confirmed` or
  `ready`, and no transaction, live or archived, may carry the same `order_global_id`. Otherwise the request fails
  with `ORDER_ALREADY_COMPLETED` / `ORDER_NOT_COMPLETABLE`.
- **Line pricing:** a sale line that matches an order line (same product, and the same unit or its base conversion)
  with quantity ≤ the confirmed quantity is priced at the order's `unit_price_usd`, converted to the line's unit. This
  happens on the server, without the price-override setting. All other lines and changes follow the normal rules.
- **Sale type:** it must be a sale (`type` absent or `'sale'`) and not a refund.
- **Commit:** after the existing validation passes, the server:
  1. requires a session;
  2. pre-generates `global_id`;
  3. calls `order_complete(order, global_id, total_amount, actor)` with a 10 s timeout;
  4. commits the transaction with that `global_id` and `order_global_id`.

  If step 4 throws, it calls `order_complete_undo` (best effort, logged).
- **Responses:**
  - success: the usual body plus `{ order: { number, state: 'completed' } }`; also broadcasts `ORDERS_UPDATED`.
  - offline: `ORDER_NEEDS_ONLINE` (503); nothing is written.
  - `handled`: `ORDER_ALREADY_COMPLETED` (409); nothing is written, and the mirror is refreshed from the returned row.

Without `order_global_id`, behaviour is byte-identical to today.

## Store settings and blocked phones

These extend `PUT /api/commerce/stores/:id`, which needs `store.manage`:
- `settings.ordering_mode` now accepts `online`, which needs pickup or delivery on
  (`STORE_ORDERING_NEEDS_FULFILMENT`). `ORDERING_MODE_UNAVAILABLE` is no longer thrown.
- `settings.order_expiry_hours`: an integer from 1 to 72. Anything else returns `STORE_ORDER_EXPIRY_INVALID`.

| Route | Permission | Cloud function |
|---|---|---|
| `GET /api/commerce/stores/:id/blocked-phones` | `orders.manage` | `order_blocked_phones` → `{ rows: [{ phone, note, created_at }] }` |
| `POST /api/commerce/stores/:id/blocked-phones` `{ phone, note? }` | `orders.manage` | `order_block_phone` (`ORDER_PHONE_INVALID`) |
| `DELETE /api/commerce/stores/:id/blocked-phones/:phone` | `orders.manage` | `order_unblock_phone` |

All three are online only; offline returns `ORDER_NEEDS_ONLINE`.

## WebSocket messages

| Type | Payload | Sent when |
|---|---|---|
| `ORDERS_UPDATED` | `{ newSubmitted: n, changed: n }` | after a pull changed order rows (via `onPulled`), and after every action or completion |

## Permissions (`server/permissions.ts` + `src/lib/permissions.ts`)

- New group: `{ area: 'orders', keys: ['orders.view', 'orders.manage'] }`.
- Defaults: admin and manager get both keys. Cashier, staff and accountant get `orders.view`. Stored role maps gain
  the defaults on first read.
- Page `onlineOrders` → `['orders.view']`, with a sidebar item and a badge.
- i18n: `perm_area_orders`, `perm_orders_view`, `perm_orders_manage` (en/ar/fr).

## UI surfaces

- **Back office:**
  - "Online orders" page: the list with state chips, store filter, date range and search, plus the detail drawer.
    The drawer shows customer and fulfilment, lines with local stock, history, and actions: accept (per-line
    confirmed quantity and reason), reject, ready, cancel, block phone, WhatsApp / Call customer.
  - An offline banner is shown when the session is not ok.
- **POS window:** an "Online orders" button with a badge in the header. It opens a drawer with confirmed and ready
  orders first, and a "Complete sale" action that opens a pre-filled sale tab titled with the order number. The tab
  shows any skipped or converted lines in a warning.
- **Settings → Online store → Ordering:**
  - the "Online orders" option in the mode selector;
  - "Orders expire after (hours)";
  - "Blocked phones" (list, add, remove; online only).
- **Notifications:** a toast, a tone and a badge (research R21), plus a mute toggle on the Online orders page.
