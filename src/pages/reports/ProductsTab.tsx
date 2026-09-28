import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardBody, DataTable, type DataTableColumn } from '../../components/ui';
import { BarChart } from '../../components/ui/charts/BarChart';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, formatPercent } from '../../lib/format';
import { ReportToolbar } from './ReportToolbar';
import { exportRowsToExcel, exportRowsToPdf, type ExportColumn } from './exportUtils';
import type { ReportTabProps, ByProductRow } from './types';

export function ProductsTab({ range, businessName }: ReportTabProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<ByProductRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<ByProductRow[]>('/api/reports/by-product', { from: range.from, to: range.to })
      .then((data) => !cancelled && setRows(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to]);

  const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });

  const top10 = useMemo(
    () =>
      [...rows]
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10)
        .map((r) => ({ label: r.name.length > 18 ? r.name.slice(0, 18) + '…' : r.name, value: r.revenue })),
    [rows],
  );

  const columns: DataTableColumn<ByProductRow>[] = [
    { key: 'name', header: t('rep_col_product', 'Product'), sortable: true, render: (r) => (
      <div>
        <p className="font-medium text-text">{r.name}</p>
        <p className="text-xs text-text-3">{r.category}{r.barcode ? ` · ${r.barcode}` : ''}</p>
      </div>
    ) },
    { key: 'qty', header: t('rep_col_qty', 'Qty'), sortable: true, align: 'end', render: (r) => r.qty },
    { key: 'revenue', header: t('rep_col_revenue', 'Revenue'), sortable: true, align: 'end', render: (r) => usd(r.revenue) },
    { key: 'cogs', header: t('rep_col_cogs', 'COGS'), sortable: true, align: 'end', render: (r) => usd(r.cogs) },
    { key: 'profit', header: t('rep_col_profit', 'Profit'), sortable: true, align: 'end', render: (r) => usd(r.profit) },
    {
      key: 'margin_pct',
      header: t('rep_col_margin', 'Margin %'),
      sortable: true,
      align: 'end',
      render: (r) => <span className={r.margin_pct < 0 ? 'text-danger' : ''}>{formatPercent(r.margin_pct)}</span>,
    },
  ];

  const exportColumns: ExportColumn<ByProductRow>[] = [
    { key: 'name', header: t('rep_col_product', 'Product'), value: (r) => r.name },
    { key: 'category', header: t('rep_col_category', 'Category'), value: (r) => r.category },
    { key: 'qty', header: t('rep_col_qty', 'Qty'), value: (r) => r.qty, align: 'right' },
    { key: 'revenue', header: t('rep_col_revenue', 'Revenue'), value: (r) => r.revenue, align: 'right' },
    { key: 'cogs', header: t('rep_col_cogs', 'COGS'), value: (r) => r.cogs, align: 'right' },
    { key: 'profit', header: t('rep_col_profit', 'Profit'), value: (r) => r.profit, align: 'right' },
    { key: 'margin_pct', header: t('rep_col_margin', 'Margin %'), value: (r) => r.margin_pct.toFixed(1), align: 'right' },
  ];

  const meta = { fileName: `products-${range.from}_${range.to}`, title: t('rep_tab_products', 'Products'), subtitle: `${range.from} – ${range.to}`, businessName };

  const totals = rows.reduce(
    (acc, r) => ({ qty: acc.qty + r.qty, revenue: acc.revenue + r.revenue, cogs: acc.cogs + r.cogs, profit: acc.profit + r.profit }),
    { qty: 0, revenue: 0, cogs: 0, profit: 0 },
  );

  return (
    <div id="printable-report" className="space-y-4">
      <div className="hidden print:block mb-2">
        <p className="text-lg font-bold">{businessName || 'OmniPOS'}</p>
        <p className="text-xs text-text-3">{t('rep_tab_products', 'Products')} · {range.from} – {range.to}</p>
      </div>

      {top10.length > 0 && (
        <Card>
          <CardBody>
            <h3 className="mb-2 text-sm font-semibold text-text">{t('rep_top10_products', 'Top 10 products by revenue')}</h3>
            <BarChart data={top10} horizontal height={320} width={800} valueFormatter={(v) => usd(v)} />
          </CardBody>
        </Card>
      )}

      <div className="space-y-2">
        <ReportToolbar
          title={t('rep_tab_products', 'Products')}
          onExportExcel={() => exportRowsToExcel(rows, exportColumns, meta, {
            name: t('rep_total', 'Total'), qty: totals.qty, revenue: totals.revenue.toFixed(2), cogs: totals.cogs.toFixed(2), profit: totals.profit.toFixed(2),
          })}
          onExportPdf={() => exportRowsToPdf(rows, exportColumns, meta, {
            name: t('rep_total', 'Total'), qty: totals.qty, revenue: totals.revenue.toFixed(2), cogs: totals.cogs.toFixed(2), profit: totals.profit.toFixed(2),
          })}
        />
        <DataTable
          columns={columns}
          data={rows}
          rowKey={(r) => r.product_id}
          loading={loading}
          searchable
          searchPlaceholder={t('rep_search_products', 'Search products…')}
          emptyTitle={t('rep_no_data', 'No data for this range.')}
          footerTotals={{
            name: t('rep_total', 'Total'),
            qty: totals.qty,
            revenue: usd(totals.revenue),
            cogs: usd(totals.cogs),
            profit: usd(totals.profit),
          }}
        />
      </div>
    </div>
  );
}

export default ProductsTab;
