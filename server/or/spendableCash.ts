import { loadOpenPayablesReceivables } from "./payablesData.js";
import { payableReserve, runwayWithPayables } from "./payables.js";
// Real Spendable Cash Engine & Virtual Cash Bucket Ledger.
// Formula: liquid cash - drawer float - accrued bills - PO locks - near-term supplier payables.
import { db } from "../db.js";
import { listCashAccounts } from "../cashAccounts.js";
import { dailyObligationRate, ensureOrInitialized } from "./config.js";
import { localDateIso, round2 } from "./coreBridge.js";
import { stableGlobalId } from "./stableId.js";

export interface SpendableCashSnapshot {
  payables_reserve_usd: number;
  drawer_balance_usd: number;
  savings_balance_usd: number;
  bank_balance_usd: number;
  total_liquid_cash_usd: number;
  min_drawer_float_usd: number;
  locked_opex_reserve_usd: number;
  active_po_locks_usd: number;
  free_spendable_cash_usd: number;
  daily_opex_burn_usd: number;
  /** Average daily gross profit from sales (last 30 days with sales; line price - line cost). */
  avg_daily_gross_profit_usd: number;
  /** Average daily owner cash withdrawals (last 30 days). */
  avg_daily_owner_draws_usd: number;
  /** Bills + owner draws - gross profit, per day. <= 0 means the shop's profit covers its bills. */
  net_daily_burn_usd: number;
  /** Days the cash on hand lasts at the NET burn; null when profit covers the burn. */
  runway_days: number | null;
  survival_mode: string;
  accounts: Array<{ id: number; name: string; kind: string; balance_usd: number }>;
}

export function getBucketByCode(tenantId: number, code: string): { id: number; code: string; name: string; current_balance: number } {
  ensureOrInitialized(tenantId);
  const row = db
    .prepare("SELECT id, code, name, current_balance FROM or_cash_buckets WHERE tenant_id = ? AND code = ? AND deleted_at IS NULL")
    .get(tenantId, code) as any;
  if (row) return row;
  const info = db
    .prepare("INSERT INTO or_cash_buckets (global_id, tenant_id, code, name, target_amount, current_balance, priority) VALUES (?, ?, ?, ?, 0, 0, 5)")
    .run(stableGlobalId(tenantId, "or_cash_buckets", code), tenantId, code, code);
  return { id: Number(info.lastInsertRowid), code, name: code, current_balance: 0 };
}

/**
 * Appends an immutable entry to `or_cash_bucket_ledger` and updates the bucket's cached balance.
 * Must be called inside the caller's transaction when part of a multi-step workflow.
 */
