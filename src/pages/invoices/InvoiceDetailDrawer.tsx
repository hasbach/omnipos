import React, { useEffect, useState } from 'react';
import { Edit2, FileClock, Printer, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { Drawer, Button, Badge, Tabs, Checkbox, SkeletonTable } from '../../components/ui';
import { useToast, useConfirm } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, formatDateTime, formatBalance, paymentMethodLabel, partyDisplayName } from '../../lib/format';
import RefundModal, { type RefundableResponse } from './RefundModal';
import type { CurrencyRow, TxType } from './types';

export interface InvoiceDetailDrawerProps {
  open: boolean;
  onClose: () => void;
  invoiceId: number | null;
  currencies: CurrencyRow[];
  isAdmin: boolean;
  onEdit: (id: number, type: TxType) => void;
  onDeleted: () => void;
  /** Called after a refund is created against this invoice — the outer list/table should refresh. */
  onRefunded?: () => void;
  /** Open another invoice's detail (e.g. a refund's original sale) in this same drawer. */
  onOpenInvoice?: (id: number) => void;
}

const USD: CurrencyRow = { code: 'USD', symbol: '$', rate: 1 };

function typeBadge(type: string, t: (key: string, fallback?: string) => string) {
  if (type === 'refund') return <Badge variant="danger">{t('inv_type_refund', 'Refund')}</Badge>;
  if (type === 'purchase') return <Badge variant="info">{t('inv_type_purchase', 'Purchase')}</Badge>;
  return <Badge variant="success">{t('inv_type_sale', 'Sale')}</Badge>;
}

