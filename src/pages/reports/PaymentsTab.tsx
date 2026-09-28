import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardBody, DataTable, Badge, type DataTableColumn } from '../../components/ui';
import { DonutChart } from '../../components/ui/charts/DonutChart';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { ReportToolbar } from './ReportToolbar';
import { exportRowsToExcel, exportRowsToPdf, type ExportColumn } from './exportUtils';
import type { ReportTabProps, ByPaymentMethodRow } from './types';

const KIND_VARIANT: Record<string, 'success' | 'danger' | 'info'> = {
  sale: 'success',
  refund: 'danger',
  purchase: 'info',
};

export function PaymentsTab({ range, businessName }: ReportTabProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<ByPaymentMethodRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<ByPaymentMethodRow[]>('/api/reports/by-payment-method', { from: range.from, to: range.to })
      .then((data) => !cancelled && setRows(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to]);

  const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });

  const kindLabel = (k: string) =>
    k === 'sale' ? t('rep_kind_sale', 'Sale') : k === 'refund' ? t('rep_kind_refund', 'Refund') : t('rep_kind_purchase', 'Purchase');

  const donutData = useMemo(() => {
    const byMethod = new Map<string, number>();
    for (const r of rows) {
      if (r.kind !== 'sale') continue;
      byMethod.set(r.method, (byMethod.get(r.method) || 0) + r.amount_usd);
    }
    return Array.from(byMethod.entries()).map(([label, value]) => ({ label, value }));
  }, [rows]);

  const columns: DataTableColumn<ByPaymentMethodRow>[] = [
    { key: 'kind', header: t('rep_col_type', 'Type'), sortable: true, render: (r) => <Badge variant={KIND_VARIANT[r.kind] || 'neutral'}>{kindLabel(r.kind)}</Badge> },
    { key: 'method', header: t('rep_col_method', 'Method'), sortable: true, render: (r) => <span className="capitalize">{r.method}</span> },
    { key: 'currency', header: t('rep_col_currency', 'Currency'), sortable: true },
    { key: 'amount', header: t('rep_col_amount', 'Amount'), sortable: true, align: 'end' },
    { key: 'amount_usd', header: t('rep_col_amount_usd', 'Amount (USD)'), sortable: true, align: 'end', render: (r) => usd(r.amount_usd) },
    { key: 'count', header: t('rep_col_count', 'Count'), sortable: true, align: 'end' },
  ];

  const exportColumns: ExportColumn<ByPaymentMethodRow>[] = [
    { key: 'kind', header: t('rep_col_type', 'Type'), value: (r) => kindLabel(r.kind) },
    { key: 'method', header: t('rep_col_method', 'Method'), value: (r) => r.method },
    { key: 'currency', header: t('rep_col_currency', 'Currency'), value: (r) => r.currency },
    { key: 'amount', header: t('rep_col_amount', 'Amount'), value: (r) => r.amount, align: 'right' },
    { key: 'amount_usd', header: t('rep_col_amount_usd', 'Amount (USD)'), value: (r) => r.amount_usd, align: 'right' },
    { key: 'count', header: t('rep_col_count', 'Count'), value: (r) => r.count, align: 'right' },
  ];

  const meta = { fileName: `payments-${range.from}_${range.to}`, title: t('rep_tab_payments', 'Payments'), subtitle: `${range.from} – ${range.to}`, businessName };

  return (
    <div id="printable-report" className="space-y-4">
      <div className="hidden print:block mb-2">
        <p className="text-lg font-bold">{businessName || 'OmniPOS'}</p>
        <p className="text-xs text-text-3">{t('rep_tab_payments', 'Payments')} · {range.from} – {range.to}</p>
      </div>

      {donutData.length > 0 && (
        <Card>
          <CardBody>
            <h3 className="mb-3 text-sm font-semibold text-text">{t('rep_payments_by_method', 'Sales collected by method (USD)')}</h3>
            <DonutChart data={donutData} size={200} thickness={28} valueFormatter={(v) => usd(v)} />
          </CardBody>
        </Card>
      )}

      <div className="space-y-2">
        <ReportToolbar
          title={t('rep_tab_payments', 'Payments')}
          onExportExcel={() => exportRowsToExcel(rows, exportColumns, meta)}
          onExportPdf={() => exportRowsToPdf(rows, exportColumns, meta)}
        />
        <DataTable columns={columns} data={rows} rowKey={(r) => `${r.kind}-${r.method}-${r.currency}`} loading={loading} emptyTitle={t('rep_no_data', 'No data for this range.')} />
      </div>
    </div>
  );
}

export default PaymentsTab;
