import React, { useEffect, useState } from 'react';
import { Card, CardBody, DataTable, Tabs, Select, Badge, type DataTableColumn } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, formatDate } from '../../lib/format';
import { ReportToolbar } from './ReportToolbar';
import { exportRowsToExcel, exportRowsToPdf, type ExportColumn } from './exportUtils';
import type {
  ReportTabProps,
  InventoryValuationResponse,
  InventoryValuationRow,
  LowStockRow,
  SlowMoverRow,
} from './types';

type SubTab = 'valuation' | 'low-stock' | 'slow-movers';

export function InventoryTab({ businessName, range }: ReportTabProps) {
  const { t, lang } = useI18n();
  const [sub, setSub] = useState<SubTab>('valuation');

  const [valuation, setValuation] = useState<InventoryValuationResponse | null>(null);
  const [lowStock, setLowStock] = useState<LowStockRow[]>([]);
  const [slowMovers, setSlowMovers] = useState<SlowMoverRow[]>([]);
  const [slowDays, setSlowDays] = useState(30);
  const [loading, setLoading] = useState(true);

  const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.get<InventoryValuationResponse>('/api/reports/inventory-valuation'),
      api.get<LowStockRow[]>('/api/reports/low-stock'),
    ])
      .then(([v, l]) => {
        if (cancelled) return;
        setValuation(v);
        setLowStock(l);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.get<SlowMoverRow[]>('/api/reports/slow-movers', { days: slowDays }).then((data) => !cancelled && setSlowMovers(data));
    return () => {
      cancelled = true;
    };
  }, [slowDays]);

  const valuationColumns: DataTableColumn<InventoryValuationRow>[] = [
    { key: 'name', header: t('rep_col_product', 'Product'), sortable: true, render: (r) => (
      <div><p className="font-medium text-text">{r.name}</p><p className="text-xs text-text-3">{r.category}</p></div>
    ) },
    { key: 'stock', header: t('rep_col_stock', 'Stock'), sortable: true, align: 'end' },
    { key: 'cost', header: t('rep_col_unit_cost', 'Unit cost'), sortable: true, align: 'end', render: (r) => usd(r.cost) },
    { key: 'value_cost', header: t('rep_col_value_cost', 'Value (cost)'), sortable: true, align: 'end', render: (r) => usd(r.value_cost) },
    { key: 'price', header: t('rep_col_unit_price', 'Unit price'), sortable: true, align: 'end', render: (r) => usd(r.price) },
    { key: 'value_retail', header: t('rep_col_value_retail', 'Value (retail)'), sortable: true, align: 'end', render: (r) => usd(r.value_retail) },
    { key: 'potential_profit', header: t('rep_col_potential_profit', 'Potential profit'), sortable: true, align: 'end', render: (r) => usd(r.potential_profit) },
  ];

  const lowStockColumns: DataTableColumn<LowStockRow>[] = [
    { key: 'name', header: t('rep_col_product', 'Product'), sortable: true, render: (r) => (
      <div><p className="font-medium text-text">{r.name}</p><p className="text-xs text-text-3">{r.category}</p></div>
    ) },
    { key: 'stock', header: t('rep_col_stock', 'Stock'), sortable: true, align: 'end', render: (r) => (
      <span className={r.stock <= 0 ? 'text-danger font-semibold' : ''}>{r.stock}</span>
    ) },
    { key: 'reorder_point', header: t('rep_col_reorder_point', 'Reorder point'), sortable: true, align: 'end' },
    { key: 'suggested_order', header: t('rep_col_suggested_order', 'Suggested order'), sortable: true, align: 'end', render: (r) => (
      <span className="font-semibold text-primary">{r.suggested_order}</span>
    ) },
  ];

  const slowMoverColumns: DataTableColumn<SlowMoverRow>[] = [
    { key: 'name', header: t('rep_col_product', 'Product'), sortable: true, render: (r) => (
      <div><p className="font-medium text-text">{r.name}</p><p className="text-xs text-text-3">{r.category}</p></div>
    ) },
    { key: 'stock', header: t('rep_col_stock', 'Stock'), sortable: true, align: 'end' },
    { key: 'qty_sold', header: t('rep_col_qty_sold', 'Qty sold'), sortable: true, align: 'end', render: (r) => (
      <span className={r.qty_sold === 0 ? 'text-danger font-semibold' : ''}>{r.qty_sold}</span>
    ) },
    { key: 'last_sold_at', header: t('rep_col_last_sold', 'Last sold'), sortable: true, render: (r) => r.last_sold_at ? formatDate(r.last_sold_at, lang) : <Badge variant="neutral">{t('rep_never_sold', 'Never')}</Badge> },
  ];

  const printHeader = (title: string, subtitle?: string) => (
    <div className="hidden print:block mb-2">
      <p className="text-lg font-bold">{businessName || 'OmniPOS'}</p>
      <p className="text-xs text-text-3">{title}{subtitle ? ` · ${subtitle}` : ''}</p>
    </div>
  );

  if (sub === 'valuation') {
    const exportColumns: ExportColumn<InventoryValuationRow>[] = [
      { key: 'name', header: t('rep_col_product', 'Product'), value: (r) => r.name },
      { key: 'category', header: t('rep_col_category', 'Category'), value: (r) => r.category },
      { key: 'stock', header: t('rep_col_stock', 'Stock'), value: (r) => r.stock, align: 'right' },
      { key: 'cost', header: t('rep_col_unit_cost', 'Unit cost'), value: (r) => r.cost, align: 'right' },
      { key: 'value_cost', header: t('rep_col_value_cost', 'Value (cost)'), value: (r) => r.value_cost, align: 'right' },
      { key: 'value_retail', header: t('rep_col_value_retail', 'Value (retail)'), value: (r) => r.value_retail, align: 'right' },
      { key: 'potential_profit', header: t('rep_col_potential_profit', 'Potential profit'), value: (r) => r.potential_profit, align: 'right' },
    ];
    const meta = { fileName: `inventory-valuation-${range.to}`, title: t('rep_inventory_valuation', 'Inventory valuation'), businessName };
    const totalsRow = valuation
      ? { name: t('rep_total', 'Total'), value_cost: valuation.totals.value_cost.toFixed(2), value_retail: valuation.totals.value_retail.toFixed(2), potential_profit: valuation.totals.potential_profit.toFixed(2) }
      : undefined;
    return (
      <div id="printable-report" className="space-y-4">
        {printHeader(t('rep_inventory_valuation', 'Inventory valuation'))}
        <InventorySubTabs sub={sub} setSub={setSub} t={t} />
        {valuation && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 print:hidden">
            <Card><CardBody><p className="text-xs text-text-3">{t('rep_col_value_cost', 'Value (cost)')}</p><p className="num text-lg font-bold">{usd(valuation.totals.value_cost)}</p></CardBody></Card>
            <Card><CardBody><p className="text-xs text-text-3">{t('rep_col_value_retail', 'Value (retail)')}</p><p className="num text-lg font-bold">{usd(valuation.totals.value_retail)}</p></CardBody></Card>
            <Card><CardBody><p className="text-xs text-text-3">{t('rep_col_potential_profit', 'Potential profit')}</p><p className="num text-lg font-bold">{usd(valuation.totals.potential_profit)}</p></CardBody></Card>
            <Card><CardBody><p className="text-xs text-text-3">{t('rep_col_product_count', 'Products')}</p><p className="num text-lg font-bold">{valuation.totals.product_count}</p></CardBody></Card>
          </div>
        )}
        <ReportToolbar
          title={t('rep_inventory_valuation', 'Inventory valuation')}
          onExportExcel={() => exportRowsToExcel(valuation?.rows || [], exportColumns, meta, totalsRow)}
          onExportPdf={() => exportRowsToPdf(valuation?.rows || [], exportColumns, meta, totalsRow)}
        />
        <DataTable
          columns={valuationColumns}
          data={valuation?.rows || []}
          rowKey={(r) => r.product_id}
          loading={loading}
          searchable
          emptyTitle={t('rep_no_data', 'No data.')}
          footerTotals={valuation ? { name: t('rep_total', 'Total'), value_cost: usd(valuation.totals.value_cost), value_retail: usd(valuation.totals.value_retail), potential_profit: usd(valuation.totals.potential_profit) } : undefined}
        />
      </div>
    );
  }

  if (sub === 'low-stock') {
    const exportColumns: ExportColumn<LowStockRow>[] = [
      { key: 'name', header: t('rep_col_product', 'Product'), value: (r) => r.name },
      { key: 'category', header: t('rep_col_category', 'Category'), value: (r) => r.category },
      { key: 'stock', header: t('rep_col_stock', 'Stock'), value: (r) => r.stock, align: 'right' },
      { key: 'reorder_point', header: t('rep_col_reorder_point', 'Reorder point'), value: (r) => r.reorder_point, align: 'right' },
      { key: 'suggested_order', header: t('rep_col_suggested_order', 'Suggested order'), value: (r) => r.suggested_order, align: 'right' },
    ];
    const meta = { fileName: `low-stock-${range.to}`, title: t('rep_low_stock', 'Low stock'), businessName };
    return (
      <div id="printable-report" className="space-y-4">
        {printHeader(t('rep_low_stock', 'Low stock'))}
        <InventorySubTabs sub={sub} setSub={setSub} t={t} />
        <ReportToolbar
          title={t('rep_low_stock', 'Low stock')}
          onExportExcel={() => exportRowsToExcel(lowStock, exportColumns, meta)}
          onExportPdf={() => exportRowsToPdf(lowStock, exportColumns, meta)}
        />
        <DataTable columns={lowStockColumns} data={lowStock} rowKey={(r) => r.product_id} loading={loading} searchable emptyTitle={t('rep_no_low_stock', 'Nothing is low on stock.')} />
      </div>
    );
  }

  const exportColumns: ExportColumn<SlowMoverRow>[] = [
    { key: 'name', header: t('rep_col_product', 'Product'), value: (r) => r.name },
    { key: 'category', header: t('rep_col_category', 'Category'), value: (r) => r.category },
    { key: 'stock', header: t('rep_col_stock', 'Stock'), value: (r) => r.stock, align: 'right' },
    { key: 'qty_sold', header: t('rep_col_qty_sold', 'Qty sold'), value: (r) => r.qty_sold, align: 'right' },
    { key: 'last_sold_at', header: t('rep_col_last_sold', 'Last sold'), value: (r) => (r.last_sold_at ? formatDate(r.last_sold_at, lang) : t('rep_never_sold', 'Never')) },
  ];
  const meta = { fileName: `slow-movers-${slowDays}d`, title: t('rep_slow_movers', 'Slow movers'), subtitle: t('rep_last_n_days', 'Last {n} days').replace('{n}', String(slowDays)), businessName };

  return (
    <div id="printable-report" className="space-y-4">
      {printHeader(t('rep_slow_movers', 'Slow movers'), t('rep_last_n_days', 'Last {n} days').replace('{n}', String(slowDays)))}
      <InventorySubTabs sub={sub} setSub={setSub} t={t} />
      <ReportToolbar
        title={t('rep_slow_movers', 'Slow movers')}
        onExportExcel={() => exportRowsToExcel(slowMovers, exportColumns, meta)}
        onExportPdf={() => exportRowsToPdf(slowMovers, exportColumns, meta)}
      >
        <Select
          value={String(slowDays)}
          onChange={(e) => setSlowDays(Number(e.target.value))}
          className="!h-8 w-32"
          options={[
            { value: '30', label: t('rep_days_30', '30 days') },
            { value: '60', label: t('rep_days_60', '60 days') },
            { value: '90', label: t('rep_days_90', '90 days') },
          ]}
        />
      </ReportToolbar>
      <DataTable columns={slowMoverColumns} data={slowMovers} rowKey={(r) => r.product_id} loading={loading} searchable emptyTitle={t('rep_no_data', 'No data.')} />
    </div>
  );
}

function InventorySubTabs({ sub, setSub, t }: { sub: SubTab; setSub: (s: SubTab) => void; t: (k: string, f?: string) => string }) {
  return (
    <Tabs
      className="print:hidden"
      value={sub}
      onChange={(v) => setSub(v as SubTab)}
      items={[
        { value: 'valuation', label: t('rep_inventory_valuation', 'Inventory valuation') },
        { value: 'low-stock', label: t('rep_low_stock', 'Low stock') },
        { value: 'slow-movers', label: t('rep_slow_movers', 'Slow movers') },
      ]}
    />
  );
}

export default InventoryTab;
