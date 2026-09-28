// Read-only history of End-of-Day (daily_reports) and yearly close-out reports. Creating these
// happens on the Settlement page (src/pages/Settlement.tsx); this tab just lists/exports them,
// restyled with the new component library, matching the brief's "keep every existing capability".
import React, { useEffect, useState } from 'react';
import { Badge, Tabs, DataTable, type DataTableColumn } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, formatDate } from '../../lib/format';
import { ReportToolbar } from './ReportToolbar';
import { exportRowsToExcel, exportRowsToPdf, type ExportColumn } from './exportUtils';
import type { DailyReportRow, YearlyReportRow } from './types';
import { SettlementDetailDrawer } from '../settlement/SettlementDetailDrawer';

export interface DailyYearlyTabProps {
  businessName: string;
}

export function DailyYearlyTab({ businessName }: DailyYearlyTabProps) {
  const { t, lang } = useI18n();
  const [sub, setSub] = useState<'daily' | 'yearly'>('daily');
  const [daily, setDaily] = useState<DailyReportRow[]>([]);
  const [yearly, setYearly] = useState<YearlyReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.get<DailyReportRow[]>('/api/reports/daily'),
      api.get<YearlyReportRow[]>('/api/reports/yearly'),
    ])
      .then(([d, y]) => {
        if (cancelled) return;
        setDaily(d);
        setYearly(y);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });

  const printHeader = (title: string) => (
    <div className="hidden print:block mb-2">
      <p className="text-lg font-bold">{businessName || 'OmniPOS'}</p>
      <p className="text-xs text-text-3">{title}</p>
    </div>
  );

  if (sub === 'daily') {
    const columns: DataTableColumn<DailyReportRow>[] = [
      {
        key: 'date',
        header: t('rep_col_date', 'Date'),
        sortable: true,
        render: (r) => (
          <span className="flex flex-wrap items-center gap-1.5">
            <span>{formatDate(r.date, lang)}</span>
            {(r.corrections_count ?? 0) > 0 && <Badge variant="primary">{t('sd_badge_corrected', 'Corrected')}</Badge>}
            {r.changed_after_close && <Badge variant="warning">{t('sd_badge_changed', 'Changed after closing')}</Badge>}
          </span>
        ),
      },
      { key: 'opening_balance', header: t('rep_daily_opening', 'Opening'), sortable: true, align: 'end', render: (r) => usd(r.opening_balance) },
      { key: 'total_sales', header: t('rep_daily_sales', 'Sales'), sortable: true, align: 'end', render: (r) => usd(r.total_sales) },
      { key: 'total_purchases', header: t('rep_daily_purchases', 'Purchases'), sortable: true, align: 'end', render: (r) => usd(r.total_purchases) },
      { key: 'closing_balance', header: t('rep_daily_expected', 'Expected closing'), sortable: true, align: 'end', sortValue: (r) => r.effective_expected ?? r.closing_balance, render: (r) => usd(r.effective_expected ?? r.closing_balance) },
      { key: 'actual_balance', header: t('rep_daily_actual', 'Actual counted'), sortable: true, align: 'end', sortValue: (r) => r.effective_actual ?? r.actual_balance, render: (r) => usd(r.effective_actual ?? r.actual_balance) },
      { key: 'difference', header: t('rep_daily_difference', 'Difference'), sortable: true, align: 'end', sortValue: (r) => r.effective_difference ?? r.difference, render: (r) => { const d = r.effective_difference ?? r.difference; return <span className={Math.abs(d) > 0.01 ? 'text-danger font-semibold' : ''}>{usd(d)}</span>; } },
      { key: 'user_name', header: t('rep_col_user', 'Closed by'), sortable: true, render: (r) => r.user_name || '—' },
    ];
    const exportColumns: ExportColumn<DailyReportRow>[] = [
      { key: 'date', header: t('rep_col_date', 'Date'), value: (r) => formatDate(r.date, lang) },
      { key: 'opening_balance', header: t('rep_daily_opening', 'Opening'), value: (r) => r.opening_balance, align: 'right' },
      { key: 'total_sales', header: t('rep_daily_sales', 'Sales'), value: (r) => r.total_sales, align: 'right' },
      { key: 'total_purchases', header: t('rep_daily_purchases', 'Purchases'), value: (r) => r.total_purchases, align: 'right' },
      { key: 'closing_balance', header: t('rep_daily_expected', 'Expected closing'), value: (r) => r.effective_expected ?? r.closing_balance, align: 'right' },
      { key: 'actual_balance', header: t('rep_daily_actual', 'Actual counted'), value: (r) => r.effective_actual ?? r.actual_balance, align: 'right' },
      { key: 'difference', header: t('rep_daily_difference', 'Difference'), value: (r) => r.effective_difference ?? r.difference, align: 'right' },
      { key: 'user_name', header: t('rep_col_user', 'Closed by'), value: (r) => r.user_name || '' },
    ];
    const meta = { fileName: 'daily-reports', title: t('rep_tab_daily_reports', 'Daily reports'), businessName };
    return (
      <div id="printable-report" className="space-y-4">
        {printHeader(meta.title)}
        <Tabs className="print:hidden" value={sub} onChange={(v) => setSub(v as 'daily' | 'yearly')} items={[
          { value: 'daily', label: t('rep_tab_daily_reports', 'Daily reports') },
          { value: 'yearly', label: t('rep_tab_yearly_reports', 'Yearly reports') },
        ]} />
        <ReportToolbar
          title={meta.title}
          onExportExcel={() => exportRowsToExcel(daily, exportColumns, meta)}
          onExportPdf={() => exportRowsToPdf(daily, exportColumns, meta)}
        />
        <DataTable columns={columns} data={daily} rowKey={(r) => r.id} loading={loading} searchable onRowClick={(r) => setDetailId(r.id)} emptyTitle={t('rep_no_daily_reports', 'No end-of-day reports yet.')} emptyDescription={t('rep_no_daily_reports_desc', 'Close a register on the Settlement page to create one.')} />
        <SettlementDetailDrawer reportId={detailId} onClose={() => setDetailId(null)} onChanged={() => setReloadKey((k) => k + 1)} businessName={businessName} />
      </div>
    );
  }

  const columns: DataTableColumn<YearlyReportRow>[] = [
    { key: 'year', header: t('rep_col_year', 'Year'), sortable: true },
    { key: 'total_sales', header: t('rep_daily_sales', 'Sales'), sortable: true, align: 'end', render: (r) => usd(r.total_sales) },
    { key: 'total_purchases', header: t('rep_daily_purchases', 'Purchases'), sortable: true, align: 'end', render: (r) => usd(r.total_purchases) },
    { key: 'total_profit', header: t('rep_col_profit', 'Profit'), sortable: true, align: 'end', render: (r) => usd(r.total_profit) },
    { key: 'user_name', header: t('rep_col_user', 'Recorded by'), sortable: true, render: (r) => r.user_name || '—' },
  ];
  const exportColumns: ExportColumn<YearlyReportRow>[] = [
    { key: 'year', header: t('rep_col_year', 'Year'), value: (r) => r.year },
    { key: 'total_sales', header: t('rep_daily_sales', 'Sales'), value: (r) => r.total_sales, align: 'right' },
    { key: 'total_purchases', header: t('rep_daily_purchases', 'Purchases'), value: (r) => r.total_purchases, align: 'right' },
    { key: 'total_profit', header: t('rep_col_profit', 'Profit'), value: (r) => r.total_profit, align: 'right' },
    { key: 'user_name', header: t('rep_col_user', 'Recorded by'), value: (r) => r.user_name || '' },
  ];
  const meta = { fileName: 'yearly-reports', title: t('rep_tab_yearly_reports', 'Yearly reports'), businessName };

  return (
    <div id="printable-report" className="space-y-4">
      {printHeader(meta.title)}
      <Tabs className="print:hidden" value={sub} onChange={(v) => setSub(v as 'daily' | 'yearly')} items={[
        { value: 'daily', label: t('rep_tab_daily_reports', 'Daily reports') },
        { value: 'yearly', label: t('rep_tab_yearly_reports', 'Yearly reports') },
      ]} />
      <ReportToolbar
        title={meta.title}
        onExportExcel={() => exportRowsToExcel(yearly, exportColumns, meta)}
        onExportPdf={() => exportRowsToPdf(yearly, exportColumns, meta)}
      />
      <DataTable columns={columns} data={yearly} rowKey={(r) => r.id} loading={loading} searchable emptyTitle={t('rep_no_yearly_reports', 'No yearly reports yet.')} />
    </div>
  );
}

export default DailyYearlyTab;