export function InvoiceDetailDrawer({ open, onClose, invoiceId, currencies, isAdmin, onEdit, onDeleted, onRefunded, onOpenInvoice }: InvoiceDetailDrawerProps) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(false);
  const [invoice, setInvoice] = useState<any>(null);
  const [edits, setEdits] = useState<any[]>([]);
  const [tab, setTab] = useState<'lines' | 'audit'>('lines');
  const [showCost, setShowCost] = useState(false);
  const [refundable, setRefundable] = useState<RefundableResponse | null>(null);
  const [refundModalOpen, setRefundModalOpen] = useState(false);

  const local = currencies.find((c) => c.code !== 'USD') || null;

  const loadInvoice = (id: number, opts: { showSkeleton: boolean }) => {
    if (opts.showSkeleton) setLoading(true);
    setRefundable(null);
    return Promise.all([
      api.get(`/api/transactions/${id}`),
      api.get(`/api/transactions/${id}/edits`).catch(() => []),
    ])
      .then(([inv, ed]) => {
        setInvoice(inv);
        setEdits(Array.isArray(ed) ? ed : []);
        // Only a sale can be refunded — fetch what's still eligible so the Refund action can be
        // hidden once nothing remains (GET /api/transactions/:id/refundable).
        if (inv.type === 'sale') {
          api.get<RefundableResponse>(`/api/transactions/${id}/refundable`)
            .then(setRefundable)
            .catch(() => setRefundable(null));
        }
      })
      .catch((err) => toast.error(err.message))
      .finally(() => { if (opts.showSkeleton) setLoading(false); });
  };

  useEffect(() => {
    if (!open || !invoiceId) return;
    setTab('lines');
    loadInvoice(invoiceId, { showSkeleton: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoiceId]);

  const hasRemainingRefund = !!refundable && refundable.lines.some((l) => l.remaining_qty > 0.0001);

  const handleDelete = async () => {
    if (!invoice) return;
    const ok = await confirm({
      title: t('inv_delete_confirm_title', 'Delete invoice #{id}?').replace('{id}', String(invoice.id)),
      description: t('inv_delete_confirm_desc'),
      confirmText: String(invoice.id),
      confirmLabel: t('inv_delete_confirm_label', 'Delete'),
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/api/transactions/${invoice.id}`);
      toast.success(t('inv_deleted_toast', 'Invoice #{id} deleted.').replace('{id}', String(invoice.id)));
      onDeleted();
      onClose();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const handlePrint = () => {
    if (!invoice) return;
    const win = window.open('', '_blank', 'width=420,height=700');
    if (!win) return;
    const rows = (invoice.items || [])
      .map((it: any) => {
        const total = Number(it.price) * it.quantity - (it.discount?.value
          ? it.discount.type === 'percentage'
            ? (Number(it.price) * it.quantity * it.discount.value) / 100
            : it.discount.value
          : 0);
        // A unit-of-measure line prints "2 Carton (x24)" at the price of one carton; quantity and
        // price on the row stay in the line's own unit.
        const uom = it.uom_name ? ` - ${it.uom_name} x${it.uom_factor}` : '';
        const qtyShown = it.display_qty ?? it.quantity;
        const priceShown = it.display_unit_price ?? Number(it.price);
        return `<tr><td>${it.product_name}${uom}</td><td style="text-align:center">${qtyShown}</td><td style="text-align:end">${Number(priceShown).toFixed(2)}</td><td style="text-align:end">${total.toFixed(2)}</td></tr>`;
      })
      .join('');
    win.document.write(`
      <html><head><title>#${invoice.id}</title>
      <style>
        body{font-family:Arial,sans-serif;font-size:12px;padding:16px;color:#0F172A;}
        h1{font-size:16px;margin:0 0 4px;} p{margin:2px 0;}
        table{width:100%;border-collapse:collapse;margin-top:12px;}
        th,td{padding:4px 2px;border-bottom:1px solid #E2E8F0;text-align:start;}
        .totals{margin-top:12px;text-align:end;} .totals p{font-weight:bold;}
      </style></head><body>
      <h1>Invoice #${invoice.id} — ${invoice.type === 'refund' ? t('inv_type_refund', 'Refund') : invoice.type === 'purchase' ? t('inv_type_purchase', 'Purchase') : t('inv_type_sale', 'Sale')}</h1>
      <p>${invoice.stakeholder_name ? partyDisplayName(invoice.stakeholder_name, t) : ''}</p>
      <p>${formatDateTime(invoice.created_at, lang)}</p>
      <table><thead><tr><th>${t('inv_detail_col_product', 'Product')}</th><th>${t('inv_detail_col_qty', 'Qty')}</th><th>${t('inv_editor_col_unit_price', 'Price')}</th><th>${t('inv_detail_col_line_total', 'Line total')}</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <div class="totals">
        <p>${t('inv_col_total', 'Total')}: ${Number(invoice.total_amount).toFixed(2)}</p>
        <p>${t('inv_col_paid', 'Paid')}: ${Number(invoice.paid_amount).toFixed(2)}</p>
        <p>${t('inv_col_due', 'Due')}: ${Math.max(0, Number(invoice.total_amount) - Number(invoice.paid_amount)).toFixed(2)}</p>
      </div>
      </body></html>
    `);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 250);
  };

  const total = invoice ? Number(invoice.total_amount) : 0;
  const paid = invoice ? Number(invoice.paid_amount) : 0;
  const due = Math.max(0, total - paid);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="lg"
      title={invoice ? (
        <span className="inline-flex items-center gap-2">
          {t('inv_detail_title', 'Invoice #{id}').replace('{id}', String(invoice.id))}
          {typeBadge(invoice.type, t)}
          {invoice.archived ? <Badge variant="neutral">{t('inv_flag_settled', 'Settled')}</Badge> : null}
          {invoice.edit_count > 0 ? <Badge variant="warning">{t('inv_flag_edited_many', 'Edited ×{n}').replace('{n}', String(invoice.edit_count))}</Badge> : null}
        </span>
      ) : t('inv_page_title', 'Invoices')}
      footer={invoice ? (
        <>
          <Button variant="secondary" onClick={handlePrint}><Printer size={15} /> {t('inv_action_print', 'Print')}</Button>
          {!invoice.archived && invoice.type !== 'refund' && (
            <Button variant="danger" onClick={handleDelete}><Trash2 size={15} /> {t('inv_action_delete', 'Delete')}</Button>
          )}
          {invoice.type === 'sale' && hasRemainingRefund && (
            <Button variant="secondary" onClick={() => setRefundModalOpen(true)}><RotateCcw size={15} /> {t('inv_action_refund', 'Refund')}</Button>
          )}
          {invoice.type !== 'refund' && (
            <Button variant="primary" onClick={() => onEdit(invoice.id, invoice.type)}><Edit2 size={15} /> {t('inv_action_edit', 'Edit')}</Button>
          )}
        </>
      ) : undefined}
    >
      {loading || !invoice ? (
        <SkeletonTable cols={4} rows={6} />
      ) : (
        <div className="space-y-4">
          {invoice.type === 'refund' && invoice.original_transaction_id ? (
            <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-border bg-surface-2 px-3 py-2 text-sm">
              <span className="inline-flex items-center gap-1.5 text-text-2">
                <Undo2 size={14} className="text-text-3" />
                {t('inv_refund_of', 'Refund of #{id}').replace('{id}', String(invoice.original_transaction_id))}
              </span>
              {onOpenInvoice && (
                <Button variant="ghost" size="sm" onClick={() => onOpenInvoice(invoice.original_transaction_id)}>
                  {t('inv_refund_view_original', 'View original sale')}
                </Button>
              )}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-text-3">{invoice.type === 'purchase' ? t('inv_detail_supplier', 'Supplier') : t('inv_detail_party', 'Party')}</p>
              <p className="font-medium text-text">{invoice.stakeholder_name ? partyDisplayName(invoice.stakeholder_name, t) : '—'}</p>
            </div>
            <div>
              <p className="text-xs text-text-3">{t('inv_detail_date', 'Date')}</p>
              <p className="font-medium text-text num">{formatDateTime(invoice.created_at, lang)}</p>
            </div>
            <div>
              <p className="text-xs text-text-3">{t('inv_detail_price_level', 'Price level')}</p>
              <p className="font-medium text-text capitalize">{t(`inv_editor_price_level_${invoice.price_level || 'retail'}`, (invoice.price_level || 'retail').replace('_', ' '))}</p>
            </div>
            <div>
              <p className="text-xs text-text-3">{t('inv_detail_reference', 'Reference')}</p>
              <p className="font-medium text-text">{invoice.reference || '—'}</p>
            </div>
            {invoice.notes && (
              <div className="col-span-2">
                <p className="text-xs text-text-3">{t('inv_detail_notes', 'Notes')}</p>
                <p className="text-text">{invoice.notes}</p>
              </div>
            )}
          </div>

          <Tabs
            items={[
              { value: 'lines', label: t('inv_detail_lines', 'Line items') },
              { value: 'audit', label: t('inv_detail_audit', 'Edit history') },
            ]}
            value={tab}
            onChange={(v) => setTab(v as any)}
          />

          {tab === 'lines' ? (
            <div className="space-y-4">
              {isAdmin && (
                <Checkbox checked={showCost} onChange={(e) => setShowCost(e.target.checked)} label={t('inv_detail_show_cost', 'Show cost / profit')} />
              )}
              <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border">
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-surface-2">
                    <tr className="text-xs uppercase tracking-wide text-text-3">
                      <th className="px-3 py-2 text-start">{t('inv_detail_col_product', 'Product')}</th>
                      <th className="px-3 py-2 text-end num">{t('inv_detail_col_qty', 'Qty')}</th>
                      <th className="px-3 py-2 text-end num">{t('inv_detail_col_unit_price', 'Unit price')}</th>
                      <th className="px-3 py-2 text-end num">{t('inv_detail_col_discount', 'Discount')}</th>
                      {showCost && isAdmin && <th className="px-3 py-2 text-end num">{t('inv_detail_col_cost', 'Cost')}</th>}
                      {showCost && isAdmin && <th className="px-3 py-2 text-end num">{t('inv_detail_col_profit', 'Profit')}</th>}
                      <th className="px-3 py-2 text-end num">{t('inv_detail_col_line_total', 'Line total')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(invoice.items || []).map((item: any) => {
                      const lineBase = Number(item.price) * item.quantity;
                      const discAmt = item.discount?.value
                        ? item.discount.type === 'percentage'
                          ? (lineBase * item.discount.value) / 100
                          : item.discount.value
                        : 0;
                      const lineTot = Math.max(0, lineBase - discAmt);
                      const cost = (item.unit_cost ?? 0) * item.quantity;
                      const profit = lineTot - cost;
                      return (
                        <tr key={item.id} className="border-t border-border">
                          <td className="px-3 py-2 font-medium text-text">
                            {item.product_name}
                            {item.uom_name && <span className="ms-2 text-xs font-semibold text-primary">{item.uom_name} ×{item.uom_factor}</span>}
                          </td>
                          <td className="px-3 py-2 text-end num">
                            {item.display_qty ?? item.quantity}
                            {item.uom_name && <span className="block text-[10px] text-text-3">= {item.quantity} {t('uom_piece_short', 'pcs')}</span>}
                          </td>
                          <td className="px-3 py-2 text-end num">{formatMoney(Number(item.display_unit_price ?? item.price), USD)}</td>
                          <td className="px-3 py-2 text-end num text-text-3">
                            {item.discount?.value ? (item.discount.type === 'percentage' ? `-${item.discount.value}%` : `-${formatMoney(item.discount.value, USD)}`) : '—'}
                          </td>
                          {showCost && isAdmin && <td className="px-3 py-2 text-end num text-text-3">{formatMoney(cost, USD)}</td>}
                          {showCost && isAdmin && (
                            <td className={['px-3 py-2 text-end num', profit >= 0 ? 'text-success' : 'text-danger'].join(' ')}>{formatMoney(profit, USD)}</td>
                          )}
                          <td className="px-3 py-2 text-end num font-semibold text-text">{formatMoney(lineTot, USD)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="rounded-[var(--radius-card)] border border-border p-3 space-y-1 text-sm">
                {invoice.discount?.value > 0 && (
                  <div className="flex justify-between"><span className="text-text-3">{t('inv_detail_discount', 'Discount')}</span><span className="num">{invoice.discount.type === 'percentage' ? `${invoice.discount.value}%` : formatMoney(invoice.discount.value, USD)}</span></div>
                )}
                <div className="flex justify-between text-base font-semibold"><span>{t('inv_detail_total', 'Total')}</span><span className="num">{formatMoney(total, USD)}</span></div>
                {local && <div className="flex justify-between text-xs text-text-3"><span>{t('inv_detail_local', 'Local')}</span><span className="num">{formatMoney(total * local.rate, local)}</span></div>}
                <div className="flex justify-between"><span className="text-text-3">{t('inv_detail_paid', 'Paid')}</span><span className="num text-success">{formatMoney(paid, USD)}</span></div>
                <div className="flex justify-between"><span className="text-text-3">{t('inv_detail_due', 'Due')}</span><span className={['num font-semibold', due > 0.01 ? 'text-danger' : 'text-success'].join(' ')}>{formatMoney(due, USD)}</span></div>
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-3">{t('inv_detail_payments', 'Payments')}</p>
                {(invoice.payments || []).length === 0 ? (
                  <p className="text-sm text-text-3">{t('inv_detail_no_payments', 'No payments recorded.')}</p>
                ) : (
                  <div className="space-y-1.5">
                    {invoice.payments.map((p: any) => {
                      const cur = currencies.find((c) => c.code === p.currency) || USD;
                      return (
                        <div key={p.id} className="flex items-center justify-between rounded-md border border-border px-3 py-1.5 text-sm">
                          <span className="text-text-2">{paymentMethodLabel(p.method, t)}</span>
                          <span className="num text-text">{formatMoney(Number(p.amount), cur)}</span>
                          <span className="num text-xs text-text-3">{formatMoney(Number(p.amount) / (p.exchange_rate || 1), USD)}</span>
                          <span className="text-xs text-text-3">{formatDateTime(p.created_at, lang)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {edits.length === 0 ? (
                <p className="text-sm text-text-3">{t('inv_detail_no_edits', 'This invoice has not been edited.')}</p>
              ) : (
                edits.map((e) => {
                  const beforeTotal = Number(e.before?.total_amount ?? 0);
                  const afterTotal = Number(e.after?.total_amount ?? 0);
                  const beforePayCount = e.before?.payments?.length ?? 0;
                  const afterPayCount = e.after?.payments?.length ?? 0;
                  return (
                    <div key={e.id} className="rounded-[var(--radius-card)] border border-border p-3 text-sm space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 font-medium text-text"><FileClock size={14} className="text-text-3" /> {t('inv_detail_edit_by', 'By {user}').replace('{user}', e.user_name || t('inv_detail_edit_no_user', 'Unknown user'))}</span>
                        <span className="text-xs text-text-3 num">{formatDateTime(e.created_at, lang)}</span>
                      </div>
                      <p className="text-text-2">{t('inv_detail_edit_reason', 'Reason: {reason}').replace('{reason}', e.reason || t('inv_detail_edit_no_reason', 'No reason given'))}</p>
                      {Math.abs(beforeTotal - afterTotal) > 0.005 && (
                        <p className="text-xs text-text-3 num">{t('inv_detail_edit_change_total', 'Total {from} → {to}').replace('{from}', formatMoney(beforeTotal, USD)).replace('{to}', formatMoney(afterTotal, USD))}</p>
                      )}
                      {(e.before?.items?.length ?? 0) !== (e.after?.items?.length ?? 0) && (
                        <p className="text-xs text-text-3">{t('inv_detail_edit_change_lines', '{n} line item(s) changed').replace('{n}', String(e.after?.items?.length ?? 0))}</p>
                      )}
                      {beforePayCount !== afterPayCount && (
                        <p className="text-xs text-text-3">{t('inv_detail_edit_change_payments', 'Payments changed ({from} → {to})').replace('{from}', String(beforePayCount)).replace('{to}', String(afterPayCount))}</p>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      )}

      <RefundModal
        open={refundModalOpen}
        onClose={() => setRefundModalOpen(false)}
        invoiceId={invoice?.id ?? invoiceId}
        currencies={currencies}
        onDone={() => {
          setRefundModalOpen(false);
          if (invoiceId) loadInvoice(invoiceId, { showSkeleton: false });
          onRefunded?.();
        }}
      />
    </Drawer>
  );
}

export default InvoiceDetailDrawer;
