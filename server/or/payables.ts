// Pure USD projections of FIFO-settled statements. No database or HTTP dependencies.
export interface OpenInvoice {
  party_id: number;
  name: string;
  phone: string | null;
  invoice_id: number | null;
  amount_usd: number;
  invoice_date: string | null;
  due_date: string | null;
  age_days: number | null;
}
const dayMs = 86400000;
const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const day = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`);

export function openInvoices(
  party: { id: number; name: string; phone?: string | null },
  statement: { orders: Array<{ id: number; type: string; date: string; remaining: number }>; previous_balance: number },
  kind: "purchase" | "sale", terms: number, today: string,
): OpenInvoice[] {
  const rows: OpenInvoice[] = statement.orders.filter(o => o.type === kind && o.remaining > 0.005).map(o => {
    const date = o.date.slice(0, 10);
    return {
      party_id: party.id, name: party.name, phone: party.phone || null, invoice_id: o.id,
      amount_usd: cents(o.remaining), invoice_date: date,
      due_date: new Date(day(date) + Math.max(0, Math.trunc(terms)) * dayMs).toISOString().slice(0, 10),
      age_days: Math.max(0, Math.floor((day(today) - day(date)) / dayMs)),
    };
  });
  // Undated opening/manual debt is visible and conservatively reserved immediately.
  if (statement.previous_balance > 0.005) rows.push({
    party_id: party.id, name: party.name, phone: party.phone || null, invoice_id: null,
    amount_usd: cents(statement.previous_balance), invoice_date: null, due_date: null, age_days: null,
  });
  return rows;
}

export function agingBuckets(rows: OpenInvoice[]) {
  const buckets = { days_0_30: 0, days_31_60: 0, days_60_plus: 0, undated: 0, total_usd: 0 };
  for (const row of rows) {
    const key = row.age_days === null ? "undated" : row.age_days <= 30 ? "days_0_30" : row.age_days <= 60 ? "days_31_60" : "days_60_plus";
    buckets[key] = cents(buckets[key] + row.amount_usd);
    buckets.total_usd = cents(buckets.total_usd + row.amount_usd);
  }
  return buckets;
}

export function payableReserve(rows: OpenInvoice[], today: string, days = 7): number {
  const end = day(today) + Math.max(0, days) * dayMs;
  return cents(rows.reduce((sum, row) => sum + (row.due_date === null || day(row.due_date) <= end ? row.amount_usd : 0), 0));
}

/** First day projected cash fails; invoice outflows are charged once on their due day. */
export function runwayWithPayables(cash: number, netBurn: number, rows: OpenInvoice[], today: string): number | null {
  const groups = new Map<number, number>();
  for (const row of rows) {
    const due = row.due_date === null ? 0 : Math.max(0, (day(row.due_date) - day(today)) / dayMs);
    groups.set(due, (groups.get(due) || 0) + row.amount_usd);
  }
  let balance = Math.max(0, cash), previous = 0;
  for (const [due, amount] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (netBurn > 0.01 && balance / netBurn < due - previous) return cents(previous + balance / netBurn);
    balance -= netBurn * (due - previous) + amount;
    if (balance < 0) return cents(due);
    previous = due;
  }
  return netBurn > 0.01 ? cents(previous + balance / netBurn) : null;
}

export function payableBriefing(payables: OpenInvoice[], receivables: OpenInvoice[], today: string) {
  const overdue = payables.filter(r => r.due_date !== null && r.due_date < today);
  const due_week = payables.filter(r => r.due_date !== null && r.due_date >= today && day(r.due_date) <= day(today) + 7 * dayMs);
  const customers = new Map<number, { name: string; phone: string | null; amount_usd: number; age_days: number | null }>();
  for (const row of receivables) {
    const current = customers.get(row.party_id);
    customers.set(row.party_id, { name: row.name, phone: row.phone,
      amount_usd: cents((current?.amount_usd || 0) + row.amount_usd),
      age_days: row.age_days === null ? current?.age_days ?? null : Math.max(current?.age_days || 0, row.age_days) });
  }
  const chase = [...customers.values()].sort((a, b) => (b.age_days || 0) - (a.age_days || 0) || b.amount_usd - a.amount_usd).slice(0, 5);
  return { overdue, due_week, chase };
}