export function recordBucketLedger(params: {
  tenantId: number;
  bucketCode: string;
  txType: "PO_LOCK" | "PO_RELEASE" | "PO_PAYMENT" | "OPEX_ACCRUAL" | "OWNER_DRAW" | "SALES_INFLOW" | "ADJUSTMENT";
  amount: number;
  referenceType?: string | null;
  referenceId?: number | null;
  note?: string | null;
  bucketDelta?: number; // optional explicit delta to bucket.current_balance; defaults to `amount`
}): number {
  const bucket = getBucketByCode(params.tenantId, params.bucketCode);
  const amt = round2(Number(params.amount) || 0);
  const delta = params.bucketDelta !== undefined ? round2(params.bucketDelta) : amt;

  const info = db
    .prepare(
      `INSERT INTO or_cash_bucket_ledger (tenant_id, bucket_id, tx_type, amount, reference_type, reference_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.tenantId,
      bucket.id,
      params.txType,
      amt,
      params.referenceType ?? null,
      params.referenceId ?? null,
      params.note ?? null
    );

  if (delta !== 0) {
    db.prepare("UPDATE or_cash_buckets SET current_balance = MAX(0, IFNULL(current_balance, 0) + ?) WHERE id = ? AND tenant_id = ?")
      .run(delta, bucket.id, params.tenantId);
  }
  return Number(info.lastInsertRowid);
}

const DAY_MS = 86400000;
const utcDay = (y: number, m: number, d: number) => Date.UTC(y, m, Math.min(d, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()));

/**
 * How much of one obligation has accrued since its last due date, for `today` (YYYY-MM-DD, local business day).
 * The reserve grows a little each day and falls back to ~0 on the due date, when the bill is actually paid out of
 * the real cash accounts — so it can never pile up forever.
 *   daily   -> one day's amount
 *   weekly  -> due_day = ISO weekday (1 = Monday ... 7 = Sunday)
 *   monthly -> due_day = day of month (clamped to the month's length)
 *   yearly  -> due_day = day of January (clamped)
 */
export function accruedObligationReserve(amountUsd: number, frequency: string, dueDay: number | null | undefined, today: string): number {
  const amt = Math.max(0, Number(amountUsd) || 0);
  if (amt <= 0) return 0;
  if (frequency === "daily") return round2(amt);
  const [y, m, d] = today.split("-").map(Number);
  const now = Date.UTC(y, m - 1, d);
  let last: number;
  let next: number;
  if (frequency === "weekly") {
    const want = Math.min(7, Math.max(1, Number(dueDay) || 1)) % 7; // JS getUTCDay: 0 = Sunday
    const back = (new Date(now).getUTCDay() - want + 7) % 7;
    last = now - back * DAY_MS;
    next = last + 7 * DAY_MS;
  } else if (frequency === "yearly") {
    const dd = Math.max(1, Number(dueDay) || 1);
    const thisYear = utcDay(y, 0, dd);
    last = now >= thisYear ? thisYear : utcDay(y - 1, 0, dd);
    next = now >= thisYear ? utcDay(y + 1, 0, dd) : thisYear;
  } else {
    const dd = Math.max(1, Number(dueDay) || 1);
    const thisMonth = utcDay(y, m - 1, dd);
    last = now >= thisMonth ? thisMonth : utcDay(y, m - 2, dd);
    next = now >= thisMonth ? utcDay(y, m, dd) : thisMonth;
  }
  const period = Math.max(1, (next - last) / DAY_MS);
  const elapsed = Math.max(0, (now - last) / DAY_MS);
  return round2((amt * elapsed) / period);
}

/** Sum of the accrued reserve of every active fixed obligation for the given business day. */
export function computeOpexReserve(tenantId: number, today = localDateIso()): number {
  const obligations = db
    .prepare("SELECT amount_usd, frequency, due_day FROM or_fixed_obligations WHERE tenant_id = ? AND active = 1 AND deleted_at IS NULL")
    .all(tenantId) as any[];
  return round2(obligations.reduce((sum, o) => sum + accruedObligationReserve(o.amount_usd, o.frequency, o.due_day, today), 0));
}

const PROFIT_WINDOW_DAYS = 30;

/**
 * Average daily gross profit over the last 30 days: sum(qty x (unit_price - unit_cost)) of live + archived sales,
 * minus refunds, divided by the days in the window that the shop has been trading (first sale in the window up to
 * today, at least 7). Lines without a cost (e.g. service items such as bread bought daily as an expense) count their
 * full price as profit; their cost is then expected to be a fixed obligation.
 */
export function averageDailyGrossProfit(tenantId: number): number {
  const row = db
    .prepare(
      `SELECT IFNULL(SUM(CASE WHEN type = 'refund' THEN -1 ELSE 1 END * qty * (price - cost)), 0) AS profit,
              MIN(created_at) AS first_at
         FROM (
           SELECT t.type, t.created_at, ti.quantity AS qty, ti.unit_price AS price, IFNULL(ti.unit_cost, 0) AS cost
             FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
            WHERE t.tenant_id = ? AND t.type IN ('sale', 'refund') AND t.deleted_at IS NULL
              AND datetime(t.created_at) >= datetime('now', '-${PROFIT_WINDOW_DAYS} days')
           UNION ALL
           SELECT t.type, t.created_at, ti.quantity, ti.unit_price, IFNULL(ti.unit_cost, 0)
             FROM archived_transaction_items ti JOIN archived_transactions t ON t.id = ti.transaction_id
            WHERE t.tenant_id = ? AND t.type IN ('sale', 'refund')
              AND datetime(t.created_at) >= datetime('now', '-${PROFIT_WINDOW_DAYS} days')
         )`
    )
    .get(tenantId, tenantId) as any;
  if (!row?.first_at) return 0;
  const firstMs = Date.parse(String(row.first_at).replace(" ", "T") + (/(Z|[+-]\d{2}:?\d{2})$/.test(String(row.first_at)) ? "" : "Z"));
  const days = Math.min(PROFIT_WINDOW_DAYS, Math.max(7, Math.ceil((Date.now() - firstMs) / 86400000)));
  return round2(Math.max(0, Number(row.profit) || 0) / days);
}

/** Average daily owner cash withdrawals (cash_flow owner_withdrawal, live + archived) over the last 30 days. */
export function averageDailyOwnerDraws(tenantId: number): number {
  const row = db
    .prepare(
      `SELECT IFNULL(SUM(amount / IFNULL(NULLIF(exchange_rate, 0), 1)), 0) AS total FROM (
         SELECT amount, exchange_rate FROM cash_flow
          WHERE tenant_id = ? AND type = 'out' AND category = 'owner_withdrawal' AND deleted_at IS NULL
            AND datetime(created_at) >= datetime('now', '-${PROFIT_WINDOW_DAYS} days')
         UNION ALL
         SELECT amount, exchange_rate FROM archived_cash_flow
          WHERE tenant_id = ? AND type = 'out' AND category = 'owner_withdrawal'
            AND datetime(created_at) >= datetime('now', '-${PROFIT_WINDOW_DAYS} days'))`
    )
    .get(tenantId, tenantId) as any;
  return round2((Number(row?.total) || 0) / PROFIT_WINDOW_DAYS);
}

/** Computes Real Spendable Cash directly from OmniPOS Core `cash_accounts` + OR locks/reserves. */
export function computeSpendableCash(tenantId: number, today = localDateIso(), readOnly = false): SpendableCashSnapshot {
  const config = readOnly ? db.prepare("SELECT * FROM or_tenant_config WHERE tenant_id = ? AND deleted_at IS NULL").get(tenantId) as ReturnType<typeof ensureOrInitialized> : ensureOrInitialized(tenantId);
  const accounts = listCashAccounts(tenantId, false, readOnly);

  let drawer = 0;
  let savings = 0;
  let bank = 0;
  for (const acc of accounts) {
    const bal = Number(acc.balance_usd) || 0;
    if (acc.kind === "drawer") drawer += bal;
    else if (acc.kind === "bank") bank += bal;
    else savings += bal;
  }
  const totalLiquid = round2(drawer + savings + bank);

  // Derived every time (never accumulated): what each fixed obligation has built up since its last due date.
  const lockedOpex = computeOpexReserve(tenantId, today);

  const poLockRow = db
    .prepare(
      `SELECT IFNULL(SUM(locked_cash_amount), 0) AS locked
         FROM or_po_commitments
        WHERE tenant_id = ? AND deleted_at IS NULL AND status IN ('APPROVED_LOCKED', 'PARTIALLY_RECEIVED')`
    )
    .get(tenantId) as any;
  const activePoLocks = round2(Math.max(0, Number(poLockRow?.locked) || 0));

  const minFloat = round2(Math.max(0, Number(config.min_drawer_float) || 0));
  const { payables } = loadOpenPayablesReceivables(tenantId, today);
  const payablesReserve = payableReserve(payables, today, config.payables_reserve_days ?? 7);
  const freeSpendable = round2(totalLiquid - minFloat - lockedOpex - activePoLocks - payablesReserve);

  const obligations = db
    .prepare("SELECT amount_usd, frequency FROM or_fixed_obligations WHERE tenant_id = ? AND active = 1 AND deleted_at IS NULL")
    .all(tenantId) as any[];
  const dailyOpexBurn = round2(obligations.reduce((sum, o) => sum + dailyObligationRate(o.amount_usd, o.frequency), 0));

  // Runway: cash on hand (minus float and active PO locks) divided by the NET daily burn - bills plus owner draws
  // minus the gross profit the shop actually earns each day. A shop whose profit covers its bills has no runway
  // limit (null) unless an invoice falling due exhausts the available cash.
  const grossProfit = averageDailyGrossProfit(tenantId);
  const ownerDraws = averageDailyOwnerDraws(tenantId);
  const netBurn = round2(dailyOpexBurn + ownerDraws - grossProfit);
  const runwayCash = Math.max(0, totalLiquid - minFloat - activePoLocks);
  const runwayDays = runwayWithPayables(runwayCash, netBurn, payables, today);

  return {
    payables_reserve_usd: payablesReserve,
    drawer_balance_usd: round2(drawer),
    savings_balance_usd: round2(savings),
    bank_balance_usd: round2(bank),
    total_liquid_cash_usd: totalLiquid,
    min_drawer_float_usd: minFloat,
    locked_opex_reserve_usd: lockedOpex,
    active_po_locks_usd: activePoLocks,
    free_spendable_cash_usd: freeSpendable,
    daily_opex_burn_usd: dailyOpexBurn,
    avg_daily_gross_profit_usd: grossProfit,
    avg_daily_owner_draws_usd: ownerDraws,
    net_daily_burn_usd: netBurn,
    runway_days: runwayDays,
    survival_mode: config.survival_mode,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, balance_usd: a.balance_usd })),
  };
}

export function listBucketLedger(tenantId: number, limit = 100) {
  return db
    .prepare(
      `SELECT l.*, b.code AS bucket_code, b.name AS bucket_name
         FROM or_cash_bucket_ledger l
         JOIN or_cash_buckets b ON b.id = l.bucket_id
        WHERE l.tenant_id = ? AND l.deleted_at IS NULL
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ?`
    )
    .all(tenantId, Math.max(1, Math.min(500, limit)));
}
