import React, { useEffect, useMemo, useState } from 'react';
import { Drawer, Tabs, Badge, Button, DataTable, Skeleton } from '../../components/ui';
import type { DataTableColumn } from '../../components/ui';
import { Mail, Phone, MapPin, CreditCard, Layers, Printer, FileDown, Edit2, HandCoins } from 'lucide-react';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatDate, formatDateTime, formatMoney, transactionTypeLabel, partyDisplayName } from '../../lib/format';
import { useSettings } from '../../lib/useSettings';
import type { Currency, Stakeholder } from '../../types';

export interface DetailDrawerProps {
  open: boolean;
  onClose: () => void;
  stakeholder: Stakeholder | null;
  currencies: Currency[];
  onEdit: (s: Stakeholder) => void;
  onPay: (s: Stakeholder) => void;
  /** Hide the Edit / Collect-Pay actions the signed-in role may not use (default: shown). */
  canEdit?: boolean;
  canPay?: boolean;
}

interface StatementRow {
  date: string;
  type: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  user?: string;
  _idx?: number;
}

interface InvoiceRow {
  id: number;
  created_at: string;
  type: string;
  total_amount: number;
  paid_amount: number;
  archived?: number;
}

interface AgingRow {
  stakeholder_id: number;
  balance: number;
  current: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  oldest_invoice_at: string | null;
}

const usd: Currency = { code: 'USD', symbol: '$', rate: 1, is_default: 1 };

function invoiceStatus(inv: InvoiceRow): 'paid' | 'partial' | 'unpaid' {
  if (inv.type === 'refund') return 'paid';
  if (inv.paid_amount >= inv.total_amount - 0.005) return 'paid';
  if (inv.paid_amount > 0) return 'partial';
  return 'unpaid';
}

