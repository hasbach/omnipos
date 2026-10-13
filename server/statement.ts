import { db } from './db.js';
import { isRealMoney } from './paymentMethods.js';
import { transactionBalanceEffect } from './balance.js';

// Customer / supplier statement. Every row carries an `effect` (its change to the party's balance, in the
// APP's sign convention: negative = they owe us / we owe the supplier). A reconciling "opening" row makes
// the closing balance equal stakeholders.balance exactly. Read-only: never touches balance math.
//
// Sources of events:
//   1. transactions (live + archived): invoice row (-total for sale/purchase, +total for refund) and one
//      row per payment (real money: +usd for sale/purchase, -usd for refund; credit/store_credit: effect 0).
//      Per transaction the sum equals transactionBalanceEffect() in server/balance.ts.
//   2. stakeholder_balance_log rows with no reference (balance collections / supplier payments from the
//      Balance Payment window, manual edits, imports, creation openings). 'history_start' seeds are excluded.
//   3. legacy cash_flow balance payments made BEFORE the stakeholder's first balance-log row.

const LOG_SOURCES = ['balance_collection', 'supplier_payment', 'manual_edit', 'import', 'opening'];
const LOG_LABELS: Record<string, string> = {
  balance_collection: 'Balance collection',
  supplier_payment: 'Supplier payment',
  manual_edit: 'Manual balance edit',
  import: 'Import',
  opening: 'Opening balance',
};

// Event types that carry a REAL-money payment row (on_account rows have effect 0 and never take the residue).
const PAYMENT_EVENT_TYPES = new Set(['payment', 'refund_payment', 'balance_collection', 'supplier_payment']);

interface Ev {
  date: string;
  seq: number;
  type: string;
  reference: string;
  description: string;
  effect: number;
  currency?: string;
  amount_original?: number;
  exchange_rate?: number;
  method?: string;    // payment rows: the payment method
  tx_id?: number;     // every row that comes from a transaction
  archived?: boolean; // that transaction lives in the archived_* tables (settled)
  reconciling?: boolean; // the synthetic "Opening balance & earlier adjustments" line (step 5)
  user: string | null;
}

