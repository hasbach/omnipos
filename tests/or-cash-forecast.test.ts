import { test } from "node:test";
import assert from "node:assert/strict";
import { forecastDate, obligationDue, projectCashForecast, type ForecastInput } from "../server/or/cashForecast.js";
import type { OpenInvoice } from "../server/or/payables.js";

const today = "2026-11-27";
const fixture = (overrides: Partial<ForecastInput> = {}): ForecastInput => ({
  today, liquid_cash_usd: 1000, min_float_usd: 100, sales: [], cash_share: 1,
  receivables: [], payables: [], obligations: [], pos: [], daily_owner_draws_usd: 0, ...overrides,
});
const invoice = (amount_usd: number, age_days: number | null, due_date: string | null = null): OpenInvoice => ({
  party_id: 1, name: 'Party', phone: null, invoice_id: null, invoice_date: null, amount_usd, age_days, due_date,
});

test("weekday averages use all eight weeks including zero days, exclude today and older history, apply cash share", () => {
  const report = projectCashForecast(fixture({ cash_share: 0.5, sales: [
    { date: forecastDate(today, -7), revenue_usd: 800 },
    { date: forecastDate(today, -56), revenue_usd: 80 },
    { date: today, revenue_usd: 10000 },
    { date: forecastDate(today, -63), revenue_usd: 10000 },
  ] }));
  assert.equal(report.days.length, 91);
  assert.equal(report.days[0].sales, 55);
  assert.equal(report.days[1].sales, 0);
  assert.equal(report.days[7].sales, 55);
  assert.equal(report.days[90].date, forecastDate(today, 90));
});

test("collection haircuts respect 30/31/60/61 boundaries and undated debt; cent allocation totals exactly", () => {
  const report = projectCashForecast(fixture({ receivables: [0, 30, 31, 60, 61, null].map(age => invoice(100, age)) }));
  assert.equal(report.expected_collections_usd, 300);
  assert.equal(report.days[0].collections, 10);
  assert.equal(report.days[30].collections, 0);
  const uneven = projectCashForecast(fixture({ receivables: [invoice(1, 0)] }));
  assert.equal(Math.round(uneven.days.reduce((s, d) => s + d.collections, 0) * 100), 80);
});

test("obligation dates match weekly ISO, daily, month-end clamping and January yearly rules", () => {
  const due = (frequency: string, due_day: number, date: string) => obligationDue({ name: 'Bill', amount_usd: 10, frequency, due_day }, date);
  assert.equal(due('monthly', 31, '2027-02-28'), true);
  assert.equal(due('monthly', 31, '2027-02-27'), false);
  assert.equal(due('weekly', 7, '2026-11-29'), true);
  assert.equal(due('weekly', 1, '2026-11-30'), true);
  assert.equal(due('yearly', 31, '2027-01-31'), true);
  assert.equal(due('yearly', 31, '2027-03-31'), false);
  assert.equal(due('daily', 1, today), true);
});

test("payables, overdue and undated debt, remaining PO locks and draws are charged once on their day", () => {
  const report = projectCashForecast(fixture({
    liquid_cash_usd: 200, min_float_usd: 100, daily_owner_draws_usd: 1,
    payables: [invoice(10, null), invoice(20, 40, '2026-11-01'), invoice(50, 0, forecastDate(today, 2)), invoice(999, 0, forecastDate(today, 91))],
    pos: [{ name: 'PO', amount_usd: 30, due_date: forecastDate(today, 1) }],
    obligations: [{ name: 'Rent', amount_usd: 20, frequency: 'monthly', due_day: 28 }],
  }));
  assert.equal(report.days[0].opening, 200);
  assert.equal(report.days[0].outflows, 31);
  assert.equal(report.days[1].opening, 169);
  assert.equal(report.days[1].outflows, 51);
  assert.equal(report.days[2].closing, 67);
  assert.equal(report.first_shortfall?.date, forecastDate(today, 2));
  assert.equal(report.lowest.date, forecastDate(today, 90));
  assert.equal(report.biggest_outflows[0].amount_usd, 50);
});

test("shortfall is strictly below float, can occur on day zero; ties select earliest lowest day", () => {
  assert.equal(projectCashForecast(fixture({ liquid_cash_usd: 100 })).first_shortfall, null);
  const result = projectCashForecast(fixture({ liquid_cash_usd: 99 }));
  assert.equal(result.first_shortfall?.date, today);
  assert.equal(result.lowest.date, today);
});
