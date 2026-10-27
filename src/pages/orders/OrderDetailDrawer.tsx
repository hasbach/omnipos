import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Drawer, Modal, Badge, Button, Field, NumberInput, Select, Textarea, DataTable, SkeletonTable,
  useToast, type DataTableColumn,
} from '../../components/ui';
import { useI18n } from '../../intl/index';
import { ordersApi, shortfallReasons, orderBadge, type OrderDetail, type OrderLine, type ConfirmLine } from '../../lib/ordersApi';
import { formatDateTime, formatMoney } from '../../lib/format';
import { translateServerError } from '../../lib/serverErrors';
import type { ApiError } from '../../lib/api';
import ordersLocale from '../../intl/locales/orders';

type Action = 'accept' | 'reject' | 'cancel' | 'ready';

export default function OrderDetailDrawer({ orderId, open, onClose, onChanged }: {
  orderId: number | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [data, setData] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [lines, setLines] = useState<ConfirmLine[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const request = useRef(0);

  const load = useCallback(async () => {
    if (orderId === null || !open) return;
    const seq = ++request.current;
    setLoading(true);
    try {
      const result = await ordersApi.detail(orderId);
      // Ignore a response if the user has since opened another order or closed the drawer.
      if (seq === request.current) setData(result);
    } catch (e) {
      if (seq === request.current) toast.error(translateServerError(e, t));
    } finally {
      if (seq === request.current) setLoading(false);
    }
  }, [orderId, open, t, toast]);

  useEffect(() => {
    setData(null);
    setAction(null);
    void load();
    const sync = (e: Event) => {
      if ((e as CustomEvent).detail?.type === 'ORDERS_UPDATED') void load();
    };
    window.addEventListener('pos-sync', sync);
    return () => {
      ++request.current;
      window.removeEventListener('pos-sync', sync);
    };
  }, [load]);

  const begin = (a: Action) => {
    if (!data) return;
    setErrors({});
    setReason('');
    setLines(data.lines.map((l) => ({ line_no: l.line_no, confirmed_qty: l.ordered_qty })));
    setAction(a);
  };

  const submit = async (a: Action) => {
    if (!data || busy || !data.online || !data.actions[a]) return;
    const invalid: Record<string, string> = {};
    if (a === 'accept') {
      lines.forEach((l, i) => {
        const ordered = data.lines[i].ordered_qty;
        if (!Number.isFinite(l.confirmed_qty) || l.confirmed_qty < 0 || l.confirmed_qty > ordered) {
          invalid['lines[' + i + ']'] = t('commerce_err_order_confirm_exceeds');
        } else if (l.confirmed_qty < ordered && !l.reason) {
          invalid['lines[' + i + ']'] = t('commerce_err_order_reason_required');
        }
      });
      if (!lines.some((l) => l.confirmed_qty > 0)) invalid.form = t('commerce_err_order_all_zero');
    } else if (a !== 'ready' && (!reason.trim() || reason.trim().length > 300)) {
      invalid.reason = t('commerce_err_order_reason_required');
    }
    setErrors(invalid);
    if (Object.keys(invalid).length) return;
    setBusy(true);
    try {
      if (a === 'accept') {
        await ordersApi.accept(data.order.id, data.order.state, lines);
      } else {
        await ordersApi.action(data.order.id, a, data.order.state, a === 'ready' ? undefined : reason.trim());
      }
      setAction(null);
      toast.success(t('orders_updated'));
      onChanged();
      void load();
    } catch (e) {
      const err = e as ApiError;
      const message = translateServerError(e, t);
      setErrors({ [err.field || 'form']: message });
      if (err.code === 'ORDER_ALREADY_HANDLED') {
        // Another register may have handled it; show the server's state and refresh both views.
        toast.info(t('orders_handled').replace('{state}', err.state ? t('orders_' + err.state) : t('orders_state')));
        setAction(null);
        onChanged();
        void load();
      } else {
        toast.error(message);
        if (err.code === 'ORDER_EXPIRED' || err.code === 'ORDER_NEEDS_ONLINE') {
          onChanged();
          void load();
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const columns: DataTableColumn<OrderLine>[] = [
    {
      key: 'product_name', header: t('orders_lines'),
      render: (l) => (
        <div>
          {l.product_name}
          <div className="text-xs text-text-3">{l.unit_name} × {l.unit_factor}</div>
        </div>
      ),
    },
    { key: 'ordered_qty', header: t('orders_ordered'), align: 'end' },
    { key: 'confirmed_qty', header: t('orders_confirmed_qty'), align: 'end', render: (l) => l.confirmed_qty ?? '—' },
    {
      key: 'stock', header: t('orders_stock'),
      render: (l) => l.local_product
        ? <span className="num">{l.local_product.stock} {l.local_product.unit}</span>
        : t('orders_unmatched'),
    },
  ];

  const contact = (call: boolean) => {
    if (!data?.customer_wa_digits) return;
    if (call) {
      window.open('tel:+' + data.customer_wa_digits, '_blank', 'noopener');
      return;
    }
    // Customer messages follow the store's language, independently of the operator's UI language.
    const language = data.store.default_language;
    const dict: Record<string, string> = ordersLocale[language === 'ar' || language === 'fr' ? language : 'en'];
    const state = data.order.effective_state;
    let message = dict[['confirmed', 'ready', 'rejected'].includes(state) ? 'orders_wa_' + state : 'orders_wa_default'];
    const vars: Record<string, string> = {
      number: data.order.number,
      store: data.store.name,
      total: formatMoney(data.order.confirmed_total_usd ?? data.order.total_usd, { code: 'USD', symbol: '$' }),
      note: data.store.pickup_note || '',
      reason: data.order.reason || '',
      fulfilment: dict['orders_' + data.order.fulfilment],
    };
    message = message.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '');
    window.open('https://wa.me/' + data.customer_wa_digits + '?text=' + encodeURIComponent(message), '_blank', 'noopener');
  };

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <>
      <Drawer open={open} onClose={close} size="lg" title={data?.order.number ?? t('orders_title')}>
        {loading && !data ? <SkeletonTable /> : data ? (
          <div className="space-y-4">
            {!data.online && (
              <div role="status" className="rounded-md bg-accent-soft p-3 text-accent">
                {t('orders_offline')}
              </div>
            )}
            <Badge variant={orderBadge(data.order.effective_state)}>{t('orders_' + data.order.effective_state)}</Badge>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Field label={t('orders_customer')}>
                <div>
                  {data.order.customer_name}
                  <div dir="ltr" className="num text-start">{data.order.customer_phone}</div>
                </div>
              </Field>
              <Field label={t('orders_fulfilment')}>
                <div>{t('orders_' + data.order.fulfilment)} · {data.store.name}</div>
              </Field>
            </div>
            {data.order.address && (
              <Field label={t('orders_address')}>
                <p className="whitespace-pre-wrap">{data.order.address}</p>
              </Field>
            )}
            {data.order.note && (
              <Field label={t('orders_note')}>
                <p className="whitespace-pre-wrap">{data.order.note}</p>
              </Field>
            )}
            {data.order.reason && (
              <Field label={t('orders_reason')}>
                <p>{data.order.reason}</p>
              </Field>
            )}
            <DataTable columns={columns} data={data.lines} rowKey={(l) => l.line_no} />
            <div className="num text-end font-semibold">
              {t('orders_total')}: {formatMoney(data.order.confirmed_total_usd ?? data.order.total_usd, { code: 'USD', symbol: '$' })}
              {data.order.local_currency && (
                <>
                  {' · '}
                  {formatMoney(data.order.confirmed_total_local ?? data.order.total_local ?? 0, {
                    code: data.order.local_currency,
                    symbol: data.order.local_currency,
                  }, { decimals: 0 })}
                </>
              )}
            </div>
            {['confirmed', 'ready'].includes(data.order.effective_state) && (
              <p className="rounded-md bg-info-soft p-3 text-sm text-info">{t('orders_pos_note')}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {(['accept', 'reject', 'ready', 'cancel'] as const).map((a) => (
                <Button
                  key={a}
                  variant={a === 'reject' || a === 'cancel' ? 'danger' : 'secondary'}
                  disabled={busy || loading || !data.online || !data.actions[a]}
                  onClick={() => a === 'ready' ? void submit(a) : begin(a)}
                >
                  {t(a === 'ready' ? 'orders_mark_ready' : 'orders_' + a)}
                </Button>
              ))}
            </div>
            {data.customer_wa_digits && (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => contact(false)}>{t('orders_whatsapp')}</Button>
                <Button variant="secondary" onClick={() => contact(true)}>{t('orders_call')}</Button>
              </div>
            )}
            <h3 className="text-sm font-semibold">{t('orders_history')}</h3>
            <ol className="space-y-2 text-sm">
              {data.events.map((e, i) => (
                <li key={i} className="border-s-2 border-border ps-3">
                  <div className="num text-xs text-text-3">{formatDateTime(e.at, lang)}</div>
                  <div>
                    {t('orders_' + e.kind)}
                    {/* "from → to" only for an actual state change (not for "submitted" or "adjusted"). */}
                    {e.from_state && e.to_state && e.from_state !== e.to_state && (
                      <span className="text-text-3"> · {t('orders_' + e.from_state)} → {t('orders_' + e.to_state)}</span>
                    )}
                  </div>
                  <div className="text-text-2">
                    {e.actor_name || t('orders_actor_' + e.actor_kind)}
                    {e.terminal && <> · {e.terminal}</>}
                    {e.reason && <> · {e.reason}</>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </Drawer>
      <Modal
        open={action !== null}
        onClose={() => {
          if (!busy) setAction(null);
        }}
        title={action ? t('orders_' + action) + ' · ' + (data?.order.number ?? '') : ''}
        size="lg"
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (action) void submit(action);
          }}
        >
          {action === 'accept' ? data?.lines.map((l, i) => (
            <div key={l.line_no} className="space-y-2 rounded-md border border-border p-3">
              <div className="text-sm font-medium">{l.product_name} · {l.unit_name}</div>
              <div className="num text-xs text-text-3">
                {t('orders_ordered')}: {l.ordered_qty} · {t('orders_stock')}:{' '}
                {l.local_product ? l.local_product.stock + ' ' + l.local_product.unit : t('orders_unmatched')}
              </div>
              <Field label={t('orders_confirmed_qty')} error={errors['lines[' + i + ']']}>
                <NumberInput
                  value={lines[i]?.confirmed_qty ?? 0}
                  min={0}
                  max={l.ordered_qty}
                  step={0.001}
                  disabled={busy}
                  onChange={(v) => setLines((old) => old.map((x, j) => j === i ? { ...x, confirmed_qty: v } : x))}
                />
              </Field>
              {(lines[i]?.confirmed_qty ?? 0) < l.ordered_qty && (
                <Field label={t('orders_reason')}>
                  <Select
                    required
                    disabled={busy}
                    value={lines[i]?.reason ?? ''}
                    onChange={(e) => setLines((old) => old.map((x, j) => (
                      j === i ? { ...x, reason: e.target.value as ConfirmLine['reason'] } : x
                    )))}
                    options={[
                      { value: '', label: t('orders_choose_reason') },
                      ...shortfallReasons.map((r) => ({ value: r, label: t('orders_' + r) })),
                    ]}
                  />
                </Field>
              )}
            </div>
          )) : (
            <Field label={t('orders_reason')} error={errors.reason}>
              <Textarea
                required
                maxLength={300}
                value={reason}
                disabled={busy}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          )}
          {errors.form && <p role="alert" className="text-sm text-danger">{errors.form}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setAction(null)}>
              {t('orders_close')}
            </Button>
            <Button type="submit" loading={busy} disabled={!data?.online || !action || !data.actions[action]}>
              {t('orders_save')}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