export function DetailDrawer({ open, onClose, stakeholder, currencies, onEdit, onPay, canEdit = true, canPay = true }: DetailDrawerProps) {
  const { t, lang } = useI18n();
  const { priceLevelsEnabled } = useSettings();
  const [tab, setTab] = useState('summary');
  const [statement, setStatement] = useState<StatementRow[] | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null);
  const [aging, setAging] = useState<AgingRow | null>(null);
  const [loading, setLoading] = useState(false);

  const local = currencies.find((c) => c.code !== 'USD');

  useEffect(() => {
    if (!open || !stakeholder) return;
    setTab('summary');
    setStatement(null);
    setInvoices(null);
    setAging(null);
  }, [open, stakeholder?.id]);

  useEffect(() => {
    if (!open || !stakeholder) return;
    if (tab === 'statement' && statement === null) {
      setLoading(true);
      api
        .get<StatementRow[]>(`/api/reports/customer-statement/${stakeholder.id}`)
        .then((rows) => setStatement(rows.map((r, i) => ({ ...r, _idx: i }))))
        .catch(() => setStatement([]))
        .finally(() => setLoading(false));
    }
    if (tab === 'invoices' && invoices === null) {
      setLoading(true);
      api
        .get<InvoiceRow[]>('/api/transactions/recent', { stakeholder_id: stakeholder.id, limit: 500 })
        .then(setInvoices)
        .catch(() => setInvoices([]))
        .finally(() => setLoading(false));
    }
    if (tab === 'summary' && aging === null) {
      api
        .get<AgingRow[]>('/api/reports/aging', { type: stakeholder.type })
        .then((rows) => setAging(rows.find((r) => r.stakeholder_id === stakeholder.id) || null))
        .catch(() => setAging(null));
    }
  }, [open, tab, stakeholder]);

  if (!stakeholder) return null;

  const overLimit = !!stakeholder.credit_limit && stakeholder.credit_limit > 0 && -stakeholder.balance > stakeholder.credit_limit;

  const statementColumns: DataTableColumn<StatementRow>[] = [
    { key: 'date', header: t('stk_statement_col_date'), render: (r) => formatDateTime(r.date, lang), sortable: true },
    { key: 'reference', header: t('stk_statement_col_ref') },
    { key: 'description', header: t('stk_statement_col_desc') },
    { key: 'debit', header: t('stk_statement_col_debit'), align: 'end', render: (r) => (r.debit ? formatMoney(r.debit, usd) : '—') },
    { key: 'credit', header: t('stk_statement_col_credit'), align: 'end', render: (r) => (r.credit ? formatMoney(r.credit, usd) : '—') },
    { key: 'balance', header: t('stk_statement_col_balance'), align: 'end', render: (r) => formatMoney(r.balance, usd) },
  ];

  const invoiceColumns: DataTableColumn<InvoiceRow>[] = [
    { key: 'id', header: t('stk_invoices_col_id'), sortable: true, render: (r) => `#${r.id}` },
    { key: 'created_at', header: t('stk_invoices_col_date'), sortable: true, render: (r) => formatDate(r.created_at, lang) },
    { key: 'type', header: t('stk_invoices_col_type'), render: (r) => <span>{transactionTypeLabel(r.type, t)}</span> },
    { key: 'total_amount', header: t('stk_invoices_col_total'), align: 'end', render: (r) => formatMoney(r.total_amount, usd) },
    { key: 'paid_amount', header: t('stk_invoices_col_paid'), align: 'end', render: (r) => formatMoney(r.paid_amount, usd) },
    {
      key: 'status',
      header: t('stk_invoices_col_status'),
      render: (r) => {
        const s = invoiceStatus(r);
        const variant = s === 'paid' ? 'success' : s === 'partial' ? 'warning' : 'danger';
        const label = s === 'paid' ? t('stk_status_paid') : s === 'partial' ? t('stk_status_partial') : t('stk_status_unpaid');
        return <Badge variant={variant}>{label}</Badge>;
      },
    },
  ];

  const handlePrintStatement = () => window.print();

  const handleExportStatement = () => {
    if (!statement) return;
    import('jspdf').then(({ jsPDF }) => {
      import('jspdf-autotable').then(({ autoTable }) => {
        const doc = new jsPDF();
        doc.text(`${partyDisplayName(stakeholder.name, t)} — ${t('stk_detail_tab_statement')}`, 14, 14);
        autoTable(doc, {
          startY: 20,
          head: [[t('stk_statement_col_date'), t('stk_statement_col_desc'), t('stk_statement_col_debit'), t('stk_statement_col_credit'), t('stk_statement_col_balance')]],
          body: statement.map((r) => [
            formatDate(r.date, lang),
            r.description,
            r.debit ? formatMoney(r.debit, usd, { hideCurrency: false }) : '',
            r.credit ? formatMoney(r.credit, usd) : '',
            formatMoney(r.balance, usd),
          ]),
        });
        doc.save(`statement-${stakeholder.name}.pdf`);
      });
    });
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={partyDisplayName(stakeholder.name, t)}
      size="lg"
      footer={
        <>
          {canEdit && (
            <Button variant="secondary" onClick={() => onEdit(stakeholder)}>
              <Edit2 size={15} /> {t('stk_edit')}
            </Button>
          )}
          {canPay && (
            <Button variant="primary" onClick={() => onPay(stakeholder)}>
              <HandCoins size={15} /> {stakeholder.type === 'supplier' ? t('stk_action_pay') : t('stk_action_collect')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={stakeholder.type === 'customer' ? 'primary' : 'info'}>
            {stakeholder.type === 'customer' ? t('stk_type_customer') : t('stk_type_supplier')}
          </Badge>
          {priceLevelsEnabled && (
            <Badge variant="neutral">
              {stakeholder.price_level === 'wholesale'
                ? t('stk_price_level_wholesale')
                : stakeholder.price_level === 'super_wholesale'
                ? t('stk_price_level_super_wholesale')
                : t('stk_price_level_retail')}
            </Badge>
          )}
          {overLimit && <Badge variant="danger">{t('stk_over_limit_badge')}</Badge>}
        </div>

        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: 'summary', label: t('stk_detail_tab_summary') },
            { value: 'statement', label: t('stk_detail_tab_statement') },
            { value: 'invoices', label: t('stk_detail_tab_invoices') },
          ]}
        />

        {tab === 'summary' && (
          <div className="flex flex-col gap-4">
            <div className="rounded-[var(--radius-card)] border border-border p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.04em] text-text-3">{t('stk_summary_contact')}</p>
              <div className="flex flex-col gap-1.5 text-sm text-text-2">
                <div className="flex items-center gap-2">
                  <Phone size={14} className="text-text-3" /> {stakeholder.phone || t('stk_summary_no_phone')}
                </div>
                <div className="flex items-center gap-2">
                  <Mail size={14} className="text-text-3" /> {stakeholder.email || t('stk_summary_no_email')}
                </div>
                <div className="flex items-center gap-2">
                  <MapPin size={14} className="text-text-3" /> {stakeholder.address || t('stk_summary_no_address')}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-[var(--radius-card)] border border-border p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-3">{t('stk_summary_balance')}</p>
                <p className={['num mt-1 text-lg font-bold', stakeholder.balance < 0 ? 'text-danger' : stakeholder.balance > 0 ? 'text-success' : 'text-text'].join(' ')}>
                  {formatMoney(Math.abs(stakeholder.balance), usd)}
                </p>
                <p className="text-xs text-text-3">
                  {stakeholder.balance < 0 ? t('stk_owes', 'Owes').split('{amount}')[0] : stakeholder.balance > 0 ? t('stk_credit', 'Credit').split('{amount}')[0] : t('stk_settled')}
                </p>
              </div>
              <div className="rounded-[var(--radius-card)] border border-border p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
                  <CreditCard size={13} /> {t('stk_summary_credit')}
                </p>
                <p className="num mt-1 text-lg font-bold text-text">
                  {stakeholder.credit_limit ? formatMoney(stakeholder.credit_limit, usd) : t('stk_unlimited')}
                </p>
                {!!stakeholder.credit_limit && (
                  <div className="mt-2">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                      <div
                        className={['h-full rounded-full', overLimit ? 'bg-danger' : 'bg-primary'].join(' ')}
                        style={{ width: `${Math.min(100, (Math.max(0, -stakeholder.balance) / stakeholder.credit_limit) * 100)}%` }}
                      />
                    </div>
                    <p className="mt-1 text-[11px] text-text-3">{t('stk_utilization')}</p>
                  </div>
                )}
              </div>
            </div>

            {aging && (
              <div className="rounded-[var(--radius-card)] border border-border p-3">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
                  <Layers size={13} /> {t('stk_detail_aging')}
                </p>
                <div className="grid grid-cols-4 gap-2 text-center">
                  {[
                    { label: t('stk_aging_current'), value: aging.current },
                    { label: t('stk_aging_31_60'), value: aging.d31_60 },
                    { label: t('stk_aging_61_90'), value: aging.d61_90 },
                    { label: t('stk_aging_90_plus'), value: aging.d90_plus },
                  ].map((b, i) => (
                    <div key={i} className="rounded-md bg-surface-2 p-2">
                      <p className="num text-sm font-semibold text-text">{formatMoney(b.value, usd, { hideCurrency: true })}</p>
                      <p className="text-[10px] text-text-3">{b.label}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'statement' && (
          <div className="flex flex-col gap-3">
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={handlePrintStatement}>
                <Printer size={14} /> {t('stk_statement_print')}
              </Button>
              <Button variant="secondary" size="sm" onClick={handleExportStatement} disabled={!statement?.length}>
                <FileDown size={14} /> {t('stk_statement_export')}
              </Button>
            </div>
            {loading || statement === null ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <DataTable
                columns={statementColumns}
                data={statement}
                rowKey={(r) => r._idx ?? `${r.date}-${r.reference}`}
                emptyTitle={t('stk_statement_empty')}
                defaultPageSize={25}
              />
            )}
          </div>
        )}

        {tab === 'invoices' && (
          <div>
            {loading || invoices === null ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <DataTable
                columns={invoiceColumns}
                data={invoices}
                rowKey={(r) => r.id}
                emptyTitle={t('stk_invoices_empty')}
                defaultPageSize={25}
              />
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}

export default DetailDrawer;
