import React, { useEffect, useState } from 'react';
import { Card, CardBody, Field, Select, DataTable, Badge, type DataTableColumn } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, formatDateTime, stakeholderTypeLabel } from '../../lib/format';
import { ReportToolbar } from './ReportToolbar';
import { exportRowsToExcel, exportRowsToPdf, type ExportColumn } from './exportUtils';
import type { CustomerStatementRow, StakeholderLite } from './types';

export interface CustomerStatementTabProps {
  businessName: string;
  selectedId?: string;
  onSelectedIdChange?: (id: string) => void;
}

const TYPE_VARIANT: Record<string, 'success' | 'danger' | 'info' | 'neutral'> = {
  sale: 'success', refund: 'danger', purchase: 'info', payment: 'neutral',
};

export function CustomerStatementTab({ businessName, selectedId, onSelectedIdChange }: CustomerStatementTabProps) {
  const { t, lang } = useI18n();
  const [stakeholders, setStakeholders] = useState<StakeholderLite[]>([]);
  const [internalId, setInternalId] = useState('');
  const [rows, setRows] = useState<CustomerStatementRow[]>([]);
  const [loading, setLoading] = useState(false);

  const id = selectedId !== undefined ? selectedId : internalId;
  const setId = onSelectedIdChange || setInternalId;

  useEffect(() => {
    api.get<StakeholderLite[]>('/api/stakeholders').then(setStakeholders).catch(() => {});
  }, []);

  useEffect(() => {
    if (!id) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .get<CustomerStatementRow[]>(`/api/reports/customer-statement/${id}`)
      .then((data) => !cancelled && setRows(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });
  const kindLabel = (k: string) =>
    k === 'sale' ? t('rep_kind_sale', 'Sale') : k === 'refund' ? t('rep_kind_refund', 'Refund') : k === 'purchase' ? t('rep_kind_purchase', 'Purchase') : t('rep_kind_payment', 'Payment');

  const party = stakeholders.find((s) => String(s.id) === id);

  const columns: DataTableColumn<CustomerStatementRow>[] = [
    { key: 'date', header: t('rep_col_date', 'Date'), sortable: true, render: (r) => formatDateTime(r.date, lang) },
    { key: 'reference', header: t('rep_col_reference', 'Reference'), sortable: true },
    { key: 'type', header: t('rep_col_type', 'Type'), sortable: true, render: (r) => <Badge variant={TYPE_VARIANT[r.type] || 'neutral'}>{kindLabel(r.type)}</Badge> },
    { key: 'description', header: t('rep_col_description', 'Description') },
    { key: 'debit', header: t('rep_col_debit', 'Debit'), sortable: true, align: 'end', render: (r) => (r.debit ? usd(r.debit) : '—') },
    { key: 'credit', header: t('rep_col_credit', 'Credit'), sortable: true, align: 'end', render: (r) => (r.credit ? usd(r.credit) : '—') },
    { key: 'balance', header: t('rep_col_running_balance', 'Balance'), align: 'end', render: (r) => usd(r.balance) },
  ];

  const exportColumns: ExportColumn<CustomerStatementRow>[] = [
    { key: 'date', header: t('rep_col_date', 'Date'), value: (r) => formatDateTime(r.date, lang) },
    { key: 'reference', header: t('rep_col_reference', 'Reference'), value: (r) => r.reference },
    { key: 'type', header: t('rep_col_type', 'Type'), value: (r) => kindLabel(r.type) },
    { key: 'description', header: t('rep_col_description', 'Description'), value: (r) => r.description },
    { key: 'debit', header: t('rep_col_debit', 'Debit'), value: (r) => r.debit, align: 'right' },
    { key: 'credit', header: t('rep_col_credit', 'Credit'), value: (r) => r.credit, align: 'right' },
    { key: 'balance', header: t('rep_col_running_balance', 'Balance'), value: (r) => r.balance, align: 'right' },
  ];

  const meta = {
    fileName: `statement-${party?.name || id}`,
    title: t('rep_tab_customer_statement', 'Customer statement'),
    subtitle: party?.name,
    businessName,
  };

  return (
    <div className="space-y-4">
      <Card className="print:hidden">
        <CardBody>
          <Field label={t('rep_statement_select', 'Customer / supplier')} className="max-w-sm">
            <Select
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder={t('rep_statement_select_placeholder', 'Select a party…')}
              options={stakeholders.map((s) => ({ value: String(s.id), label: `${s.name} (${stakeholderTypeLabel(s.type, t)})` }))}
            />
          </Field>
        </CardBody>
      </Card>

      {id && (
        <div id="printable-report" className="space-y-2">
          <div className="hidden print:block mb-2">
            <p className="text-lg font-bold">{businessName || 'OmniPOS'}</p>
            <p className="text-sm font-semibold">{meta.title} — {party?.name}</p>
          </div>
          <ReportToolbar
            title={`${t('rep_tab_customer_statement', 'Customer statement')}${party ? ` — ${party.name}` : ''}`}
            onExportExcel={() => exportRowsToExcel(rows, exportColumns, meta)}
            onExportPdf={() => exportRowsToPdf(rows, exportColumns, meta)}
          />
          <DataTable
            columns={columns}
            data={rows}
            rowKey={(r) => `${r.date}-${r.reference}-${r.type}-${r.debit}-${r.credit}-${r.balance}`}
            loading={loading}
            emptyTitle={t('rep_no_data', 'No activity found.')}
          />
        </div>
      )}
    </div>
  );
}

export default CustomerStatementTab;
