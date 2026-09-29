import React from 'react';
import { Pencil } from 'lucide-react';
import { Badge, IconButton, type DataTableColumn } from '../../components/ui';
import { formatDateTime, formatMoney } from '../../lib/format';
import { categoryLabel, type CashFlowRow, type Translate } from './common';

interface CurrencyLike { code: string; symbol: string; rate: number }

/** Shared columns for the open-register list and the analytics list. */
export function cashFlowColumns(opts: {
  t: Translate;
  lang: string;
  currencies: CurrencyLike[];
  onEdit?: (row: CashFlowRow) => void;
}): DataTableColumn<CashFlowRow>[] {
  const { t, lang, currencies, onEdit } = opts;
  const cols: DataTableColumn<CashFlowRow>[] = [
    {
      key: 'created_at',
      header: t('fin_time', 'Time'),
      sortable: true,
      render: (row) => <span className="num whitespace-nowrap text-xs text-text-3">{formatDateTime(row.created_at, lang)}</span>,
    },
    {
      key: 'type',
      header: t('fin_cfr_movement_type', 'Movement Type'),
      render: (row) => (
        <Badge variant={row.type === 'in' ? 'success' : 'danger'}>
          {row.type === 'in' ? t('fin_cfr_cash_in', 'Cash In') : t('fin_cfr_cash_out', 'Cash Out')}
        </Badge>
      ),
    },
    {
      key: 'category',
      header: t('cf_category', 'Category'),
      sortValue: (row) => categoryLabel(row.category, t),
      sortable: true,
      render: (row) => <span className="text-text-2">{categoryLabel(row.category, t)}</span>,
    },
    {
      key: 'amount',
      header: t('fin_amount', 'Amount'),
      align: 'end',
      sortable: true,
      sortValue: (row) => (row.amount / (row.exchange_rate || 1)) * (row.type === 'in' ? 1 : -1),
      render: (row) => {
        const cur = currencies.find((c) => c.code === row.currency) || { code: row.currency, symbol: row.currency, rate: row.exchange_rate };
        return (
          <div className="flex flex-col items-end">
            <span className={['num whitespace-nowrap font-semibold', row.type === 'in' ? 'text-success' : 'text-danger'].join(' ')}>
              {row.type === 'in' ? '+' : '-'}
              {formatMoney(row.amount, cur)}
            </span>
            {row.currency !== 'USD' && (
              <span className="num whitespace-nowrap text-xs text-text-3">
                ≈ {formatMoney(row.amount / (row.exchange_rate || 1), { code: 'USD', symbol: '$' })}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'reason',
      header: t('fin_reason', 'Reason'),
      render: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-text-2">
            {row.counterparty ? <strong className="font-semibold text-text">{row.counterparty}</strong> : null}
            {row.counterparty && row.reason ? ' · ' : ''}
            {row.reason || (row.counterparty ? '' : '—')}
          </span>
          {row.archived && <Badge variant="neutral">{t('cf_archived', 'Settled')}</Badge>}
          {row.edited && <Badge variant="warning">{t('cf_edited', 'Edited')}</Badge>}
        </div>
      ),
    },
  ];
  if (onEdit) {
    cols.push({
      key: 'actions',
      header: '',
      align: 'end',
      width: 48,
      render: (row) => (
        <IconButton size="sm" aria-label={t('cf_edit', 'Edit entry')} title={t('cf_edit', 'Edit entry')} onClick={(e) => { e.stopPropagation(); onEdit(row); }}>
          <Pencil size={14} />
        </IconButton>
      ),
    });
  }
  return cols;
}
