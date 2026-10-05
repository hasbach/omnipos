import React, { useEffect, useState } from 'react';
import { Card, CardBody, Field, Select, DataTable, Badge, type DataTableColumn } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, formatDateTime, formatBalance, stakeholderTypeLabel, partyDisplayName } from '../../lib/format';
import { ReportToolbar } from './ReportToolbar';
import { exportRowsToExcel, exportRowsToPdf, type ExportColumn } from './exportUtils';
import type { CustomerStatementRow, StakeholderLite } from './types';
import { originalAmountLabel, statementKindLabel, statementDescription, balanceText, balanceColorClass } from './statementUtils';
import { BalanceLogTable } from '../stakeholders/BalanceLogTable';

export interface CustomerStatementTabProps {
  businessName: string;
  selectedId?: string;
  onSelectedIdChange?: (id: string) => void;
}

const TYPE_VARIANT: Record<string, 'success' | 'danger' | 'info' | 'neutral'> = {
  sale: 'success', refund: 'danger', purchase: 'info', payment: 'neutral', refund_payment: 'danger',
  on_account: 'neutral', balance_collection: 'info', supplier_payment: 'info', manual_edit: 'neutral', import: 'neutral', opening: 'neutral',
};

export function CustomerStatementTab({ businessName, selectedId, onSelectedIdChange }: CustomerStatementTabProps) {
  const { t, lang } = useI18n();
  const [stakeholders, setStakeholders] = useState<StakeholderLite[]>([]);
  const [internalId, setInternalId] = useState('');
  const [rows, setRows] = useState<CustomerStatementRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [currencies, setCurrencies] = useState<{ code: string; symbol: string; rate?: number }[]>([]);

  const id = selectedId !== undefined ? selectedId : internalId;
  const setId = onSelectedIdChange || setInternalId;

  useEffect(() => {
    api.get<StakeholderLite[]>('/api/stakeholders').then(setStakeholders).catch(() => {});
    api.get<{ code: string; symbol: string; rate?: number }[]>('/api/currencies').then(setCurrencies).catch(() => {});
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
  const kindLabel = (k: string) => statementKindLabel(k, t);
  const moneyCell = (r: CustomerStatementRow, amount: number) => {
    if (!amount) return '—';
    const orig = originalAmountLabel(r, currencies);
    return orig ? (
      <div>
        <div>{usd(amount)}</div>
        <div className="text-[11px] text-text-3">{orig}</div>
      </div>
    ) : usd(amount);
  };

  const party = stakeholders.find((s) => String(s.id) === id);

  const columns: DataTableColumn<CustomerStatementRow>[] = [
    { key: 'date', header: t('rep_col_date', 'Date'), sortable: true, render: (r) => formatDateTime(r.date, lang) },
    { key: 'reference', header: t('rep_col_reference', 'Reference'), sortable: true },
    { key: 'type', header: t('rep_col_type', 'Type'), sortable: true, render: (r) => <Badge variant={TYPE_VARIANT[r.type] || 'neutral'}>{kindLabel(r.type)}</Badge> },
    { key: 'description', header: t('rep_col_description', 'Description'), render: (r) => statementDescription(r, t) },
    { key: 'debit', header: t('rep_col_debit', 'Debit'), sortable: true, align: 'end', render: (r) => moneyCell(r, r.debit) },
    { key: 'credit', header: t('rep_col_credit', 'Credit'), sortable: true, align: 'end', render: (r) => moneyCell(r, r.credit) },
    { key: 'balance', header: t('rep_col_running_balance', 'Balance'), align: 'end', render: (r) => {
        const b = formatBalance(r.balance, { code: 'USD', symbol: '$' }, t);
        return <span className={balanceColorClass(r.balance)}>{b.amount} <span className="text-[11px] opacity-80">{b.label}</span></span>;
      } },
  ];

  const exportColumns: ExportColumn<CustomerStatementRow>[] = [
    { key: 'date', header: t('rep_col_date', 'Date'), value: (r) => formatDateTime(r.date, lang) },
    { key: 'reference', header: t('rep_col_reference', 'Reference'), value: (r) => r.reference },
    { key: 'type', header: t('rep_col_type', 'Type'), value: (r) => kindLabel(r.type) },
    { key: 'description', header: t('rep_col_description', 'Description'), value: (r) => { const d = statementDescription(r, t); const orig = originalAmountLabel(r, currencies); return orig ? `${d} — ${orig}` : d; } },
    { key: 'debit', header: t('rep_col_debit', 'Debit'), value: (r) => r.debit, align: 'right' },
    { key: 'credit', header: t('rep_col_credit', 'Credit'), value: (r) => r.credit, align: 'right' },
    { key: 'balance', header: t('rep_col_running_balance', 'Balance'), value: (r) => balanceText(r.balance, t), align: 'right' },
  ];

  const meta = {
    fileName: `statement-${party?.name || id}`,
    title: t('rep_tab_customer_statement', 'Customer statement'),
    subtitle: party ? partyDisplayName(party.name, t) : undefined,
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
              options={stakeholders.map((s) => ({ value: String(s.id), label: `${partyDisplayName(s.name, t)} (${stakeholderTypeLabel(s.type, t)})` }))}
            />
          </Field>
        </CardBody>
      </Card>

      {id && (
        <div id="printable-report" className="space-y-2">
          <div className="hidden print:block mb-2">
            <p className="text-lg font-bold">{businessName || 'OmniPOS'}</p>
            <p className="text-sm font-semibold">{meta.title} — {party ? partyDisplayName(party.name, t) : ''}</p>
          </div>
          <ReportToolbar
            title={`${t('rep_tab_customer_statement', 'Customer statement')}${party ? ` — ${partyDisplayName(party.name, t)}` : ''}`}
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
          {rows.length > 0 && (() => {
            const closing = rows[rows.length - 1].balance;
            const b = formatBalance(closing, { code: 'USD', symbol: '$' }, t);
            return (
              <p className="text-sm font-semibold text-text">
                {t('rep_stmt_closing', 'Closing balance')}:{' '}
                <span className={balanceColorClass(closing)}>{b.amount} {b.label}</span>
              </p>
            );
          })()}
          <div className="pt-4 print:hidden">
            <p className="mb-2 text-sm font-semibold text-text">{t('bal_log_title', 'Balance history')}</p>
            <BalanceLogTable stakeholderId={id} />
          </div>
        </div>
      )}
    </div>
  );
}

export default CustomerStatementTab;
