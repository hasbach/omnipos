import React, { useEffect, useMemo, useState } from 'react';
import { getTerminalId } from '../../lib/terminal';
import { RotateCcw, Undo2 } from 'lucide-react';
import { Modal, Button, Field, NumberInput, Select, Textarea, Badge, useToast, useConfirm, SkeletonTable } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, formatDateTime, formatBalance, partyDisplayName } from '../../lib/format';
import { translateServerError } from '../../lib/serverErrors';
import { postJson, ApiFieldError, type CurrencyRow } from './types';

export interface RefundableLine {
  /** The ORIGINAL sale line (transaction_items.id) - refunds are tracked per line, not per product. */
  item_id: number;
  product_id: number;
  uom_id?: number | null;
  uom_name?: string | null;
  uom_factor?: number;
  product_name: string;
  barcode: string | null;
  sold_qty: number;
  refunded_qty: number;
  remaining_qty: number;
  unit_price: number;
  discount_type: string | null;
  discount_value: number | null;
  unit_refund: number;
}

export interface RefundablePreviousRefund {
  id: number;
  created_at: string;
  total_amount: number;
  archived: 0 | 1;
}

export interface RefundableResponse {
  transaction: { id: number; created_at: string; total_amount: number; paid_amount: number; archived: 0 | 1 };
  stakeholder: { id: number; name: string; balance: number } | null;
  factor: number;
  lines: RefundableLine[];
  refunds: RefundablePreviousRefund[];
}

export interface RefundModalProps {
  open: boolean;
  onClose: () => void;
  invoiceId: number | null;
  currencies: CurrencyRow[];
  /** Called after a refund is successfully created (id of the new refund transaction). */
  onDone: (refundId: number) => void;
}

type RefundMethod = 'cash' | 'card' | 'credit';

const USD: CurrencyRow = { code: 'USD', symbol: '$', rate: 1 };
const WALK_IN_NAME = 'Walk-in Customer';

