import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Coins, HandCoins, Landmark, PiggyBank, Receipt, Scale, X } from 'lucide-react';
import { Badge, Button, Card, DataTable, DateRangePicker, Select, SearchInput, useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, resolveDateRangePreset, type DateRange } from '../../lib/format';
import { CashFlowEditModal } from './EditModal';
import { cashFlowColumns } from './columns';
import { FitStat, STAT_GRID, cashFlowErrorMessage, categoryLabel, categoryOptions, type CashFlowRow } from './common';

interface Currency { code: string; symbol: string; rate: number }

interface Analytics {
  totals: { in: number; out: number; net: number; count: number };
  by_category: { category: string; type: 'in' | 'out'; count: number; total: number }[];
  by_counterparty: { counterparty: string; borrowed: number; repaid: number; outstanding: number }[];
  rows: CashFlowRow[];
}

const USD = { code: 'USD', symbol: '$' };
const usd = (n: number) => formatMoney(n, USD);

/** Filters + analytics cards/tables + the full (open + settled) movement list. */
export function AnalyticsPanel({ currencies }: { currencies: Currency[] }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [range, setRange] = useState<DateRange>(() => resolveDateRangePreset('this_month'));
  const [type, setType] = useState('all');
  const [category, setCategory] = useState('all');
  const [q, setQ] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<CashFlowRow | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (type !== 'all') params.set('type', type);
    if (category !== 'all') params.set('category', category);
    if (q.trim()) params.set('q', q.trim());
    if (counterparty.trim()) params.set('counterparty', counterparty.trim());
    try {
      setData(await api.get<Analytics>(`/api/cash-flow/analytics?${params.toString()}`));
    } catch (err: any) {
      toast.error(cashFlowErrorMessage(err, t));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, type, category, q, counterparty]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onSync = (e: any) => { if (e.detail?.type === 'CASH_FLOW_UPDATED') load(); };
    window.addEventListener('pos-sync', onSync);
    return () => window.removeEventListener('pos-sync', onSync);
  }, [load]);

  const filtered = type !== 'all' || category !== 'all' || q.trim() !== '' || counterparty.trim() !== '';
  const clear = () => { setType('all'); setCategory('all'); setQ(''); setCounterparty(''); };

  const stats = useMemo(() => {
    const cats = data?.by_category || [];
    const sum = (c: string) => cats.filter((x) => x.category === c).reduce((s, x) => ({ n: s.n + x.count, total: s.total + x.total }), { n: 0, total: 0 });
    const top = sum('top_up');
    const exp = sum('expense');
    const loans = data?.by_counterparty || [];
    return {
      top, exp,
      borrowed: loans.reduce((s, l) => s + l.borrowed, 0),
      repaid: loans.reduce((s, l) => s + l.repaid, 0),
      outstanding: loans.reduce((s, l) => s + l.outstanding, 0),
    };
  }, [data]);

  const columns = useMemo(
    () => cashFlowColumns({ t, lang, currencies, onEdit: setEditing }),
    [t, lang, currencies],
  );
  const dash = '—';
  const v = (n: number | undefined, sign = '') => (data && n !== undefined ? `${sign}${usd(n)}` : dash);

  return (
    <div className="flex flex-col gap-5">
      {/* Filter bar */}
      <Card className="flex flex-wrap items-end gap-3 p-3">
        <DateRangePicker value={range} onChange={(r) => setRange(r)} />
        <Select
          aria-label={t('cf_filter_type', 'Type')}
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="w-36"
          options={[
            { value: 'all', label: t('cf_all_types', 'All types') },
            { value: 'in', label: t('fin_cfr_cash_in', 'Cash In') },
            { value: 'out', label: t('fin_cfr_cash_out', 'Cash Out') },
          ]}
        />
        <Select
          aria-label={t('cf_category', 'Category')}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="w-52"
          options={[{ value: 'all', label: t('cf_all_categories', 'All categories') }, ...categoryOptions(t)]}
        />
        <SearchInput
          value={q}
          onChange={setQ}
          hotkey={false}
          placeholder={t('cf_search_placeholder', 'Search reason or counterparty…')}
          aria-label={t('cf_search_placeholder', 'Search reason or counterparty…')}
          className="min-w-[14rem] flex-1"
        />
        <input
          value={counterparty}
          onChange={(e) => setCounterparty(e.target.value)}
          placeholder={t('cf_counterparty_filter', 'Counterparty')}
          aria-label={t('cf_counterparty_filter', 'Counterparty')}
          className="h-9 w-40 rounded-[var(--radius-input)] border border-border bg-surface px-3 text-sm text-text placeholder:text-text-3 focus:border-primary focus:outline-none"
        />
        {filtered && (
          <Button variant="ghost" onClick={clear}><X size={14} /> {t('cf_clear_filters', 'Clear filters')}</Button>
        )}
      </Card>

      {/* Stat cards — 2 cols / 3 cols / 4 cols, so 8 cards are always 2+ rows; figures auto-fit. */}
      <div className={STAT_GRID}>
        <FitStat label={t('cf_total_in', 'Total in')} icon={ArrowDownLeft} tone="success" value={v(data?.totals.in, '+')} sub={data ? t('cf_movement_count', '{n} movements').replace('{n}', String(data.totals.count)) : undefined} />
        <FitStat label={t('cf_total_out', 'Total out')} icon={ArrowUpRight} tone="danger" value={v(data?.totals.out, '-')} />
        <FitStat label={t('cf_net', 'Net')} icon={Scale} tone={data && data.totals.net < 0 ? 'danger' : 'default'} value={v(data?.totals.net)} />
        <FitStat label={t('cf_topups', 'Top-ups')} icon={PiggyBank} value={v(data ? stats.top.total : undefined)} sub={data ? t('cf_topups_sub', '{n} times').replace('{n}', String(stats.top.n)) : undefined} />
        <FitStat label={t('cf_borrowed', 'Borrowed')} icon={Landmark} value={v(data ? stats.borrowed : undefined)} />
        <FitStat label={t('cf_repaid', 'Repaid')} icon={HandCoins} value={v(data ? stats.repaid : undefined)} />
        <FitStat label={t('cf_outstanding', 'Outstanding loans')} icon={Coins} tone={data && stats.outstanding > 0.005 ? 'accent' : 'default'} value={v(data ? stats.outstanding : undefined)} className="border-primary/40" />
        <FitStat label={t('cf_expenses', 'Expenses')} icon={Receipt} value={v(data ? stats.exp.total : undefined)} sub={data ? t('cf_topups_sub', '{n} times').replace('{n}', String(stats.exp.n)) : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card className="min-w-0 p-3">
          <h2 className="mb-2 text-sm font-semibold text-text">{t('cf_by_category', 'By category')}</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-[0.04em] text-text-3">
                  <th className="py-1.5 text-start font-medium">{t('cf_col_category', 'Category')}</th>
                  <th className="py-1.5 text-end font-medium">{t('cf_col_count', 'Count')}</th>
                  <th className="py-1.5 text-end font-medium">{t('cf_col_total', 'Total (USD)')}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.by_category || []).map((c) => (
                  <tr key={`${c.category}-${c.type}`} className="border-t border-border">
                    <td className="py-1.5">
                      <span className="me-2">{categoryLabel(c.category, t)}</span>
                      <Badge variant={c.type === 'in' ? 'success' : 'danger'}>{c.type === 'in' ? t('fin_cfr_cash_in', 'Cash In') : t('fin_cfr_cash_out', 'Cash Out')}</Badge>
                    </td>
                    <td className="num py-1.5 text-end">{c.count}</td>
                    <td className={['num whitespace-nowrap py-1.5 text-end font-semibold', c.type === 'in' ? 'text-success' : 'text-danger'].join(' ')}>{usd(c.total)}</td>
                  </tr>
                ))}
                {data && data.by_category.length === 0 && (
                  <tr><td colSpan={3} className="py-3 text-center text-xs text-text-3">{t('cf_list_empty', 'No movements match these filters')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="min-w-0 p-3">
          <h2 className="mb-2 text-sm font-semibold text-text">{t('cf_loans', 'Loans by counterparty')}</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-[0.04em] text-text-3">
                  <th className="py-1.5 text-start font-medium">{t('cf_counterparty_short', 'Counterparty')}</th>
                  <th className="py-1.5 text-end font-medium">{t('cf_borrowed', 'Borrowed')}</th>
                  <th className="py-1.5 text-end font-medium">{t('cf_repaid', 'Repaid')}</th>
                  <th className="py-1.5 text-end font-medium">{t('cf_outstanding', 'Outstanding loans')}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.by_counterparty || []).map((l) => (
                  <tr key={l.counterparty || '_'} className="border-t border-border">
                    <td className="py-1.5">{l.counterparty || <span className="text-text-3">{t('cf_unspecified', 'Unspecified')}</span>}</td>
                    <td className="num whitespace-nowrap py-1.5 text-end">{usd(l.borrowed)}</td>
                    <td className="num whitespace-nowrap py-1.5 text-end">{usd(l.repaid)}</td>
                    <td className={['num whitespace-nowrap py-1.5 text-end font-semibold', l.outstanding > 0.005 ? 'text-accent' : 'text-text'].join(' ')}>{usd(l.outstanding)}</td>
                  </tr>
                ))}
                {data && data.by_counterparty.length === 0 && (
                  <tr><td colSpan={4} className="py-3 text-center text-xs text-text-3">{t('cf_no_loans', 'No loans in this period.')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-text-3">{t('cf_loans_note', 'Loans are cumulative up to the end date.')}</p>
        </Card>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-text">{t('cf_list_title', 'Movements (open and settled)')}</h2>
        <DataTable
          columns={columns}
          data={data?.rows || []}
          rowKey={(r) => `${r.archived ? 'a' : 'l'}${r.id}`}
          loading={loading}
          emptyTitle={t('cf_list_empty', 'No movements match these filters')}
          emptyDescription={t('cf_list_empty_desc', 'Try a wider date range or clear the filters.')}
        />
      </div>

      <CashFlowEditModal row={editing} currencies={currencies} onClose={() => setEditing(null)} onSaved={load} />
    </div>
  );
}
