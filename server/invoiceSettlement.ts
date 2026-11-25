// Invoice paid / due as the party's balance sees it.
//
// An invoice's own `payments` rows only hold what was paid AT the sale / purchase. Money paid later
// through Cash Flow -> Balance Payment (customer collection, supplier payment) moves the party's balance
// but is not tied to any invoice, so lists kept showing those invoices as unpaid and "Due" stayed high.
// The open statement (server/statement.ts buildOpenStatement) already allocates the party's later
// payments to the OLDEST debts first; this applies the same allocation to invoice lists, so an invoice
// is settled once the party's payments have covered it.
import { buildOpenStatement } from "./statement.js";

const EPS = 0.01;

export interface SettlementRow {
  id: number;
  type?: string;
  stakeholder_id?: number | null;
  total_amount: number;
  paid_amount: number;
}

/**
 * Raises `paid_amount` of the given invoice rows (in place) by the share of the party's later balance
 * payments that the oldest-first allocation gives them, and sets `paid_later` to that share. Rows already
 * paid on their own, refunds, rows without a party, and parties with no open statement are left as they are.
 * Never lowers what an invoice's own payments say.
 */
export function applyLaterPayments<T extends SettlementRow>(tenantId: number, rows: T[]): T[] {
  const open = new Map<number, Map<number, number> | null>(); // party -> (invoice id -> remaining)
  for (const row of rows) {
    const r = row as any;
    r.paid_later = 0;
    if (row.type && row.type !== "sale" && row.type !== "purchase") continue;
    const party = row.stakeholder_id;
    if (!party) continue;
    const total = Number(row.total_amount) || 0;
    const paid = Number(row.paid_amount) || 0;
    if (total - paid <= EPS) continue;
    if (!open.has(party)) {
      const st = buildOpenStatement(tenantId, party);
      open.set(party, st ? new Map(st.orders.map((o) => [Number(o.id), Number(o.remaining) || 0])) : null);
    }
    const remainingById = open.get(party);
    if (!remainingById) continue;
    const remaining = remainingById.get(Number(row.id)) ?? 0; // not among the open orders => fully covered
    const settledPaid = Math.max(paid, total - remaining);
    if (settledPaid - paid > EPS / 2) {
      r.paid_later = Math.round((settledPaid - paid) * 100) / 100;
      r.paid_amount = settledPaid;
    }
  }
  return rows;
}

/** Keeps rows matching a paid / unpaid status filter, judged AFTER applyLaterPayments. */
export function filterBySettlement<T extends SettlementRow>(rows: T[], status: unknown): T[] {
  if (status === "paid") return rows.filter((r) => (Number(r.total_amount) || 0) - (Number(r.paid_amount) || 0) <= EPS);
  if (status === "unpaid") return rows.filter((r) => (Number(r.total_amount) || 0) - (Number(r.paid_amount) || 0) > EPS);
  return rows;
}
