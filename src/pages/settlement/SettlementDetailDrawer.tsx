import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, Info, Plus, Printer } from 'lucide-react';
import { Badge, Button, Card, CardBody, CardHeader, Drawer } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatDate, formatDateTime, formatMoney } from '../../lib/format';
import { translateServerError } from '../../lib/serverErrors';
import { CorrectionModal, type CurrencyInfo } from './CorrectionModal';
import { printXReport } from './printXReport';
import {
  effectiveOf,
  type Breakdown,
  type CountedLine,
  type FlowBlock,
  type NativeMap,
  type SettlementDetail,
} from './types';

interface Props {
  reportId: number | null;
  onClose: () => void;
  /** Called after a correction is saved so the history list can refetch. */
  onChanged?: () => void;
  businessName?: string;
}

const USD = { code: 'USD', symbol: '$' };
const usd = (n: number | null | undefined) => formatMoney(n ?? 0, USD);
const signedUsd = (n: number) => `${n > 0 ? '+' : ''}${usd(n)}`;
const METHODS = ['cash', 'card', 'credit', 'store_credit'] as const;

const Th = ({ children, end }: { children?: React.ReactNode; end?: boolean }) => (
  <th scope="col" className={['px-3 py-2 text-xs font-medium uppercase tracking-[0.04em] text-text-3', end ? 'text-end' : 'text-start'].join(' ')}>
    {children}
  </th>
);

function Section({ title, action, children }: { title: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold text-text">{title}</h3>
        {action}
      </CardHeader>
      <CardBody dense>{children}</CardBody>
    </Card>
  );
}

