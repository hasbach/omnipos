import React, { useEffect, useState } from 'react';
import { Card, CardBody, Field, Select, Input, Button, DataTable, Badge, type DataTableColumn } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, formatDateTime } from '../../lib/format';
import { ReportToolbar } from './ReportToolbar';
import { exportRowsToExcel, exportRowsToPdf, type ExportColumn } from './exportUtils';
import type { CustomBuilderRow, ProductLite, StakeholderLite } from './types';

export interface CustomBuilderTabProps {
  businessName: string;
}

interface Filters {
  stakeholderId: string;
  type: string;
  status: string;
  fromDate: string;
  toDate: string;
  productId: string;
  invoiceNumber: string;
  category: string;
}

const EMPTY_FILTERS: Filters = {
  stakeholderId: '', type: '', status: '', fromDate: '', toDate: '', productId: '', invoiceNumber: '', category: '',
};

const TYPE_VARIANT: Record<string, 'success' | 'danger' | 'info'> = { sale: 'success', refund: 'danger', purchase: 'info' };

export function CustomBuilderTab({ businessName }: CustomBuilderTabProps) {
  const { t, lang } = useI18n();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [stakeholders, setStakeholders] = useState<StakeholderLite[]>([]);
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [rows, setRows] = useState<CustomBuilderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [ran, setRan] = useState(false);

  useEffect(() => {
    api.get<StakeholderLite[]>('/api/stakeholders').then(setStakeholders).catch(() => {});
    api.get<any[]>('/api/products').then((data) => {
      setProducts(data);
      setCategories(Array.from(new Set(data.map((p) => p.category).filter(Boolean))));
    }).catch(() => {});
  }, []);

  const runReport = async () => {
    setLoading(true);
    try {
      const data = await api.post<CustomBuilderRow[]>('/api/reports/custom-builder', filters);
      setRows(data);
      setRan(true);
    } finally {
      setLoading(false);
    }
  };

  const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });
  const kindLabel = (k: string) => (k === 'sale' ? t('rep_kind_sale', 'Sale') : k === 'refund' ? t('rep_kind_refund', 'Refund') : t('rep_kind_purchase', 'Purchase'));

  const columns: DataTableColumn<CustomBuilderRow>[] = [
    { key: 'invoice_no', header: t('rep_col_invoice_no', 'Invoice #'), sortable: true },
    { key: 'date', header: t('rep_col_date', 'Date'), sortable: true, render: (r) => formatDateTime(r.date, lang) },
    { key: 'type', header: t('rep_col_type', 'Type'), sortable: true, render: (r) => <Badge variant={TYPE_VARIANT[r.type] || 'neutral'}>{kindLabel(r.type)}</Badge> },
    { key: 'stakeholder', header: t('rep_col_party', 'Party'), sortable: true, render: (r) => r.stakeholder || '—' },
    { key: 'total_amount', header: t('rep_col_amount', 'Amount'), sortable: true, align: 'end', render: (r) => usd(r.total_amount) },
    { key: 'paid_amount', header: t('rep_col_paid', 'Paid'), sortable: true, align: 'end', render: (r) => usd(r.paid_amount) },
    { key: 'balance', header: t('rep_col_balance', 'Balance'), sortable: true, align: 'end', render: (r) => <span className={r.balance > 0.01 ? 'text-danger' : ''}>{usd(r.balance)}</span> },
    { key: 'processed_by', header: t('rep_col_processed_by', 'Processed by'), sortable: true, render: (r) => r.processed_by || '—' },
  ];

  const exportColumns: ExportColumn<CustomBuilderRow>[] = [
    { key: 'invoice_no', header: t('rep_col_invoice_no', 'Invoice #'), value: (r) => r.invoice_no },
    { key: 'date', header: t('rep_col_date', 'Date'), value: (r) => formatDateTime(r.date, lang) },
    { key: 'type', header: t('rep_col_type', 'Type'), value: (r) => kindLabel(r.type) },
    { key: 'stakeholder', header: t('rep_col_party', 'Party'), value: (r) => r.stakeholder || '' },
    { key: 'total_amount', header: t('rep_col_amount', 'Amount'), value: (r) => r.total_amount, align: 'right' },
    { key: 'paid_amount', header: t('rep_col_paid', 'Paid'), value: (r) => r.paid_amount, align: 'right' },
    { key: 'balance', header: t('rep_col_balance', 'Balance'), value: (r) => r.balance, align: 'right' },
    { key: 'processed_by', header: t('rep_col_processed_by', 'Processed by'), value: (r) => r.processed_by || '' },
  ];

  const meta = {
    fileName: `custom-report-${new Date().toISOString().slice(0, 10)}`,
    title: t('rep_tab_custom_builder', 'Custom report builder'),
    subtitle: filters.fromDate || filters.toDate ? `${filters.fromDate || '…'} – ${filters.toDate || '…'}` : undefined,
    businessName,
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-4">
          <h3 className="text-sm font-semibold text-text">{t('rep_builder_filters', 'Filters')}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t('rep_builder_stakeholder', 'Customer / Supplier')}>
              <Select
                value={filters.stakeholderId}
                onChange={(e) => setFilters((f) => ({ ...f, stakeholderId: e.target.value }))}
                placeholder={t('rep_builder_all_stakeholders', 'All stakeholders')}
                options={stakeholders.map((s) => ({ value: String(s.id), label: `${s.name} (${s.type})` }))}
              />
            </Field>
            <Field label={t('rep_builder_type', 'Invoice type')}>
              <Select
                value={filters.type}
                onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}
                placeholder={t('rep_builder_all_types', 'All types')}
                options={[
                  { value: 'sale', label: t('rep_kind_sale', 'Sale') },
                  { value: 'purchase', label: t('rep_kind_purchase', 'Purchase') },
                  { value: 'refund', label: t('rep_kind_refund', 'Refund') },
                ]}
              />
            </Field>
            <Field label={t('rep_builder_status', 'Payment status')}>
              <Select
                value={filters.status}
                onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
                placeholder={t('rep_builder_all_statuses', 'All statuses')}
                options={[
                  { value: 'paid', label: t('rep_builder_paid', 'Fully paid') },
                  { value: 'unpaid', label: t('rep_builder_unpaid', 'Unpaid / partial') },
                ]}
              />
            </Field>
            <Field label={t('rep_builder_product', 'Specific product')}>
              <Select
                value={filters.productId}
                onChange={(e) => setFilters((f) => ({ ...f, productId: e.target.value }))}
                placeholder={t('rep_builder_all_products', 'All products')}
                options={products.map((p) => ({ value: String(p.id), label: p.name }))}
              />
            </Field>
            <Field label={t('rep_builder_from_date', 'From date')}>
              <Input type="date" value={filters.fromDate} onChange={(e) => setFilters((f) => ({ ...f, fromDate: e.target.value }))} />
            </Field>
            <Field label={t('rep_builder_to_date', 'To date')}>
              <Input type="date" value={filters.toDate} onChange={(e) => setFilters((f) => ({ ...f, toDate: e.target.value }))} />
            </Field>
            <Field label={t('rep_builder_category', 'Category')}>
              <Select
                value={filters.category}
                onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}
                placeholder={t('rep_builder_all_categories', 'All categories')}
                options={categories.map((c) => ({ value: c, label: c }))}
              />
            </Field>
            <Field label={t('rep_builder_invoice_no', 'Invoice #')}>
              <Input placeholder="e.g. 1042" value={filters.invoiceNumber} onChange={(e) => setFilters((f) => ({ ...f, invoiceNumber: e.target.value }))} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)}>{t('rep_builder_reset', 'Reset')}</Button>
            <Button variant="primary" loading={loading} onClick={runReport}>{t('rep_builder_generate', 'Generate report')}</Button>
          </div>
        </CardBody>
      </Card>

      {ran && (
        <div id="printable-report" className="space-y-2">
          <div className="hidden print:block mb-2">
            <p className="text-lg font-bold">{businessName || 'OmniPOS'}</p>
            <p className="text-xs text-text-3">{meta.title}{meta.subtitle ? ` · ${meta.subtitle}` : ''}</p>
          </div>
          <ReportToolbar
            title={t('rep_builder_results', 'Results')}
            onExportExcel={() => exportRowsToExcel(rows, exportColumns, meta)}
            onExportPdf={() => exportRowsToPdf(rows, exportColumns, meta)}
          />
          <DataTable columns={columns} data={rows} rowKey={(r) => `${r.type}-${r.invoice_no}`} loading={loading} searchable emptyTitle={t('rep_no_data', 'No data for this range.')} />
        </div>
      )}
    </div>
  );
}

export default CustomBuilderTab;
