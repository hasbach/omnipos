# Settlement detail, admin corrections, "changed after closing" warning

## Problems in the current code (verified)
- `POST /api/tenant/settlement` (server/routes.ts ~561) takes no body and never writes `daily_reports`; the client
  (`src/pages/Settlement.tsx` ~256-317) first POSTs `/api/reports/daily` with numbers it computed from
  `/api/cash-flow/summary`, then calls settlement. Not atomic, values trusted from the client.
- Archived rows have NO link to the settlement that archived them (only `archived_at`).
- Counted cash is one USD number (`actual_balance`); per-currency counts only survive as text in `notes`
  ("... [Breakdown: 120 USD, 500000 LBP]").
- `total_refunds` is sent but dropped (no column). Shifts are deleted at settlement (not archived).
- Admin is only known client-side; server identifies the actor by `user_id` in the body; admin can be proven with
  a PIN (see `POST /api/auth/verify-pin`, and server/tenantReset.ts which re-verifies an admin PIN — reuse that
  helper; do NOT honour the SUPER_ADMIN_PIN backdoor for corrections).

NOTE: another session is concurrently fixing the id-offset block at the top of the settlement transaction. Put
all new logic in a NEW module `server/settlement.ts` and keep edits to the existing settlement route minimal
(call into the module), so the two changes merge cleanly.

## Data model (server/db.ts; try/catch ALTER pattern; new tables before the sync-metadata block)
- `daily_reports` new columns: `settled_at DATETIME`, `period_start DATETIME` (the register window start =
  lastRegisterClose().since at settlement time), `total_refunds REAL DEFAULT 0`, `counted_json TEXT`
  (`[{currency, amount, rate}]`), `snapshot_json TEXT` (breakdown at closing, below), `corrected_actual_balance REAL`
  (NULL = no counted-cash correction), `adjustments_total REAL DEFAULT 0` (USD, Σ adjustment corrections).
- `archived_transactions.settlement_id INTEGER`, `archived_cash_flow.settlement_id INTEGER` (= daily_reports.id).
  Local-only tables; index them.
- New synced table `settlement_corrections`: `id, tenant_id, report_id, user_id, kind TEXT CHECK IN
  ('counted','adjustment'), currency TEXT, old_value REAL, new_value REAL, amount_usd REAL, reason TEXT NOT NULL,
  created_at`. Add to sync PUSH/PULL + fkMap `{tenant_id:'tenants', report_id:'daily_reports', user_id:'users'}`
  (missing cloud table is already skipped gracefully).
