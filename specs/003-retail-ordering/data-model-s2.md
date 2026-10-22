# Data model — B2C Retail Ordering, Slice 2 (online orders)

Builds on [data-model.md](data-model.md) (Slice 1). Order data is **cloud-authoritative**. Registers keep read-only
mirrors of `orders`, `order_lines` and `order_events` and never push them (research R13, R18).

## Cloud tables (migration `2026-10-23_retail_ordering_s2.sql`)

All synced tables have:
- `global_id uuid PK DEFAULT gen_random_uuid()`
- `tenant_id uuid NOT NULL REFERENCES tenants(global_id)`
- `created_at` / `updated_at timestamp DEFAULT now()`
- `deleted_at timestamp` (unused, kept for the sync shape)
- `synced_at timestamptz` with the `set_synced_at()` trigger and the `(tenant_id, synced_at, global_id)` index

RLS is on, with a single policy `FOR SELECT TO authenticated USING (tenant_id::text = auth.uid()::text)` and no
insert, update, delete or anon policy. Writes happen only through the functions in
[contracts/cloud-api-s2.md](contracts/cloud-api-s2.md).

### `orders`

| Column | Type | Rule |
|---|---|---|
| `store_id` | uuid → `stores(global_id)` | the store the order was placed on |
| `number` | integer | per store, from `order_counters`, starts at 1001; `UNIQUE (store_id, number)`; shown as `W-<number>` |
| `state` | text | `submitted` \| `confirmed` \| `ready` \| `completed` \| `rejected` \| `cancelled` \| `expired` (CHECK) |
| `cancelled_by` | text null | `customer` \| `shop` when `state = 'cancelled'` |
| `reason` | text null ≤ 300 | rejection / shop-cancel reason (required for those transitions) |
| `customer_name` | text 1–80 | as typed |
| `customer_phone` | text | normalised `+<8–15 digits>` |
| `fulfilment` | text | `pickup` \| `delivery` (must be enabled on the store at submit) |
| `address` | text null ≤ 300 | required when `fulfilment = 'delivery'` |
| `note` | text null ≤ 300 | |
| `local_currency` | text null | the store's local currency code at submit (null when none) |
| `local_rate` | numeric null | rate used for the local totals |
| `total_usd` / `total_local` | numeric(14,2) / numeric null | ordered totals, computed in the cloud (R14) |
| `confirmed_total_usd` / `confirmed_total_local` | numeric null | set at acceptance from the confirmed quantities |
| `sale_global_id` | uuid null | the POS sale that fulfilled the order (set by `order_complete`) |
| `sale_total_usd` | numeric null | that sale's final total (US5 AS3) |
| `submitted_at` | timestamptz | `now()` at submit |
| `expires_at` | timestamptz | `submitted_at + order_expiry_hours` (store setting, default 24) |
| `confirmed_at`, `ready_at`, `closed_at` | timestamptz null | `closed_at` = completed / rejected / cancelled / expired time |
| `idempotency_key` | text (UUID string) | `UNIQUE (store_id, idempotency_key)` |
| `status_key_hash` | text | hex SHA-256 of the browser-generated status key; `UNIQUE`; the key itself is never stored |
| `network_hash` | text | daily-rotating hash from the storefront (R12); used only for limits |

Indexes:
- `(store_id, customer_phone, submitted_at)`, for the phone limits;
- `(network_hash, submitted_at)`, for the network limits;
- `(tenant_id, state)`;
- the sync index.

**Effective state**: `submitted` with `expires_at < now()` is treated as `expired` by every reader, and is turned into
`expired` by `_orders_expire` (R17).

### `order_lines`

