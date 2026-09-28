import React, { useEffect, useState } from 'react';
import { ArrowUpRight, Package, RotateCcw, ShoppingCart } from 'lucide-react';
import { Drawer, Badge, SkeletonTable, EmptyState } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { formatDateTime } from '../../lib/format';
import { api } from '../../lib/api';

export interface MovementRow {
  date: string;
  type: 'sale' | 'refund' | 'purchase' | 'adjustment';
  transaction_id?: number;
  adjustment_id?: number;
  archived?: boolean;
  reason?: string | null;
  quantity_change: number;
  balance_after: number;
}

export interface MovementsDrawerProps {
  open: boolean;
  productId: number | null;
  productName?: string;
  onClose: () => void;
}

const TYPE_ICON: Record<MovementRow['type'], React.ReactNode> = {
  sale: <ShoppingCart size={13} />,
  refund: <RotateCcw size={13} />,
  purchase: <Package size={13} />,
  adjustment: <ArrowUpRight size={13} />,
};

const TYPE_VARIANT: Record<MovementRow['type'], 'primary' | 'warning' | 'success' | 'neutral'> = {
  sale: 'primary',
  refund: 'warning',
  purchase: 'success',
  adjustment: 'neutral',
};

export function MovementsDrawer({ open, productId, productName, onClose }: MovementsDrawerProps) {
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<MovementRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !productId) return;
    setLoading(true);
    api
      .get<MovementRow[]>(`/api/stock/movements/${productId}`)
      .then((data) => setRows([...data].reverse()))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [open, productId]);

  const typeLabel = (type: MovementRow['type']) =>
    t(
      type === 'sale'
        ? 'stock_type_sale'
        : type === 'refund'
        ? 'stock_type_refund'
        : type === 'purchase'
        ? 'stock_type_purchase'
        : 'stock_type_adjustment',
    );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title={t('stock_movements_title', 'Movements: {name}').replace('{name}', productName || '')}
    >
      {loading ? (
        <SkeletonTable rows={8} cols={5} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('stock_movement_empty', 'No movements recorded yet.')} icon={Package} />
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-xs text-text-3">
              <th className="border-b border-border px-2 py-2 text-start font-medium">{t('stock_movement_date', 'Date')}</th>
              <th className="border-b border-border px-2 py-2 text-start font-medium">{t('stock_movement_type', 'Type')}</th>
              <th className="border-b border-border px-2 py-2 text-start font-medium">{t('stock_movement_reference', 'Reference #')}</th>
              <th className="border-b border-border px-2 py-2 text-end font-medium">{t('stock_movement_qty_in', 'Qty in')}</th>
              <th className="border-b border-border px-2 py-2 text-end font-medium">{t('stock_movement_qty_out', 'Qty out')}</th>
              <th className="border-b border-border px-2 py-2 text-end font-medium">{t('stock_movement_balance', 'Balance after')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const qtyIn = r.quantity_change > 0 ? r.quantity_change : 0;
              const qtyOut = r.quantity_change < 0 ? -r.quantity_change : 0;
              const ref = r.type === 'adjustment' ? (r.reason || '—') : `#${r.transaction_id}${r.archived ? ' (settled)' : ''}`;
              return (
                <tr key={i} className="hover:bg-surface-2">
                  <td className="border-b border-border px-2 py-2 text-text-2 whitespace-nowrap">{formatDateTime(r.date, lang)}</td>
                  <td className="border-b border-border px-2 py-2">
                    <Badge variant={TYPE_VARIANT[r.type]}>
                      {TYPE_ICON[r.type]}
                      {typeLabel(r.type)}
                    </Badge>
                  </td>
                  <td className="border-b border-border px-2 py-2 text-text-3">{ref}</td>
                  <td className="num border-b border-border px-2 py-2 text-end text-success">{qtyIn > 0 ? `+${qtyIn}` : ''}</td>
                  <td className="num border-b border-border px-2 py-2 text-end text-danger">{qtyOut > 0 ? `-${qtyOut}` : ''}</td>
                  <td className="num border-b border-border px-2 py-2 text-end font-semibold text-text">{r.balance_after}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Drawer>
  );
}

export default MovementsDrawer;
