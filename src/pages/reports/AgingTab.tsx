import React, { useEffect, useState } from 'react';
import { DataTable, Tabs, type DataTableColumn } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { ReportToolbar } from './ReportToolbar';
import { exportRowsToExcel, exportRowsToPdf, type ExportColumn } from './exportUtils';
import type { ReportTabProps, AgingRow } from './types';

export interface AgingTabProps extends ReportTabProps {
  onOpenStatement?: (stakeholderId: number) => void;
}

function StackedBar({ row, total, t }: { row: AgingRow; total: number; t: (key: string, fallback?: string) => string }) {
  if (total <= 0) return null;
  const pct = (n: number) => `${Math.max(0, (n / total) * 100)}%`;
  return (
    <div className="flex h-2 w-28 overflow-hidden rounded-full bg-surface-2">
      <div style={{ width: pct(row.current) }} className="bg-success" title={t('rep_aging_current', 'Current')} />
      <div style={{ width: pct(row.d31_60) }} className="bg-info" title={t('rep_aging_31_60', '31–60')} />
      <div style={{ width: pct(row.d61_90) }} className="bg-accent" title={t('rep_aging_61_90', '61–90')} />
      <div style={{ width: pct(row.d90_plus) }} className="bg-danger" title={t('rep_aging_90_plus', '90+')} />
    </div>
  );
}

export function AgingTab({ businessName, onOpenStatement }: AgingTabProps) {
  const { t } = useI18n();
  const [type, setType] = useState<'customer' | 'supplier'>('customer');
  const [rows, setRows] = useState<AgingRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<AgingRow[]>('/api/reports/aging', { type })
      .then((data) => !cancelled && setRows(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [type]);

  const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });
  const outstanding = (r: AgingRow) => r.current + r.d31_60 + r.d61_90 + r.d90_plus;

  const columns: DataTableColumn<AgingRow>[] = [
    { key: 'name', header: type === 'customer' ? t('rep_col_customer', 'Customer') : t('rep_col_supplier', 'Supplier'), sortable: true },
    { key: 'current', header: t('rep_aging_current', 'Current'), sortable: true, align: 'end', render: (r) => usd(r.current) },
    { key: 'd31_60', header: t('rep_aging_31_60', '31–60'), sortable: true, align: 'end', render: (r) => usd(r.d31_60) },
    { key: 'd61_90', header: t('rep_aging_61_90', '61–90'), sortable: true, align: 'end', render: (r) => usd(r.d61_90) },
    { key: 'd90_plus', header: t('rep_aging_90_plus', '90+'), sortable: true, align: 'end', render: (r) => <span className={r.d90_plus > 0 ? 'text-danger font-semibold' : ''}>{usd(r.d90_plus)}</span> },
    { key: 'total', header: t('rep_aging_total', 'Total outstanding'), sortable: true, align: 'end', sortValue: outstanding, render: (r) => usd(outstanding(r)) },
    { key: 'mix', header: t('rep_aging_mix', 'Mix'), render: (r) => <StackedBar row={r} total={outstanding(r)} t={t} /> },
  ];

  const exportColumns: ExportColumn<AgingRow>[] = [
    { key: 'name', header: type === 'customer' ? t('rep_col_customer', 'Customer') : t('rep_col_supplier', 'Supplier'), value: (r) => r.name },
    { key: 'current', header: t('rep_aging_current', 'Current'), value: (r) => r.current, align: 'right' },
    { key: 'd31_60', header: t('rep_aging_31_60', '31–60'), value: (r) => r.d31_60, align: 'right' },
    { key: 'd61_90', header: t('rep_aging_61_90', '61–90'), value: (r) => r.d61_90, align: 'right' },
    { key: 'd90_plus', header: t('rep_aging_90_plus', '90+'), value: (r) => r.d90_plus, align: 'right' },
    { key: 'total', header: t('rep_aging_total', 'Total outstanding'), value: (r) => outstanding(r), align: 'right' },
  ];

  const meta = {
    fileName: `aging-${type}-${new Date().toISOString().slice(0, 10)}`,
    title: type === 'customer' ? t('rep_tab_receivables', 'Receivables aging') : t('rep_tab_payables', 'Payables aging'),
    businessName,
  };

  const totals = rows.reduce(
    (acc, r) => ({
      current: acc.current + r.current,
      d31_60: acc.d31_60 + r.d31_60,
      d61_90: acc.d61_90 + r.d61_90,
      d90_plus: acc.d90_plus + r.d90_plus,
      total: acc.total + outstanding(r),
    }),
    { current: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 },
  );

  return (
    <div id="printable-report" className="space-y-4">
      <div className="hidden print:block mb-2">
        <p className="text-lg font-bold">{businessName || 'OmniPOS'}</p>
        <p className="text-xs text-text-3">{meta.title}</p>
      </div>

      <Tabs
        className="print:hidden"
        value={type}
        onChange={(v) => setType(v as 'customer' | 'supplier')}
        items={[
          { value: 'customer', label: t('rep_tab_receivables', 'Receivables') },
          { value: 'supplier', label: t('rep_tab_payables', 'Payables') },
        ]}
      />

      <ReportToolbar
        title={meta.title}
        onExportExcel={() => exportRowsToExcel(rows, exportColumns, meta, { name: t('rep_total', 'Total'), current: totals.current.toFixed(2), d31_60: totals.d31_60.toFixed(2), d61_90: totals.d61_90.toFixed(2), d90_plus: totals.d90_plus.toFixed(2), total: totals.total.toFixed(2) })}
        onExportPdf={() => exportRowsToPdf(rows, exportColumns, meta, { name: t('rep_total', 'Total'), current: totals.current.toFixed(2), d31_60: totals.d31_60.toFixed(2), d61_90: totals.d61_90.toFixed(2), d90_plus: totals.d90_plus.toFixed(2), total: totals.total.toFixed(2) })}
      />
      <DataTable
        columns={columns}
        data={rows}
        rowKey={(r) => r.stakeholder_id}
        loading={loading}
        searchable
        onRowClick={onOpenStatement ? (r) => onOpenStatement(r.stakeholder_id) : undefined}
        emptyTitle={t('rep_no_outstanding', 'Nothing outstanding.')}
        footerTotals={{
          name: t('rep_total', 'Total'),
          current: usd(totals.current),
          d31_60: usd(totals.d31_60),
          d61_90: usd(totals.d61_90),
          d90_plus: usd(totals.d90_plus),
          total: usd(totals.total),
        }}
      />
    </div>
  );
}

export default AgingTab;
