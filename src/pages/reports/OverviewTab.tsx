import React, { useEffect, useMemo, useState } from 'react';
import {
  Banknote, TrendingUp, PackageMinus, Receipt, Percent, RotateCcw,
  ShoppingCart, Wallet, ArrowDownToLine, ArrowUpFromLine, Boxes,
} from 'lucide-react';
import { Card, CardHeader, CardBody, StatCard, Select, Skeleton } from '../../components/ui';
import { LineChart } from '../../components/ui/charts/LineChart';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, formatPercent } from '../../lib/format';
import { ReportToolbar } from './ReportToolbar';
import { exportRowsToExcel, exportRowsToPdf, type ExportColumn } from './exportUtils';
import type { ReportTabProps, ReportSummary, ProfitAndLoss, SalesTrendPoint } from './types';

interface PlLine {
  line: string;
  amount: number;
  pct: string;
}

function daysBetween(from: string, to: string): number {
  const a = new Date(from + 'T00:00:00Z').getTime();
  const b = new Date(to + 'T00:00:00Z').getTime();
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

function autoGroup(from: string, to: string): 'day' | 'week' | 'month' {
  const n = daysBetween(from, to);
  if (n <= 45) return 'day';
  if (n <= 210) return 'week';
  return 'month';
}

export function OverviewTab({ range, localCurrency, businessName }: ReportTabProps) {
  const { t } = useI18n();
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [pl, setPl] = useState<ProfitAndLoss | null>(null);
  const [trend, setTrend] = useState<SalesTrendPoint[]>([]);
  const [group, setGroup] = useState<'day' | 'week' | 'month'>(() => autoGroup(range.from, range.to));
  const [groupTouched, setGroupTouched] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!groupTouched) setGroup(autoGroup(range.from, range.to));
  }, [range.from, range.to, groupTouched]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.get<ReportSummary>('/api/reports/summary', { from: range.from, to: range.to }),
      api.get<ProfitAndLoss>('/api/reports/profit-and-loss', { from: range.from, to: range.to }),
      api.get<SalesTrendPoint[]>('/api/reports/sales-trend', { from: range.from, to: range.to, group }),
    ])
      .then(([s, p, tr]) => {
        if (cancelled) return;
        setSummary(s);
        setPl(p);
        setTrend(tr);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to, group]);

  const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });
  const local = (n: number) =>
    localCurrency ? formatMoney(n * (localCurrency.rate || 1), localCurrency) : null;

  const trendLabels = useMemo(() => trend.map((p) => p.period), [trend]);

  const revenuePct = (n: number) => (pl && pl.revenue ? formatPercent((n / pl.revenue) * 100) : '—');

  const exportMeta = {
    fileName: `pl-statement-${range.from}_${range.to}`,
    title: t('rep_tab_overview', 'Overview / P&L'),
    subtitle: `${range.from} – ${range.to}`,
    businessName,
  };

  const plColumns: ExportColumn<PlLine>[] = [
    { key: 'line', header: t('rep_pl_line', 'Line'), value: (r) => r.line },
    { key: 'amount', header: t('rep_pl_amount', 'Amount (USD)'), value: (r) => r.amount, align: 'right' },
    { key: 'pct', header: t('rep_pl_pct_revenue', '% of revenue'), value: (r) => r.pct, align: 'right' },
  ];

  const plRows: PlLine[] = pl
    ? [
        { line: t('rep_pl_revenue', 'Revenue'), amount: pl.revenue, pct: revenuePct(pl.revenue) },
        { line: t('rep_pl_cogs', 'COGS'), amount: pl.cogs, pct: revenuePct(pl.cogs) },
        { line: t('rep_pl_gross_profit', 'Gross profit'), amount: pl.gross_profit, pct: revenuePct(pl.gross_profit) },
        { line: t('rep_pl_expenses', 'Expenses'), amount: pl.expenses, pct: revenuePct(pl.expenses) },
        { line: t('rep_pl_net_profit', 'Net profit'), amount: pl.net_profit, pct: revenuePct(pl.net_profit) },
      ]
    : [];

  if (loading && !summary) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-[var(--radius-card)]" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-[var(--radius-card)]" />
      </div>
    );
  }

  if (!summary || !pl) return null;

  return (
    <div id="printable-report" className="space-y-4">
      <div className="hidden print:block mb-2">
        <p className="text-lg font-bold">{businessName || 'OmniPOS'}</p>
        <p className="text-xs text-text-3">
          {t('rep_tab_overview', 'Overview / P&L')} · {range.from} – {range.to}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        <StatCard label={t('rep_kpi_net_sales', 'Net sales')} value={usd(summary.net_sales)} icon={Banknote} />
        <StatCard
          label={t('rep_kpi_gross_profit', 'Gross profit')}
          value={usd(summary.gross_profit)}
          delta={summary.margin_pct}
          icon={TrendingUp}
        />
        <StatCard label={t('rep_kpi_cogs', 'COGS')} value={usd(summary.cogs)} icon={PackageMinus} />
        <StatCard
          label={t('rep_kpi_transactions', 'Transactions')}
          value={summary.tx_count}
          icon={Receipt}
        />
        <StatCard label={t('rep_kpi_avg_ticket', 'Avg. ticket')} value={usd(summary.avg_ticket)} icon={Percent} />
        <StatCard label={t('rep_kpi_discounts', 'Discounts')} value={usd(summary.discounts)} icon={Percent} />
        <StatCard label={t('rep_kpi_refunds', 'Refunds')} value={usd(summary.refunds)} icon={RotateCcw} />
        <StatCard label={t('rep_kpi_purchases', 'Purchases')} value={usd(summary.purchases)} icon={ShoppingCart} />
        <StatCard label={t('rep_kpi_collected', 'Cash collected')} value={usd(summary.collected)} icon={Wallet} />
        <StatCard label={t('rep_kpi_receivables', 'Receivables')} value={usd(summary.receivables)} icon={ArrowDownToLine} />
        <StatCard label={t('rep_kpi_payables', 'Payables')} value={usd(summary.payables)} icon={ArrowUpFromLine} />
        <StatCard
          label={t('rep_kpi_inventory_value', 'Inventory value')}
          value={usd(summary.inventory_value_cost)}
          icon={Boxes}
        />
      </div>

      <Card>
        <CardHeader className="print:hidden">
          <h3 className="text-sm font-semibold text-text">{t('rep_sales_trend', 'Sales trend')}</h3>
          <Select
            value={group}
            onChange={(e) => {
              setGroupTouched(true);
              setGroup(e.target.value as 'day' | 'week' | 'month');
            }}
            className="!h-8 w-32"
            options={[
              { value: 'day', label: t('rep_group_day', 'By day') },
              { value: 'week', label: t('rep_group_week', 'By week') },
              { value: 'month', label: t('rep_group_month', 'By month') },
            ]}
          />
        </CardHeader>
        <CardBody>
          {trend.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-3">{t('rep_no_data', 'No data for this range.')}</p>
          ) : (
            <LineChart
              labels={trendLabels}
              height={260}
              width={900}
              valueFormatter={(v) => usd(v)}
              series={[
                { name: t('rep_series_net_sales', 'Net sales'), data: trend.map((p) => p.net) },
                { name: t('rep_series_profit', 'Profit'), data: trend.map((p) => p.profit) },
              ]}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <ReportToolbar
            title={t('rep_pl_statement', 'Profit & loss statement')}
            onExportExcel={() => exportRowsToExcel(plRows, plColumns, { ...exportMeta, title: t('rep_pl_statement', 'Profit & loss statement') })}
            onExportPdf={() => exportRowsToPdf(plRows, plColumns, { ...exportMeta, title: t('rep_pl_statement', 'Profit & loss statement') })}
          />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-2 text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
                  <th className="px-3 py-2 text-start">{t('rep_pl_line', 'Line')}</th>
                  <th className="px-3 py-2 text-end num">{t('rep_pl_amount', 'Amount (USD)')}</th>
                  {localCurrency && <th className="px-3 py-2 text-end num">{localCurrency.code}</th>}
                  <th className="px-3 py-2 text-end num">{t('rep_pl_pct_revenue', '% of revenue')}</th>
                </tr>
              </thead>
              <tbody>
                {plRows.map((r) => (
                  <tr key={r.line} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-medium text-text">{r.line}</td>
                    <td className="px-3 py-2 text-end num">{usd(r.amount)}</td>
                    {localCurrency && <td className="px-3 py-2 text-end num text-text-3">{local(r.amount)}</td>}
                    <td className="px-3 py-2 text-end num text-text-3">{r.pct}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

export default OverviewTab;
