// TODO: StatsForecast could replace this pure model here, without calling OR_SOLVER_URL.
export interface DailySale { date: string; units: number }
export interface ForecastConfig { salaryDays: number[]; periods: { from: string; to: string; multiplier: number }[] }
export const defaultForecastConfig: ForecastConfig = { salaryDays: [1, 15], periods: [] };
export function demandDate(date: string, offset: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
}
const weekday = (date: string) => new Date(date + 'T00:00:00Z').getUTCDay();
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
export function forecastDemand(history: DailySale[], today: string, leadDays = 2, config = defaultForecastConfig) {
  const observed = history.filter(d => d.date < today && d.date >= demandDate(today, -56));
  const byDate = new Map(observed.map(d => [d.date, d.units]));
  const first = observed.map(d => d.date).sort()[0];
  const length = first ? Math.min(56, Math.round((Date.parse(today) - Date.parse(first)) / 86400000)) : 0;
  const days = Array.from({ length }, (_, i) => {
    const date = demandDate(today, i - length);
    return { date, units: byDate.get(date) || 0 };
  });
  const horizon = Math.max(1, Math.ceil(leadDays));
  const holiday = (date: string) => config.periods.reduce((m, p) => date >= p.from && date <= p.to ? m * p.multiplier : m, 1);
  const salary = (date: string) => config.salaryDays.includes(Number(date.slice(8, 10)));
  const legacy = (n: number) => days.filter(d => d.date >= demandDate(today, -n)).reduce((s, d) => s + d.units, 0) / n;
  const fallback = 0.5 * legacy(7) + 0.3 * legacy(14) + 0.2 * legacy(30);
  if (length < 14) return { method: 'weighted' as const, daily: fallback, total: fallback * horizon, residualStd: 0, salaryMultiplier: 1 };
  const normal = Array.from({ length: 7 }, (_, w) => mean(days.filter(d => weekday(d.date) === w && !salary(d.date)).map(d => d.units / holiday(d.date))));
  const ratios = days.filter(d => salary(d.date) && normal[weekday(d.date)] > 0).map(d => d.units / holiday(d.date) / normal[weekday(d.date)]);
  const salaryMultiplier = Math.max(1, Math.min(1.5, ratios.length ? mean(ratios) : 1));
  const adjusted = days.map(d => ({ ...d, units: d.units / holiday(d.date) / (salary(d.date) ? salaryMultiplier : 1) }));
  const trend = mean(adjusted.slice(7).map((d, i) => d.units - adjusted[i].units)) / 7;
  const center = (length - 1) / 2;
  const levels = Array.from({ length: 7 }, (_, w) => mean(adjusted.map((d, i) => ({ ...d, index: i })).filter(d => weekday(d.date) === w).map(d => d.units - trend * (d.index - center))));
  const predict = (date: string, index: number) => Math.max(0, levels[weekday(date)] + trend * (index - center)) * holiday(date) * (salary(date) ? salaryMultiplier : 1);
  const residuals = days.map((d, i) => d.units - predict(d.date, i));
  const residualMean = mean(residuals);
  const residualStd = Math.sqrt(mean(residuals.map(r => (r - residualMean) ** 2)));
  const total = Array.from({ length: horizon }, (_, i) => predict(demandDate(today, i), length + i)).reduce((a, b) => a + b, 0);
  return { method: 'seasonal-trend' as const, daily: total / horizon, total, residualStd, salaryMultiplier };
}
export function wape(errors: number, actual: number): number | null { return actual > 0 ? errors / actual : null; }
export function backtestDemand(history: DailySale[], today: string, config = defaultForecastConfig) {
  const lookup = new Map(history.map(d => [d.date, d.units]));
  let absoluteError = 0, actual = 0, predictions = 0;
  for (let week = 8; week >= 1; week--) {
    const origin = demandDate(today, -7 * week);
    const training = history.filter(d => d.date < origin && d.date >= demandDate(origin, -56));
    if (!training.some(d => d.date <= demandDate(origin, -14))) continue;
    for (let day = 0; day < 7; day++) {
      const date = demandDate(origin, day);
      const cumulative = forecastDemand(training, origin, day + 1, config).total;
      const previous = day ? forecastDemand(training, origin, day, config).total : 0;
      const units = lookup.get(date) || 0;
      absoluteError += Math.abs(units - (cumulative - previous));
      actual += units;
      predictions++;
    }
  }
  return { absoluteError, actual, predictions, wape: wape(absoluteError, actual) };
}
