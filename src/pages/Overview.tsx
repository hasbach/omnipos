import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Banknote, TrendingUp, Receipt, Percent, ArrowRight, PackageX, Users2, FileText,
} from 'lucide-react';
import { Card, CardHeader, CardBody, StatCard, Badge, Skeleton, EmptyState } from '../components/ui';
import { LineChart } from '../components/ui/charts/LineChart';
import { useI18n } from '../intl/index';
import { api } from '../lib/api';
import { formatMoney, formatDateTime, localToday, toLocalYMD, resolveDateRangePreset } from '../lib/format';
import type { ReportSummary, SalesTrendPoint, ByProductRow, LowStockRow, AgingRow } from './reports/types';

interface RecentInvoice {
  id: number;
  type: 'sale' | 'refund' | 'purchase';
  total_amount: number;
  stakeholder_name: string | null;
  created_at: string;
  paid_amount: number;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toLocalYMD(d);
}

function deltaPct(current: number, previous: number): number | undefined {
  if (!previous) return undefined;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export default function Overview() {
  const { t, lang } = useI18n();
  const [today, setToday] = useState<ReportSummary | null>(null);
  const [yesterday, setYesterday] = useState<ReportSummary | null>(null);
  const [month, setMonth] = useState<ReportSummary | null>(null);
  const [trend, setTrend] = useState<SalesTrendPoint[]>([]);
  const [topProducts, setTopProducts] = useState<ByProductRow[]>([]);
  const [lowStock, setLowStock] = useState<LowStockRow[]>([]);
  const [aging, setAging] = useState<AgingRow[]>([]);
  const [recent, setRecent] = useState<RecentInvoice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const todayStr = localToday();
    const yesterdayRange = resolveDateRangePreset('yesterday');
    const monthRange = resolveDateRangePreset('this_month');
    const from30 = daysAgo(29);

    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.get<ReportSummary>('/api/reports/summary', { from: todayStr, to: todayStr }),
      api.get<ReportSummary>('/api/reports/summary', { from: yesterdayRange.from, to: yesterdayRange.to }),
      api.get<ReportSummary>('/api/reports/summary', { from: monthRange.from, to: monthRange.to }),
      api.get<SalesTrendPoint[]>('/api/reports/sales-trend', { from: from30, to: todayStr, group: 'day' }),
      api.get<ByProductRow[]>('/api/reports/by-product', { from: monthRange.from, to: monthRange.to, sort: 'revenue', limit: 5 }),
      api.get<LowStockRow[]>('/api/reports/low-stock'),
      api.get<AgingRow[]>('/api/reports/aging', { type: 'customer' }),
      api.get<RecentInvoice[]>('/api/transactions/recent', { limit: 8 }),
    ])
      .then(([t0, y0, m0, tr, tp, ls, ag, rec]) => {
        if (cancelled) return;
        setToday(t0);
        setYesterday(y0);
        setMonth(m0);
        setTrend(tr);
        setTopProducts(tp);
        setLowStock(ls.slice(0, 5));
        setAging(ag.filter((a) => a.balance < -0.01).slice(0, 5));
        setRecent(rec);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, []);

  const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return t('ov_greeting_morning', 'Good morning');
    if (hour < 18) return t('ov_greeting_afternoon', 'Good afternoon');
    return t('ov_greeting_evening', 'Good evening');
  }, [t]);

  const todayDate = useMemo(
    () => new Intl.DateTimeFormat(lang === 'ar' ? 'ar-LB' : lang === 'fr' ? 'fr-FR' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date()),
    [lang],
  );

  const trendLabels = useMemo(() => trend.map((p) => p.period), [trend]);

  if (loading && !today) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-[var(--radius-card)]" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-[var(--radius-card)]" />
      </div>
    );
  }

  const typeVariant = (type: string): 'success' | 'danger' | 'info' => (type === 'sale' ? 'success' : type === 'refund' ? 'danger' : 'info');
  const typeLabel = (type: string) =>
    type === 'sale' ? t('rep_kind_sale', 'Sale') : type === 'refund' ? t('rep_kind_refund', 'Refund') : t('rep_kind_purchase', 'Purchase');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-text">{greeting}</h1>
        <p className="text-sm text-text-3">{todayDate}</p>
      </header>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.04em] text-text-3">{t('ov_section_today', "Today")}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label={t('ov_kpi_net_sales', 'Net sales')} value={usd(today?.net_sales || 0)} icon={Banknote} delta={deltaPct(today?.net_sales || 0, yesterday?.net_sales || 0)} />
          <StatCard label={t('ov_kpi_profit', 'Profit')} value={usd(today?.gross_profit || 0)} icon={TrendingUp} delta={deltaPct(today?.gross_profit || 0, yesterday?.gross_profit || 0)} />
          <StatCard label={t('ov_kpi_transactions', 'Transactions')} value={today?.tx_count || 0} icon={Receipt} delta={deltaPct(today?.tx_count || 0, yesterday?.tx_count || 0)} />
          <StatCard label={t('ov_kpi_avg_ticket', 'Avg. ticket')} value={usd(today?.avg_ticket || 0)} icon={Percent} delta={deltaPct(today?.avg_ticket || 0, yesterday?.avg_ticket || 0)} />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.04em] text-text-3">{t('ov_section_this_month', 'This month')}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label={t('ov_kpi_net_sales', 'Net sales')} value={usd(month?.net_sales || 0)} icon={Banknote} />
          <StatCard label={t('ov_kpi_gross_profit', 'Gross profit')} value={usd(month?.gross_profit || 0)} icon={TrendingUp} />
          <StatCard label={t('ov_kpi_margin', 'Margin')} value={`${(month?.margin_pct || 0).toFixed(1)}%`} icon={Percent} />
          <StatCard label={t('ov_kpi_receivables', 'Receivables')} value={usd(month?.receivables || 0)} icon={Users2} />
        </div>
      </section>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text">{t('ov_trend_30d', 'Last 30 days')}</h3>
          <Link to="/dashboard/reports" className="text-xs font-medium text-primary hover:underline">
            {t('ov_view_reports', 'View full reports')}
          </Link>
        </CardHeader>
        <CardBody>
          {trend.length === 0 ? (
            <EmptyState title={t('ov_no_trend_data', 'No sales in the last 30 days.')} />
          ) : (
            <LineChart
              labels={trendLabels}
              height={240}
              width={900}
              valueFormatter={(v) => usd(v)}
              series={[{ name: t('ov_kpi_net_sales', 'Net sales'), data: trend.map((p) => p.net) }]}
            />
          )}
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text">{t('ov_top_products', 'Top 5 products this month')}</h3>
          </CardHeader>
          <CardBody className="p-0">
            {topProducts.length === 0 ? (
              <EmptyState title={t('ov_no_products', 'No sales yet this month.')} className="py-8" />
            ) : (
              <ul className="divide-y divide-border">
                {topProducts.map((p, i) => (
                  <li key={p.product_id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary">{i + 1}</span>
                      <span className="truncate text-sm text-text">{p.name}</span>
                    </div>
                    <span className="num shrink-0 text-sm font-medium text-text">{usd(p.revenue)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text">{t('ov_low_stock', 'Low stock')}</h3>
            <Link to="/dashboard/stock" className="text-xs font-medium text-primary hover:underline flex items-center gap-1">
              {t('ov_view_stock', 'Manage stock')} <ArrowRight size={12} className="rtl:rotate-180" />
            </Link>
          </CardHeader>
          <CardBody className="p-0">
            {lowStock.length === 0 ? (
              <EmptyState icon={PackageX} title={t('ov_no_low_stock', 'Nothing is low on stock.')} className="py-8" />
            ) : (
              <ul className="divide-y divide-border">
                {lowStock.map((p) => (
                  <li key={p.product_id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="truncate text-sm text-text">{p.name}</span>
                    <Badge variant={p.stock <= 0 ? 'danger' : 'warning'}>{p.stock} {t('ov_left', 'left')}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text">{t('ov_largest_receivables', 'Largest receivables')}</h3>
            <Link to="/dashboard/reports" className="text-xs font-medium text-primary hover:underline flex items-center gap-1">
              {t('ov_view_reports', 'View full reports')} <ArrowRight size={12} className="rtl:rotate-180" />
            </Link>
          </CardHeader>
          <CardBody className="p-0">
            {aging.length === 0 ? (
              <EmptyState icon={Users2} title={t('ov_no_receivables', 'No outstanding balances.')} className="py-8" />
            ) : (
              <ul className="divide-y divide-border">
                {aging.map((a) => (
                  <li key={a.stakeholder_id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="truncate text-sm text-text">{a.name}</span>
                    <span className="num text-sm font-medium text-danger">{usd(-a.balance)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text">{t('ov_recent_invoices', 'Recent invoices')}</h3>
          <Link to="/dashboard/invoices" className="text-xs font-medium text-primary hover:underline flex items-center gap-1">
            {t('ov_view_invoices', 'All invoices')} <ArrowRight size={12} className="rtl:rotate-180" />
          </Link>
        </CardHeader>
        <CardBody className="p-0">
          {recent.length === 0 ? (
            <EmptyState icon={FileText} title={t('ov_no_invoices', 'No invoices yet.')} className="py-8" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-2 text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
                    <th className="px-4 py-2 text-start">{t('rep_col_invoice_no', 'Invoice #')}</th>
                    <th className="px-4 py-2 text-start">{t('rep_col_type', 'Type')}</th>
                    <th className="px-4 py-2 text-start">{t('rep_col_party', 'Party')}</th>
                    <th className="px-4 py-2 text-start">{t('rep_col_date', 'Date')}</th>
                    <th className="px-4 py-2 text-end">{t('rep_col_amount', 'Amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((inv) => (
                    <tr key={inv.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                      <td className="px-4 py-2 font-medium text-text">#{inv.id}</td>
                      <td className="px-4 py-2"><Badge variant={typeVariant(inv.type)}>{typeLabel(inv.type)}</Badge></td>
                      <td className="px-4 py-2 text-text-2">{inv.stakeholder_name || '—'}</td>
                      <td className="px-4 py-2 text-text-3">{formatDateTime(inv.created_at, lang)}</td>
                      <td className="px-4 py-2 text-end num">{usd(inv.total_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
