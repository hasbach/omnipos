// Customers, Suppliers and Cashiers tabs — similar "party" table shape, kept in one file.
import React, { useEffect, useState } from 'react';
import { DataTable, type DataTableColumn } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { ReportToolbar } from './ReportToolbar';
import { exportRowsToExcel, exportRowsToPdf, type ExportColumn } from './exportUtils';
import type { ReportTabProps, ByCustomerRow, BySupplierRow, ByCashierRow } from './types';

function Balance({ n }: { n: number }) {
  if (n >= -0.004) return <span className="num">0.00</span>;
  return <span className="num text-danger">{formatMoney(-n, { code: 'USD', symbol: '$' })}</span>;
}

export function CustomersTab({ range, businessName }: ReportTabProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<ByCustomerRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<ByCustomerRow[]>('/api/reports/by-customer', { from: range.from, to: range.to })
      .then((data) => !cancelled && setRows(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to]);

  const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });

  const columns: DataTableColumn<ByCustomerRow>[] = [
    { key: 'name', header: t('rep_col_customer', 'Customer'), sortable: true },
    { key: 'invoices', header: t('rep_col_invoices', 'Invoices'), sortable: true, align: 'end' },
    { key: 'revenue', header: t('rep_col_revenue', 'Revenue'), sortable: true, align: 'end', render: (r) => usd(r.revenue) },
    { key: 'profit', header: t('rep_col_profit', 'Profit'), sortable: true, align: 'end', render: (r) => usd(r.profit) },
    { key: 'paid', header: t('rep_col_paid', 'Paid'), sortable: true, align: 'end', render: (r) => usd(r.paid) },
    {
      key: 'balance',
      header: t('rep_col_receivable', 'Receivable'),
      sortable: true,
      align: 'end',
      sortValue: (r) => Math.min(0, r.balance),
      render: (r) => <Balance n={r.balance} />,
    },
  ];

  const exportColumns: ExportColumn<ByCustomerRow>[] = [
    { key: 'name', header: t('rep_col_customer', 'Customer'), value: (r) => r.name },
    { key: 'invoices', header: t('rep_col_invoices', 'Invoices'), value: (r) => r.invoices, align: 'right' },
    { key: 'revenue', header: t('rep_col_revenue', 'Revenue'), value: (r) => r.revenue, align: 'right' },
    { key: 'profit', header: t('rep_col_profit', 'Profit'), value: (r) => r.profit, align: 'right' },
    { key: 'paid', header: t('rep_col_paid', 'Paid'), value: (r) => r.paid, align: 'right' },
    { key: 'balance', header: t('rep_col_receivable', 'Receivable'), value: (r) => Math.max(0, -r.balance), align: 'right' },
  ];

  const meta = { fileName: `customers-${range.from}_${range.to}`, title: t('rep_tab_customers', 'Customers'), subtitle: `${range.from} – ${range.to}`, businessName };

  return (
    <div id="printable-report" className="space-y-2">
      <div className="hidden print:block mb-2">
        <p className="text-lg font-bold">{businessName || 'OmniPOS'}</p>
        <p className="text-xs text-text-3">{t('rep_tab_customers', 'Customers')} · {range.from} – {range.to}</p>
      </div>
      <ReportToolbar
        title={t('rep_tab_customers', 'Customers')}
        onExportExcel={() => exportRowsToExcel(rows, exportColumns, meta)}
        onExportPdf={() => exportRowsToPdf(rows, exportColumns, meta)}
      />
      <DataTable columns={columns} data={rows} rowKey={(r) => r.stakeholder_id} loading={loading} searchable emptyTitle={t('rep_no_data', 'No data for this range.')} />
    </div>
  );
}