export function SettlementDetailDrawer({ reportId, onClose, onChanged, businessName }: Props) {
  const { t, lang } = useI18n();
  const [detail, setDetail] = useState<SettlementDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [currencies, setCurrencies] = useState<CurrencyInfo[]>([]);
  const [corrOpen, setCorrOpen] = useState(false);

  const load = useCallback(async () => {
    if (reportId == null) return;
    setLoading(true);
    setError('');
    try {
      setDetail(await api.get<SettlementDetail>(`/api/settlements/${reportId}`));
    } catch (err: any) {
      setError(translateServerError(err, t) || t('sd_load_failed', 'Could not load this settlement.'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId]);

  useEffect(() => {
    setDetail(null);
    setCorrOpen(false);
    if (reportId != null) load();
  }, [reportId, load]);

  useEffect(() => {
    if (reportId == null) return;
    api
      .get<CurrencyInfo[]>('/api/currencies')
      .then((c) => Array.isArray(c) && setCurrencies(c))
      .catch(() => {});
  }, [reportId]);

  const symbolFor = (code: string) => currencies.find((c) => c.code === code)?.symbol || code;
  const native = (code: string, n: number) => formatMoney(n, { code, symbol: symbolFor(code) });
  const methodLabel = (m: string) => t(`pm_${m}`, m);

  const open = reportId != null;
  const report = detail?.report;
  const eff = report ? effectiveOf(report) : null;
  const recorded: Breakdown | null = detail?.recorded ?? null;
  const rebuilt: Breakdown | null = detail?.rebuilt ?? null;
  const corrections = detail?.corrections ?? [];
  const hasCorrections = corrections.length > 0;
  const changes = detail?.changes;
  const legacy = !!recorded?.legacy;

  const diffLabel = (path: string) => {
    if (path === 'sales.total') return t('sd_diff_sales_total', 'Sales total');
    if (path === 'refunds.total') return t('sd_diff_refunds_total', 'Refunds total');
    if (path === 'purchases.total') return t('sd_diff_purchases_total', 'Purchases total');
    if (path === 'register.expected') return t('sd_diff_register_expected', 'Expected cash');
    const m = path.match(/^sales\.by_method\.(\w+)$/);
    if (m) return t('sd_diff_sales_method', 'Sales — {method}').replace('{method}', methodLabel(m[1]));
    return path;
  };

  const handlePrint = () => {
    if (!report) return;
    printXReport(report, { t, lang, title: t('fin_xr_daily_report', 'DAILY X-REPORT'), businessName, corrections });
  };

  // ── Cash register card ────────────────────────────────────────────
  const regRows: { label: string; key: keyof NonNullable<Breakdown['register']>; sign: '+' | '-' | '' ; strong?: boolean }[] = [
    { label: t('sd_row_opening', 'Opening balance'), key: 'opening', sign: '' },
    { label: t('sd_row_cash_sales', 'Cash sales'), key: 'cash_sales', sign: '+' },
    { label: t('sd_row_cash_refunds', 'Cash refunds'), key: 'cash_refunds', sign: '-' },
    { label: t('sd_row_cash_purchases', 'Cash purchases'), key: 'cash_purchases', sign: '-' },
    { label: t('sd_row_cash_in', 'Cash in'), key: 'cash_in', sign: '+' },
    { label: t('sd_row_cash_out', 'Cash out'), key: 'cash_out', sign: '-' },
  ];
  const adjustments = report?.adjustments_total ?? 0;
  const showRebuilt = !!rebuilt?.register && !legacy;
  const regCell = (b: Breakdown | null, key: keyof NonNullable<Breakdown['register']>, sign: string) => {
    const v = b?.register?.[key];
    if (v == null) return '—';
    return `${sign}${usd(v)}`;
  };
  const diffClass = (d: number) => (Math.abs(d) < 0.005 ? 'text-text-3' : d > 0 ? 'text-success' : 'text-danger');
  const recExpected = recorded?.register?.expected ?? report?.closing_balance ?? 0;
  const recCounted = report?.actual_balance ?? 0;
  const recDiff = report?.difference ?? recCounted - recExpected;
  const rebExpected = rebuilt?.register?.expected;

  // ── Counted per currency ──────────────────────────────────────────
  const originalCounted: CountedLine[] = detail?.counted ?? [];
  const correctedCounted = detail?.corrected_counted ?? null;
  const countedCodes = Array.from(new Set([...originalCounted.map((l) => l.currency), ...(correctedCounted ?? []).map((l) => l.currency)]));

  const nativeList = (m?: NativeMap) => {
    const entries = Object.entries(m || {}).filter(([, v]) => Math.abs(v) > 0.000001);
    return entries.length ? entries : null;
  };

  const flowCard = (title: string, block: FlowBlock | undefined) => (
    <Section
      title={title}
      action={block ? <span className="text-xs text-text-3">{t('sd_count_label', '{n} documents').replace('{n}', String(block.count ?? 0))}</span> : undefined}
    >
      {!block ? (
        <p className="text-sm text-text-3">—</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-text-2">{t('sd_total', 'Total')}</span>
            <span className="num text-lg font-bold text-text">{usd(block.total)}</span>
          </div>
          {block.by_method && (
            <dl className="flex flex-col gap-1 border-t border-border pt-2 text-sm">
              <dt className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">{t('sd_by_method', 'By payment method')}</dt>
              {METHODS.map((m) => (
                <div key={m} className="flex justify-between">
                  <dd className="text-text-2">{methodLabel(m)}</dd>
                  <dd className="num font-medium text-text">{usd(block.by_method?.[m] ?? 0)}</dd>
                </div>
              ))}
              {/* Invoice totals not covered by any payment (left open on the customer's / supplier's account). */}
              {(() => {
                const paid = METHODS.reduce((sum, m) => sum + (block.by_method?.[m] ?? 0), 0);
                const unpaid = (block.total ?? 0) - paid;
                return unpaid > 0.005 ? (
                  <div className="flex justify-between">
                    <dd className="text-text-2">{t('sd_unpaid', 'Unpaid')}</dd>
                    <dd className="num font-medium text-text">{usd(unpaid)}</dd>
                  </div>
                ) : null;
              })()}
            </dl>
          )}
          {nativeList(block.cash_by_currency) && (
            <dl className="flex flex-col gap-1 border-t border-border pt-2 text-sm">
              <dt className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">{t('sd_cash_by_currency', 'Cash by currency')}</dt>
              {nativeList(block.cash_by_currency)!.map(([code, v]) => (
                <div key={code} className="flex justify-between">
                  <dd className="text-text-2">{code}</dd>
                  <dd className="num font-medium text-text">{native(code, v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </Section>
  );

  const moveBlock = (label: string, b?: { total: number; by_currency?: NativeMap }) => (
    <div className="flex flex-col gap-1 rounded-[var(--radius-input)] bg-surface-2 p-3">
      <span className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">{label}</span>
      <span className="num text-base font-bold text-text">{usd(b?.total ?? 0)}</span>
      {nativeList(b?.by_currency)?.map(([code, v]) => (
        <span key={code} className="num text-xs text-text-3">{native(code, v)}</span>
      ))}
    </div>
  );

  const body = () => {
    if (loading && !detail) return <p className="py-16 text-center text-sm italic text-text-3">{t('sd_loading', 'Loading settlement…')}</p>;
    if (error && !detail) {
      return (
        <div className="flex flex-col items-center gap-3 py-16 text-center" role="alert">
          <p className="text-sm text-danger">{error}</p>
          <Button variant="secondary" size="sm" onClick={load}>{t('sd_retry', 'Retry')}</Button>
        </div>
      );
    }
    if (!detail || !report || !eff) return null;

    const period = recorded?.period_start || report.period_start;
    const periodEnd = recorded?.period_end || report.settled_at;

    return (
      <div className="flex flex-col gap-4">
        {/* Header */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <span className="block text-xs text-text-3">{t('sd_closed_by', 'Closed by')}</span>
            <span className="text-sm font-medium text-text">{report.user_name || '—'}</span>
          </div>
          <div>
            <span className="block text-xs text-text-3">{t('sd_closed_at', 'Closed at')}</span>
            <span className="text-sm font-medium text-text">{report.settled_at ? formatDateTime(report.settled_at, lang) : formatDate(report.date, lang)}</span>
          </div>
          <div>
            <span className="block text-xs text-text-3">{t('sd_period', 'Register period')}</span>
            <span className="text-sm font-medium text-text">
              {period
                ? `${/^0000-|^2000-01-01/.test(String(period)) ? t('sd_period_first', 'First closing') : formatDateTime(period, lang)} ${t('sd_period_until', 'until')} ${periodEnd ? formatDateTime(periodEnd, lang) : '—'}`
                : t('sd_period_unknown', 'Not recorded')}
            </span>
          </div>
        </div>
        {report.notes && (
          <p className="rounded-[var(--radius-input)] bg-surface-2 px-3 py-2 text-sm text-text-2">
            <span className="font-medium text-text">{t('sd_notes', 'Notes')}: </span>{report.notes}
          </p>
        )}

        {legacy && (
          <div className="flex items-start gap-2 rounded-[var(--radius-input)] border border-border bg-surface-2 px-3 py-2 text-sm text-text-2">
            <Info size={16} className="mt-0.5 shrink-0 text-text-3" />
            <span>{t('sd_legacy_note', 'Closed before detailed snapshots were recorded — showing what was saved at closing.')}</span>
          </div>
        )}

        {/* Changed after closing */}
        {changes?.changed && (
          <section role="alert" className="rounded-[var(--radius-card)] border border-accent/40 bg-accent-soft p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-accent">
              <AlertTriangle size={16} /> {t('sd_changed_title', 'Totals changed after closing')}
            </h3>
            <p className="mt-1 text-xs text-text-2">{t('sd_changed_desc', 'Invoices were edited or paid after this day was closed. The figures recorded at closing were not changed; the rebuilt figures below show the current picture.')}</p>

            {changes.diffs.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr><Th>{t('sd_diff_item', 'Figure')}</Th><Th end>{t('sd_diff_recorded', 'Recorded')}</Th><Th end>{t('sd_diff_now', 'Now')}</Th><Th end>{t('sd_diff_change', 'Change')}</Th></tr>
                  </thead>
                  <tbody>
                    {changes.diffs.map((d) => (
                      <tr key={d.path} className="border-t border-accent/20">
                        <td className="px-3 py-1.5 text-text">{diffLabel(d.path)}</td>
                        <td className="num px-3 py-1.5 text-end text-text-2">{usd(d.recorded)}</td>
                        <td className="num px-3 py-1.5 text-end font-semibold text-text">{usd(d.rebuilt)}</td>
                        <td className={['num px-3 py-1.5 text-end font-semibold', d.rebuilt - d.recorded > 0 ? 'text-success' : 'text-danger'].join(' ')}>{signedUsd(d.rebuilt - d.recorded)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {changes.edited_invoices.length > 0 && (
              <div className="mt-3">
                <h4 className="mb-1 text-xs font-medium uppercase tracking-[0.04em] text-text-3">{t('sd_edited_invoices', 'Edited invoices')}</h4>
                <ul className="flex flex-col divide-y divide-accent/20">
                  {changes.edited_invoices.map((e, i) => (
                    <li key={`${e.transaction_id}-${i}`} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2 text-sm">
                      <div className="min-w-0">
                        <a href={`/dashboard/invoices?id=${e.transaction_id}`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                          {t('sd_invoice', 'Invoice #{id}').replace('{id}', String(e.transaction_id))} <ExternalLink size={12} className="rtl:-scale-x-100" />
                        </a>
                        <span className="block text-xs text-text-3">
                          {t('sd_edited_by_at', '{user} · {date}').replace('{user}', e.user_name || '—').replace('{date}', formatDateTime(e.edited_at, lang))}
                        </span>
                        {e.reason && <span className="block text-xs text-text-2">{e.reason}</span>}
                      </div>
                      <span className="num whitespace-nowrap text-sm text-text-2">
                        {usd(e.before_total)} <span aria-hidden="true" className="rtl:hidden">→</span><span aria-hidden="true" className="hidden rtl:inline">←</span> <span className="font-semibold text-text">{usd(e.after_total)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {changes.late_payments.length > 0 && (
              <div className="mt-3">
                <h4 className="mb-1 text-xs font-medium uppercase tracking-[0.04em] text-text-3">{t('sd_late_payments', 'Payments added after closing')}</h4>
                <p className="mb-1 text-xs text-text-2">{t('sd_late_payments_note', 'These payments went into a later register and are not part of this day’s cash.')}</p>
                <ul className="flex flex-col divide-y divide-accent/20">
                  {changes.late_payments.map((p, i) => (
                    <li key={`${p.transaction_id}-${i}`} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                      <span className="min-w-0">
                        <a href={`/dashboard/invoices?id=${p.transaction_id}`} className="font-medium text-primary hover:underline">
                          {t('sd_invoice', 'Invoice #{id}').replace('{id}', String(p.transaction_id))}
                        </a>
                        <span className="ms-2 text-xs text-text-3">{methodLabel(p.method)} · {formatDateTime(p.created_at, lang)}</span>
                      </span>
                      <span className="num font-semibold text-text">{usd(p.amount_usd)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {/* Cash register */}
        <Section title={t('sd_register_title', 'Cash register')}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>{t('sd_col_line', 'Line')}</Th>
                  <Th end>{t('sd_col_recorded', 'Recorded at closing')}</Th>
                  {showRebuilt && <Th end>{t('sd_col_rebuilt', 'Rebuilt now')}</Th>}
                  {hasCorrections && <Th end>{t('sd_col_corrected', 'After corrections')}</Th>}
                </tr>
              </thead>
              <tbody>
                {regRows.map((r) => (
                  <tr key={r.key} className="border-t border-border">
                    <td className="px-3 py-1.5 text-text-2">{r.label}</td>
                    <td className="num px-3 py-1.5 text-end text-text">{regCell(recorded, r.key, r.sign)}</td>
                    {showRebuilt && <td className="num px-3 py-1.5 text-end text-text">{regCell(rebuilt, r.key, r.sign)}</td>}
                    {hasCorrections && <td className="num px-3 py-1.5 text-end text-text-3">{regCell(recorded, r.key, r.sign)}</td>}
                  </tr>
                ))}
                {(hasCorrections || adjustments !== 0) && (
                  <tr className="border-t border-border">
                    <td className="px-3 py-1.5 text-text-2">{t('sd_row_adjustments', 'Adjustments')}</td>
                    <td className="num px-3 py-1.5 text-end text-text-3">—</td>
                    {showRebuilt && <td className="num px-3 py-1.5 text-end text-text-3">—</td>}
                    {hasCorrections && <td className="num px-3 py-1.5 text-end text-text">{adjustments === 0 ? usd(0) : signedUsd(adjustments)}</td>}
                  </tr>
                )}
                <tr className="border-t-2 border-border bg-surface-2 font-semibold">
                  <td className="px-3 py-1.5 text-text">{t('sd_row_expected', 'Expected')}</td>
                  <td className="num px-3 py-1.5 text-end text-text">{usd(recExpected)}</td>
                  {showRebuilt && <td className="num px-3 py-1.5 text-end text-text">{rebExpected == null ? '—' : usd(rebExpected)}</td>}
                  {hasCorrections && <td className="num px-3 py-1.5 text-end text-text">{usd(eff.expected)}</td>}
                </tr>
                <tr className="border-t border-border">
                  <td className="px-3 py-1.5 text-text-2">{t('sd_row_counted', 'Counted')}</td>
                  <td className="num px-3 py-1.5 text-end text-text">{usd(recCounted)}</td>
                  {showRebuilt && <td className="num px-3 py-1.5 text-end text-text-3">{usd(recCounted)}</td>}
                  {hasCorrections && <td className="num px-3 py-1.5 text-end text-text">{usd(eff.actual)}</td>}
                </tr>
                <tr className="border-t border-border">
                  <td className="px-3 py-1.5 font-semibold text-text">{t('sd_row_difference', 'Difference')}</td>
                  <td className={['num px-3 py-1.5 text-end font-semibold', diffClass(recDiff)].join(' ')}>{signedUsd(recDiff)}</td>
                  {showRebuilt && (
                    <td className={['num px-3 py-1.5 text-end font-semibold', diffClass(recCounted - (rebExpected ?? recExpected))].join(' ')}>
                      {signedUsd(recCounted - (rebExpected ?? recExpected))}
                    </td>
                  )}
                  {hasCorrections && <td className={['num px-3 py-1.5 text-end font-semibold', diffClass(eff.difference)].join(' ')}>{signedUsd(eff.difference)}</td>}
                </tr>
              </tbody>
            </table>
          </div>
          {!legacy && !rebuilt && <p className="mt-2 text-xs text-text-3">{t('sd_no_rebuild', 'The closed transactions of this day could not be rebuilt, so only the recorded figures are shown.')}</p>}
        </Section>

        {/* Counted per currency */}
        <Section title={t('sd_counted_title', 'Counted cash by currency')}>
          {countedCodes.length === 0 ? (
            <p className="text-sm text-text-3">{t('sd_counted_empty', 'The per-currency count was not recorded for this closing.')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <Th>{t('sd_col_currency', 'Currency')}</Th>
                    <Th end>{t('sd_col_original', 'Counted')}</Th>
                    <Th end>{t('sd_col_rate', 'Rate')}</Th>
                    <Th end>{t('sd_col_usd', 'USD')}</Th>
                    {correctedCounted && <Th end>{t('sd_col_corrected_count', 'Corrected')}</Th>}
                    {correctedCounted && <Th end>{t('sd_col_usd', 'USD')}</Th>}
                  </tr>
                </thead>
                <tbody>
                  {countedCodes.map((code) => {
                    const o = originalCounted.find((l) => l.currency === code);
                    const c = correctedCounted?.find((l) => l.currency === code);
                    const oUsd = o ? o.amount_usd ?? o.amount / (o.rate || 1) : 0;
                    const cUsd = c ? c.amount_usd ?? c.amount / (c.rate || 1) : 0;
                    const changed = !!c && Math.abs((c.amount ?? 0) - (o?.amount ?? 0)) > 0.0001;
                    return (
                      <tr key={code} className="border-t border-border">
                        <td className="px-3 py-1.5 font-medium text-text">{code}</td>
                        <td className="num px-3 py-1.5 text-end text-text">{o ? native(code, o.amount) : '—'}</td>
                        <td className="num px-3 py-1.5 text-end text-text-3">{o ? o.rate : '—'}</td>
                        <td className="num px-3 py-1.5 text-end text-text">{o ? usd(oUsd) : '—'}</td>
                        {correctedCounted && <td className={['num px-3 py-1.5 text-end', changed ? 'font-semibold text-primary' : 'text-text'].join(' ')}>{c ? native(code, c.amount) : '—'}</td>}
                        {correctedCounted && <td className={['num px-3 py-1.5 text-end', changed ? 'font-semibold text-primary' : 'text-text'].join(' ')}>{c ? usd(cUsd) : '—'}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Sales / refunds / purchases (rebuilt = whole-day truth; fall back to what was recorded) */}
        {flowCard(t('sd_sales', 'Sales'), (rebuilt ?? recorded)?.sales)}
        {flowCard(t('sd_refunds', 'Refunds'), (rebuilt ?? recorded)?.refunds)}
        {flowCard(t('sd_purchases', 'Purchases'), (rebuilt ?? recorded)?.purchases)}

        {/* Cash in / out */}
        {((rebuilt ?? recorded)?.cash_in || (rebuilt ?? recorded)?.cash_out) && (
          <Section title={t('sd_cash_moves_title', 'Manual cash in / out')}>
            <div className="grid grid-cols-2 gap-3">
              {moveBlock(t('sd_cash_in', 'Cash in'), (rebuilt ?? recorded)?.cash_in)}
              {moveBlock(t('sd_cash_out', 'Cash out'), (rebuilt ?? recorded)?.cash_out)}
            </div>
          </Section>
        )}

        {/* Shifts (snapshot) */}
        <Section title={t('sd_shifts_title', 'Cashier shifts of the day')}>
          {!recorded?.shifts?.length ? (
            <p className="text-sm text-text-3">{t('sd_shifts_empty', 'No shifts were recorded.')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <Th>{t('fin_stl_cashier', 'Cashier')}</Th>
                    <Th end>{t('fin_stl_expected', 'Expected')}</Th>
                    <Th end>{t('fin_stl_actual', 'Actual')}</Th>
                    <Th end>{t('fin_stl_diff', 'Difference')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {recorded.shifts.map((s, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="px-3 py-1.5 text-text">
                        {s.user_name}
                        {s.created_at && <span className="ms-2 text-xs text-text-3">{formatDateTime(s.created_at, lang)}</span>}
                      </td>
                      <td className="num px-3 py-1.5 text-end text-text">{usd(s.expected_cash)}</td>
                      <td className="num px-3 py-1.5 text-end text-text">{usd(s.actual_cash)}</td>
                      <td className={['num px-3 py-1.5 text-end font-semibold', diffClass(s.difference)].join(' ')}>{signedUsd(s.difference)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Corrections history */}
        <Section
          title={t('sd_corrections_title', 'Corrections')}
          action={
            <Button variant="secondary" size="sm" onClick={() => setCorrOpen(true)}>
              <Plus size={14} /> {t('sd_add_correction', 'Add correction')}
            </Button>
          }
        >
          {corrections.length === 0 ? (
            <p className="text-sm text-text-3">{t('sd_corrections_empty', 'No corrections have been made to this settlement.')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {corrections.map((c) => (
                <li key={c.id} className="flex flex-col gap-0.5 py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2 font-medium text-text">
                      <Badge variant="primary">{c.kind === 'counted' ? t('sd_corr_kind_counted', 'Counted cash') : t('sd_corr_kind_adjustment', 'Adjustment')}</Badge>
                      {c.kind === 'counted' ? (
                        <span className="num">
                          {c.currency}: {native(c.currency || 'USD', c.old_value ?? 0)} <span aria-hidden="true" className="rtl:hidden">→</span><span aria-hidden="true" className="hidden rtl:inline">←</span> {native(c.currency || 'USD', c.new_value ?? 0)}
                        </span>
                      ) : (
                        <span className="num">
                          {c.amount_usd >= 0 ? t('sd_corr_adjustment_in', 'Cash in') : t('sd_corr_adjustment_out', 'Cash out')}{' '}
                          {c.currency && c.currency !== 'USD' && c.new_value != null ? `${native(c.currency, Math.abs(c.new_value))} · ` : ''}
                          {usd(Math.abs(c.amount_usd))}
                        </span>
                      )}
                    </span>
                    {c.kind === 'counted' && <span className={['num text-xs font-semibold', diffClass(c.amount_usd)].join(' ')}>{signedUsd(c.amount_usd)}</span>}
                  </div>
                  <span className="text-xs text-text-3">{t('sd_corr_by_at', '{user} · {date}').replace('{user}', c.user_name || '—').replace('{date}', formatDateTime(c.created_at, lang))}</span>
                  <span className="text-xs text-text-2"><span className="font-medium">{t('sd_corr_reason', 'Reason')}:</span> {c.reason}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-text-3">{t('sd_corrections_note', 'Original figures are never overwritten; corrections are listed here and reflected in the “After corrections” column.')}</p>
          <p className="mt-1 text-xs text-text-3">{t('sd_latest_close_note', 'If this is the latest closing, the open register’s opening balance follows the corrected counted cash.')}</p>
        </Section>

        <CorrectionModal
          open={corrOpen}
          onClose={() => setCorrOpen(false)}
          reportId={report.id}
          detail={detail}
          currencies={currencies}
          onSaved={() => {
            load();
            onChanged?.();
          }}
        />
      </div>
    );
  };

  return (
    <Drawer
      open={open}
      // Esc/backdrop while the correction dialog is open should only close the dialog.
      onClose={() => {
        if (!corrOpen) onClose();
      }}
      size="lg"
      title={
        <span className="flex flex-wrap items-center gap-2">
          {t('sd_title', 'Settlement details')}
          {report && <span className="text-sm font-normal text-text-3">{formatDate(report.date, lang)}</span>}
          {report && (report.corrections_count ?? corrections.length) > 0 && <Badge variant="primary">{t('sd_badge_corrected', 'Corrected')}</Badge>}
          {changes?.changed && <Badge variant="warning">{t('sd_badge_changed', 'Changed after closing')}</Badge>}
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={handlePrint} disabled={!report}>
            <Printer size={15} /> {t('sd_print', 'Print X-Report')}
          </Button>
          <Button variant="primary" onClick={onClose}>{t('sd_close', 'Close')}</Button>
        </>
      }
    >
      {body()}
    </Drawer>
  );
}

export default SettlementDetailDrawer;
