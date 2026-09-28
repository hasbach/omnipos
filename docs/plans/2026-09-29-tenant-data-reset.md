# Tenant data reset ("Danger zone" in Settings)

Lets an admin wipe the current tenant's business data and start from zero, locally AND in the cloud, with
strong guards. Never touches other tenants, the license, users, settings, currencies or printers.

## Scopes (checkboxes; "Everything" preset ticks all four)
1. `transactions` — all sales, purchases, refunds and their history, live + archived: transactions,
   transaction_items, payments, archived_transactions, archived_transaction_items, archived_payments,
   cash_flow, archived_cash_flow, daily_reports, yearly_reports, cashier_shifts, transaction_edits,
   stock_adjustments. Every stakeholder of the tenant gets `balance = 0, balance_baseline = 0`
   (balances derive from transactions + baseline, see server/balance.ts).
2. `stock` — every product of the tenant gets `stock = 0` (products kept). Log nothing per product.
3. `products` — delete products, product_barcodes, product_units of the tenant. REQUIRES `transactions`
   (lines reference products) — server rejects otherwise with code `RESET_SCOPE_DEPENDENCY`.
4. `parties` — delete customers & suppliers (stakeholders) EXCEPT the tenant's default Walk-in customer
   (however the app identifies it today — check server/routes.ts / seedTenant; it must survive, balance 0).
   REQUIRES `transactions`.
Kept always: tenants row, users, settings, currencies, printers, user_logs (audit trail; add a log entry
"Tenant data reset" with the scopes and the backup file name).

## API
- `GET /api/tenant/reset/preview` → counts per scope for this tenant:
  `{ transactions: n (live+archived tx), products: n, parties: n (excl. walk-in), stock_units: sum(stock>0) }`
  and `cloud: { connected: boolean, hasSyncedData: boolean }`.
- `POST /api/tenant/reset` body `{ scopes: string[], confirm: "DELETE", admin_pin: string }`.
  - Validate: non-empty known scopes (`RESET_SCOPE_INVALID`), dependency rule, `confirm === "DELETE"`
    (`RESET_CONFIRM_REQUIRED`, field `confirm`), `admin_pin` matches a user of THIS tenant with
    `role = 'admin'` (`RESET_PIN_INVALID`, field `admin_pin`, status 403). Use the same PIN comparison the
    PIN login uses (plain or hashed — check).
  - **Backup first**: `await db.backup(<appDataDir>/backups/pos-before-reset-<tenantId>-<YYYYMMDD-HHmmss>.db)`
    (better-sqlite3 online backup; dir next to dbPath from server/db.ts; create it). If the backup fails →
    500 `RESET_BACKUP_FAILED`, nothing deleted. Return the backup path in the response.
  - **Cloud first, then local**: if this tenant has synced data locally (any row of its tables with
    `last_synced_at IS NOT NULL`) the reset must also remove the cloud copy, otherwise the next pull puts
    everything back. If `getActiveSession()` has no cloud session (offline / not logged in to cloud) and
    there is synced data → 409 `RESET_NEEDS_CLOUD` ("Connect to the internet and log in, then retry"),
    nothing deleted. Otherwise purge the cloud rows for the selected scopes (children first, as RLS tenant;
    reuse/extend `purgeCloudTransactionalData` in server/routes.ts — it covers transactions, items,
    payments, cash_flow, cashier_shifts; add daily_reports; for products: product_units (ignore a missing
    table error PGRST205/42P01), product_barcodes (by product_id in the tenant's product global_ids),
    products; for parties: stakeholders except the walk-in's global_id). If the cloud purge throws →
    502 `RESET_CLOUD_FAILED`, nothing deleted locally (cloud may be partially purged — say so in the
    message; retry is safe because it's idempotent).
    Stock zeroing and balance zeroing propagate by the normal push (the local UPDATE bumps updated_at).
  - Local deletion in ONE `db.transaction`, child tables first, all scoped to the tenant (items/payments via
    their transaction's tenant; barcodes/units via product tenant). Do not reset sqlite_sequence (shared by
    tenants).
  - Pause/skip the sync engine while resetting if there is a simple flag (check server/sync.ts for a
    running/lock variable); at minimum make sure no push happens between cloud purge and local delete
    (e.g. a module-level `resetInProgress` flag the sync loop checks).
  - Broadcast `PRODUCTS_UPDATED` and whatever event makes the POS/dashboard refetch (check existing
    broadcast types, e.g. after settlement).
  - Response `{ success: true, backup: "<path>", deleted: {per-scope counts} }`.

## UI — Settings → new section "Data reset" (danger zone; last item in the settings nav, red accent)
- Explanation text: what is deleted, what is kept, that a backup file is created automatically, that other
  registers keep their own local copy until they are reset or reinstalled (multi-register note).
- Four checkboxes with the live counts from the preview endpoint, "Select everything" shortcut; dependency
  auto-ticks `transactions` when products or parties are ticked (and disables unticking it).
- If `cloud.hasSyncedData && !cloud.connected`: warning banner, button disabled.
- Red "Delete selected data" button → modal: summary of what will be deleted with counts, admin PIN input
  (password type, numeric), a text input "Type DELETE to confirm", final red button enabled only when both
  filled. Inline field errors from the server codes. On success: toast with the backup path, refresh
  preview counts, and trigger app-wide refetch.
- Only visible to admins if the dashboard knows the current user role (check how other admin-only UI is
  gated); server enforces the PIN anyway.
- All strings en/ar/fr; error codes into translateServerError.

## Tests (tests/tenant-reset.test.ts)
Seed two tenants with products/units/barcodes, parties, sales, purchases, refunds, a settlement (archived
rows), cash flow. Reset tenant A with each scope combination: counts go to zero for A, tenant B untouched;
walk-in survives with balance 0; stock-only zeroes stock and keeps history; dependency rule; wrong PIN (403,
nothing deleted); missing confirm; backup file created (exists, opens, contains A's data); RESET_NEEDS_CLOUD
when rows have last_synced_at set and no session; after reset new sales work normally.