export function SuppliersTab({ range, businessName }: ReportTabProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<BySupplierRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<BySupplierRow[]>('/api/reports/by-supplier', { from: range.from, to: range.to })
      .then((data) => !cancelled && setRows(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to]);

  const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });

  const columns: DataTableColumn<BySupplierRow>[] = [
    { key: 'name', header: t('rep_col_supplier', 'Supplier'), sortable: true },
    { key: 'purchases', header: t('rep_col_purchases_count', 'Purchases'), sortable: true, align: 'end' },
    { key: 'amount', header: t('rep_col_amount', 'Amount'), sortable: true, align: 'end', render: (r) => usd(r.amount) },
    { key: 'paid', header: t('rep_col_paid', 'Paid'), sortable: true, align: 'end', render: (r) => usd(r.paid) },
    {
      key: 'balance',
      header: t('rep_col_payable', 'Payable'),
      sortable: true,
      align: 'end',
      sortValue: (r) => Math.min(0, r.balance),
      render: (r) => <Balance n={r.balance} />,
    },
  ];

  const exportColumns: ExportColumn<BySupplierRow>[] = [
    { key: 'name', header: t('rep_col_supplier', 'Supplier'), value: (r) => r.name },
    { key: 'purchases', header: t('rep_col_purchases_count', 'Purchases'), value: (r) => r.purchases, align: 'right' },
    { key: 'amount', header: t('rep_col_amount', 'Amount'), value: (r) => r.amount, align: 'right' },
    { key: 'paid', header: t('rep_col_paid', 'Paid'), value: (r) => r.paid, align: 'right' },
    { key: 'balance', header: t('rep_col_payable', 'Payable'), value: (r) => Math.max(0, -r.balance), align: 'right' },
  ];

  const meta = { fileName: `suppliers-${range.from}_${range.to}`, title: t('rep_tab_suppliers', 'Suppliers'), subtitle: `${range.from} – ${range.to}`, businessName };

  return (
    <div id="printable-report" className="space-y-2">
      <div className="hidden print:block mb-2">
        <p className="text-lg font-bold">{businessName || 'OmniPOS'}</p>
        <p className="text-xs text-text-3">{t('rep_tab_suppliers', 'Suppliers')} · {range.from} – {range.to}</p>
      </div>
      <ReportToolbar
        title={t('rep_tab_suppliers', 'Suppliers')}
        onExportExcel={() => exportRowsToExcel(rows, exportColumns, meta)}
        onExportPdf={() => exportRowsToPdf(rows, exportColumns, meta)}
      />
      <DataTable columns={columns} data={rows} rowKey={(r) => r.stakeholder_id} loading={loading} searchable emptyTitle={t('rep_no_data', 'No data for this range.')} />
    </div>
  );
}

export function CashiersTab({ range, businessName }: ReportTabProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<ByCashierRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<ByCashierRow[]>('/api/reports/by-cashier', { from: range.from, to: range.to })
      .then((data) => !cancelled && setRows(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to]);

  const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });

  const columns: DataTableColumn<ByCashierRow>[] = [
    { key: 'name', header: t('rep_col_cashier', 'Cashier'), sortable: true },
    { key: 'invoices', header: t('rep_col_invoices', 'Invoices'), sortable: true, align: 'end' },
    { key: 'revenue', header: t('rep_col_revenue', 'Revenue'), sortable: true, align: 'end', render: (r) => usd(r.revenue) },
    { key: 'refunds', header: t('rep_col_refunds', 'Refunds'), sortable: true, align: 'end', render: (r) => usd(r.refunds) },
    { key: 'avg_ticket', header: t('rep_col_avg_ticket', 'Avg. ticket'), sortable: true, align: 'end', render: (r) => usd(r.avg_ticket) },
  ];

  const exportColumns: ExportColumn<ByCashierRow>[] = [
    { key: 'name', header: t('rep_col_cashier', 'Cashier'), value: (r) => r.name },
    { key: 'invoices', header: t('rep_col_invoices', 'Invoices'), value: (r) => r.invoices, align: 'right' },
    { key: 'revenue', header: t('rep_col_revenue', 'Revenue'), value: (r) => r.revenue, align: 'right' },
    { key: 'refunds', header: t('rep_col_refunds', 'Refunds'), value: (r) => r.refunds, align: 'right' },
    { key: 'avg_ticket', header: t('rep_col_avg_ticket', 'Avg. ticket'), value: (r) => r.avg_ticket, align: 'right' },
  ];

  const meta = { fileName: `cashiers-${range.from}_${range.to}`, title: t('rep_tab_cashiers', 'Cashiers'), subtitle: `${range.from} – ${range.to}`, businessName };

  return (
    <div id="printable-report" className="space-y-2">
      <div className="hidden print:block mb-2">
        <p className="text-lg font-bold">{businessName || 'OmniPOS'}</p>
        <p className="text-xs text-text-3">{t('rep_tab_cashiers', 'Cashiers')} · {range.from} – {range.to}</p>
      </div>
      <ReportToolbar
        title={t('rep_tab_cashiers', 'Cashiers')}
        onExportExcel={() => exportRowsToExcel(rows, exportColumns, meta)}
        onExportPdf={() => exportRowsToPdf(rows, exportColumns, meta)}
      />
      <DataTable columns={columns} data={rows} rowKey={(r) => r.user_id} loading={loading} searchable emptyTitle={t('rep_no_data', 'No data for this range.')} />
    </div>
  );
}
