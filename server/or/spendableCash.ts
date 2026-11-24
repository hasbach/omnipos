// Real Spendable Cash Engine & Virtual Cash Bucket Ledger.
// Formula: Free Spendable Cash = Total Liquid Cash - Min Drawer Float - Locked OpEx Reserve - Sum(Active PO Locks).
import { db } from "../db.js";
import { listCashAccounts } from "../cashAccounts.js";
import { dailyObligationRate, ensureOrInitialized } from "./config.js";
import { round2 } from "./coreBridge.js";

export interface SpendableCashSnapshot {
  drawer_balance_usd: number;
  savings_balance_usd: number;
  bank_balance_usd: number;
  total_liquid_cash_usd: number;
  min_drawer_float_usd: number;
  locked_opex_reserve_usd: number;
  active_po_locks_usd: number;
  free_spendable_cash_usd: number;
  daily_opex_burn_usd: number;
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
    .prepare("INSERT INTO or_cash_buckets (tenant_id, code, name, target_amount, current_balance, priority) VALUES (?, ?, ?, 0, 0, 5)")
    .run(tenantId, code, code);
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

/** Computes Real Spendable Cash directly from OmniPOS Core `cash_accounts` + OR locks/reserves. */
export function computeSpendableCash(tenantId: number): SpendableCashSnapshot {
  const config = ensureOrInitialized(tenantId);
  const accounts = listCashAccounts(tenantId, false);

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

  const opexRow = db
    .prepare("SELECT IFNULL(current_balance, 0) AS bal FROM or_cash_buckets WHERE tenant_id = ? AND code = 'OPEX_RESERVE' AND deleted_at IS NULL")
    .get(tenantId) as any;
  const lockedOpex = round2(Math.max(0, Number(opexRow?.bal) || 0));

  const poLockRow = db
    .prepare(
      `SELECT IFNULL(SUM(locked_cash_amount), 0) AS locked
         FROM or_po_commitments
        WHERE tenant_id = ? AND deleted_at IS NULL AND status IN ('APPROVED_LOCKED', 'PARTIALLY_RECEIVED')`
    )
    .get(tenantId) as any;
  const activePoLocks = round2(Math.max(0, Number(poLockRow?.locked) || 0));

  const minFloat = round2(Math.max(0, Number(config.min_drawer_float) || 0));
  const freeSpendable = round2(totalLiquid - minFloat - lockedOpex - activePoLocks);

  const obligations = db
    .prepare("SELECT amount_usd, frequency FROM or_fixed_obligations WHERE tenant_id = ? AND active = 1 AND deleted_at IS NULL")
    .all(tenantId) as any[];
  const dailyOpexBurn = round2(obligations.reduce((sum, o) => sum + dailyObligationRate(o.amount_usd, o.frequency), 0));

  // Runway in days: liquid cash (minus float and active PO locks) divided by daily fixed obligation burn
  const runwayCash = Math.max(0, totalLiquid - minFloat - activePoLocks);
  const runwayDays = dailyOpexBurn > 0.01 ? round2(runwayCash / dailyOpexBurn) : null;

  return {
    drawer_balance_usd: round2(drawer),
    savings_balance_usd: round2(savings),
    bank_balance_usd: round2(bank),
    total_liquid_cash_usd: totalLiquid,
    min_drawer_float_usd: minFloat,
    locked_opex_reserve_usd: lockedOpex,
    active_po_locks_usd: activePoLocks,
    free_spendable_cash_usd: freeSpendable,
    daily_opex_burn_usd: dailyOpexBurn,
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
