import type { OpenInvoice } from "./payables.js";

const DAY = 86400000;
const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const forecastDate = (date: string, offset: number) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * DAY).toISOString().slice(0, 10);
export interface ForecastObligation { name: string; amount_usd: number; frequency: string; due_day: number | null }
export interface ForecastInput {
  today: string;
  liquid_cash_usd: number;
  min_float_usd: number;
  sales: Array<{ date: string; revenue_usd: number }>;
  cash_share: number;
  receivables: OpenInvoice[];
  payables: OpenInvoice[];
  obligations: ForecastObligation[];
  pos: Array<{ name: string; amount_usd: number; due_date: string | null }>;
  daily_owner_draws_usd: number;
}

/** Same calendar rules as computeOpexReserve: ISO weekly, clamped monthly, January yearly. */
export function obligationDue(obligation: ForecastObligation, date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  const due = Math.max(1, obligation.due_day || 1);
  if (obligation.frequency === "daily") return true;
  if (obligation.frequency === "weekly") return (d.getUTCDay() || 7) === Math.min(7, due);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return d.getUTCDate() === Math.min(due, last) && (obligation.frequency !== "yearly" || d.getUTCMonth() === 0);
}

/** Offline, deterministic 91-day projection. No reserves are subtracted from liquid cash. */
export function projectCashForecast(input: ForecastInput) {
  const weekday = Array<number>(7).fill(0);
  const from = forecastDate(input.today, -56);
  for (const sale of input.sales) {
    if (sale.date >= from && sale.date < input.today) weekday[new Date(`${sale.date}T00:00:00Z`).getUTCDay()] += sale.revenue_usd / 8;
  }
  const collections = cents(input.receivables.reduce((sum, r) => sum + r.amount_usd * (r.age_days === null || r.age_days > 60 ? 0.2 : r.age_days > 30 ? 0.5 : 0.8), 0));
  const events: Array<{ date: string; kind: 'obligation' | 'payable' | 'po' | 'draw'; name: string; amount_usd: number }> = [];
  let balance = cents(input.liquid_cash_usd);
  const days = Array.from({ length: 91 }, (_, i) => {
    const date = forecastDate(input.today, i);
    const opening = balance;
    const sales = cents(Math.max(0, weekday[new Date(`${date}T00:00:00Z`).getUTCDay()]) * Math.max(0, Math.min(1, input.cash_share)));
    // Allocate cents cumulatively so all 30 days sum exactly to the expected collections.
    const collection = i < 30 ? cents(cents(collections * (i + 1) / 30) - cents(collections * i / 30)) : 0;
    const add = (kind: typeof events[number]['kind'], name: string, amount: number) => {
      if (amount > 0) events.push({ date, kind, name, amount_usd: cents(amount) });
    };
    for (const o of input.obligations) if (obligationDue(o, date)) add('obligation', o.name, o.amount_usd);
    for (const p of input.payables) if ((p.due_date && p.due_date > input.today ? p.due_date : input.today) === date) add('payable', p.name, p.amount_usd);
    for (const p of input.pos) if ((p.due_date && p.due_date > input.today ? p.due_date : input.today) === date) add('po', p.name, p.amount_usd);
    add('draw', '', input.daily_owner_draws_usd);
    const outflows = cents(events.filter(e => e.date === date).reduce((sum, e) => sum + e.amount_usd, 0));
    const inflows = cents(sales + collection);
    balance = cents(opening + inflows - outflows);
    return { date, opening, inflows, outflows, closing: balance, sales, collections: collection };
  });
  const lowest = days.reduce((a, b) => b.closing < a.closing ? b : a);
  const first_shortfall = days.find(d => d.closing < input.min_float_usd) ?? null;
  const driverDate = first_shortfall?.date ?? lowest.date;
  return {
    days, lowest, first_shortfall, min_float_usd: input.min_float_usd,
    expected_collections_usd: collections,
    biggest_outflows: events.filter(e => e.date <= driverDate).sort((a, b) => b.amount_usd - a.amount_usd || a.date.localeCompare(b.date)).slice(0, 10),
  };
}
export type CashForecast = ReturnType<typeof projectCashForecast>;