| Column | Type | Rule |
|---|---|---|
| `order_id` | uuid → `orders(global_id)` | |
| `line_no` | smallint | 1…50, `UNIQUE (order_id, line_no)` |
| `listing_id` | uuid | `store_listings.global_id` at submit (informational) |
| `product_id` | uuid null → `products(global_id)` | null only if the product row is later gone |
| `product_name` | text | listing title or product name as shown at submit (kept if the product changes) |
| `unit_key` | text | `base` or `product_units.global_id` as text (Slice 1 unit keys) |
| `unit_name` | text | unit name at submit (base unit: the product's unit label) |
| `unit_factor` | numeric | contents in base units (1 for base) |
| `ordered_qty` | numeric | > 0, ≤ 999; integer unless base unit of a measured product (≤ 3 decimals) |
| `confirmed_qty` | numeric null | set at acceptance; 0 ≤ confirmed ≤ ordered |
| `shortfall_reason` | text null | `out_of_stock` \| `damaged` \| `customer_request` \| `other`; required when confirmed < ordered |
| `unit_price_usd` | numeric(14,2) | quoted retail price of the unit at submit |
| `unit_price_local` | numeric null | the unit's `price_lbp` when > 0, else `round(usd × local_rate)`; null without a rate |
| `line_total_usd` / `line_total_local` | numeric | `round(price × qty, 2)` / `round(local × qty)` (ordered quantities) |

### `order_events` (history)

| Column | Type | Rule |
|---|---|---|
| `order_id` | uuid → `orders` | |
| `at` | timestamptz | `clock_timestamp()` |
| `kind` | text | `submitted` \| `confirmed` \| `adjusted` \| `ready` \| `rejected` \| `cancelled` \| `expired` \| `completed` \| `completion_undone` |
| `from_state` / `to_state` | text | |
| `actor_kind` | text | `customer` \| `user` \| `system` |
| `actor_name` | text null | user's name (owner actions) |
| `terminal` | text null | register id (owner actions) |
| `reason` | text null | |
| `detail` | jsonb null | per-line changes `[{line_no, ordered, confirmed, reason}]`, sale id, totals |

### Private tables (RLS on, no policy; functions only)

| Table | Columns | Purpose |
|---|---|---|
| `order_counters` | `store_id uuid PK`, `last_no int` | per-store order numbers (R15) |
| `order_blocked_phones` | `tenant_id`, `store_id`, `phone` (normalised), `note ≤ 120`, `created_at`; `PK (store_id, phone)` | FR-041 blocked list (R25) |
| `storefront_gateway_keys` | `key_hash text PK`, `label`, `created_at`, `revoked_at` | gateway key hashes (R12) |

### Existing cloud tables

- `transactions` gains `order_global_id uuid null` (no foreign key: the order and sale are written by different
  paths).
- `stores.settings` JSON gains `order_expiry_hours` (default 24, set by `_store_public_settings` like the other
  defaults).

## State machine (FR-024, 001 subset)

```text
submitted ──accept──▶ confirmed ──ready──▶ ready ──complete──▶ completed
    │                     │  └────────────complete──────────────▲
    │                     └──cancel(shop, reason)──▶ cancelled
    ├──reject(reason)──▶ rejected          ready ──cancel(shop, reason)──▶ cancelled
    ├──cancel(customer)─▶ cancelled
    └──(expires_at passed)──▶ expired
completed ──complete_undo(same sale id)──▶ previous state (confirmed or ready)  [compensation only, R20]
```

- Accept sets every line's `confirmed_qty`. Lines left out are confirmed at their ordered quantity. All lines at 0 is
  refused with `all_zero` (use reject instead).
- "Adjust" is part of accept, and happens only in state `submitted`. After acceptance, quantities change only through
  the POS sale (US5 AS3).
- Any other transition returns `invalid_transition`. An action against a state that changed under the user returns
  `handled` with the current state.
- No transition changes stock, invoices, payments or balances (FR-038).

## Local SQLite mirrors (`server/db.ts`)

`orders`, `order_lines` and `order_events` have the same columns as the cloud, with these differences:
- `id INTEGER PK` (local) plus the standard sync columns from the metadata loop.
- Foreign keys are translated on pull through `fkMap`:
  - `orders.tenant_id → tenants`, `orders.store_id → stores`;
  - `order_lines.tenant_id → tenants`, `order_lines.order_id → orders`, `order_lines.product_id → products`
    (null when the product isn't local);
  - `order_events.tenant_id → tenants`, `order_events.order_id → orders`.
- These stay as global-id text: `sale_global_id`, `unit_key`, `listing_id`.
- No local foreign-key constraints, because rows may arrive in any order.
- `network_hash`, `idempotency_key` and `status_key_hash` are cloud-only. The pull selects `*`, so they arrive with
  the row, but they have no local column and `dropUnknownLocalColumns` drops them, so they are never stored locally.
  Owner RPC results already exclude them.

The mirrors are written only by the pull and by applying rows returned from an owner RPC. They are members of
`CLOUD_AUTHORITATIVE`, so the cloud row always overwrites the local one.

## Local `transactions` / `archived_transactions`

- New column `order_global_id TEXT`, added to both tables by the existing column loops.
- `CREATE UNIQUE INDEX idx_transactions_order ON transactions(order_global_id) WHERE order_global_id IS NOT NULL`. The
  completion path also checks `archived_transactions`.
- It is added to the settlement `INSERT … SELECT` column list, to `TX_LIVE_COLUMNS` / `TX_ARCHIVED_COLUMNS`, and to
  `OPTIONAL_CLOUD_COLUMNS.transactions`, so it is pushed once the cloud has it.

## Store settings (`stores.settings` JSON, local + cloud)

| Key | Type | Default | Rule |
|---|---|---|---|
| `ordering_mode` | `'off' \| 'whatsapp' \| 'online'` | `'off'` | `online` now accepted; needs pickup or delivery on (WhatsApp optional) |
| `order_expiry_hours` | integer | 24 | 1–72 |

The Slice 1 keys are unchanged.

## Browser state (visitor's device only)

- **My orders**: `localStorage["sf-orders:v1:<address>"]` = `{ v: 1, orders: [{ number, key, at, state }] }`, newest
  first, ≤ 20 entries. `state` is the last state seen on the status page.
- **Checkout attempt**: `localStorage["sf-attempt:v1:<address>"]` = `{ key: <uuid>, status: <32-char key>, cart: <hash
  of lines> }`. New keys are made when the cart hash changes. The entry is cleared after a successful submit; the
  status key then lives on in My orders.
- **Register mute**: `localStorage["omnipos.orders.mute"]` = `"1"` on registers that muted the tone.
