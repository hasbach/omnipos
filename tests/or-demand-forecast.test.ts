import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backtestDemand, demandDate, forecastDemand, wape, type DailySale } from '../server/or/demandForecast.js';
const today = '2026-11-30';
const history = (days: number, units: (date: string) => number): DailySale[] => Array.from({ length: days }, (_, i) => {
  const date = demandDate(today, i - days);
  return { date, units: units(date) };
});
test('weekday pattern drives lead-time demand and excludes predictable variance', () => {
  const sales = history(56, date => new Date(date).getUTCDay() === 1 ? 70 : 7);
  const result = forecastDemand(sales, today, 2, { salaryDays: [], periods: [] });
  assert.equal(result.total, 77);
  assert.equal(result.residualStd, 0);
});
test('salary uplift is estimated separately from weekdays and capped at 1.5', () => {
  const sales = history(56, date => [1, 15].includes(Number(date.slice(8))) ? 20 : 10);
  assert.equal(forecastDemand(sales, today).salaryMultiplier, 1.5);
  assert.equal(forecastDemand(sales, today, 2, { salaryDays: [], periods: [] }).salaryMultiplier, 1);
});
test('holiday multiplier applies only inside inclusive dates and history is normalized', () => {
  const sales = history(56, () => 10);
  const result = forecastDemand(sales, today, 2, { salaryDays: [], periods: [{ from: today, to: today, multiplier: 2 }] });
  assert.equal(result.total, 30);
});
test('short history retains weighted velocity', () => {
  const result = forecastDemand(history(7, () => 10), today);
  assert.equal(result.method, 'weighted');
  assert.equal(result.daily, 0.5 * 10 + 0.3 * 5 + 0.2 * (70 / 30));
});
test('rolling backtest uses prior history only and WAPE uses unit sums', () => {
  const result = backtestDemand(history(112, () => 10), today);
  assert.equal(result.predictions, 56);
  assert.equal(result.actual, 560);
  assert.equal(result.wape, 0);
  assert.equal(wape(30, 100), 0.3);
  assert.equal(wape(0, 0), null);
  assert.equal(backtestDemand([], today).predictions, 0);
});
