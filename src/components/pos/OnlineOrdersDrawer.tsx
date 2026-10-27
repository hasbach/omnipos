import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Drawer, SkeletonTable, useToast } from '../ui';
import { useI18n } from '../../intl/index';
import { ordersApi, orderBadge, type OrderRow, type OrderSaleDraft } from '../../lib/ordersApi';
import { formatMoney } from '../../lib/format';
import { translateServerError } from '../../lib/serverErrors';

export default function OnlineOrdersDrawer({ open, onClose, onComplete }: {
  open: boolean;
  onClose: () => void;
  onComplete: (draft: OrderSaleDraft) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const request = useRef(0);
  const draftRequest = useRef(0);

  const load = useCallback(async () => {
    if (!open) return;
    const sequence = ++request.current;
    setLoading(true);
    try {
      const result = await ordersApi.list();
      if (sequence !== request.current) return;
      setRows(result.rows.filter(row => (
        ['confirmed', 'ready', 'submitted'].includes(row.effective_state)
      )).sort((a, b) => (
        Number(a.effective_state === 'submitted') - Number(b.effective_state === 'submitted')
        || Date.parse(a.submitted_at) - Date.parse(b.submitted_at)
      )));
      setOnline(result.online);
    } catch (error) {
      if (sequence === request.current) toast.error(translateServerError(error, t));
    } finally {
      if (sequence === request.current) setLoading(false);
    }
  }, [open, t, toast]);

  useEffect(() => {
    setRows([]);
    void load();
    const sync = () => { void load(); };
    window.addEventListener('pos-sync', sync);
    return () => {
      ++request.current;
      ++draftRequest.current;
      window.removeEventListener('pos-sync', sync);
    };
  }, [load]);

  const complete = async (id: number) => {
    if (busy !== null) return;
    const sequence = ++draftRequest.current;
    setBusy(id);
    try {
      const draft = await ordersApi.getSaleDraft(id);
      if (sequence !== draftRequest.current) return;
      onComplete(draft);
      onClose();
    } catch (error) {
      if (sequence === draftRequest.current) toast.error(translateServerError(error, t));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title={t('orders_title')} size="md">
      <div className="space-y-3">
        {!online && (
          <p role="status" className="rounded-md bg-accent-soft p-3 text-sm text-accent">
            {t('orders_completion_offline')}
          </p>
        )}
        {loading && <SkeletonTable />}
        {!loading && rows.length === 0 && (
          <p className="py-8 text-center text-sm text-text-3">{t('orders_empty')}</p>
        )}
        {rows.map(row => (
          <div key={row.id} className="space-y-2 rounded-md border border-border p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="num font-semibold">{row.number}</span>
              <Badge variant={orderBadge(row.effective_state)}>
                {t('orders_' + row.effective_state)}
              </Badge>
            </div>
            <div>{row.customer_name}</div>
            <div className="text-text-3">{row.store.name}</div>
            <div className="num">
              {formatMoney(row.confirmed_total_usd ?? row.total_usd, { code: 'USD', symbol: '$' })}
            </div>
            {row.effective_state === 'submitted' ? (
              <p className="text-text-3">{t('orders_accept_first')}</p>
            ) : (
              <Button
                loading={busy === row.id}
                disabled={busy !== null || loading || !online}
                onClick={() => void complete(row.id)}
              >
                {t('orders_complete_sale')}
              </Button>
            )}
          </div>
        ))}
      </div>
    </Drawer>
  );
}
