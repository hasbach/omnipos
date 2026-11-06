import { formatDateTime } from '../../lib/format';
import { CATEGORIES, builtinCategoryLabel, type Category } from '../cashflow/common';
import { printReportHtml, type PrintResult } from './printReport';
import { effectiveOf, type Breakdown, type CountedLine, type FlowBlock, type SettlementDetail } from './types';

type T = (key: string, fallback?: string) => string;

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const METHODS = ['cash', 'card', 'credit', 'store_credit'] as const;
const EPS = 0.005;

export interface PrintSettlementOptions {
  t: T;
  lang: string;
  businessName?: string;
  title?: string;
}

const num = (n: number, decimals: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const usd = (n: number) => `${n < -EPS ? '-' : ''}$${num(Math.abs(n || 0), 2)}`;
const signedUsd = (n: number) => `${n > EPS ? '+' : n < -EPS ? '-' : ''}$${num(Math.abs(n || 0), 2)}`;
/** Native-currency amount: whole units for weak currencies (LBP), 2 decimals otherwise. */
const native = (code: string, n: number, rate?: number) => {
  const whole = code === 'LBP' || (rate != null && rate >= 100);
  return `${num(n, whole ? 0 : 2)} ${code}`;
};
const qtyFmt = (n: number) => num(n, Number.isInteger(Math.round(n * 1000) / 1000) ? 0 : 2);

/**
 * Builds the HTML of the End-of-Day X-report from a settlement detail (GET /api/settlements/:id).
 * Sections: header, sales summary by payment method, cash drawer, counted cash per currency,
 * cashier shifts, cash in/out by category, sales by category and by cashier, corrections, notes.
 * Older snapshots lack the per-category/cashier data; the rebuilt breakdown fills in when present.
 */
export function buildSettlementReportHtml(detail: SettlementDetail, opts: PrintSettlementOptions): string {
  const { t, lang, businessName } = opts;
  const title = opts.title || t('fin_xr_end_of_day', 'END OF DAY');
  const report = detail.report;
  const rec: Breakdown = detail.recorded || {};
  const extra: Breakdown = detail.rebuilt || {};
  const reg = rec.register;
  const eff = effectiveOf(report);
  const adjustments = Number(report.adjustments_total || 0);
  const corrections = detail.corrections || [];
  const methodLabel = (m: string) => t(`pm_${m}`, m);

  const row = (label: string, value: string, cls = '') =>
    `<div class="row ${cls}"><span class="l">${esc(label)}</span><span class="v">${esc(value)}</span></div>`;
  const sub = (label: string, value: string) => row(label, value, 'sub');
  const section = (heading: string, body: string) => (body ? `<div class="sec"><div class="h">${esc(heading)}</div>${body}</div>` : '');

  // ── A. Header ──────────────────────────────────────────────────────
  const periodStart = rec.period_start || report.period_start;
  const periodEnd = rec.period_end || report.settled_at || report.created_at;
  const header = `
    <div class="biz">${esc(businessName || t('fin_xr_business_fallback', 'Business'))}</div>
    <h1>${esc(title)}</h1>
    <div class="meta">
      ${row(t('xr_report_no', 'Report #'), String(report.id))}
      ${row(t('xr_from', 'From'), periodStart && !periodStart.startsWith('0000') ? formatDateTime(periodStart, lang) : t('sd_period_first', 'First closing'))}
      ${periodEnd ? row(t('xr_to', 'To'), formatDateTime(periodEnd, lang)) : ''}
      ${report.user_name ? row(t('sd_closed_by', 'Closed by'), report.user_name) : ''}
      ${row(t('xr_printed', 'Printed'), formatDateTime(new Date(), lang))}
    </div>`;

  // ── B. Sales summary ──────────────────────────────────────────────
  const flow = (label: string, b: FlowBlock | undefined) => {
    if (!b) return '';
    const lines = METHODS.filter((m) => Math.abs(b.by_method?.[m] || 0) > EPS).map((m) => sub(methodLabel(m), usd(b.by_method![m]!)));
    return row(`${label} (${b.count || 0})`, usd(b.total || 0), 'b') + lines.join('');
  };
  let salesBody = '';
  if (rec.sales) {
    salesBody = flow(t('xr_sales', 'Sales'), rec.sales) + flow(t('xr_refunds', 'Refunds'), rec.refunds);
    salesBody += row(t('xr_net_sales', 'Net sales'), usd((rec.sales.total || 0) - (rec.refunds?.total || 0)), 'total');
    salesBody += flow(t('xr_purchases', 'Purchases'), rec.purchases);
  }

  // ── C. Cash drawer ────────────────────────────────────────────────
  let drawer = '';
  if (reg) {
    drawer += row(t('sd_row_opening', 'Opening balance'), usd(reg.opening));
    drawer += row(t('sd_row_cash_sales', 'Cash sales'), signedUsd(reg.cash_sales));
    if (Math.abs(reg.cash_refunds) > EPS) drawer += row(t('sd_row_cash_refunds', 'Cash refunds'), signedUsd(-reg.cash_refunds));
    if (Math.abs(reg.cash_purchases) > EPS) drawer += row(t('sd_row_cash_purchases', 'Cash purchases'), signedUsd(-reg.cash_purchases));
    drawer += row(t('sd_row_cash_in', 'Cash in'), signedUsd(reg.cash_in));
    drawer += row(t('sd_row_cash_out', 'Cash out'), signedUsd(-reg.cash_out));
    if (Math.abs(adjustments) > EPS) drawer += row(t('sd_xr_adjustments', 'Adjustments:').replace(/:\s*$/, ''), signedUsd(adjustments));
    drawer += row(t('xr_expected_cash', 'Expected cash'), usd(eff.expected), 'total');
    const byCur = rec.sales?.cash_by_currency || {};
    const curs = Object.keys(byCur).filter((c) => Math.abs(byCur[c]) > EPS);
    if (curs.length > 1 || (curs.length === 1 && curs[0] !== 'USD')) {
      drawer += `<div class="note">${esc(t('xr_cash_sales_by_currency', 'Cash sales received'))}</div>`;
      drawer += curs.map((c) => sub(c, native(c, byCur[c]))).join('');
    }
  }

  // ── D. Counted cash ───────────────────────────────────────────────
  const countedLines: CountedLine[] = detail.corrected_counted || detail.counted || [];
  let counted = countedLines
    .filter((l) => Math.abs(l.amount) > EPS || countedLines.length === 1)
    .map((l) =>
      row(
        l.currency === 'USD' ? 'USD' : `${l.currency} @ ${num(l.rate, l.rate >= 100 ? 0 : 2)}`,
        l.currency === 'USD' ? usd(l.amount) : `${native(l.currency, l.amount, l.rate)} = ${usd(l.amount_usd ?? l.amount / l.rate)}`,
      ),
    )
    .join('');
  const diff = eff.actual - eff.expected;
  counted += row(
    t('xr_total_counted', 'Total counted') + (detail.corrected_counted ? ` ${t('sd_xr_corrected_flag', '(corrected)')}` : ''),
    usd(eff.actual),
    'total',
  );
  if (detail.corrected_counted) counted += sub(t('sd_xr_original_actual', 'Originally counted:').replace(/:\s*$/, ''), usd(report.actual_balance || 0));
  counted += row(t('xr_expected_cash', 'Expected cash'), usd(eff.expected));
  counted += row(
    Math.abs(diff) <= EPS ? t('xr_balanced', 'Balanced') : diff > 0 ? t('xr_over', 'Over') : t('xr_short', 'Short'),
    signedUsd(diff),
    `total ${diff < -EPS ? 'neg' : ''}`,
  );

  // ── E. Shifts ─────────────────────────────────────────────────────
  const shifts = (rec.shifts || [])
    .map(
      (s) => `<div class="blk">
        ${row(s.user_name || '—', s.created_at ? formatDateTime(s.created_at, lang) : '', 'b')}
        ${sub(t('xr_expected', 'Expected'), usd(s.expected_cash))}
        ${sub(t('xr_counted', 'Counted'), usd(s.actual_cash))}
        ${sub(t('xr_difference', 'Difference'), signedUsd(s.difference))}
      </div>`,
    )
    .join('');

  // ── F. Cash in/out by category ────────────────────────────────────
  const cfCats = rec.cash_flow_by_category || extra.cash_flow_by_category || [];
  const catLabel = (key: string, name: string | null) =>
    (CATEGORIES as readonly string[]).includes(key) ? builtinCategoryLabel(key as Category, t) : name || key;
  const cfBlock = (type: 'in' | 'out', heading: string, total: number | undefined) => {
    const items = cfCats.filter((c) => c.type === type);
    if (!items.length) return '';
    return (
      row(heading, usd(total ?? items.reduce((s, c) => s + c.total, 0)), 'b') +
      items.map((c) => sub(`${catLabel(c.category, c.name)} (${c.count})`, usd(c.total))).join('')
    );
  };
  let cashFlow = cfBlock('in', t('sd_row_cash_in', 'Cash in'), reg?.cash_in) + cfBlock('out', t('sd_row_cash_out', 'Cash out'), reg?.cash_out);
  for (const [k, label] of [['cash_in', t('sd_row_cash_in', 'Cash in')], ['cash_out', t('sd_row_cash_out', 'Cash out')]] as const) {
    const byCur = rec[k]?.by_currency || {};
    const curs = Object.keys(byCur).filter((c) => Math.abs(byCur[c]) > EPS);
    if (curs.length > 1 || (curs.length === 1 && curs[0] !== 'USD')) {
      cashFlow += `<div class="note">${esc(label)} — ${esc(curs.map((c) => native(c, byCur[c])).join(' + '))}</div>`;
    }
  }

  // ── G. Sales by category and by cashier ───────────────────────────
  const cats = rec.sales_by_category || extra.sales_by_category || [];
  const catsBody = cats
    .filter((c) => Math.abs(c.revenue) > EPS || Math.abs(c.qty) > EPS)
    .map((c) => row(`${c.category === 'Uncategorized' ? t('xr_uncategorized', 'Uncategorized') : c.category} × ${qtyFmt(c.qty)}`, usd(c.revenue)))
    .join('');
  const cashiers = rec.cashiers || extra.cashiers || [];
  const cashiersBody = cashiers
    .map(
      (c) =>
        row(`${c.name || t('xr_unknown_user', 'Unknown')} (${c.invoices})`, usd(c.sales), 'b') +
        (Math.abs(c.refunds) > EPS ? sub(t('xr_refunds', 'Refunds'), signedUsd(-c.refunds)) : ''),
    )
    .join('');

  // ── Corrections, changes, notes ──────────────────────────────────
  const corrBody = corrections
    .map((c) => {
      const what =
        c.kind === 'counted'
          ? `${t('sd_corr_kind_counted', 'Counted cash')} ${c.currency || ''}: ${c.old_value ?? 0} → ${c.new_value ?? 0}`
          : `${t('sd_corr_kind_adjustment', 'Adjustment')}: ${signedUsd(c.amount_usd)}`;
      return `<div class="blk small"><div>${esc(what)}</div><div class="dim">${esc(c.user_name || '')} · ${esc(formatDateTime(c.created_at, lang))}</div><div>${esc(c.reason)}</div></div>`;
    })
    .join('');
  const changed = report.changed_after_close
    ? `<div class="warn">${esc(t('sd_badge_changed', 'Changed after closing'))}</div>`
    : '';
  const notes = (report.notes || '').trim();

  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  return `<!doctype html>
<html dir="${dir}" lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<title>${esc(title)} #${esc(report.id)}</title>
<style>
  @page { margin: 0; }
  body { font-family: 'Courier New', Courier, monospace; margin: 0; padding: 8px 10px; width: 280px; color: #000; font-size: 12px; }
  .biz { text-align: center; font-weight: bold; font-size: 14px; }
  h1 { text-align: center; font-size: 16px; margin: 2px 0 6px; }
  .meta { border-bottom: 1px dashed #000; padding-bottom: 6px; margin-bottom: 4px; font-size: 11px; }
  .sec { border-bottom: 1px dashed #000; padding: 6px 0; }
  .h { font-weight: bold; text-align: center; margin-bottom: 4px; letter-spacing: .5px; }
  .row { display: flex; justify-content: space-between; gap: 6px; line-height: 1.35; }
  .row .l { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .row .v { white-space: nowrap; direction: ltr; unicode-bidi: embed; }
  .row.b { font-weight: bold; margin-top: 3px; }
  .row.sub { padding-inline-start: 10px; font-size: 11px; }
  .row.total { font-weight: bold; border-top: 1px solid #000; margin-top: 3px; padding-top: 2px; }
  .row.neg .v { text-decoration: underline; }
  .note { font-size: 11px; margin-top: 4px; }
  .blk { margin-bottom: 4px; }
  .small { font-size: 11px; }
  .dim { opacity: .7; }
  .warn { text-align: center; font-weight: bold; border: 1px solid #000; padding: 2px; margin: 6px 0; }
  .foot { text-align: center; font-size: 10px; margin-top: 8px; }
</style>
</head>
<body>
  ${header}
  ${changed}
  ${section(t('xr_sec_sales', 'SALES SUMMARY'), salesBody)}
  ${section(t('xr_sec_drawer', 'CASH DRAWER'), drawer)}
  ${section(t('xr_sec_counted', 'COUNTED CASH'), counted)}
  ${section(t('xr_sec_shifts', 'SHIFTS'), shifts)}
  ${section(t('xr_sec_cash_flow', 'CASH IN / OUT'), cashFlow)}
  ${section(t('xr_sec_categories', 'SALES BY CATEGORY'), catsBody)}
  ${section(t('xr_sec_cashiers', 'SALES BY CASHIER'), cashiersBody)}
  ${section(t('sd_xr_corrections', 'CORRECTIONS'), corrBody)}
  ${notes ? section(t('sd_notes', 'Notes'), `<div class="small">${esc(notes)}</div>`) : ''}
  <div class="foot">${esc(title)} · #${esc(report.id)}</div>
</body>
</html>`;
}

/** Prints the End-of-Day X-report to the default printer, like a POS receipt (no print dialog). */
export function printSettlementReport(detail: SettlementDetail, opts: PrintSettlementOptions): Promise<PrintResult> {
  return printReportHtml(buildSettlementReportHtml(detail, opts));
}
