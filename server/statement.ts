import { db } from './db.js';
import { isRealMoney } from './paymentMethods.js';

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
          effect: 0, ...orig, user: t.user_name || null,
        });
        continue;
      }
      if (isDebtTicket) {
        events.push({
          date, seq: seq++, type: isSupplier ? 'supplier_payment' : 'balance_collection', reference: `#${t.id}`,
          description: `${isSupplier ? 'Supplier payment' : 'Balance collection'} (${p.method})`,
          effect: usd, ...orig, user: t.user_name || null,
        });
      } else if (t.type === 'refund') {
        events.push({
          date, seq: seq++, type: 'refund_payment', reference: `Pay for #${t.id}`,
          description: `Refund paid out (${p.method})`, effect: -usd, ...orig, user: t.user_name || null,
        });
      } else {
        events.push({
          date, seq: seq++, type: 'payment', reference: `Pay for #${t.id}`,
          description: `Payment (${p.method})`, effect: usd, ...orig, user: t.user_name || null,
        });
      }
    }
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
      description: 'Opening balance & earlier adjustments', effect: opening, user: null,
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
    return row;
  });
}