- One-time migration `settlement_link_backfill_v1`: for archived_transactions / archived_cash_flow with
  settlement_id NULL, set it to the id of the tenant's daily_report with the greatest `created_at <= archived_at
  + 120 seconds` (the old client wrote the report seconds before settling). Also set that report's `settled_at` =
  MAX(archived_at) of the rows linked to it when NULL. Reports without linked rows stay unlinked.
- Supabase: `supabase/migrations/2026-09-29_settlement_detail.sql` — ALTER daily_reports ADD the new columns
  (`IF NOT EXISTS`), CREATE settlement_corrections (UUID FKs like other tables, tenant RLS policy mirroring
  daily_reports' policy — look at supabase_schema.sql / earlier migration files for the pattern).

## Breakdown (one pure-ish function, used for BOTH the snapshot and the rebuild)
`buildBreakdown(source)` where source is either "live now" (at settlement) or "archived rows of settlement X".
All money in USD (payment.amount / exchange_rate) unless noted "native". Payment methods per
server/paymentMethods.ts: cash, card, credit, store_credit.
```
{
  period_start, period_end,
  sales:     { count, total, by_method: {cash, card, credit, store_credit}, cash_by_currency: {USD: native, LBP: native} },
  refunds:   { count, total, by_method: {...}, cash_by_currency: {...} },
  purchases: { count, total, by_method: {...}, cash_by_currency: {...} },
  cash_in:   { total, by_currency: {...native}, count },
  cash_out:  { total, by_currency: {...native}, count },
  register:  { opening, cash_sales, cash_refunds, cash_purchases, cash_in, cash_out, expected },   // same window + formula as /api/cash-flow/summary
  shifts:    [{ user_name, expected_cash, actual_cash, difference, created_at }],                   // snapshot only (shifts are deleted at settlement)
}
```
- sales/refunds/purchases cover ALL transactions archived by that settlement (the whole day); `total` = invoice
  totals; by_method from their payments.
- `register` follows the existing summary logic exactly (refactor `/api/cash-flow/summary` computation into this
  module and have that route call it, so numbers can't drift): cash payments with created_at > period_start plus
  cash_flow with created_at > period_start; opening from lastRegisterClose. For the rebuild, `opening` is taken
  from the snapshot (or the report's opening_balance for legacy) and movements from the archived rows of that
  settlement with `period_start < created_at <= settled_at`.
- Rebuild EXCLUDES payments created after `settled_at` (payments added later when editing a settled invoice —
  that cash went into a later register via its own cash_flow row); list them separately as `late_payments:
  [{transaction_id, amount_usd, method, created_at}]`.

## Settlement becomes atomic
`POST /api/tenant/settlement` body (new): `{ user_id, counted: [{currency, amount, rate}], notes }`.
Inside the same db.transaction, BEFORE rows are deleted from live tables: compute the breakdown from live data,
insert the daily_report (date = localToday(), user via tenantUserId, opening/total_sales(=cash sales, as today)/
total_refunds/total_purchases/total_cash_in/total_cash_out/closing_balance(=expected)/actual_balance(=Σ counted
USD)/difference/notes/settled_at/period_start/counted_json/snapshot_json), then archive as today and stamp
`settlement_id` on the archived_transactions and archived_cash_flow rows it moved. Log with the real user id.
Return `{ success, report_id, cloudPurged, ... }` (keep existing fields/207 behaviour).
Backward compat: if the body has no `counted`, keep the old behaviour but link the rows to the most recent
daily_report created in the last 10 minutes (old client flow) and fill its settled_at/period_start.
`POST /api/reports/daily` stays for Cash Out / compatibility.

## API
- `GET /api/reports/daily` — add per row: `effective_actual` (= corrected_actual_balance ?? actual_balance),
  `effective_expected` (= closing_balance + adjustments_total), `effective_difference`, `corrections_count`,
  `changed_after_close` (boolean, see below). Keep existing fields.
- `GET /api/settlements/:reportId` →
  ```
  { report: {...row, user_name, effective_*},
    recorded: snapshot | legacyRecorded (built from the report columns + counted parsed from notes when possible; flag legacy: true),
    rebuilt: breakdown from archived rows (null if no rows linked),
    counted: [{currency, amount, rate, amount_usd}] (original), corrected_counted: [...] | null,
    changes: { changed: bool, diffs: [{path:'sales.total', recorded, rebuilt}], edited_invoices: [{transaction_id, edited_at, user_name, reason, before_total, after_total}] , late_payments: [...] },
    corrections: [{id, kind, currency, old_value, new_value, amount_usd, reason, user_name, created_at}] }
  ```
  `changed_after_close` = any transaction_edits row with archived=1 for a transaction of this settlement created
  after settled_at, OR (snapshot exists AND any diff > 0.005 on sales.total, sales.by_method.*, refunds.total,
  purchases.total, register.expected). diffs only computed when a non-legacy snapshot exists.
- `POST /api/settlements/:reportId/corrections` body `{ kind, admin_pin, reason (required, trimmed, >= 3 chars),
  ... }`:
  - kind `counted`: `counted: [{currency, amount, rate}]` = the corrected full count; stores one correction row per
    currency whose amount changed (old/new native), sets `corrected_actual_balance` = Σ new USD.
  - kind `adjustment`: `amount` (signed, native), `currency`, `rate` → amount_usd; adds to `adjustments_total`.
  - Admin PIN verified against a role='admin' user of THIS tenant; that user is recorded as the author.
  - Errors (ValidationError shape): `CORRECTION_REASON_REQUIRED` (field reason), `CORRECTION_PIN_INVALID` (403,
    field admin_pin), `CORRECTION_KIND_INVALID`, `CORRECTION_AMOUNT_INVALID` (field amount / counted.<i>.amount),
    404 for an unknown report.
  - Original daily_reports numbers (actual_balance, closing_balance, difference, counted_json, snapshot_json) are
    NEVER modified.
  - If the corrected report is the LATEST close (the one lastRegisterClose() reads), the open register's opening
    balance must follow the corrected counted cash: make lastRegisterClose use
    `COALESCE(corrected_actual_balance, actual_balance)`. Document it in the UI.
  - logAction 'Settlement Corrected'. Broadcast so open pages refetch.

## UI
- `src/pages/Settlement.tsx`:
  - New settlement flow sends `{user_id, counted, notes}` to `/api/tenant/settlement` in ONE call (drop the
    separate `/api/reports/daily` POST for Complete Settlement; Cash Out unchanged).
  - History table rows are clickable (and keyboard accessible) → opens `SettlementDetailDrawer`. Columns show the
    effective values; badges "Corrected" and "Changed after closing" (amber).
- `src/pages/settlement/SettlementDetailDrawer.tsx` (new, large drawer):
  - Header: date, closed by, closed at, register period.
  - Amber banner when changes.changed: "Totals changed after closing" + a table of diffs (Recorded → Now) and the
    edited invoices (links to /dashboard/invoices?id=…, who, when, reason, old → new total) and late payments.
  - Cash register card: rows Opening, Cash sales, Cash refunds, Cash purchases, Cash in, Cash out, Expected,
    Counted, Difference; columns Recorded at closing | Rebuilt now | After corrections (only if corrections).
  - Counted per currency table (native amount, rate, USD) original vs corrected.
  - Sales / Refunds / Purchases cards: count, total, by payment method (Cash, Card, On account, From balance —
    reuse existing method labels/translations), cash by currency.
  - Cash in / out totals by currency; shifts of the day (snapshot).
  - Corrections history (who, when, kind, old → new / amount, reason).
  - "Add correction" button → modal: tabs "Fix counted cash" (per-currency inputs prefilled with current effective
    count) / "Add adjustment" (direction in/out, amount, currency), mandatory reason textarea, admin PIN; inline
    server field errors.
  - Legacy reports: note "Closed before detailed snapshots were recorded — showing what was saved at closing."
- `src/pages/reports/DailyYearlyTab.tsx`: show effective values + the two badges (read-only is fine; clicking can
  open the same drawer if simple).
- Print X report uses effective values and lists corrections.
- All strings en/ar/fr; error codes in translateServerError; RTL-safe.

## Tests (tests/settlement-detail.test.ts)
Atomic settlement with counted per currency → report row with snapshot, links on archived rows, returned id;
detail endpoint recorded == rebuilt for an untouched day; edit a settled invoice (change qty/price and add a
payment) → changed_after_close true, diffs + edited_invoices, late payment excluded from the rebuild; corrections:
reason required, wrong/staff PIN 403, counted fix updates effective values and keeps originals, adjustment adds to
effective expected, next opening balance follows the corrected count of the latest close; legacy flow (report
posted first, settlement without body) still links rows; backfill migration links pre-existing archived rows;
/api/cash-flow/summary numbers unchanged by the refactor (existing tests stay green). All existing tests pass.