const currentUserId = () => {
  const raw = sessionStorage.getItem('currentCashierId');
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

export function RefundModal({ open, onClose, invoiceId, currencies, onDone }: RefundModalProps) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<RefundableResponse | null>(null);
  const [qty, setQty] = useState<Record<number, number>>({});
  const [method, setMethod] = useState<RefundMethod>('cash');
  const [payCurrency, setPayCurrency] = useState<string>('USD');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const local = currencies.find((c) => c.code !== 'USD') || null;
  const isWalkIn = !!data && (!data.stakeholder || data.stakeholder.name === WALK_IN_NAME);

  useEffect(() => {
    if (!open || !invoiceId) return;
    setLoading(true);
    setQty({});
    setReason('');
    api.get<RefundableResponse>(`/api/transactions/${invoiceId}/refundable`)
      .then((res) => {
        setData(res);
        const fullyPaid = res.transaction.paid_amount >= res.transaction.total_amount - 0.01;
        setMethod(fullyPaid ? 'cash' : (res.stakeholder && res.stakeholder.name !== WALK_IN_NAME ? 'credit' : 'cash'));
        setPayCurrency('USD');
      })
      .catch((err) => { toast.error(translateServerError(err, t) || err.message); onClose(); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoiceId]);

  const setLineQty = (itemId: number, value: number, remaining: number) => {
    const clamped = Math.max(0, Math.min(remaining, Number.isFinite(value) ? value : 0));
    setQty((prev) => ({ ...prev, [itemId]: clamped }));
  };

  const refundAll = () => {
    if (!data) return;
    const next: Record<number, number> = {};
    for (const l of data.lines) if (l.remaining_qty > 0) next[l.item_id] = l.remaining_qty;
    setQty(next);
  };
  const clearAll = () => setQty({});

  const totalUSD = useMemo(() => {
    if (!data) return 0;
    return data.lines.reduce((sum, l) => sum + (qty[l.item_id] || 0) * l.unit_refund, 0);
  }, [data, qty]);

  const hasAnyQty = totalUSD > 0.0001 || Object.values(qty).some((q) => q > 0);

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const handleSubmit = async () => {
    if (!data || !invoiceId) return;
    const lines = data.lines.filter((l) => (qty[l.item_id] || 0) > 0);
    if (lines.length === 0) {
      toast.error(t('inv_refund_validation_no_qty', 'Enter a quantity to refund for at least one line.'));
      return;
    }
    for (const l of lines) {
      if ((qty[l.item_id] || 0) > l.remaining_qty + 1e-9) {
        toast.error(t('inv_refund_validation_over', 'Cannot refund more than the remaining quantity for {name}.').replace('{name}', l.product_name));
        return;
      }
    }
    if (!reason.trim()) {
      toast.error(t('inv_refund_reason_required', 'A reason is required.'));
      return;
    }

    const methodLabel = method === 'cash' ? t('inv_refund_method_cash', 'Cash')
      : method === 'card' ? t('inv_refund_method_card', 'Card')
      : t('inv_refund_method_credit', 'Credit to customer account');
    const ok = await confirm({
      title: t('inv_refund_confirm_title', 'Process this refund?'),
      description: t('inv_refund_confirm_desc', 'Refund {amount} via {method}.').replace('{amount}', formatMoney(totalUSD, USD)).replace('{method}', methodLabel),
      confirmLabel: t('inv_refund_confirm_label', 'Refund'),
      variant: 'primary',
    });
    if (!ok) return;

    setSubmitting(true);
    setFormError(null);
    try {
      const cur = currencies.find((c) => c.code === payCurrency) || USD;
      const payments = method === 'credit' ? [] : [{
        amount: method === 'cash' || method === 'card' ? totalUSD * (cur.rate || 1) : totalUSD,
        method,
        currency: cur.code,
        exchange_rate: cur.rate || 1,
      }];
      const res = await postJson<{ id: number }>('/api/transactions', {
        type: 'refund',
        terminalId: getTerminalId(),
        original_transaction_id: invoiceId,
        stakeholder_id: data.stakeholder?.id ?? null,
        user_id: currentUserId(),
        // One entry per original line; quantity is in that line's unit (carton, pack, piece).
        items: lines.map((l) => ({ id: l.product_id, original_item_id: l.item_id, uom_id: l.uom_id ?? undefined, quantity: qty[l.item_id] })),
        currency: 'USD',
        exchange_rate: 1,
        payments,
        notes: reason,
      });
      toast.success(t('inv_refund_success', 'Refund #{id} created.').replace('{id}', String(res.id)));
      onDone(res.id);
    } catch (err: any) {
      const translated = translateServerError(err, t) || err.message;
      toast.error(translated);
      if (err instanceof ApiFieldError) setFormError(translated);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="lg"
      title={invoiceId ? t('inv_refund_modal_title', 'Refund invoice #{id}').replace('{id}', String(invoiceId)) : t('inv_action_refund', 'Refund')}
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={submitting}>{t('inv_refund_cancel', 'Cancel')}</Button>
          <Button variant="primary" loading={submitting} disabled={!hasAnyQty} onClick={handleSubmit}>
            <RotateCcw size={15} /> {t('inv_refund_submit', 'Process refund')}
          </Button>
        </>
      }
    >
      <div
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !(e.target as HTMLElement).closest('textarea')) {
            e.preventDefault();
            if (hasAnyQty && !submitting) handleSubmit();
          }
        }}
      >
        {loading || !data ? (
          <SkeletonTable cols={5} rows={4} />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-3 text-sm">
              <div>
                <p className="text-xs text-text-3">{t('inv_detail_party', 'Party')}</p>
                <p className="font-medium text-text">{data.stakeholder ? partyDisplayName(data.stakeholder.name, t) : t('party_walk_in', 'Walk-in Customer')}</p>
              </div>
              <div>
                <p className="text-xs text-text-3">{t('inv_detail_date', 'Date')}</p>
                <p className="font-medium text-text num">{formatDateTime(data.transaction.created_at, lang)}</p>
              </div>
              <div>
                <p className="text-xs text-text-3">{t('inv_detail_total', 'Total')}</p>
                <p className="font-medium text-text num">{formatMoney(data.transaction.total_amount, USD)}</p>
              </div>
              <div>
                <p className="text-xs text-text-3">{t('inv_detail_paid', 'Paid')}</p>
                <p className="font-medium text-text num">{formatMoney(data.transaction.paid_amount, USD)}</p>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-3">{t('inv_detail_lines', 'Line items')}</p>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={refundAll}>{t('inv_refund_all_remaining', 'Refund all remaining')}</Button>
                <Button variant="ghost" size="sm" onClick={clearAll}>{t('inv_refund_clear', 'Clear')}</Button>
              </div>
            </div>

            <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-surface-2">
                  <tr className="text-xs uppercase tracking-wide text-text-3">
                    <th className="px-2 py-2 text-start">{t('inv_refund_col_product', 'Product')}</th>
                    <th className="px-2 py-2 text-end num">{t('inv_refund_col_sold', 'Sold')}</th>
                    <th className="px-2 py-2 text-end num">{t('inv_refund_col_refunded', 'Refunded')}</th>
                    <th className="px-2 py-2 text-end num">{t('inv_refund_col_remaining', 'Remaining')}</th>
                    <th className="px-2 py-2 w-24 text-end num">{t('inv_refund_col_qty', 'Refund qty')}</th>
                    <th className="px-2 py-2 text-end num">{t('inv_refund_col_unit_refund', 'Unit refund')}</th>
                    <th className="px-2 py-2 text-end num">{t('inv_refund_col_line_total', 'Line refund')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((l) => {
                    const fractional = !Number.isInteger(l.sold_qty);
                    const q = qty[l.item_id] || 0;
                    return (
                      <tr key={l.item_id} className="border-t border-border">
                        <td className="px-2 py-2 font-medium text-text">
                          {l.product_name}
                          {l.uom_name && <span className="ms-2 text-xs font-semibold text-primary">{l.uom_name}{(l.uom_factor || 1) > 1 ? ` ×${l.uom_factor}` : ''}</span>}
                        </td>
                        <td className="px-2 py-2 text-end num">{l.sold_qty}</td>
                        <td className="px-2 py-2 text-end num text-text-3">{l.refunded_qty}</td>
                        <td className="px-2 py-2 text-end num">{l.remaining_qty}</td>
                        <td className="px-2 py-2">
                          <NumberInput
                            value={q}
                            min={0}
                            max={l.remaining_qty}
                            step={fractional ? 0.01 : 1}
                            disabled={l.remaining_qty <= 0}
                            onChange={(v) => setLineQty(l.item_id, v, l.remaining_qty)}
                            className="w-24"
                          />
                        </td>
                        <td className="px-2 py-2 text-end num text-text-3">{formatMoney(l.unit_refund, USD)}</td>
                        <td className="px-2 py-2 text-end num font-semibold text-text">{formatMoney(q * l.unit_refund, USD)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-[var(--radius-card)] border border-border p-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-text-3">{t('inv_refund_method', 'Refund method')}</p>
                <Select
                  value={method}
                  onChange={(e) => setMethod(e.target.value as RefundMethod)}
                  options={[
                    { value: 'cash', label: t('inv_refund_method_cash', 'Cash') },
                    { value: 'card', label: t('inv_refund_method_card', 'Card') },
                    { value: 'credit', label: t('inv_refund_method_credit', 'Credit to customer account'), disabled: isWalkIn },
                  ]}
                />
                {isWalkIn && method !== 'credit' && (
                  <p className="text-xs text-text-3">{t('inv_refund_walkin_no_credit', 'Credit to account is unavailable for Walk-in customers.')}</p>
                )}
                {method !== 'credit' && (
                  <Field label={t('inv_refund_currency', 'Currency')}>
                    <Select
                      value={payCurrency}
                      onChange={(e) => setPayCurrency(e.target.value)}
                      options={[{ value: 'USD', label: 'USD' }, ...(local ? [{ value: local.code, label: local.code }] : [])]}
                    />
                  </Field>
                )}
                <Field label={t('inv_refund_reason', 'Reason')} required error={formError || undefined}>
                  <Textarea rows={2} value={reason} onChange={(e) => { setReason(e.target.value); setFormError(null); }} placeholder={t('inv_refund_reason_placeholder', 'Why is this being refunded?')} />
                </Field>
              </div>

              <div className="space-y-2">
                <div className="rounded-[var(--radius-card)] border border-border p-3 space-y-1 text-sm">
                  <div className="flex justify-between text-base font-semibold"><span>{t('inv_refund_total', 'Refund total')}</span><span className="num text-danger">{formatMoney(totalUSD, USD)}</span></div>
                  {local && <div className="flex justify-between text-xs text-text-3"><span>{t('inv_detail_local', 'Local')}</span><span className="num">{formatMoney(totalUSD * local.rate, local)}</span></div>}
                </div>

                {data.stakeholder && !isWalkIn && (() => {
                  const prevBal = data.stakeholder!.balance;
                  const newBal = method === 'credit' ? prevBal + totalUSD : prevBal;
                  const prev = formatBalance(prevBal, USD, t);
                  const next = formatBalance(newBal, USD, t);
                  const variantClass = (v: 'danger' | 'success' | 'neutral') => v === 'danger' ? 'text-danger' : v === 'success' ? 'text-success' : 'text-text-3';
                  return (
                    <div className="rounded-[var(--radius-card)] border border-border p-3 flex justify-between text-sm">
                      <span className="text-text-3">{t('inv_editor_old_balance', 'Old balance')}: <span className={`num font-semibold ${variantClass(prev.variant)}`}>{prev.amount} {prev.label}</span></span>
                      <span className="text-text-3">{t('inv_editor_new_balance', 'New balance')}: <span className={`num font-semibold ${variantClass(next.variant)}`}>{next.amount} {next.label}</span></span>
                    </div>
                  );
                })()}

                <div className="rounded-[var(--radius-card)] border border-border p-3">
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-3">{t('inv_refund_previous', 'Previous refunds')}</p>
                  {data.refunds.length === 0 ? (
                    <p className="text-xs text-text-3">{t('inv_refund_previous_none', 'No refunds yet.')}</p>
                  ) : (
                    <div className="space-y-1">
                      {data.refunds.map((r) => (
                        <div key={r.id} className="flex items-center justify-between text-xs">
                          <span className="inline-flex items-center gap-1 text-text-2"><Undo2 size={12} /> #{r.id}</span>
                          <span className="num text-text-3">{formatDateTime(r.created_at, lang)}</span>
                          <span className="num font-medium text-text">{formatMoney(r.total_amount, USD)}</span>
                          {r.archived ? <Badge variant="neutral">{t('inv_flag_settled', 'Settled')}</Badge> : <span />}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default RefundModal;
