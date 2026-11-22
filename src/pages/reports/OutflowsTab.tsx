import React, { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ShoppingCart, Receipt, Wallet, RotateCcw } from 'lucide-react';
import {
  Card, CardBody, StatCard, DataTable, Badge, Select, Skeleton,
  type DataTableColumn,
} from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, formatDateTime, paymentMethodLabel } from '../../lib/format';
import { CATEGORIES, builtinCategoryLabel, type Category } from '../cashflow/common';
import { ReportToolbar } from './ReportToolbar';
import { exportRowsToExcel, exportRowsToPdf, type ExportColumn } from './exportUtils';
import type { ReportTabProps, OutflowsReport, OutflowRow } from './types';

interface AccountOption {
  id: number;
  name: string;
  is_default: number;
}

const SOURCE_VARIANT: Record<OutflowRow['source'], 'info' | 'warning' | 'danger' | 'neutral'> = {
  purchase: 'info',
  supplier_payment: 'info',
  expense: 'warning',
  refund: 'danger',
  other: 'neutral',
};

export function OutflowsTab({ range, businessName }: ReportTabProps) {
  const { t, lang } = useI18n();
  const [data, setData] = useState<OutflowsReport | null>(null);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [accountId, setAccountId] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<AccountOption[]>('/api/cash-accounts').then((rows) => {
      if (Array.isArray(rows)) setAccounts(rows);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<OutflowsReport>('/api/reports/outflows', {
        from: range.from,
        to: range.to,
        ...(accountId !== 'all' ? { account_id: accountId } : {}),
      })
      .then((res) => !cancelled && setData(res))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [range.from, range.to, accountId]);

  const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });

  const sourceLabel = (src: OutflowRow['source']) => {
    if (src === 'purchase') return t('rep_out_src_purchase', 'Purchase payment');
    if (src === 'supplier_payment') return t('rep_out_src_supplier', 'Supplier payment');
    if (src === 'expense') return t('rep_out_src_expense', 'Expense');
    if (src === 'refund') return t('rep_out_src_refund', 'Refund payout');
    return t('rep_out_src_other', 'Other outflow');
  };

  const categoryLabel = (key: string, customLabel: string | null) => {
    if (key === 'purchase_payment') return t('rep_out_src_purchase', 'Purchase payment');
    if (key === 'refund_payout') return t('rep_out_src_refund', 'Refund payout');
    if ((CATEGORIES as readonly string[]).includes(key)) return builtinCategoryLabel(key as Category, t);
    return customLabel || key;
  };

  const filteredRows = useMemo(() => {
    if (!data) return [];
    if (sourceFilter === 'all') return data.rows;
    if (sourceFilter === 'purchases_suppliers') {
      return data.rows.filter((r) => r.source === 'purchase' || r.source === 'supplier_payment');
    }
    return data.rows.filter((r) => r.source === sourceFilter);
  }, [data, sourceFilter]);

  const columns: DataTableColumn<OutflowRow>[] = [
    { key: 'created_at', header: t('rep_col_date', 'Date'), sortable: true, render: (r) => <span className="num text-text-2">{formatDateTime(r.created_at, lang)}</span> },
    {
      key: 'source',
      header: t('rep_col_type', 'Type'),
      sortable: true,
      render: (r) => <Badge variant={SOURCE_VARIANT[r.source]}>{sourceLabel(r.source)}</Badge>,
    },
    {
      key: 'category',
      header: t('rep_col_category', 'Category'),
      sortable: true,
      render: (r) => <span>{categoryLabel(r.category, r.category_label)}</span>,
    },
    { key: 'counterparty', header: t('rep_out_col_party', 'Party / Payee'), sortable: true, render: (r) => r.counterparty || '—' },
    { key: 'description', header: t('rep_out_col_desc', 'Description'), render: (r) => <span className="max-w-xs truncate block text-text-2">{r.description || '—'}</span> },
    ...(accounts.length > 1 ? [{
      key: 'account_name',
      header: t('rep_out_col_account', 'Account'),
      sortable: true,
      render: (r: OutflowRow) => r.account_name || t('acc_default_drawer', 'Cash Drawer'),
    }] : []),
    { key: 'method', header: t('rep_col_method', 'Method'), sortable: true, render: (r) => paymentMethodLabel(r.method, t) },
    { key: 'amount', header: t('rep_col_amount', 'Amount'), sortable: true, align: 'end', render: (r) => <span className="num">{r.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} {r.currency}</span> },
    { key: 'amount_usd', header: t('rep_col_amount_usd', 'Amount (USD)'), sortable: true, align: 'end', render: (r) => <span className="num font-semibold text-danger">{usd(r.amount_usd)}</span> },
  ];

  const exportColumns: ExportColumn<OutflowRow>[] = [
    { key: 'date', header: t('rep_col_date', 'Date'), value: (r) => formatDateTime(r.created_at, lang) },
    { key: 'source', header: t('rep_col_type', 'Type'), value: (r) => sourceLabel(r.source) },
    { key: 'category', header: t('rep_col_category', 'Category'), value: (r) => categoryLabel(r.category, r.category_label) },
    { key: 'counterparty', header: t('rep_out_col_party', 'Party / Payee'), value: (r) => r.counterparty || '' },
    { key: 'description', header: t('rep_out_col_desc', 'Description'), value: (r) => r.description || '' },
    ...(accounts.length > 1 ? [{ key: 'account_name', header: t('rep_out_col_account', 'Account'), value: (r: OutflowRow) => r.account_name || t('acc_default_drawer', 'Cash Drawer') }] : []),
    { key: 'method', header: t('rep_col_method', 'Method'), value: (r) => paymentMethodLabel(r.method, t) },
    { key: 'currency', header: t('rep_col_currency', 'Currency'), value: (r) => r.currency },
    { key: 'amount', header: t('rep_col_amount', 'Amount'), value: (r) => r.amount, align: 'right' },
    { key: 'amount_usd', header: t('rep_col_amount_usd', 'Amount (USD)'), value: (r) => r.amount_usd, align: 'right' },
  ];

  const meta = {
    fileName: `money-out-${range.from}_${range.to}`,
    title: t('rep_tab_outflows', 'Money out'),
    subtitle: `${range.from} – ${range.to}`,
    businessName,
  };

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-[var(--radius-card)]" />)}
        </div>
        <Skeleton className="h-64 rounded-[var(--radius-card)]" />
      </div>
    );
  }

  const totals = data?.totals;
  const purchasesAndSuppliers = (totals?.purchases_paid || 0) + (totals?.supplier_payments || 0);

  return (
    <div id="printable-report" className="space-y-4">
      <div className="hidden print:block mb-2">
        <p className="text-lg font-bold">{businessName || 'OmniPOS'}</p>
        <p className="text-xs text-text-3">{t('rep_tab_outflows', 'Money out')} · {range.from} – {range.to}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label={t('rep_kpi_total_outflows', 'Total money out')} value={usd(totals?.total_outflows || 0)} icon={ArrowUpRight} />
        <StatCard label={t('rep_out_purchases_suppliers', 'Purchases & suppliers')} value={usd(purchasesAndSuppliers)} icon={ShoppingCart} />
        <StatCard label={t('rep_pl_expenses', 'Expenses')} value={usd(totals?.expenses || 0)} icon={Receipt} />
        <StatCard label={t('rep_out_other', 'Withdrawals & other')} value={usd(totals?.other_out || 0)} icon={Wallet} />
        <StatCard label={t('rep_out_refunds_paid', 'Refunds paid')} value={usd(totals?.refunds_paid || 0)} icon={RotateCcw} />
      </div>

      {data && data.by_category.length > 0 && (
        <Card>
          <CardBody className="space-y-2">
            <h3 className="text-sm font-semibold text-text">{t('rep_out_by_category', 'Breakdown by category')}</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {data.by_category.map((c) => (
                <div key={c.key} className="flex items-center justify-between rounded-[var(--radius-card)] border border-border bg-surface-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-text">{categoryLabel(c.key, c.label)}</p>
                    <p className="text-xs text-text-3">{c.count} {t('rep_out_payments_count', 'payments')}</p>
                  </div>
                  <span className="num font-semibold text-text shrink-0">{usd(c.total_usd)}</span>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="w-48"
              options={[
                { value: 'all', label: t('rep_out_filter_all', 'All outflows') },
                { value: 'purchases_suppliers', label: t('rep_out_purchases_suppliers', 'Purchases & suppliers') },
                { value: 'expense', label: t('rep_pl_expenses', 'Expenses') },
                { value: 'other', label: t('rep_out_other', 'Withdrawals & other') },
                { value: 'refund', label: t('rep_out_refunds_paid', 'Refunds paid') },
              ]}
            />
            {accounts.length > 1 && (
              <Select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-48"
                options={[
                  { value: 'all', label: t('acc_filter_all', 'All accounts') },
                  ...accounts.map((a) => ({ value: String(a.id), label: a.name })),
                ]}
              />
            )}
          </div>
          <ReportToolbar
            title={t('rep_tab_outflows', 'Money out')}
            onExportExcel={() => exportRowsToExcel(filteredRows, exportColumns, meta)}
            onExportPdf={() => exportRowsToPdf(filteredRows, exportColumns, meta)}
          />
        </div>
        <DataTable
          columns={columns}
          data={filteredRows}
          rowKey={(r) => r.uid}
          loading={loading}
          searchable
          emptyTitle={t('rep_no_data', 'No data for this range.')}
        />
      </div>
    </div>
  );
}

export default OutflowsTab;
