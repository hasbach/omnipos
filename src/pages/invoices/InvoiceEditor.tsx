import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Plus, Search, Trash2 } from 'lucide-react';
import {
  Modal, Button, Field, Input, Select, NumberInput, MoneyInput, Textarea, useToast, useConfirm,
} from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { normalizeLevel, saleLineUnitPrice, tierUnitPrice, type PriceLevel } from '../../lib/pricing';
import type { Product, Stakeholder } from '../../types';
import {
  computeInvoiceTotals, lineDraftTotal, nextKey, paidFromPayments,
  type CurrencyRow, type LineDraft, type PaymentDraft, type PaymentMethod, type TxType,
} from './types';

export interface InvoiceEditorProps {
  open: boolean;
  onClose: () => void;
  /** New invoice type, or the type of the invoice being edited (fetched, but pass a hint if known). */
  txType: 'sale' | 'purchase';
  editingId: number | null;
  products: Product[];
  stakeholders: Stakeholder[];
  currencies: CurrencyRow[];
  onSaved: (id: number) => void;
}

const USD: CurrencyRow = { code: 'USD', symbol: '$', rate: 1 };
const currentUserId = () => {
  const raw = sessionStorage.getItem('currentCashierId');
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

function nowLocalDateTime(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function InvoiceEditor({ open, onClose, txType, editingId, products, stakeholders, currencies, onSaved }: InvoiceEditorProps) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();

  const isPurchase = txType === 'purchase';
  const parties = useMemo(() => stakeholders.filter((s) => (isPurchase ? s.type === 'supplier' : s.type === 'customer')), [stakeholders, isPurchase]);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [archived, setArchived] = useState(false);

  const [partyId, setPartyId] = useState<number | ''>('');
  const [partySearch, setPartySearch] = useState('');
  const [partyOpen, setPartyOpen] = useState(false);
  const [priceLevel, setPriceLevel] = useState<PriceLevel>('retail');
  const [dateTime, setDateTime] = useState(nowLocalDateTime());
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [globalDiscount, setGlobalDiscount] = useState<{ type: 'percentage' | 'fixed'; value: number }>({ type: 'percentage', value: 0 });
  const [globalTax, setGlobalTax] = useState<{ type: 'percentage' | 'fixed'; value: number }>({ type: 'percentage', value: 0 });
  const [payments, setPayments] = useState<PaymentDraft[]>([]);
  const [newPayAmount, setNewPayAmount] = useState<number>(0);
  const [newPayMethod, setNewPayMethod] = useState<PaymentMethod>('cash');
  const [newPayCurrency, setNewPayCurrency] = useState<string>('USD');
  const [reason, setReason] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);

  const party = stakeholders.find((s) => s.id === partyId) || null;

  useEffect(() => {
    if (!open) return;
    setDirty(false);
    if (editingId) {
      setLoading(true);
      api.get(`/api/transactions/${editingId}`).then((tx) => {
        setArchived(!!tx.archived);
        setPartyId(tx.stakeholder_id || '');
        setPriceLevel(normalizeLevel(tx.price_level));
        setDateTime(tx.created_at ? toLocalInput(tx.created_at) : nowLocalDateTime());
        setReference(tx.reference || '');
        setNotes(tx.notes || '');
        setGlobalDiscount(tx.discount || { type: 'percentage', value: 0 });
        setGlobalTax({ type: (tx.tax_type as any) || 'percentage', value: tx.tax_value || 0 });
        setLines((tx.items || []).map((it: any) => ({
          _key: nextKey('l'),
          product_id: it.product_id,
          name: it.product_name,
          quantity: it.quantity,
          unit_price: Number(it.price),
          unit_cost: it.unit_cost,
          discount: it.discount || { type: 'percentage', value: 0 },
        })));
        setPayments((tx.payments || []).map((p: any) => ({
          _key: nextKey('p'),
          id: p.id,
          amount: Number(p.amount),
          method: p.method,
          currency: p.currency,
          exchange_rate: p.exchange_rate || 1,
          created_at: p.created_at,
        })));
        setReason('');
      }).catch((err) => toast.error(err.message)).finally(() => setLoading(false));
    } else {
      setArchived(false);
      setPartyId('');
      setPartySearch('');
      setPriceLevel('retail');
      setDateTime(nowLocalDateTime());
      setReference('');
      setNotes('');
      setLines([]);
      setGlobalDiscount({ type: 'percentage', value: 0 });
      setGlobalTax({ type: 'percentage', value: 0 });
      setPayments([]);
      setReason('');
      setNewPayAmount(0);
      setNewPayMethod('cash');
      setNewPayCurrency('USD');
    }
  }, [open, editingId]);

  // Default the customer's price level when a party is picked fresh (new invoice only).
  useEffect(() => {
    if (!open || editingId) return;
    if (party?.price_level) reprice(normalizeLevel(party.price_level));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId]);

  const reprice = (level: PriceLevel) => {
    setPriceLevel(level);
    if (isPurchase) return;
    setLines((prev) => prev.map((l) => {
      const product = products.find((p) => p.id === l.product_id);
      if (!product) return l;
      const price = saleLineUnitPrice(product as any, level, l.quantity);
      return { ...l, unit_price: price, catalogPrice: tierUnitPrice(product as any, level) ?? product.price };
    }));
    setDirty(true);
  };

  const addProduct = (p: Product) => {
    const unit_price = isPurchase ? (p.cost || 0) : saleLineUnitPrice(p as any, priceLevel, 1);
    setLines((prev) => [...prev, {
      _key: nextKey('l'),
      product_id: p.id,
      name: p.name,
      barcode: p.barcode,
      quantity: 1,
      unit_price,
      unit_cost: p.cost ?? null,
      discount: { type: 'percentage', value: 0 },
      catalogPrice: isPurchase ? undefined : (tierUnitPrice(p as any, priceLevel) ?? p.price),
      minPrice: p.min_price ?? null,
    }]);
    setProductSearch('');
    setDirty(true);
    setTimeout(() => searchRef.current?.focus(), 30);
  };

  const searchResults = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return [];
    return products.filter((p) => p.name.toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q)).slice(0, 8);
  }, [productSearch, products]);

  const updateLine = (key: string, patch: Partial<LineDraft>) => {
    setLines((prev) => prev.map((l) => (l._key === key ? { ...l, ...patch } : l)));
    setDirty(true);
  };
  const removeLine = (key: string) => { setLines((prev) => prev.filter((l) => l._key !== key)); setDirty(true); };

  const totals = computeInvoiceTotals(lines, globalDiscount.value ? globalDiscount : null, globalTax.value ? globalTax : null);
  const paid = paidFromPayments(payments);
  const due = Math.max(0, totals.total - paid);
  const local = currencies.find((c) => c.code !== 'USD') || null;

  const removePayment = (key: string) => {
    setPayments((prev) => prev.map((p) => (p._key === key ? { ...p, removed: !p.removed } : p)));
    setDirty(true);
  };
  const addPayment = (amount: number) => {
    if (!amount || amount <= 0) return;
    const cur = currencies.find((c) => c.code === newPayCurrency) || USD;
    setPayments((prev) => [...prev, {
      _key: nextKey('p'),
      amount,
      method: newPayMethod,
      currency: cur.code,
      exchange_rate: cur.rate,
    }]);
    setNewPayAmount(0);
    setDirty(true);
  };

  const handleClose = async () => {
    if (dirty) {
      const ok = await confirm({
        title: t('inv_editor_unsaved_title', 'Discard unsaved changes?'),
        description: t('inv_editor_unsaved_desc'),
        confirmLabel: t('inv_editor_unsaved_confirm', 'Discard'),
        variant: 'danger',
      });
      if (!ok) return;
    }
    onClose();
  };

  const handleSave = async () => {
    if (lines.length === 0) return toast.error(t('inv_editor_validation_no_lines', 'Add at least one line item.'));
    if (!partyId) return toast.error(t('inv_editor_validation_no_party', 'Select a customer or supplier.'));
    if (editingId && !reason.trim()) return toast.error(t('inv_editor_reason_required'));

    setSaving(true);
    try {
      if (editingId) {
        const body = {
          stakeholder_id: partyId,
          items: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity, unit_price: l.unit_price, discount: l.discount })),
          payments: payments.filter((p) => !p.removed).map((p) => (p.id ? { id: p.id } : { amount: p.amount, method: p.method, currency: p.currency, exchange_rate: p.exchange_rate })),
          discount: globalDiscount,
          tax: globalTax,
          notes,
          reference,
          price_level: priceLevel,
          created_at: fromLocalInput(dateTime),
          reason,
          user_id: currentUserId(),
        };
        const tx = await api.put(`/api/transactions/${editingId}`, body);
        toast.success(t('inv_editor_saved_toast', 'Invoice #{id} saved.').replace('{id}', String(tx.id)));
        onSaved(tx.id);
      } else {
        const payload: any[] = payments.map((p) => ({ amount: p.amount, method: p.method, currency: p.currency, exchange_rate: p.exchange_rate }));
        const body = {
          stakeholder_id: partyId,
          user_id: currentUserId(),
          type: txType,
          items: lines.map((l) => ({ id: l.product_id, quantity: l.quantity, price: l.unit_price, discount: l.discount })),
          currency: 'USD',
          exchange_rate: 1,
          payments: payload,
          discount: globalDiscount,
          tax: globalTax,
          price_level: priceLevel,
          notes,
          reference,
        };
        const res = await api.post('/api/transactions', body);
        toast.success(t('inv_editor_created_toast', 'Invoice #{id} created.').replace('{id}', String(res.id)));
        onSaved(res.id);
      }
      setDirty(false);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="full"
      title={editingId
        ? t('inv_editor_edit_title', 'Edit invoice #{id}').replace('{id}', String(editingId))
        : (isPurchase ? t('inv_editor_new_purchase_title', 'New purchase invoice') : t('inv_editor_new_sale_title', 'New sale invoice'))}
      footer={
        <>
          <Button variant="secondary" onClick={handleClose}>{t('inv_editor_cancel', 'Cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={handleSave}>
            {editingId ? t('inv_editor_save', 'Save') : t('inv_editor_save_new', 'Finalize invoice')}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="py-16 text-center text-sm text-text-3">…</div>
      ) : (
        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 space-y-4">
            {archived && (
              <div className="flex items-start gap-2 rounded-[var(--radius-card)] border border-accent/40 bg-accent-soft p-3 text-sm text-text">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-accent" />
                <div>
                  <p className="font-semibold">{t('inv_editor_settled_warning_title', 'This invoice is settled')}</p>
                  <p className="text-text-2">{t('inv_editor_settled_warning_body')}</p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label={isPurchase ? t('inv_editor_party_purchase', 'Supplier') : t('inv_editor_party_sale', 'Customer')} required>
                <div className="relative">
                  <Input
                    value={party ? party.name : partySearch}
                    placeholder={t('inv_editor_party_placeholder')}
                    onFocus={() => setPartyOpen(true)}
                    onChange={(e) => { setPartySearch(e.target.value); setPartyId(''); setPartyOpen(true); }}
                    startAdornment={<Search size={14} />}
                  />
                  {partyOpen && (
                    <div className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-modal)]">
                      {parties.filter((p) => p.name.toLowerCase().includes(partySearch.toLowerCase())).slice(0, 30).map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className="flex w-full items-center justify-between px-3 py-2 text-start text-sm hover:bg-surface-2 cursor-pointer"
                          onClick={() => { setPartyId(p.id); setPartySearch(''); setPartyOpen(false); setDirty(true); }}
                        >
                          <span className="font-medium text-text">{p.name}</span>
                          <span className="num text-xs text-text-3">{formatMoney(p.balance || 0, USD)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {party && (
                  <p className="text-xs text-text-3">
                    {t('inv_editor_party_balance', 'Balance: {balance}').replace('{balance}', formatMoney(party.balance || 0, USD))}
                    {' · '}
                    {party.credit_limit ? t('inv_editor_party_credit_limit', 'Credit limit: {limit}').replace('{limit}', formatMoney(party.credit_limit, USD)) : t('inv_editor_party_no_credit_limit', 'No credit limit')}
                  </p>
                )}
              </Field>

              {!isPurchase && (
                <Field label={t('inv_editor_price_level', 'Price level')}>
                  <Select
                    value={priceLevel}
                    onChange={(e) => reprice(e.target.value as PriceLevel)}
                    options={[
                      { value: 'retail', label: t('inv_editor_price_level_retail', 'Retail') },
                      { value: 'wholesale', label: t('inv_editor_price_level_wholesale', 'Wholesale') },
                      { value: 'super_wholesale', label: t('inv_editor_price_level_super_wholesale', 'Super wholesale') },
                    ]}
                  />
                </Field>
              )}

              <Field label={t('inv_editor_date', 'Date & time')}>
                <Input type="datetime-local" value={dateTime} onChange={(e) => { setDateTime(e.target.value); setDirty(true); }} />
              </Field>

              <Field label={t('inv_editor_reference', 'Reference')} helper={isPurchase ? t('inv_editor_reference_hint_purchase') : undefined}>
                <Input value={reference} onChange={(e) => { setReference(e.target.value); setDirty(true); }} />
              </Field>
            </div>

            <Field label={t('inv_editor_notes', 'Notes')}>
              <Textarea rows={2} value={notes} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} />
            </Field>

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-3">{t('inv_editor_lines', 'Line items')}</p>
              <div className="relative">
                <Input
                  ref={searchRef}
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  placeholder={t('inv_editor_search_product')}
                  startAdornment={<Search size={14} />}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && searchResults.length > 0) { e.preventDefault(); addProduct(searchResults[0]); }
                    if (e.key === 'Escape') setProductSearch('');
                  }}
                />
                {productSearch && (
                  <div className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-modal)]">
                    {searchResults.length === 0 ? (
                      <p className="p-3 text-center text-xs text-text-3">{t('inv_editor_no_results')}</p>
                    ) : searchResults.map((p) => (
                      <button key={p.id} type="button" className="flex w-full items-center justify-between px-3 py-2 text-start text-sm hover:bg-surface-2 cursor-pointer" onClick={() => addProduct(p)}>
                        <span className="font-medium text-text">{p.name}</span>
                        <span className="num text-xs text-text-3">{formatMoney(isPurchase ? (p.cost || 0) : p.price, USD)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border">
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-surface-2">
                    <tr className="text-xs uppercase tracking-wide text-text-3">
                      <th className="px-2 py-2 text-start">{t('inv_editor_col_product', 'Product')}</th>
                      <th className="px-2 py-2 w-20 text-end">{t('inv_editor_col_qty', 'Qty')}</th>
                      <th className="px-2 py-2 w-28 text-end">{t('inv_editor_col_unit_price', 'Unit price')}</th>
                      <th className="px-2 py-2 w-24 text-end">{t('inv_editor_col_discount', 'Discount')}</th>
                      <th className="px-2 py-2 w-24 text-end">{t('inv_editor_col_total', 'Total')}</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.length === 0 ? (
                      <tr><td colSpan={6} className="p-6 text-center text-xs text-text-3">{t('inv_editor_empty_lines')}</td></tr>
                    ) : lines.map((l) => {
                      const below = !isPurchase && l.minPrice && l.unit_price < l.minPrice;
                      return (
                        <tr key={l._key} className="border-t border-border align-top">
                          <td className="px-2 py-2">
                            <p className="font-medium text-text">{l.name}</p>
                            {!isPurchase && l.catalogPrice !== undefined && (
                              <p className="text-xs text-text-3">{t('inv_editor_tier_price_hint', 'Catalog price: {price}').replace('{price}', formatMoney(l.catalogPrice, USD))}</p>
                            )}
                            {below && <p className="text-xs text-danger">{t('inv_editor_min_price_warning', 'Below minimum price of {min}').replace('{min}', formatMoney(l.minPrice || 0, USD))}</p>}
                          </td>
                          <td className="px-2 py-2">
                            <NumberInput value={l.quantity} min={0.01} step={1} onChange={(v) => updateLine(l._key, { quantity: v })} className="w-20" />
                          </td>
                          <td className="px-2 py-2">
                            <MoneyInput value={l.unit_price} onChange={(v) => updateLine(l._key, { unit_price: v })} invalid={!!below} className="w-28" />
                          </td>
                          <td className="px-2 py-2">
                            <NumberInput value={l.discount.value} min={0} onChange={(v) => updateLine(l._key, { discount: { ...l.discount, value: v } })} className="w-20" endAdornment={l.discount.type === 'percentage' ? '%' : '$'} />
                          </td>
                          <td className="px-2 py-2 text-end num font-semibold text-text">{formatMoney(lineDraftTotal(l), USD)}</td>
                          <td className="px-2 py-2">
                            <button type="button" aria-label="Remove line" className="text-danger hover:opacity-70 cursor-pointer" onClick={() => removeLine(l._key)}>
                              <Trash2 size={15} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-[var(--radius-card)] border border-border p-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('inv_editor_global_discount', 'Global discount')}>
                  <div className="flex gap-1">
                    <NumberInput value={globalDiscount.value} min={0} onChange={(v) => { setGlobalDiscount((d) => ({ ...d, value: v })); setDirty(true); }} className="flex-1" />
                    <Select value={globalDiscount.type} onChange={(e) => { setGlobalDiscount((d) => ({ ...d, type: e.target.value as any })); setDirty(true); }} options={[{ value: 'percentage', label: '%' }, { value: 'fixed', label: '$' }]} className="w-16" />
                  </div>
                </Field>
                <Field label={t('inv_editor_global_tax', 'Tax %')}>
                  <NumberInput value={globalTax.value} min={0} onChange={(v) => { setGlobalTax((tx) => ({ ...tx, value: v })); setDirty(true); }} />
                </Field>
              </div>
              <div className="space-y-1 border-t border-border pt-2 text-sm">
                <div className="flex justify-between text-text-3"><span>{t('inv_editor_totals_subtotal', 'Subtotal')}</span><span className="num">{formatMoney(totals.subtotal, USD)}</span></div>
                {totals.discountAmount > 0 && <div className="flex justify-between text-text-3"><span>{t('inv_editor_totals_discount', 'Discount')}</span><span className="num">-{formatMoney(totals.discountAmount, USD)}</span></div>}
                {totals.taxAmount > 0 && <div className="flex justify-between text-text-3"><span>{t('inv_editor_totals_tax', 'Tax')}</span><span className="num">+{formatMoney(totals.taxAmount, USD)}</span></div>}
                <div className="flex justify-between text-base font-semibold text-text"><span>{t('inv_editor_totals_total', 'Total')}</span><span className="num">{formatMoney(totals.total, USD)}</span></div>
                {local && <div className="flex justify-between text-xs text-text-3"><span>{t('inv_detail_local', 'Local')}</span><span className="num">{formatMoney(totals.total * local.rate, local)}</span></div>}
              </div>
            </div>

            <div className="rounded-[var(--radius-card)] border border-border p-3 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-3">{t('inv_editor_payments', 'Payments')}</p>
              {payments.map((p) => {
                const cur = currencies.find((c) => c.code === p.currency) || USD;
                return (
                  <div key={p._key} className={['flex items-center justify-between rounded-md border border-border px-2 py-1.5 text-sm', p.removed ? 'opacity-40 line-through' : ''].join(' ')}>
                    <span className="capitalize text-text-2">{p.method}</span>
                    <span className="num text-text">{formatMoney(p.amount, cur)}</span>
                    <button type="button" className="text-danger hover:opacity-70 cursor-pointer text-xs" onClick={() => removePayment(p._key)}>×</button>
                  </div>
                );
              })}
              <div className="grid grid-cols-3 gap-1.5">
                <MoneyInput value={newPayAmount} onChange={setNewPayAmount} className="col-span-1" />
                <Select value={newPayMethod} onChange={(e) => setNewPayMethod(e.target.value as PaymentMethod)} options={[
                  { value: 'cash', label: t('inv_editor_payment_method_cash', 'Cash') },
                  { value: 'card', label: t('inv_editor_payment_method_card', 'Card') },
                  { value: 'credit', label: t('inv_editor_payment_method_credit', 'Credit') },
                ]} />
                <Select value={newPayCurrency} onChange={(e) => setNewPayCurrency(e.target.value)} options={currencies.map((c) => ({ value: c.code, label: c.code }))} />
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" className="flex-1" onClick={() => addPayment(newPayAmount)}><Plus size={14} /> {t('inv_editor_payments_add', 'Add payment')}</Button>
                <Button variant="ghost" size="sm" onClick={() => { const cur = currencies.find((c) => c.code === newPayCurrency) || USD; addPayment(Number((due * cur.rate).toFixed(2))); }}>{t('inv_editor_pay_remaining', 'Pay remaining')}</Button>
              </div>
              <div className="flex justify-between text-xs text-text-3 pt-1">
                <span>{t('inv_editor_paid', 'Paid')}: <span className="num text-success">{formatMoney(paid, USD)}</span></span>
                <span>{t('inv_editor_due', 'Due')}: <span className="num text-danger">{formatMoney(due, USD)}</span></span>
              </div>
            </div>

            {editingId && (
              <Field label={t('inv_editor_reason_label', 'Reason for edit')} required>
                <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('inv_editor_reason_placeholder')} />
              </Field>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(local: string): string {
  // datetime-local has no timezone; treat it as local time and convert to an ISO instant.
  const d = new Date(local);
  return d.toISOString();
}

export default InvoiceEditor;