export function buildStatement(tenantId: number, stakeholderId: number | string): any[] {
  const st = db.prepare("SELECT id, name, type, balance FROM stakeholders WHERE id = ? AND tenant_id = ?").get(stakeholderId, tenantId) as any;
  if (!st) return [];
  const isSupplier = st.type === 'supplier';
  const events: Ev[] = [];
  let seq = 0;

  // 1. Transactions
  const txns = db.prepare(`
    SELECT t.*, u.name as user_name
    FROM (
      SELECT id, user_id, type, total_amount, created_at, 0 as archived FROM transactions WHERE tenant_id = ? AND stakeholder_id = ?
      UNION ALL
      SELECT id, user_id, type, total_amount, created_at, 1 as archived FROM archived_transactions WHERE tenant_id = ? AND stakeholder_id = ?
    ) t
    LEFT JOIN users u ON t.user_id = u.id
    ORDER BY t.created_at ASC, t.id ASC
  `).all(tenantId, stakeholderId, tenantId, stakeholderId) as any[];

  for (const t of txns) {
    const itemsTable = t.archived ? 'archived_transaction_items' : 'transaction_items';
    const paymentsTable = t.archived ? 'archived_payments' : 'payments';
    const items = db.prepare(`
      SELECT ti.quantity, p.name FROM ${itemsTable} ti JOIN products p ON ti.product_id = p.id WHERE ti.transaction_id = ?
    `).all(t.id) as any[];
    const itemsList = items.map((i) => `${i.quantity}x ${i.name}`).join(', ');
    const sign = t.type === 'refund' ? 1 : -1; // refund raises the balance; sale/purchase lowers it
    const label = t.type === 'refund' ? 'Refund' : t.type === 'purchase' ? 'Purchase' : 'Invoice';
    // A 0-total item-less "sale" is the system ticket created by /api/stakeholders/settle-balance.
    const isDebtTicket = t.type === 'sale' && !(t.total_amount > 0) && items.length === 0;

    const txStart = events.length; // first event of this transaction
    if (!isDebtTicket) {
      events.push({
        date: t.created_at, seq: seq++, type: t.type, reference: `#${t.id}`,
        description: `${label} #${t.id}${itemsList ? ` (${itemsList})` : ''}`,
        effect: sign * (t.total_amount || 0), user: t.user_name || null,
      });
    }

    const payments = db.prepare(`SELECT * FROM ${paymentsTable} WHERE transaction_id = ? ORDER BY id ASC`).all(t.id) as any[];
    for (const p of payments) {
      const rate = p.exchange_rate || 1;
      const usd = p.amount / rate;
      const date = p.created_at && p.created_at > t.created_at ? p.created_at : t.created_at;
      const orig = { currency: p.currency || 'USD', amount_original: p.amount, exchange_rate: rate };
      if (!isRealMoney(p.method)) {
        events.push({
          date, seq: seq++, type: 'on_account', reference: `Pay for #${t.id}`,
          description: `${p.method === 'store_credit' ? 'Paid from balance' : 'On account (credit)'} — ${usd.toFixed(2)} USD`,
          effect: 0, ...orig, method: p.method, user: t.user_name || null,
        });
        continue;
      }
      if (isDebtTicket) {
        events.push({
          date, seq: seq++, type: isSupplier ? 'supplier_payment' : 'balance_collection', reference: `#${t.id}`,
          description: `${isSupplier ? 'Supplier payment' : 'Balance collection'} (${p.method})`,
          effect: usd, ...orig, method: p.method, user: t.user_name || null,
        });
      } else if (t.type === 'refund') {
        events.push({
          date, seq: seq++, type: 'refund_payment', reference: `Pay for #${t.id}`,
          description: `Refund paid out (${p.method})`, effect: -usd, ...orig, method: p.method, user: t.user_name || null,
        });
      } else {
        events.push({
          date, seq: seq++, type: 'payment', reference: `Pay for #${t.id}`,
          description: `Payment (${p.method})`, effect: usd, ...orig, method: p.method, user: t.user_name || null,
        });
      }
    }

    // server/balance.ts counts an invoice whose real-money remainder is within PAID_TOLERANCE_USD as exactly
    // settled (effect 0). Mirror that here, otherwise the sub-cent residue piles up in the reconciling opening
    // line: when the balance math says 0 but the rows add up to a residue, fold it into the LAST real-money
    // payment row (amount_original / currency stay as paid). Uses the same helper as the balance itself.
    const rows = events.slice(txStart);
    const residue = rows.reduce((s, e) => s + e.effect, 0);
    if (Math.abs(residue) > 1e-9 && transactionBalanceEffect(t.type, t.id, t.total_amount, paymentsTable) === 0) {
      const last = [...rows].reverse().find((e) => PAYMENT_EVENT_TYPES.has(e.type));
      if (last) last.effect -= residue;
    }
    for (const e of events.slice(txStart)) { e.tx_id = t.id; e.archived = !!t.archived; }
  }

  // 2. Non-transaction adjustments from the balance log
  const logRows = db.prepare(`
    SELECT l.*, u.name AS user_name FROM stakeholder_balance_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.tenant_id = ? AND l.stakeholder_id = ? AND l.reference_id IS NULL
      AND l.source IN (${LOG_SOURCES.map(() => '?').join(',')})
    ORDER BY l.id ASC
  `).all(tenantId, stakeholderId, ...LOG_SOURCES) as any[];
  for (const l of logRows) {
    const ev: Ev = {
      date: l.created_at, seq: seq++, type: l.source, reference: '—',
      description: LOG_LABELS[l.source] || l.source, effect: l.delta, user: l.user_name || null,
    };
    // Balance payments store their note as "<amount> <currency>" — expose the original amount.
    const m = (l.source === 'balance_collection' || l.source === 'supplier_payment') && typeof l.note === 'string'
      ? l.note.match(/^\s*(-?[\d.]+)\s+([A-Za-z]{3,})\s*$/) : null;
    if (m) {
      const amt = Number(m[1]);
      if (m[2] !== 'USD' && Number.isFinite(amt) && Math.abs(l.delta) > 0.0000001) {
        ev.currency = m[2];
        ev.amount_original = amt;
        ev.exchange_rate = amt / Math.abs(l.delta);
      }
    } else if (l.note) {
      ev.description += ` — ${l.note}`;
    }
    events.push(ev);
  }

  // 3. Legacy balance payments recorded only in cash_flow, before the balance log existed
  const firstLog = db.prepare("SELECT MIN(created_at) AS first FROM stakeholder_balance_log WHERE tenant_id = ? AND stakeholder_id = ?").get(tenantId, stakeholderId) as any;
  // cash_flow only stores the counterparty NAME — when two parties share it, a legacy row can't be attributed
  // safely, so leave those to the reconciling opening line rather than show it on the wrong statement.
  const sameName = db.prepare("SELECT COUNT(*) AS n FROM stakeholders WHERE tenant_id = ? AND name = ?").get(tenantId, st.name) as any;
  if (firstLog?.first && (sameName?.n || 0) <= 1) {
    const category = isSupplier ? 'supplier_payment' : 'customer_collection';
    const legacy = db.prepare(`
      SELECT * FROM (
        SELECT id, amount, currency, exchange_rate, reason, created_at, category, counterparty, tenant_id, user_id FROM cash_flow
        UNION ALL
        SELECT id, amount, currency, exchange_rate, reason, created_at, category, counterparty, tenant_id, user_id FROM archived_cash_flow
      ) c
      WHERE c.tenant_id = ? AND c.category = ? AND c.counterparty = ? AND replace(c.created_at, 'T', ' ') < replace(?, 'T', ' ')
        AND (c.reason LIKE 'Balance collection from %' OR c.reason LIKE 'Payment to supplier %')
      ORDER BY c.created_at ASC, c.id ASC
    `).all(tenantId, category, st.name, firstLog.first) as any[];
    for (const c of legacy) {
      const rate = c.exchange_rate || 1;
      events.push({
        date: c.created_at, seq: seq++, type: isSupplier ? 'supplier_payment' : 'balance_collection', reference: '—',
        description: isSupplier ? 'Supplier payment' : 'Balance collection',
        effect: c.amount / rate, currency: c.currency || 'USD', amount_original: c.amount, exchange_rate: rate, user: null,
      });
    }
  }

  // 4. Order by date (stable)
  // On a timestamp tie an opening/import balance goes first (it exists before the activity it precedes).
  const tieRank = (e: Ev) => (e.type === 'opening' || e.type === 'import' ? 0 : 1);
  // Cloud-synced rows may carry ISO timestamps ('2026-10-05T12:00:00Z') next to SQLite's '2026-10-05 12:00:00'.
  const key = (d: string) => String(d || '').replace('T', ' ').replace(/Z$|[+-]00:?00$/, '').slice(0, 19);
  events.sort((a, b) => {
    const ka = key(a.date), kb = key(b.date);
    return ka < kb ? -1 : ka > kb ? 1 : tieRank(a) - tieRank(b) || a.seq - b.seq;
  });

  // 5. Reconciling opening line
  const sumEffect = events.reduce((s, e) => s + e.effect, 0);
  const opening = (st.balance || 0) - sumEffect;
  if (Math.abs(opening) > 0.005) {
    events.unshift({
      date: events.length ? events[0].date : new Date().toISOString().replace('T', ' ').slice(0, 19),
      seq: -1, type: 'opening', reference: '—',
      description: 'Opening balance & earlier adjustments', effect: opening, user: null, reconciling: true,
    });
  }

  // 6/7. Running balance (app convention) + natural debit/credit columns
  let running = 0;
  return events.map((e) => {
    running += e.effect;
    const increases = e.effect < 0 ? -e.effect : 0; // grows what they owe us / what we owe them
    const payments = e.effect > 0 ? e.effect : 0;
    const row: any = {
      date: e.date, type: e.type, reference: e.reference, description: e.description,
      debit: isSupplier ? payments : increases,
      credit: isSupplier ? increases : payments,
      effect: e.effect, balance: running, user: e.user,
    };
    if (e.currency !== undefined) {
      row.currency = e.currency;
      row.amount_original = e.amount_original;
      row.exchange_rate = e.exchange_rate;
    }
    if (e.tx_id !== undefined) { row.tx_id = e.tx_id; row.archived = e.archived ? 1 : 0; }
    if (e.method !== undefined) row.method = e.method;
    if (e.reconciling) row.reconciling = true;
    return row;
  });
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const pad = (n: number) => String(n).padStart(2, '0');

// Stored stamps are UTC: SQLite 'YYYY-MM-DD HH:MM:SS' (no zone) or cloud ISO with Z / +00:00.
function parseStamp(stamp: string): Date | null {
  const s = String(stamp || '').trim().replace(' ', 'T');
  if (!s) return null;
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local calendar day (YYYY-MM-DD) of a stored UTC stamp. */
export function localDateOf(stamp: string): string {
  const d = parseStamp(stamp);
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : String(stamp || '').slice(0, 10);
}

/** "DD/MM/YYYY HH:mm" in local time, for printed statements. */
export function localStampLabel(stamp: string): string {
  const d = parseStamp(stamp);
  return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}` : String(stamp || '');
}

export interface StatementItem {
  name: string;
  unit: string | null;     // unit of measure name ("Carton") when sold in a unit
  factor: number | null;   // pieces per unit
  qty: number;             // in the unit when there is one, else pieces
  unit_price: number;      // per unit (per piece without a unit)
  line_total: number;      // before line discount, same as the sale receipt
  discount: { type: string; value: number } | null;
}

/** Product lines of one transaction (live or archived), shaped for printing. */
export function loadStatementItems(txId: number, archived: boolean): StatementItem[] {
  const table = archived ? 'archived_transaction_items' : 'transaction_items';
  const rows = db.prepare(`
    SELECT ti.*, COALESCE(p.name, 'Item') AS name FROM ${table} ti LEFT JOIN products p ON ti.product_id = p.id
    WHERE ti.transaction_id = ? ORDER BY ti.id ASC
  `).all(txId) as any[];
  return rows.map((r) => {
    const factor = r.uom_id && r.uom_name ? Number(r.uom_factor) || 1 : null;
    const qty = factor ? (r.uom_qty ?? r.quantity / factor) : r.quantity;
    return {
      name: r.name,
      unit: factor ? r.uom_name : null,
      factor,
      qty: Math.round(qty * 1000) / 1000,
      unit_price: round2(factor ? r.unit_price * factor : r.unit_price),
      line_total: round2(r.unit_price * r.quantity),
      discount: r.discount_type && r.discount_value > 0 ? { type: r.discount_type, value: r.discount_value } : null,
    };
  });
}

export interface OpenOrder {
  id: number;
  reference: string;   // "MAIN-0042" or "#42"
  date: string;
  date_label: string;
  type: 'sale' | 'purchase';
  items: StatementItem[];
  discount: { type: string; value: number } | null;
  total: number;
  paid: number;        // total − remaining − returned (at-sale payments + the FIFO share of later payments), ≥ 0
  returned: number;    // refund credit netted against this order (0 when none)
  remaining: number;
  status: 'unpaid' | 'partial';
}

export interface OpenStatement {
  previous_balance: number; // debt not tied to a listed order (opening, imports, manual edits)
  orders: OpenOrder[];      // oldest first
  total_due: number;        // = previous_balance + Σ remaining = −balance
  credit: number;           // > 0 when the balance is in the party's favour
}

function receiptRef(tx: any): string {
  return tx.terminal_id && tx.terminal_sequence ? `${tx.terminal_id}-${String(tx.terminal_sequence).padStart(4, '0')}` : `#${tx.id}`;
}

/**
 * Cent rounding fix so previous + Σ remaining = target exactly (items already rounded to cents, oldest
 * first). The difference goes to the NEWEST item that can take it without dropping below one cent or
 * rising above its own debt (rounded up to the cent), else to the previous balance (never below 0). Mutates `items`; returns the
 * new previous balance.
 */
export function applyCentFix(items: { remaining: number; debt: number }[], previous: number, target: number): number {
  const diff = round2(target - (items.reduce((s, t) => s + t.remaining, 0) + previous));
  if (diff === 0) return previous;
  for (let i = items.length - 1; i >= 0; i--) {
    const next = round2(items[i].remaining + diff);
    if (next >= 0.01 && next <= Math.ceil(items[i].debt * 100 - 1e-6) / 100 + 1e-9) { items[i].remaining = next; return previous; }
  }
  if (previous + diff >= -1e-9) return round2(previous + diff);
  // Last resort (keeps the invariant): the newest item takes it anyway.
  const newest = items[items.length - 1];
  newest.remaining = round2(newest.remaining + diff);
  return previous;
}

// "Unpaid orders": payments are applied to the OLDEST debts first, so the amount still owed is made of
// the NEWEST debts. Walk the debts newest -> oldest until they add up to what is owed; the debt where
// the sum crosses the balance is partially paid, older ones are fully paid. The total equals the
// balance by construction (any gap the history can't explain goes to previous_balance).
export function buildOpenStatement(tenantId: number, stakeholderId: number | string): OpenStatement | null {
  const st = db.prepare("SELECT balance FROM stakeholders WHERE id = ? AND tenant_id = ?").get(stakeholderId, tenantId) as any;
  if (!st) return null;
  const balance = round2(st.balance || 0);
  const due = -balance;
  if (due <= 0.005) return { previous_balance: 0, orders: [], total_due: 0, credit: balance > 0.005 ? balance : 0 };

  // One slot per transaction (its rows summed) or per non-transaction row, in ledger order.
  type Slot = { tx_id?: number; archived?: boolean; type: string; date: string; effect: number };
  const slots: Slot[] = [];
  const byTx = new Map<number, Slot>();
  for (const r of buildStatement(tenantId, stakeholderId)) {
    if (r.tx_id == null) { slots.push({ type: r.type, date: r.date, effect: r.effect }); continue; }
    let s = byTx.get(r.tx_id);
    if (!s) { s = { tx_id: r.tx_id, archived: !!r.archived, type: r.type, date: r.date, effect: 0 }; byTx.set(r.tx_id, s); slots.push(s); }
    s.effect += r.effect;
  }
  // A refund reverses a specific order: net it against that order first, so only the remaining
  // payments are allocated oldest-first. Leftover refund effect stays (already part of the balance).
  const returnedOf = new Map<Slot, number>(); // refund credit netted into each original order
  for (const refund of slots) {
    if (refund.type !== 'refund' || refund.tx_id == null || refund.effect <= 0.005) continue;
    const row = db.prepare(`SELECT original_transaction_id FROM ${refund.archived ? 'archived_transactions' : 'transactions'} WHERE id = ?`).get(refund.tx_id) as any;
    const original = row?.original_transaction_id != null ? byTx.get(row.original_transaction_id) : undefined;
    if (!original || original === refund || original.effect >= -0.005) continue;
    const amt = round2(Math.min(refund.effect, -original.effect));
    original.effect = round2(original.effect + amt);
    refund.effect = round2(refund.effect - amt);
    returnedOf.set(original, round2((returnedOf.get(original) || 0) + amt));
  }

  const debts = slots.filter((s) => s.effect < -0.005 && (s.tx_id == null || s.type === 'sale' || s.type === 'purchase'));

  // Allocate with UNROUNDED amounts: rounding each debt to cents first can leave a few cents of
  // shortfall (e.g. many LBP-paid orders) that would show up as a fake "previous balance".
  let left = due;
  const taken: { slot: Slot; remaining: number; debt: number }[] = [];
  for (let i = debts.length - 1; i >= 0 && left > 0.005; i--) {
    const take = Math.min(-debts[i].effect, left);
    taken.unshift({ slot: debts[i], remaining: take, debt: -debts[i].effect });
    left -= take;
  }

  for (const t of taken) t.remaining = round2(t.remaining);
  const previousBefore = left > 0.005 ? round2(left) : 0;
  let previous = taken.length ? applyCentFix(taken, previousBefore, round2(due)) : previousBefore;
  const orders: OpenOrder[] = [];
  for (const { slot, remaining } of taken) {
    if (slot.tx_id == null) { previous = round2(previous + remaining); continue; }
    const tx = db.prepare(`SELECT * FROM ${slot.archived ? 'archived_transactions' : 'transactions'} WHERE id = ?`).get(slot.tx_id) as any || { id: slot.tx_id, total_amount: remaining };
    const total = round2(tx.total_amount || 0);
    const returned = returnedOf.get(slot) || 0;
    const paid = Math.max(0, round2(total - remaining - returned));
    orders.push({
      id: slot.tx_id,
      reference: receiptRef(tx),
      date: slot.date,
      date_label: localStampLabel(slot.date),
      type: slot.type as 'sale' | 'purchase',
      items: loadStatementItems(slot.tx_id, !!slot.archived),
      discount: tx.discount_type && tx.discount_value > 0 ? { type: tx.discount_type, value: tx.discount_value } : null,
      total,
      paid,
      returned,
      remaining,
      status: paid > 0.005 ? 'partial' : 'unpaid',
    });
  }
  return { previous_balance: previous, orders, total_due: round2(due), credit: 0 };
}

export interface ActivityRow {
  date: string;
  date_label: string;
  type: string;
  reference: string;
  method: string | null;
  debit: number;
  credit: number;
  effect: number;
  balance: number;          // running balance after this row (app sign convention)
  currency?: string;
  amount_original?: number;
  tx_id?: number;
  items?: StatementItem[];  // invoice / purchase / refund rows only
  reconciling?: boolean;    // the synthetic "Opening balance & earlier adjustments" line
}

export interface ActivityStatement {
  from: string;
  to: string;
  opening: number;          // balance at the start of `from` (local midnight)
  rows: ActivityRow[];
  closing: number;          // balance at the end of `to`
  total_debit: number;
  total_credit: number;
}

const INVOICE_TYPES = new Set(['sale', 'purchase', 'refund']);

// "Account activity" between two LOCAL calendar days (inclusive), cut out of the full ledger so the
// opening and closing balances are exactly the running balance at those points.
export function buildActivityStatement(tenantId: number, stakeholderId: number | string, from: string, to: string): ActivityStatement {
  let opening = 0;
  const rows: ActivityRow[] = [];
  // Same receipt number as "Unpaid orders" (MAIN-0013 / #13), on the invoice row and its payments alike.
  const refs = new Map<string, string>();
  const refOf = (r: any): string => {
    if (r.tx_id == null) return r.reference;
    const key = `${r.archived ? 'a' : 'l'}${r.tx_id}`;
    let ref = refs.get(key);
    if (ref === undefined) {
      const tx = db.prepare(`SELECT id, terminal_id, terminal_sequence FROM ${r.archived ? 'archived_transactions' : 'transactions'} WHERE id = ?`).get(r.tx_id) as any;
      ref = tx ? receiptRef(tx) : r.reference;
      refs.set(key, ref!);
    }
    return ref!;
  };
  // Opening lines that START the ledger (the party's creation balance, or the synthetic reconciling line)
  // are folded into the opening balance instead of listed, so the first day never reads
  // "Opening balance $0" followed by an "Opening balance" row.
  let leading = true;
  for (const r of buildStatement(tenantId, stakeholderId)) {
    const day = localDateOf(r.date);
    const isOpening = r.type === 'opening' && r.tx_id == null;
    if (day < from) { opening = r.balance; if (!isOpening) leading = false; continue; }
    if (day > to) continue;
    if (leading && isOpening) { opening = r.balance; continue; }
    leading = false;
    const row: ActivityRow = {
      date: r.date, date_label: localStampLabel(r.date), type: r.type, reference: refOf(r),
      method: r.method ?? null, debit: r.debit, credit: r.credit, effect: r.effect, balance: r.balance,
    };
    if (r.currency !== undefined) { row.currency = r.currency; row.amount_original = r.amount_original; }
    if (r.reconciling) row.reconciling = true;
    if (r.tx_id != null && INVOICE_TYPES.has(r.type)) {
      row.tx_id = r.tx_id;
      row.items = loadStatementItems(r.tx_id, !!r.archived);
    }
    rows.push(row);
  }
  const closing = rows.length ? rows[rows.length - 1].balance : opening;
  return {
    from, to,
    opening: round2(opening),
    rows,
    closing: round2(closing),
    total_debit: round2(rows.reduce((s, r) => s + r.debit, 0)),
    total_credit: round2(rows.reduce((s, r) => s + r.credit, 0)),
  };
}
