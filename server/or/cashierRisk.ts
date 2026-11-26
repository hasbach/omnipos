// Pure daily risk analysis. Counts are sale-level events, cash differences are absolute USD.
export const riskMetrics = ['voids', 'refunds', 'discounts', 'overrides', 'cash_difference'] as const;
export type RiskMetric = typeof riskMetrics[number];
export interface CashierDay {
  cashier: string;
  name: string;
  date: string;
  sales: number;
  voids: number;
  refunds: number;
  discounts: number;
  overrides: number;
  cash_difference: number;
}
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n ? (sorted[Math.floor(n / 2)] + sorted[Math.floor((n - 1) / 2)]) / 2 : 0;
}
export function robustZ(value: number, baseline: number[]): number {
  if (!baseline.length) return 0;
  const center = median(baseline);
  const mad = median(baseline.map(v => Math.abs(v - center)));
  // A constant baseline has zero dispersion: any increase is an outlier.
  return mad === 0 ? (value > center ? Infinity : 0) : 0.67448975 * (value - center) / mad;
}
export function per100(value: number, sales: number): number { return sales > 0 ? value * 100 / sales : 0; }
export function analyzeCashierRisk(days: CashierDay[], yesterday: string) {
  const start = new Date(`${yesterday}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 59);
  const window = days.filter(d => d.date >= start.toISOString().slice(0, 10) && d.date <= yesterday);
  return window.filter(d => d.date === yesterday).map(day => {
    const own = window.filter(d => d.cashier === day.cashier && d.date < yesterday && d.sales > 0);
    const peers = new Map<string, CashierDay>();
    for (const d of window) {
      if (d.cashier === day.cashier || d.sales <= 0) continue;
      const total = peers.get(d.cashier);
      if (!total) peers.set(d.cashier, { ...d });
      else { total.sales += d.sales; for (const metric of riskMetrics) total[metric] += d[metric]; }
    }
    const qualified = [...peers.values()].filter(d => d.sales >= 20);
    const baselineSales = own.reduce((sum, d) => sum + d.sales, 0);
    const flags = riskMetrics.flatMap(metric => {
      const usual = own.map(d => d[metric]);
      const self = baselineSales >= 20 && robustZ(day[metric], usual) > 3.5;
      const peer = day.sales >= 20 && qualified.length >= 2 && robustZ(per100(day[metric], day.sales), qualified.map(d => per100(d[metric], d.sales))) > 3.5;
      return self || peer ? [{ metric, self, peer, usual: median(usual), per100: per100(day[metric], day.sales) }] : [];
    });
    return { ...day, baseline_sales: baselineSales, flags };
  });
}
export function cashierBriefingItems(rows: ReturnType<typeof analyzeCashierRisk>) {
  return rows.flatMap(row => row.flags.map(flag => ({
    category: `CASHIER_RISK:${row.cashier}:${flag.metric}`,
    priority: 'HIGH',
    title: `Cashier ${row.name}: ${row[flag.metric]} ${flag.metric} yesterday`,
    details: `Usual daily median: ${flag.usual}. Yesterday per 100 sales: ${flag.per100.toFixed(2)}. Review activity; an alert is not evidence of misconduct.`,
  })));
}
