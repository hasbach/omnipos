// Everything a printed statement needs, already localized: party, business header, labels, totals and
// (activity mode) a translated label per row. Shared by GET /api/reports/statement/:id(/html) and
// POST /api/print/statement so every output prints exactly the same content.
import { db } from './db.js';
import { buildOpenStatement, buildActivityStatement, localStampLabel, type OpenStatement, type ActivityStatement, type ActivityRow } from './statement.js';
import { localCurrencyFor } from './localCurrency.js';
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

/** mode/from/to from a query string or JSON body; null when activity mode lacks a valid range. */
export function parseStatementOpts(src: any): StatementOpts | null {
  if (src?.mode !== 'activity') return { mode: 'open' };
  const from = String(src?.from ?? ''), to = String(src?.to ?? '');
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) return null;
  return { mode: 'activity', from, to };
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
    local_currency: localCurrencyFor(tenantId),
  };
  if (opts.mode === 'open') {
    doc.open = buildOpenStatement(tenantId, stakeholderId) ?? undefined;
    return doc;
  }
  const symbols: Record<string, string> = Object.fromEntries(
    (db.prepare("SELECT code, symbol FROM currencies WHERE tenant_id = ?").all(tenantId) as any[]).map((c) => [c.code, c.symbol || c.code]),
  );
  const a = buildActivityStatement(tenantId, stakeholderId, opts.from!, opts.to!);
  doc.activity = {
    ...a,
    from_label: dmy(a.from),
    to_label: dmy(a.to),
    rows: a.rows.map((r) => {
      const kind = labels.kinds[r.type] ?? r.type;
      return {
        ...r,
        label: r.method ? `${kind} (${paymentMethodLabel(business.language, r.method)})` : kind,
        original_label: r.currency && r.currency !== 'USD' && r.amount_original != null
          ? `${Math.round(r.amount_original).toLocaleString('en-US')} ${symbols[r.currency] || r.currency}` : null,
      };
    }),
  };
  return doc;
}
