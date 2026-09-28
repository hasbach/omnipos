import React, { useEffect, useState } from 'react';
import { Card, CardBody, DataTable, type DataTableColumn } from '../../components/ui';
import { DonutChart } from '../../components/ui/charts/DonutChart';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, formatPercent } from '../../lib/format';
import { ReportToolbar } from './ReportToolbar';
import { exportRowsToExcel, exportRowsToPdf, type ExportColumn } from './exportUtils';
import type { ReportTabProps, ByCategoryRow } from './types';

export function CategoriesTab({ range, businessName }: ReportTabProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<ByCategoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<ByCategoryRow[]>('/api/reports/by-category', { from: range.from, to: range.to })
      .then((data) => !cancelled && setRows(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to]);

  const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });

  const columns: DataTableColumn<ByCategoryRow>[] = [
    { key: 'category', header: t('rep_col_category', 'Category'), sortable: true },
    { key: 'qty', header: t('rep_col_qty', 'Qty'), sortable: true, align: 'end' },
    { key: 'revenue', header: t('rep_col_revenue', 'Revenue'), sortable: true, align: 'end', render: (r) => usd(r.revenue) },
    { key: 'cogs', header: t('rep_col_cogs', 'COGS'), sortable: true, align: 'end', render: (r) => usd(r.cogs) },
    { key: 'profit', header: t('rep_col_profit', 'Profit'), sortable: true, align: 'end', render: (r) => usd(r.profit) },
    { key: 'margin_pct', header: t('rep_col_margin', 'Margin %'), sortable: true, align: 'end', render: (r) => formatPercent(r.margin_pct) },
    { key: 'share_pct', header: t('rep_col_share', 'Share %'), sortable: true, align: 'end', render: (r) => formatPercent(r.share_pct) },
  ];

  const exportColumns: ExportColumn<ByCategoryRow>[] = [
    { key: 'category', header: t('rep_col_category', 'Category'), value: (r) => r.category },
    { key: 'qty', header: t('rep_col_qty', 'Qty'), value: (r) => r.qty, align: 'right' },
    { key: 'revenue', header: t('rep_col_revenue', 'Revenue'), value: (r) => r.revenue, align: 'right' },
    { key: 'cogs', header: t('rep_col_cogs', 'COGS'), value: (r) => r.cogs, align: 'right' },
    { key: 'profit', header: t('rep_col_profit', 'Profit'), value: (r) => r.profit, align: 'right' },
    { key: 'margin_pct', header: t('rep_col_margin', 'Margin %'), value: (r) => r.margin_pct.toFixed(1), align: 'right' },
    { key: 'share_pct', header: t('rep_col_share', 'Share %'), value: (r) => r.share_pct.toFixed(1), align: 'right' },
  ];

  const meta = { fileName: `categories-${range.from}_${range.to}`, title: t('rep_tab_categories', 'Categories'), subtitle: `${range.from} – ${range.to}`, businessName };

  const donutData = rows.slice(0, 8).map((r) => ({ label: r.category, value: r.revenue }));

  return (
    <div id="printable-report" className="space-y-4">
      <div className="hidden print:block mb-2">
        <p className="text-lg font-bold">{businessName || 'OmniPOS'}</p>
        <p className="text-xs text-text-3">{t('rep_tab_categories', 'Categories')} · {range.from} – {range.to}</p>
      </div>

      {donutData.length > 0 && (
        <Card>
          <CardBody>
            <h3 className="mb-3 text-sm font-semibold text-text">{t('rep_category_share', 'Revenue share by category')}</h3>
            <DonutChart data={donutData} size={200} thickness={28} valueFormatter={(v) => usd(v)} centerLabel={t('rep_col_revenue', 'Revenue')} />
          </CardBody>
        </Card>
      )}

      <div className="space-y-2">
        <ReportToolbar
          title={t('rep_tab_categories', 'Categories')}
          onExportExcel={() => exportRowsToExcel(rows, exportColumns, meta)}
          onExportPdf={() => exportRowsToPdf(rows, exportColumns, meta)}
        />
        <DataTable
          columns={columns}
          data={rows}
          rowKey={(r) => r.category}
          loading={loading}
          searchable
          emptyTitle={t('rep_no_data', 'No data for this range.')}
        />
      </div>
    </div>
  );
}

export default CategoriesTab;
