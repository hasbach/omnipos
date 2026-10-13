// Everything a printed statement needs, already localized: party, business header, labels, totals and
// (activity mode) a translated label per row. Shared by GET /api/reports/statement/:id(/html) and
// POST /api/print/statement so every output prints exactly the same content.
import { db } from './db.js';
import { buildOpenStatement, buildActivityStatement, localStampLabel, type OpenStatement, type ActivityStatement, type ActivityRow } from './statement.js';
import { effectiveLocalRate } from './localCurrency.js';
import { statementLabels, type StatementLabels, type StatementLanguage } from './printing/statementLabels.js';
import { paymentMethodLabel } from './printing/receiptLabels.js';

export interface StatementOpts { mode: 'open' | 'activity'; from?: string; to?: string }
export interface StatementBusiness { name: string; address: string; phone: string; language: StatementLanguage }
export interface DocActivityRow extends ActivityRow { label: string; original_label: string | null }
export interface StatementDocument {
  mode: 'open' | 'activity';
  party: { id: number; name: string; type: 'customer' | 'supplier'; address: string; phone: string; balance: number };
  business: StatementBusiness;
  labels: StatementLabels;
  printed_at: string;
  open?: OpenStatement;
  activity?: Omit<ActivityStatement, 'rows'> & { rows: DocActivityRow[]; from_label: string; to_label: string };
  local_currency: { code: string; symbol: string; rate: number } | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day in YYYY-MM-DD form (rejects 2026-13-45, 2026-02-30, ...). */
function isCalendarDay(day: string): boolean {
  if (!ISO_DAY.test(day)) return false;
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** mode/from/to from a query string or JSON body; null when activity mode lacks a valid range. */
export function parseStatementOpts(src: any): StatementOpts | null {
  if (src?.mode !== 'activity') return { mode: 'open' };
  const from = String(src?.from ?? ''), to = String(src?.to ?? '');
  if (!isCalendarDay(from) || !isCalendarDay(to) || from > to) return null;
  return { mode: 'activity', from, to };
}

// The party's own local rate when it has one (walk-in and parties without one use the global rate).
function localCurrencyOf(tenantId: number, stakeholderId: number): StatementDocument['local_currency'] {
  const cur = effectiveLocalRate(tenantId, stakeholderId);
  return cur ? { code: cur.code, symbol: cur.symbol, rate: cur.rate } : null;
}

const dmy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

export function buildStatementDocument(tenantId: number, stakeholderId: number | string, opts: StatementOpts, business: StatementBusiness): StatementDocument | null {
  const st = db.prepare("SELECT id, name, type, address, phone, balance FROM stakeholders WHERE id = ? AND tenant_id = ?").get(stakeholderId, tenantId) as any;
  if (!st) return null;
  const labels = statementLabels(business.language);
  const doc: StatementDocument = {
    mode: opts.mode,
    party: {
      id: st.id, name: st.name === 'Walk-in Customer' ? labels.walkIn : st.name, type: st.type,
      address: st.address || '', phone: st.phone || '', balance: st.balance || 0,
    },
    business, labels,
    printed_at: localStampLabel(new Date().toISOString()),
    local_currency: localCurrencyOf(tenantId, st.id),
  };
  if (opts.mode === 'open') {
    doc.open = buildOpenStatement(tenantId, stakeholderId) ?? undefined;
    return doc;
  }
  const symbols: Record<string, string> = Object.fromEntries(
    (db.prepare("SELECT code, symbol FROM currencies WHERE tenant_id = ? AND deleted_at IS NULL").all(tenantId) as any[]).map((c) => [c.code, c.symbol || c.code]),
  );
  const a = buildActivityStatement(tenantId, stakeholderId, opts.from!, opts.to!);
  doc.activity = {
    ...a,
    from_label: dmy(a.from),
    to_label: dmy(a.to),
    rows: a.rows.map((r) => {
      const kind = labels.kinds[r.type] ?? r.type;
      const method = r.method ? labels.methods[r.method] ?? paymentMethodLabel(business.language, r.method) : null;
      // On-account rows ARE the method ("From balance" / "On account"): name it once. A listed opening row is
      // a balance-log opening (party creation); only the synthetic reconciling line keeps the long label.
      const label = r.type === 'on_account' ? method ?? kind
        : r.type === 'opening' && !r.reconciling ? labels.openingBalance
        : method ? `${kind} (${method})` : kind;
      return {
        ...r,
        label,
        original_label: r.currency && r.currency !== 'USD' && r.amount_original != null
          ? `${Math.round(r.amount_original).toLocaleString('en-US')} ${symbols[r.currency] || r.currency}` : null,
      };
    }),
  };
  return doc;
}
