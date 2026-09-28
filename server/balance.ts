import { db } from './db.js';
import { REAL_MONEY_SQL } from './paymentMethods.js';

// Derived stakeholder balances.
//
// Convention (confirmed with the business): a NEGATIVE balance means the stakeholder owes us
// (an unpaid customer sale, or money we owe a supplier — both are "outstanding" and shown
// negative); a payment moves the balance toward zero; a positive balance is store credit / an
// overpayment we owe the customer.
//
// The balance is treated as a DERIVED value, recomputed from source data rather than nudged
// incrementally. This makes it immune to the drift that incremental += / -= caused across edits,
// deletes and cloud sync (an edit that deletes+recreates, or a re-pull, can no longer leave the
// balance wrong). It is computed as:
//
//     balance = balance_baseline + Σ transactionEffect(t)
//
// `balance_baseline` holds everything NOT explained by the current transactions — i.e. manual
// balance payments/collections and the migration seed that preserves pre-existing balances.
// A 'credit' payment is not real money received, and neither is 'store_credit' (paying a sale out
// of the stakeholder's own positive balance) — see server/paymentMethods.ts. Neither ever counts
// toward the paid amount here, which is what makes an invoice paid with store_credit still
// "unpaid" in balance math: its effect keeps consuming the positive balance that funded it.

// The real-money-only unpaid remainder of one transaction (BALANCE MATH — server/paymentMethods.ts).
export function unpaidRealMoney(txId: number, total: number, paymentsTable: 'payments' | 'archived_payments' = 'payments'): number {
  const row = db.prepare(
    `SELECT IFNULL(SUM(amount / exchange_rate), 0) as paid FROM ${paymentsTable} WHERE transaction_id = ? AND ${REAL_MONEY_SQL}`
  ).get(txId) as any;
  return (total || 0) - (row?.paid || 0);
}

// This transaction's effect on its stakeholder's balance (BALANCE MATH sign convention above):
// sale/purchase -> -(unpaid), refund -> +(unpaid). Shared by stakeholderTxEffect below,
// GET /api/transactions/:id (balance_effect) and PUT /api/transactions/:id (available store credit).
export function transactionBalanceEffect(type: string, txId: number, total: number, paymentsTable: 'payments' | 'archived_payments' = 'payments'): number {
  const unpaid = unpaidRealMoney(txId, total, paymentsTable);
  if (type === 'sale' || type === 'purchase') return -unpaid;
  if (type === 'refund') return unpaid;
  return 0;
}

// Effect of one stakeholder's active transactions on their balance, in the sign convention above.
export function stakeholderTxEffect(stakeholderId: number, tenantId: number): number {
  const txns = db.prepare(
    "SELECT id, type, total_amount FROM transactions WHERE stakeholder_id = ? AND tenant_id = ?"
  ).all(stakeholderId, tenantId) as any[];

  let effect = 0;
  for (const t of txns) effect += transactionBalanceEffect(t.type, t.id, t.total_amount);
  return effect;
}

// Recompute and persist one stakeholder's balance from baseline + transaction effects.
export function recomputeStakeholderBalance(stakeholderId: number | null | undefined, tenantId: number): void {
  if (!stakeholderId) return;
  const row = db.prepare(
    "SELECT balance, balance_baseline FROM stakeholders WHERE id = ? AND tenant_id = ?"
  ).get(stakeholderId, tenantId) as any;
  if (!row) return;
  const baseline = row.balance_baseline || 0;
  const balance = baseline + stakeholderTxEffect(stakeholderId, tenantId);
  // Only write when it actually changed — otherwise the post-sync recompute would bump
  // updated_at on every stakeholder each cycle and cause needless sync churn.
  if (Math.abs((row.balance || 0) - balance) < 0.0000001) return;
  db.prepare("UPDATE stakeholders SET balance = ? WHERE id = ? AND tenant_id = ?").run(balance, stakeholderId, tenantId);
}

// Recompute every stakeholder for a tenant (used after a sync pull, which may have changed
// transactions/payments without going through the local write paths).
export function recomputeAllBalances(tenantId: number): void {
  const sts = db.prepare("SELECT id FROM stakeholders WHERE tenant_id = ?").all(tenantId) as any[];
  for (const s of sts) recomputeStakeholderBalance(s.id, tenantId);
}

// Adjust a stakeholder's baseline (used by manual balance payments/collections) and recompute.
export function adjustStakeholderBaseline(stakeholderId: number, tenantId: number, delta: number): void {
  db.prepare("UPDATE stakeholders SET balance_baseline = IFNULL(balance_baseline, 0) + ? WHERE id = ? AND tenant_id = ?")
    .run(delta, stakeholderId, tenantId);
  recomputeStakeholderBalance(stakeholderId, tenantId);
}
