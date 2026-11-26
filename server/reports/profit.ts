import { globalDiscountAmount, lineNet } from "./sales.js";

export interface ProfitLine {
  transaction_id: number;
  type: "sale" | "refund";
  day: string;
  status: string | null;
  deleted_at: string | null;
  owner: number;
  quantity: number;
  unit_price: number;
  unit_cost: number | null;
  product_cost: number | null;
  discount_type: string | null;
  discount_value: number | null;
  tx_discount_type: string | null;
  tx_discount_value: number | null;
}

export interface ProfitOutflow {
  day: string;
  category: string | null;
  reason: string | null;
  amount: number;
  exchange_rate: number | null;
}

export interface FixedObligation {
  amount_usd: number;
  frequency: string;
}

function totals() {
  return { revenue: 0, cogs: 0, ownerDraws: 0, expensesByCategory: new Map<string, number>() };
}

function summarize(value: ReturnType<typeof totals>) {
  const { revenue, cogs, ownerDraws, expensesByCategory } = value;
  const grossMargin = revenue - cogs;
  const expenses = [...expensesByCategory.values()].reduce((sum, amount) => sum + amount, 0);
  return {
    revenue,
    cogs,
    grossMargin,
    marginPct: revenue > 0 ? grossMargin / revenue * 100 : null,
    expenses,
    expenseCategories: [...expensesByCategory].map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category)),
    ownerDraws,
    netProfit: grossMargin - expenses,
  };
}

function monthKey(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0")].join("-");
}

export function profitCalendar(now: Date) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const currentMonth = monthKey(now);
  const previousMonth = monthKey(new Date(year, month - 1, 1));
  const daysInCurrentMonth = new Date(year, month + 1, 0).getDate();
  const daysInPreviousMonth = new Date(year, month, 0).getDate();
  const dates = (key: string, count: number) =>
    Array.from({ length: count }, (_, index) => key + "-" + String(index + 1).padStart(2, "0"));
  const days = [...dates(previousMonth, daysInPreviousMonth), ...dates(currentMonth, now.getDate())];

  return { currentMonth, previousMonth, daysInCurrentMonth, days };
}

export function computeProfit(
  calendar: ReturnType<typeof profitCalendar>,
  lines: ProfitLine[],
  outflows: ProfitOutflow[],
  goodsDraws: { day: string; amount: number }[],
  obligations: FixedObligation[],
) {
  const byDay = new Map(calendar.days.map((day) => [day, totals()]));
  const invoices = new Map<number, { line: ProfitLine; subtotal: number; cogs: number; drawCost: number }>();

  for (const line of lines) {
    if (line.deleted_at || ["void", "voided", "canceled", "cancelled"].includes(line.status?.toLowerCase() ?? "")) continue;
    const invoice = invoices.get(line.transaction_id) ?? { line, subtotal: 0, cogs: 0, drawCost: 0 };
    invoice.subtotal += lineNet(line.unit_price, line.quantity, line.discount_type, line.discount_value);
    invoice.cogs += line.quantity * (line.unit_cost ?? 0);
    if (line.owner) invoice.drawCost += line.quantity * (line.unit_cost || line.product_cost || line.unit_price);
    invoices.set(line.transaction_id, invoice);
  }

  for (const { line, subtotal, cogs, drawCost } of invoices.values()) {
    const day = byDay.get(line.day);
    if (!day) continue;
    const sign = line.type === "refund" ? -1 : 1;
    if (line.owner) {
      day.ownerDraws += sign * drawCost;
    } else {
      day.revenue += sign * (subtotal - globalDiscountAmount(subtotal, line.tx_discount_type, line.tx_discount_value));
      day.cogs += sign * cogs;
    }
  }

  for (const outflow of outflows) {
    const day = byDay.get(outflow.day);
    if (!day) continue;
    const category = outflow.category || "other";
    const amount = outflow.amount / (outflow.exchange_rate || 1);
    if (category === "owner_withdrawal") {
      day.ownerDraws += amount;
    } else if (category !== "supplier_payment" && category !== "transfer"
      && !/^Payment (to supplier|on invoice)/i.test(outflow.reason ?? "")) {
      day.expensesByCategory.set(category, (day.expensesByCategory.get(category) ?? 0) + amount);
    }
  }

  for (const draw of goodsDraws) {
    const day = byDay.get(draw.day);
    if (day) day.ownerDraws += draw.amount;
  }

  const current = totals();
  const previous = totals();
  for (const [date, day] of byDay) {
    const month = date.startsWith(calendar.currentMonth) ? current : previous;
    month.revenue += day.revenue;
    month.cogs += day.cogs;
    month.ownerDraws += day.ownerDraws;
    for (const [category, amount] of day.expensesByCategory) {
      month.expensesByCategory.set(category, (month.expensesByCategory.get(category) ?? 0) + amount);
    }
  }

  const currentMonth = { month: calendar.currentMonth, ...summarize(current) };
  const previousMonth = { month: calendar.previousMonth, ...summarize(previous) };
  const days = calendar.daysInCurrentMonth;
  const monthlyBills = obligations.length ? obligations.reduce((sum, obligation) => {
    const amount = obligation.amount_usd;
    switch (obligation.frequency) {
      case "daily": return sum + amount * days;
      case "weekly": return sum + amount * days / 7;
      case "yearly": return sum + amount / 12;
      default: return sum + amount;
    }
  }, 0) : previousMonth.expenses;
  const margin = currentMonth.marginPct ?? 0;
  const dailySalesTarget = margin > 0 ? monthlyBills / (margin / 100) / days : null;

  return {
    currentMonth,
    previousMonth,
    dailySalesTarget,
    daily: [...byDay].map(([date, day]) => ({ date, ...summarize(day) })),
  };
}

export type ProfitReport = ReturnType<typeof computeProfit>;
