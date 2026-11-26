// Database adapter: the statement owns FIFO allocation, including later payments and refunds.
import { db } from "../db.js";
import { buildOpenStatement, localDateOf } from "../statement.js";
import { openInvoices, agingBuckets, payableBriefing, type OpenInvoice } from "./payables.js";
import { localDateIso } from "./coreBridge.js";

export function loadOpenPayablesReceivables(tenantId: number, today = localDateIso()) {
  const parties = db.prepare(`SELECT s.id, s.name, s.phone, s.type, COALESCE(p.payment_terms_days, 0) AS terms
    FROM stakeholders s LEFT JOIN or_supplier_profiles p ON p.supplier_id = s.id AND p.tenant_id = s.tenant_id AND p.deleted_at IS NULL
    WHERE s.tenant_id = ? AND s.deleted_at IS NULL AND s.type IN ('supplier', 'customer')`).all(tenantId) as any[];
  const payables: OpenInvoice[] = [], receivables: OpenInvoice[] = [];
  for (const party of parties) {
    const statement = buildOpenStatement(tenantId, party.id);
    if (!statement) continue;
    const supplier = party.type === "supplier";
    const orders = statement.orders.map(o => ({ ...o, date: localDateOf(o.date) }));
    (supplier ? payables : receivables).push(...openInvoices(party, { ...statement, orders }, supplier ? "purchase" : "sale", supplier ? party.terms : 0, today));
  }
  return { payables, receivables, payable_aging: agingBuckets(payables), receivable_aging: agingBuckets(receivables), briefing: payableBriefing(payables, receivables, today) };
}
