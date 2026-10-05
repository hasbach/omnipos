import React, { useCallback, useEffect, useState } from 'react';
import { DataTable, type DataTableColumn } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatBalance, formatDateTime, formatMoney } from '../../lib/format';

export interface BalanceLogRow {
  id: number;
  stakeholder_id: number;
  created_at: string;
  source: string;
  reference_id: number | null;
  delta: number;
  balance_before: number;
  balance_after: number;
  user_id: number | null;
  user_name: string | null;
  note: string | null;
}

const usd = { code: 'USD', symbol: '$' };

const SOURCE_LABELS: Record<string, [string, string]> = {
  sale: ['bal_log_src_sale', 'Sale'],
  refund: ['bal_log_src_refund', 'Refund'],
  purchase: ['bal_log_src_purchase', 'Purchase'],
  payment: ['bal_log_src_payment', 'Invoice payment'],
  balance_collection: ['bal_log_src_balance_collection', 'Balance collection'],
  supplier_payment: ['bal_log_src_supplier_payment', 'Supplier payment'],
  invoice_edit: ['bal_log_src_invoice_edit', 'Invoice edited'],
  invoice_delete: ['bal_log_src_invoice_delete', 'Invoice deleted'],
  import: ['bal_log_src_import', 'Import'],
  sync: ['bal_log_src_sync', 'Sync'],
  opening: ['bal_log_src_opening', 'Opening balance'],
  history_start: ['bal_log_src_history_start', 'History start'],
  recalculation: ['bal_log_src_recalculation', 'Recalculation'],
  manual_edit: ['bal_log_src_manual_edit', 'Manual edit'],
};

/** Changelog of one stakeholder's balance (GET /api/stakeholders/:id/balance-log). */
export function BalanceLogTable({ stakeholderId }: { stakeholderId: number | string }) {
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<BalanceLogRow[] | null>(null);

  const load = useCallback(() => {
    return api
      .get<BalanceLogRow[]>(`/api/stakeholders/${stakeholderId}/balance-log`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [stakeholderId]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  useEffect(() => {
    const onSync = (e: any) => {
      if (e.detail?.type === 'STAKEHOLDERS_UPDATED') load();
    };
    window.addEventListener('pos-sync', onSync);
    return () => window.removeEventListener('pos-sync', onSync);
  }, [load]);

  const sourceLabel = (s: string) => {
    const e = SOURCE_LABELS[s];
    return e ? t(e[0], e[1]) : s;
  };
  const balanceCell = (n: number) => {
    const b = formatBalance(n, usd, t);
    return (
      <span className={b.variant === 'danger' ? 'text-danger' : b.variant === 'success' ? 'text-success' : 'text-text-2'}>
        {b.amount} <span className="text-[11px] opacity-80">{b.label}</span>
      </span>
    );
  };

  const columns: DataTableColumn<BalanceLogRow>[] = [
    { key: 'created_at', header: t('bal_log_col_date', 'Date'), render: (r) => formatDateTime(r.created_at, lang), sortValue: (r) => r.id, sortable: true },
    { key: 'source', header: t('bal_log_col_source', 'Source'), render: (r) => sourceLabel(r.source) },
    { key: 'reference_id', header: t('bal_log_col_ref', 'Reference'), render: (r) => (r.reference_id ? `#${r.reference_id}` : '—') },
    {
      key: 'delta',
      header: t('bal_log_col_change', 'Change'),
      align: 'end',
      sortable: true,
      render: (r) => (
        <span className={r.delta < 0 ? 'text-danger' : r.delta > 0 ? 'text-success' : 'text-text-2'}>
          {r.delta > 0 ? '+' : ''}
          {formatMoney(r.delta, usd)}
        </span>
      ),
    },
    { key: 'balance_before', header: t('bal_log_col_before', 'Balance before'), align: 'end', render: (r) => balanceCell(r.balance_before) },
    { key: 'balance_after', header: t('bal_log_col_after', 'Balance after'), align: 'end', render: (r) => balanceCell(r.balance_after) },
    { key: 'user_name', header: t('bal_log_col_user', 'User'), render: (r) => r.user_name || '—' },
    { key: 'note', header: t('bal_log_col_note', 'Note'), render: (r) => r.note || '—' },
  ];

  return (
    <DataTable
      columns={columns}
      data={rows || []}
      rowKey={(r) => r.id}
      loading={rows === null}
      emptyTitle={t('bal_log_empty', 'No balance changes recorded yet.')}
      defaultPageSize={25}
    />
  );
}

export default BalanceLogTable;
