import { formatDate, formatDateTime } from '../../lib/format';
import { effectiveOf, type SettlementCorrection } from './types';

type T = (key: string, fallback?: string) => string;

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export interface PrintXReportOptions {
  t: T;
  lang: string;
  title: string;
  businessName?: string;
  /** Corrections to list under the totals (from GET /api/settlements/:id). */
  corrections?: SettlementCorrection[];
}

/** Prints a thermal-style X report. Uses effective (post-correction) expected/actual/difference when present. */
export function printXReport(report: any, opts: PrintXReportOptions) {
  const { t, lang, title, businessName } = opts;
  const corrections = opts.corrections || [];
  const printWindow = window.open('', '_blank');
  if (!printWindow) return;

  const eff = effectiveOf(report);
  const expected = eff.expected || 0;
  const actual = eff.actual || 0;
  const diff = actual - expected;
  const adjustments = Number(report.adjustments_total || 0);
  const isCorrected = report.corrected_actual_balance != null || adjustments !== 0 || corrections.length > 0;
  const usd = (n: number) => `$${Math.abs(n || 0).toFixed(2)}`;
  const signed = (n: number) => `${n >= 0 ? '+' : '-'}${usd(n)}`;

  const correctionRows = corrections
    .map((c) => {
      const what =
        c.kind === 'counted'
          ? `${t('sd_corr_kind_counted', 'Counted cash')} ${esc(c.currency || '')}: ${c.old_value ?? 0} → ${c.new_value ?? 0}`
          : `${t('sd_corr_kind_adjustment', 'Adjustment')}: ${signed(c.amount_usd)}`;
      return `<div style="font-size:11px;margin-bottom:6px"><div>${what}</div><div style="opacity:.7">${esc(c.user_name || '')} · ${esc(formatDateTime(c.created_at, lang))}</div><div>${esc(c.reason)}</div></div>`;
    })
    .join('');

  printWindow.document.write(`
      <html>
        <head>
          <title>${esc(title)} - ${esc(report.date)}</title>
          <style>
            body { font-family: 'Courier New', Courier, monospace; padding: 20px; width: 300px; }
            h1 { text-align: center; font-size: 18px; margin-bottom: 5px; }
            .meta { text-align: center; font-size: 12px; margin-bottom: 20px; border-bottom: 1px dashed #000; padding-bottom: 10px; }
            .row { display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 14px; }
            .total { border-top: 1px solid #000; margin-top: 10px; padding-top: 10px; font-weight: bold; }
            .diff { color: ${diff < 0 ? 'red' : 'green'}; }
            .footer { margin-top: 30px; text-align: center; font-size: 10px; opacity: 0.5; }
          </style>
        </head>
        <body>
          <h1>${esc(title)}</h1>
          <div class="meta">
            ${t('fin_xr_date', 'Date')}: ${esc(formatDate(report.date, lang))}<br>
            ${t('fin_xr_time', 'Time')}: ${esc(new Date().toLocaleTimeString(lang === 'ar' ? 'ar-LB' : lang === 'fr' ? 'fr-FR' : 'en-US'))}
          </div>
          <div class="row"><span>${t('fin_xr_opening_bal', 'Opening Bal:')}</span> <span>$${(report.opening_balance || 0).toFixed(2)}</span></div>
          <div class="row"><span>${t('fin_xr_cash_sales', 'Cash Sales:')}</span> <span>+$${(report.total_sales || 0).toFixed(2)}</span></div>
          ${(report.total_refunds || 0) > 0 ? `<div class="row"><span>${t('fin_xr_cash_refunds', 'Cash Refunds:')}</span> <span>-$${report.total_refunds.toFixed(2)}</span></div>` : ''}
          <div class="row"><span>${t('fin_xr_cash_purchases', 'Cash Purchases:')}</span> <span>-$${(report.total_purchases || 0).toFixed(2)}</span></div>
          <div class="row"><span>${t('fin_xr_manual_in', 'Manual In:')}</span> <span>+$${(report.total_cash_in || 0).toFixed(2)}</span></div>
          <div class="row"><span>${t('fin_xr_manual_out', 'Manual Out:')}</span> <span>-$${(report.total_cash_out || 0).toFixed(2)}</span></div>
          ${adjustments !== 0 ? `<div class="row"><span>${t('sd_xr_adjustments', 'Adjustments:')}</span> <span>${signed(adjustments)}</span></div>` : ''}
          <div class="row total"><span>${t('fin_xr_expected_bal', 'Expected Bal:')}</span> <span>$${expected.toFixed(2)}</span></div>
          <div class="row"><span>${t('fin_xr_actual_bal', 'Actual Bal:')}${isCorrected && report.corrected_actual_balance != null ? ' ' + t('sd_xr_corrected_flag', '(corrected)') : ''}</span> <span>$${actual.toFixed(2)}</span></div>
          ${report.corrected_actual_balance != null ? `<div class="row" style="font-size:11px;opacity:.7"><span>${t('sd_xr_original_actual', 'Originally counted:')}</span> <span>$${(report.actual_balance || 0).toFixed(2)}</span></div>` : ''}
          <div class="row total"><span>${t('fin_xr_difference', 'Difference:')}</span> <span class="diff">${diff >= 0 ? '+' : ''}${diff.toFixed(2)}</span></div>
          ${correctionRows ? `<div style="margin-top: 15px; border-top: 1px dashed #000; padding-top: 5px;"><strong style="font-size:12px">${t('sd_xr_corrections', 'CORRECTIONS')}</strong><div style="margin-top:4px">${correctionRows}</div></div>` : ''}
          ${report.notes ? `<div style="margin-top: 15px; font-size: 12px; border-top: 1px dashed #000; padding-top: 5px;"><strong>${t('fin_xr_notes', 'Notes:')}</strong><br>${esc(report.notes)}</div>` : ''}
          <div class="footer">${esc(businessName || t('fin_xr_business_fallback', 'Business'))}<br>${esc(title)}</div>
          <script>window.print(); window.close();<\/script>
        </body>
      </html>
    `);
}
