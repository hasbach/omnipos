import React from 'react';
import { Badge } from './ui';
import { computeTotals } from '../lib/pricing';
import {
  formatMoney, formatNumber, formatDateTime, paymentMethodLabel, partyDisplayName,
} from '../lib/format';
import { orderLocal, formatLocal, formatRate } from '../lib/orderTotals';

const USD = { code: 'USD', symbol: '$', rate: 1 };

interface Props {
  /** The row picked in the history list (may also be the full transaction the refund flow swaps in). */
  tx: any;
  /** Bumped whenever the list is refreshed, so cached details/refunds are dropped and reloaded. */
  refreshKey: any;
  currencies: any[];
  t: (key: string, fallback?: string, vars?: any) => string;
  lang: string;
  formatTxId: (tx: any) => string;
  /** Print / Refund buttons, rendered in the panel footer. */
  actions?: React.ReactNode;
}

/** Order preview shown beside the Daily Order History list. */
export default function OrderHistoryPreview({ tx, refreshKey, currencies, t, lang, formatTxId, actions }: Props) {
  const [details, setDetails] = React.useState<Record<number, any>>({});
  const [refundsById, setRefundsById] = React.useState<Record<number, any[]>>({});
  const [failedId, setFailedId] = React.useState<number | null>(null);
  const id: number | null = tx?.id ?? null;
  const type: string | undefined = tx?.type;

  // The list was refreshed (date change, refund) — anything cached may be stale.
  React.useEffect(() => { setDetails({}); setRefundsById({}); setFailedId(null); }, [refreshKey]);

  // Fetch the detail for the selected order. `cancelled` drops the response if the user has already
  // clicked another row (or the cache was reset) by the time it arrives.
  React.useEffect(() => {
    if (id == null || details[id]) return;
    let cancelled = false;
    setFailedId(null);
    fetch(`/api/transactions/${id}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then(d => { if (!cancelled) setDetails(prev => ({ ...prev, [id]: d })); })
      .catch(() => { if (!cancelled) setFailedId(id); });
    return () => { cancelled = true; };
  }, [id, details, refreshKey]);

  // Refunds already made against a sale (sales only).
  React.useEffect(() => {
    if (id == null || type !== 'sale' || refundsById[id]) return;
    let cancelled = false;
    fetch(`/api/transactions/${id}/refundable`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d) setRefundsById(prev => ({ ...prev, [id]: d.refunds || [] })); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [id, type, refundsById, refreshKey]);

  if (!tx) {
    return (
      <div className="h-full min-h-[160px] flex items-center justify-center p-8 text-center text-sm italic text-text-3">
        {t('pos_hist_select_order', 'Select an order to preview it')}
      </div>
    );
  }

  const detail = details[tx.id];
  const header = detail || tx;
  const typeVariant = header.type === 'refund' ? 'danger' : header.type === 'purchase' ? 'info' : 'success';
  const typeLabel = header.type === 'sale' ? t('pos_type_sale', 'sale')
    : header.type === 'refund' ? t('pos_type_refund', 'refund')
    : header.type === 'purchase' ? t('pos_type_purchase', 'purchase') : header.type;

  const dual = (usd: number, big = false) => {
    const lbp = orderLocal(usd, header, currencies);
    return (
      <div className="text-end">
        <div className={`font-mono font-black num text-text ${big ? 'text-2xl' : 'text-sm font-bold'}`}>{formatMoney(usd, USD)}</div>
        {lbp && (
          <div className={`font-mono num text-text-3 ${big ? 'text-base font-bold' : 'text-[11px]'}`}>
            {formatLocal(lbp.amount, lbp.currency)}
            {big && (
              <span className="ms-2 text-[11px] font-normal">
                @ {formatRate(lbp.rate)}{lbp.stored ? '' : ` ${t('pos_hist_current_rate', '(current rate)')}`}
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  let body: React.ReactNode;
  if (!detail) {
    body = (
      <div className="p-8 text-center text-sm italic text-text-3">
        {failedId === tx.id ? t('pos_hist_load_failed', 'Could not load this order.') : t('pos_hist_loading_order', 'Loading order...')}
      </div>
    );
  } else {
    const items: any[] = detail.items || [];
    const totals = computeTotals({
      lines: items.map(it => ({ unitPrice: it.unit_price ?? it.price ?? 0, qty: it.quantity ?? 0, discount: it.discount || null })),
      discount: detail.discount || null,
      tax: detail.tax_type && detail.tax_value ? { type: detail.tax_type, value: detail.tax_value } : null,
    });
    const total = Number(detail.total_amount) || 0;
    const paid = Number(detail.paid_amount) || 0;
    const remaining = Math.max(0, total - paid);
    const payments: any[] = detail.payments || [];
    const refunds = refundsById[tx.id] || [];
    const refundedUSD = refunds.reduce((s, r) => s + (Number(r.total_amount) || 0), 0);

    body = (
      <div className="p-4 space-y-4">
        {detail.type === 'refund' && detail.original_transaction_id != null && (
          <div className="text-xs font-bold text-danger">
            {t('pos_hist_refund_of', 'Refund of #{id}', { id: detail.original_transaction_id })}
          </div>
        )}
        {detail.type === 'sale' && refunds.length > 0 && (
          <div className="text-xs font-bold text-danger">
            {t('pos_hist_refunded', 'Refunded: {amount} ({count} refunds)', { amount: formatMoney(refundedUSD, USD), count: refunds.length })}
          </div>
        )}

        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-text-3 mb-2">{t('pos_hist_items', 'Items')}</p>
          <div className="rounded-xl border border-border divide-y divide-border bg-surface">
            {items.map((it: any, i: number) => {
              const factor = it.uom_factor || 1;
              const unit = it.uom_name ? `${it.uom_name}${factor > 1 ? ` ×${factor}` : ''}` : '';
              const qty = it.display_qty ?? it.quantity;
              const unitPrice = it.display_unit_price ?? it.unit_price ?? it.price ?? 0;
              const lineUSD = (it.unit_price ?? it.price ?? 0) * (it.quantity ?? 0);
              const lineNet = computeTotals({ lines: [{ unitPrice: it.unit_price ?? it.price ?? 0, qty: it.quantity ?? 0, discount: it.discount || null }] }).subtotal;
              const hasDiscount = !!(it.discount && it.discount.value);
              return (
                <div key={it.id ?? i} className="p-3 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-sm text-text break-words">
                      {it.product_name || `#${it.product_id}`}
                      {unit && <span className="ms-2 text-xs font-bold text-primary">{unit}</span>}
                    </div>
                    <div className="text-xs font-mono num text-text-2">
                      {formatNumber(qty, { decimals: Number.isInteger(qty) ? 0 : 3 })} × {formatMoney(unitPrice, USD)}
                      {hasDiscount && (
                        <span className="ms-2 text-danger">
                          -{it.discount.type === 'percentage' ? `${it.discount.value}%` : formatMoney(it.discount.value, USD)}
                        </span>
                      )}
                    </div>
                    {it.barcode && <div className="text-[10px] font-mono text-text-3">{it.barcode}</div>}
                  </div>
                  <div className="text-end shrink-0">
                    <div className="font-mono font-bold num text-sm text-text">{formatMoney(lineNet, USD)}</div>
                    {hasDiscount && lineUSD !== lineNet && (
                      <div className="font-mono num text-[10px] text-text-3 line-through">{formatMoney(lineUSD, USD)}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-surface-2 p-3 space-y-1.5 text-sm">
          {(totals.discountAmount > 0 || totals.taxAmount > 0) && (
            <div className="flex justify-between text-text-2">
              <span>{t('pos_hist_subtotal', 'Subtotal')}</span>
              <span className="font-mono num">{formatMoney(totals.subtotal, USD)}</span>
            </div>
          )}
          {totals.discountAmount > 0 && (
            <div className="flex justify-between text-danger">
              <span>{t('pos_hist_discount', 'Discount')}</span>
              <span className="font-mono num">-{formatMoney(totals.discountAmount, USD)}</span>
            </div>
          )}
          {totals.taxAmount > 0 && (
            <div className="flex justify-between text-text-2">
              <span>{t('pos_hist_tax', 'Tax')}</span>
              <span className="font-mono num">{formatMoney(totals.taxAmount, USD)}</span>
            </div>
          )}
          <div className="flex justify-between items-end pt-1 border-t border-border">
            <span className="text-xs font-bold uppercase tracking-wide text-text-3">{t('pos_hist_total', 'Total')}</span>
            {dual(total, true)}
          </div>
          {detail.type === 'sale' && (
            <>
              <div className="flex justify-between text-text-2">
                <span>{t('pos_hist_paid', 'Paid')}</span>
                <span className="font-mono num">{formatMoney(paid, USD)}</span>
              </div>
              {remaining > 0.01 && (
                <div className="flex justify-between font-bold text-danger">
                  <span>{t('pos_hist_remaining', 'Remaining (on account)')}</span>
                  <span className="font-mono num">{formatMoney(remaining, USD)}</span>
                </div>
              )}
            </>
          )}
        </div>

        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-text-3 mb-2">{t('pos_hist_payments', 'Payments')}</p>
          {payments.length === 0 ? (
            <p className="text-xs italic text-text-3">{t('pos_hist_no_payments', 'No payments recorded')}</p>
          ) : (
            <div className="space-y-1.5">
              {payments.map((p: any, i: number) => {
                const cur = currencies.find((c: any) => c.code === p.currency);
                const curLike = cur || { code: p.currency, symbol: p.currency, rate: p.exchange_rate };
                const rate = p.exchange_rate || 1;
                return (
                  <div key={p.id ?? i} className="flex justify-between items-center gap-3 p-2.5 rounded-lg border border-border bg-surface text-sm">
                    <span className="font-semibold text-text">{paymentMethodLabel(p.method, t)}</span>
                    <span className="text-end font-mono num text-text">
                      {formatMoney(p.amount, curLike)}
                      {p.currency !== 'USD' && (
                        <span className="block text-[11px] text-text-3">{formatMoney(p.amount / rate, USD)}</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      <div className="p-4 border-b border-border bg-surface-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-black text-lg text-text">{formatTxId(header)}</span>
          <Badge variant={typeVariant}>{typeLabel}</Badge>
          {detail?.archived ? <Badge variant="info">{t('pos_hist_archived', 'Archived')}</Badge> : null}
        </div>
        <div className="mt-1 text-xs text-text-3">{formatDateTime(header.created_at, lang)}</div>
        <div className="mt-1 text-xs text-text-2">
          <span className="font-semibold">{header.stakeholder_name ? partyDisplayName(header.stakeholder_name, t) : t('pos_walk_in', 'Walk-in')}</span>
          <span className="mx-1.5 text-text-3">·</span>
          <span>{t('pos_hist_cashier', 'Cashier')}: {header.user_name || t('pos_hist_system', 'System')}</span>
        </div>
      </div>
      <div className="flex-1">{body}</div>
      {actions && (
        <div className="sticky bottom-0 p-3 border-t border-border bg-surface-2 flex gap-2 flex-wrap">{actions}</div>
      )}
    </div>
  );
}
