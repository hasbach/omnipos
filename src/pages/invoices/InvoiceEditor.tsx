import React, { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Plus, Search, Trash2 } from 'lucide-react';
import {
  Modal, Badge, Button, Field, Input, Select, Combobox, NumberInput, MoneyInput, Textarea, useToast, useConfirm,
} from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, formatBalance, parseServerDate, partyDisplayName } from '../../lib/format';
import { translateServerError } from '../../lib/serverErrors';
import { useSettings } from '../../lib/useSettings';
import { normalizeLevel, saleLineUnitPrice, tierUnitPrice, uomUnitPrice, type PriceLevel } from '../../lib/pricing';
import type { Product, ProductUnit, Stakeholder } from '../../types';
import {
  computeInvoiceTotals, lineDraftTotal, nextKey, paidFromPayments, realMoneyFromPayments,
  storeCreditFromPayments, postJson, putJson, ApiFieldError,
  type CurrencyRow, type LineDraft, type PaymentDraft, type PaymentMethod, type TxType,
} from './types';

type FieldErrors = Record<string, string>;

/**
 * Money field shown in the invoice's entry currency while the line/discount stays stored in USD:
 * shown = usd × rate, typed value ÷ rate → usd. While focused it keeps its own text so the
 * USD round-trip never re-formats what the user is typing; it re-syncs from the value on blur.
 */
interface EntryMoneyInputProps extends Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'> {
  usd: number;
  rate: number;
  onUsdChange: (usd: number) => void;
  /** Decimals shown while NOT focused (the stored USD value keeps full precision). */
  decimals?: number;
}
const EntryMoneyInput = forwardRef<HTMLInputElement, EntryMoneyInputProps>(function EntryMoneyInput(
  { usd, rate, onUsdChange, decimals = 6, className = '', onFocus, onBlur, ...rest },
  ref,
) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      ref={ref}
      type="number"
      inputMode="decimal"
      step="any"
      value={draft ?? String(Number(scaled(usd * rate).toFixed(decimals)))}
      className={['num text-end', className].join(' ')}
      onFocus={(e) => { e.target.select(); onFocus?.(e); }}
      onBlur={(e) => { setDraft(null); onBlur?.(e); }}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        onUsdChange(raw === '' ? 0 : Number(raw) / (rate || 1));
      }}
      {...rest}
    />
  );
});

/** Default price of ONE unit of the line's UoM: sale = tier price, purchase = product cost x factor. */
// Strips float noise from a per-piece value scaled up to a unit (1.1 × 24 = 26.400000000000002).
const scaled = (v: number) => Math.round(v * 1e6) / 1e6;

function defaultLinePrice(p: Product, unit: ProductUnit | null | undefined, isPurchase: boolean, level: PriceLevel, qty: number): number {
  if (isPurchase) return scaled((p.cost || 0) * (unit ? unit.factor : 1));
  if (unit) return uomUnitPrice(p as any, unit, level);
  return saleLineUnitPrice(p as any, level, qty, p.units);
}
function defaultCatalogPrice(p: Product, unit: ProductUnit | null | undefined, level: PriceLevel): number {
  if (unit) return uomUnitPrice(p as any, unit, level);
  return tierUnitPrice(p as any, level) ?? p.price;
}

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
  const { priceLevelsEnabled } = useSettings();

  const isPurchase = txType === 'purchase';
  const parties = useMemo(() => stakeholders.filter((s) => (isPurchase ? s.type === 'supplier' : s.type === 'customer')), [stakeholders, isPurchase]);

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const clearFieldError = (key: string) => setFieldErrors((prev) => {
    if (!(key in prev)) return prev;
    const next = { ...prev };
    delete next[key];
    return next;
  });
  // The invoice's stakeholder balance BEFORE this invoice's own effect — for a new invoice that's
  // simply the party's current balance; for an edit, the server-provided stakeholder_balance minus
  // this invoice's current balance_effect (both loaded with the transaction below).
  const [baseBalance, setBaseBalance] = useState<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [archived, setArchived] = useState(false);

  const [partyId, setPartyId] = useState<number | ''>('');
  const [priceLevel, setPriceLevel] = useState<PriceLevel>('retail');
  const [dateTime, setDateTime] = useState(nowLocalDateTime());
  // What the loaded invoice's date looked like — only send created_at when the user changed it,
  // so a routine edit never rewrites the original timestamp.
  const [initialDateTime, setInitialDateTime] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [globalDiscount, setGlobalDiscount] = useState<{ type: 'percentage' | 'fixed'; value: number }>({ type: 'percentage', value: 0 });
  const [globalTax, setGlobalTax] = useState<{ type: 'percentage' | 'fixed'; value: number }>({ type: 'percentage', value: 0 });
  const [payments, setPayments] = useState<PaymentDraft[]>([]);
  const [newPayAmount, setNewPayAmount] = useState<number>(0);
  const [newPayMethod, setNewPayMethod] = useState<PaymentMethod>('cash');
  const [newPayCurrency, setNewPayCurrency] = useState<string>('USD');
  // Currency the invoice is keyed in. Line prices stay USD internally; this only changes how they
  // are shown/typed (display = usd × rate) and what currency/exchange_rate metadata is saved.
  const [entryCurrency, setEntryCurrency] = useState<string>('USD');
  // An edited invoice reopens at the rate it was keyed with, so its local amounts read as typed.
  const [savedRate, setSavedRate] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const qtyRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const pendingFocusKey = useRef<string | null>(null);

  const entryOptions = useMemo(() => (currencies.some((c) => c.code === 'USD') ? currencies : [USD, ...currencies]), [currencies]);
  const entryCur = entryOptions.find((c) => c.code === entryCurrency) || USD;
  const rate = savedRate ?? (entryCur.rate || 1);
  // Local currencies with big rates (LBP) have no useful decimals; USD-like ones show cents.
  const totalDecimals = rate >= 100 ? 0 : 2;
  const priceDecimals = rate >= 100 ? 0 : 4;
  /** USD amount → entry-currency text (display only; never rounds to cents). */
  const fmt = (usd: number) => formatMoney(usd * rate, entryCur);

  // Default new payments to the invoice's entry currency.
  useEffect(() => { setNewPayCurrency(entryCurrency); }, [entryCurrency]);

  const party = stakeholders.find((s) => s.id === partyId) || null;

  useEffect(() => {
    if (!open) return;
    setDirty(false);
    setFieldErrors({});
    if (editingId) {
      setLoading(true);
      api.get(`/api/transactions/${editingId}`).then((tx) => {
        setArchived(!!tx.archived);
        setBaseBalance(
          tx.stakeholder_balance != null && tx.balance_effect != null
            ? tx.stakeholder_balance - tx.balance_effect
            : null,
        );
        setPartyId(tx.stakeholder_id || '');
        setPriceLevel(normalizeLevel(tx.price_level));
        const loaded = tx.created_at ? toLocalInput(tx.created_at) : nowLocalDateTime();
        setDateTime(loaded);
        setInitialDateTime(loaded);
        setReference(tx.reference || '');
        setNotes(tx.notes || '');
        const known = currencies.some((c) => c.code === tx.currency);
        setEntryCurrency(known ? tx.currency : 'USD');
        setSavedRate(known && tx.currency !== 'USD' && Number(tx.exchange_rate) > 0 ? Number(tx.exchange_rate) : null);
        setGlobalDiscount({ type: tx.discount?.type === 'fixed' ? 'fixed' : 'percentage', value: Number(tx.discount?.value) || 0 });
        setGlobalTax({ type: (tx.tax_type as any) || 'percentage', value: tx.tax_value || 0 });
        setLines((tx.items || []).map((it: any) => ({
          _key: nextKey('l'),
          product_id: it.product_id,
          name: it.product_name,
          quantity: it.display_qty ?? it.uom_qty ?? it.quantity,
          unit_price: scaled(it.display_unit_price ?? Number(it.price) * (it.uom_factor || 1)),
          uom_id: it.uom_id ?? null,
          uom_name: it.uom_name ?? null,
          uom_factor: it.uom_factor ?? null,
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
      setBaseBalance(null);
      setPartyId('');
      setEntryCurrency('USD');
      setSavedRate(null);
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
    if (!open || editingId || !priceLevelsEnabled) return;
    if (party?.price_level) reprice(normalizeLevel(party.price_level));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId, priceLevelsEnabled]);

  const reprice = (levelArg: PriceLevel) => {
    // Never send/apply a non-retail price level when the tenant has price levels disabled.
    const level = priceLevelsEnabled ? levelArg : 'retail';
    setPriceLevel(level);
    if (isPurchase) return;
    setLines((prev) => prev.map((l) => {
      const product = products.find((p) => p.id === l.product_id);
      if (!product) return l;
      const unit = l.uom_id != null ? (product.units || []).find((u) => u.id === l.uom_id) : null;
      if (l.uom_id != null && !unit) return l; // unit was removed from the product: keep the invoice's own price
      const price = defaultLinePrice(product, unit, false, level, l.quantity);
      return { ...l, unit_price: price, catalogPrice: defaultCatalogPrice(product, unit, level) };
    }));
    setDirty(true);
  };

  const addProduct = (p: Product, unit?: ProductUnit | null) => {
    const unit_price = defaultLinePrice(p, unit, isPurchase, priceLevel, 1);
    const _key = nextKey('l');
    pendingFocusKey.current = _key;
    setLines((prev) => [...prev, {
      _key,
      product_id: p.id,
      name: p.name,
      barcode: unit?.barcode || p.barcode,
      quantity: 1,
      unit_price,
      uom_id: unit ? unit.id : null,
      uom_name: unit ? unit.name : null,
      uom_factor: unit ? unit.factor : null,
      unit_cost: p.cost ?? null,
      discount: { type: 'percentage', value: 0 },
      catalogPrice: isPurchase ? undefined : defaultCatalogPrice(p, unit, priceLevel),
      minPrice: p.min_price ?? null,
    }]);
    setProductSearch('');
    setDirty(true);
  };

  // After a product is added, jump straight to its quantity (search → Enter → qty → Enter → search).
  useEffect(() => {
    const key = pendingFocusKey.current;
    if (!key) return;
    const el = qtyRefs.current[key];
    if (!el) return;
    pendingFocusKey.current = null;
    el.focus({ preventScroll: true });
    el.select();
    // Follow the new row once layout has settled.
    requestAnimationFrame(() => {
      (el.closest('tr') || el).scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, [lines]);

  // Matches name, primary barcode, extra barcodes and unit barcodes. A unit-barcode hit adds that
  // unit (carton/pack) rather than a single piece.
  const searchResults = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return [] as Array<{ p: Product; unit: ProductUnit | null }>;
    const out: Array<{ p: Product; unit: ProductUnit | null }> = [];
    for (const p of products) {
      if (!isPurchase && p.active === 0) continue; // disabled products can't be sold (purchases still allow them)
      const unitHit = (p.units || []).find((u) => (u.barcode || '').toLowerCase().includes(q));
      const baseHit = p.name.toLowerCase().includes(q)
        || (p.barcode || '').toLowerCase().includes(q)
        || (p.barcodes || []).some((b) => b.toLowerCase().includes(q));
      if (baseHit) out.push({ p, unit: null });
      else if (unitHit) out.push({ p, unit: unitHit });
      if (out.length >= 8) break;
    }
    return out;
  }, [productSearch, products, isPurchase]);

  /** Switch a line to another unit of measure (null = base piece); reprices at the default for that unit. */
  const changeLineUnit = (key: string, uomId: number | null) => {
    setLines((prev) => prev.map((l) => {
      if (l._key !== key) return l;
      const product = products.find((p) => p.id === l.product_id);
      const unit = uomId != null ? (product?.units || []).find((u) => u.id === uomId) || null : null;
      if (!product) return l;
      return {
        ...l,
        uom_id: unit ? unit.id : null,
        uom_name: unit ? unit.name : null,
        uom_factor: unit ? unit.factor : null,
        unit_price: defaultLinePrice(product, unit, isPurchase, priceLevel, l.quantity),
        catalogPrice: isPurchase ? undefined : defaultCatalogPrice(product, unit, priceLevel),
      };
    }));
    setDirty(true);
  };

  const updateLine = (key: string, patch: Partial<LineDraft>) => {
    setLines((prev) => prev.map((l) => (l._key === key ? { ...l, ...patch } : l)));
    setDirty(true);
  };
  /** The user typed a line total (entry currency, already converted to USD): back-solve the unit price. */
  const setLineTotalUsd = (l: LineDraft, totalUsd: number) => {
    if (!(l.quantity > 0)) return;
    let unit_price: number;
    if (l.discount.type === 'percentage') {
      const d = l.discount.value || 0;
      if (d >= 100) return;
      unit_price = totalUsd / (l.quantity * (1 - d / 100));
    } else {
      unit_price = (totalUsd + (l.discount.value || 0)) / l.quantity;
    }
    updateLine(l._key, { unit_price });
    clearFieldError(`items.${lines.indexOf(l)}.unit_price`);
  };
  const removeLine = (key: string) => { setLines((prev) => prev.filter((l) => l._key !== key)); setDirty(true); };

  const totals = computeInvoiceTotals(lines, globalDiscount.value ? globalDiscount : null, globalTax.value ? globalTax : null);
  const paid = paidFromPayments(payments);
  const due = Math.max(0, totals.total - paid);
  const local = currencies.find((c) => c.code !== 'USD') || null;

  // Old / new balance panel. "Old" = balance without this invoice's own effect (party's current
  // balance for a new invoice; server-provided base for an edit — see baseBalance above).
  // "New" = old − (total − real money paid), matching the shared balance-effect convention
  // (store_credit and credit are not money). Available store credit = max(0, old balance).
  const oldBalance = editingId ? (baseBalance ?? party?.balance ?? 0) : (party?.balance ?? 0);
  const realPaid = realMoneyFromPayments(payments);
  const newBalance = oldBalance - (totals.total - realPaid);
  const availableStoreCredit = Math.max(0, oldBalance);
  const storeCreditUsed = storeCreditFromPayments(payments);

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

  /** Client-side validation, mirroring the server's own checks so the cashier sees them instantly
   * (party required, qty > 0, unit price ≥ 0, reason required on edit, payment amount > 0, store
   * credit ≤ available). Populates fieldErrors and returns whether the form may be submitted. */
  const validate = (): boolean => {
    const errors: FieldErrors = {};
    if (!partyId) errors.stakeholder_id = t('inv_editor_validation_no_party', 'Select a customer or supplier.');
    lines.forEach((l, idx) => {
      if (!(l.quantity > 0)) errors[`items.${idx}.quantity`] = t('inv_editor_validation_qty', 'Quantity must be greater than 0.');
      if (l.unit_price < 0) errors[`items.${idx}.unit_price`] = t('inv_editor_validation_price', 'Unit price cannot be negative.');
    });
    if (editingId && !reason.trim()) errors.reason = t('inv_editor_reason_required', 'A reason is required.');
    if (storeCreditUsed > availableStoreCredit + 0.005) {
      errors.payments = t('inv_editor_validation_store_credit_exceeded', 'Exceeds the available account balance ({amount}).').replace('{amount}', formatMoney(availableStoreCredit, USD));
    }
    setFieldErrors(errors);
    if (lines.length === 0) toast.error(t('inv_editor_validation_no_lines', 'Add at least one line item.'));
    if (Object.keys(errors).length > 0) toast.error(t('inv_editor_validation_generic', 'Fix the highlighted fields before saving.'));
    return lines.length > 0 && Object.keys(errors).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;

    setSaving(true);
    try {
      if (editingId) {
        const body = {
          stakeholder_id: partyId,
          items: lines.map((l) => ({ product_id: l.product_id, uom_id: l.uom_id ?? undefined, quantity: l.quantity, unit_price: l.unit_price, discount: l.discount })),
          payments: payments.filter((p) => !p.removed).map((p) => (p.id ? { id: p.id } : { amount: p.amount, method: p.method, currency: p.currency, exchange_rate: p.exchange_rate })),
          discount: globalDiscount,
          tax: globalTax,
          notes,
          reference,
          currency: entryCurrency,
          exchange_rate: rate,
          price_level: priceLevelsEnabled ? priceLevel : 'retail',
          created_at: dateTime !== initialDateTime ? fromLocalInput(dateTime) : undefined,
          reason,
          user_id: currentUserId(),
        };
        const tx = await putJson(`/api/transactions/${editingId}`, body);
        toast.success(t('inv_editor_saved_toast', 'Invoice #{id} saved.').replace('{id}', String(tx.id)));
        onSaved(tx.id);
      } else {
        const payload: any[] = payments.map((p) => ({ amount: p.amount, method: p.method, currency: p.currency, exchange_rate: p.exchange_rate }));
        const body = {
          stakeholder_id: partyId,
          user_id: currentUserId(),
          type: txType,
          // unit_price + source let the server keep a back-office price the user typed (as PUT does);
          // `price` is still what a purchase line is costed at.
          source: 'backoffice',
          items: lines.map((l) => ({ id: l.product_id, uom_id: l.uom_id ?? undefined, quantity: l.quantity, price: l.unit_price, unit_price: l.unit_price, discount: l.discount })),
          currency: entryCurrency,
          exchange_rate: rate,
          payments: payload,
          discount: globalDiscount,
          tax: globalTax,
          price_level: priceLevelsEnabled ? priceLevel : 'retail',
          notes,
          reference,
        };
        const res = await postJson('/api/transactions', body);
        toast.success(t('inv_editor_created_toast', 'Invoice #{id} created.').replace('{id}', String(res.id)));
        onSaved(res.id);
      }
      setDirty(false);
    } catch (err: any) {
      const translated = translateServerError(err, t) || err.message;
      toast.error(translated);
      if (err instanceof ApiFieldError && err.field) {
        setFieldErrors((prev) => ({ ...prev, [err.field as string]: translated }));
      }
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
              <Field label={isPurchase ? t('inv_editor_party_purchase', 'Supplier') : t('inv_editor_party_sale', 'Customer')} required error={fieldErrors.stakeholder_id}>
                <Combobox
                  value={partyId === '' ? '' : String(partyId)}
                  options={parties.map((p) => ({
                    value: String(p.id),
                    label: partyDisplayName(p.name, t),
                    secondary: formatMoney(p.balance || 0, USD),
                    keywords: [p.phone, p.email].filter(Boolean).join(' '),
                  }))}
                  placeholder={t('inv_editor_party_placeholder')}
                  invalid={!!fieldErrors.stakeholder_id}
                  onChange={(v) => { setPartyId(v ? Number(v) : ''); setDirty(true); clearFieldError('stakeholder_id'); }}
                />
                {party && (
                  <p className="text-xs text-text-3">
                    {t('inv_editor_party_balance', 'Balance: {balance}').replace('{balance}', formatMoney(party.balance || 0, USD))}
                    {' · '}
                    {party.credit_limit ? t('inv_editor_party_credit_limit', 'Credit limit: {limit}').replace('{limit}', formatMoney(party.credit_limit, USD)) : t('inv_editor_party_no_credit_limit', 'No credit limit')}
                  </p>
                )}
              </Field>

              {!isPurchase && priceLevelsEnabled && (
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

              <Field label={t('inv_editor_currency', 'Invoice currency')}>
                <Select
                  value={entryCurrency}
                  onChange={(e) => { setEntryCurrency(e.target.value); setSavedRate(null); setDirty(true); }}
                  options={entryOptions.map((c) => ({ value: c.code, label: c.code }))}
                />
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
                  data-escape-local={productSearch ? 'true' : undefined}
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  placeholder={t('inv_editor_search_product')}
                  startAdornment={<Search size={14} />}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && searchResults.length > 0) { e.preventDefault(); addProduct(searchResults[0].p, searchResults[0].unit); }
                    // Escape clears the search first; only an empty search lets Escape reach the modal.
                    if (e.key === 'Escape' && productSearch) { e.preventDefault(); e.stopPropagation(); setProductSearch(''); }
                  }}
                />
                {productSearch && (
                  // In the flow (not floating) so the results push the line items down instead of hiding them.
                  <div className="mt-1 max-h-64 w-full overflow-y-auto rounded-[var(--radius-card)] border-2 border-primary/40 bg-surface shadow-[var(--shadow-card)]">
                    <div className="sticky top-0 flex items-center gap-1.5 border-b border-primary/30 bg-primary-soft px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
                      <Search size={12} />
                      <span>{t('inv_editor_search_results', 'Search results')} ({searchResults.length})</span>
                    </div>
                    {searchResults.length === 0 ? (
                      <p className="p-3 text-center text-xs text-text-3">{t('inv_editor_no_results')}</p>
                    ) : searchResults.map(({ p, unit }) => (
                      <button key={`${p.id}:${unit?.id ?? 'base'}`} type="button" className="flex w-full items-center justify-between border-b border-border px-3 py-2 text-start text-sm last:border-b-0 hover:bg-primary-soft cursor-pointer" onClick={() => addProduct(p, unit)}>
                        <span className="font-medium text-text">
                          {p.name}
                          {unit && <span className="ms-2 text-xs font-semibold text-primary">{unit.name} ×{unit.factor}</span>}
                          {p.active === 0 && <Badge variant="neutral" className="ms-2">{t('prod_disabled_badge', 'Disabled')}</Badge>}
                        </span>
                        <span className="num text-xs text-text-3">{fmt(defaultLinePrice(p, unit, isPurchase, priceLevel, 1))}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="overflow-x-auto rounded-[var(--radius-card)] border border-primary/30 bg-primary-soft/40">
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-primary-soft">
                    <tr className="text-xs font-semibold uppercase tracking-wide text-primary">
                      <th className="px-2 py-2 text-start">{t('inv_editor_col_product', 'Product')}</th>
                      <th className="px-2 py-2 w-20 text-end">{t('inv_editor_col_qty', 'Qty')}</th>
                      <th className="px-2 py-2 w-32 text-end">{t('inv_editor_col_unit_price', 'Unit price')}</th>
                      <th className="px-2 py-2 w-24 text-end">{t('inv_editor_col_discount', 'Discount')}</th>
                      <th className="px-2 py-2 w-32 text-end">{t('inv_editor_col_total', 'Total')}</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody
                    // Enter in any line field (qty, price, discount, total) returns to the product search.
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); searchRef.current?.focus(); }
                    }}
                  >
                    {lines.length === 0 ? (
                      <tr><td colSpan={6} className="border border-dashed border-primary/40 bg-primary-soft/40 p-6 text-center text-xs font-medium text-primary">{t('inv_editor_empty_lines')}</td></tr>
                    ) : lines.map((l, idx) => {
                      const below = !isPurchase && l.minPrice && l.unit_price < l.minPrice;
                      const qtyError = fieldErrors[`items.${idx}.quantity`];
                      const priceError = fieldErrors[`items.${idx}.unit_price`];
                      return (
                        <tr key={l._key} className="border-t border-primary/20 align-top">
                          <td className="border-s-[3px] border-s-primary/60 px-2 py-2">
                            <p className="font-semibold text-text">{l.name}</p>
                            {(() => {
                              const product = products.find((p) => p.id === l.product_id);
                              const units = product?.units || [];
                              // A line whose unit no longer exists on the product still shows (read-only) what was invoiced.
                              const orphan = l.uom_id != null && !units.some((u) => u.id === l.uom_id);
                              if (units.length === 0 && !orphan) return null;
                              return (
                                <Select
                                  aria-label={t('uom_select_unit', 'Unit of measure')}
                                  className="mt-1 !h-8 w-40 text-xs"
                                  value={l.uom_id != null ? String(l.uom_id) : ''}
                                  onChange={(e) => changeLineUnit(l._key, e.target.value === '' ? null : Number(e.target.value))}
                                  options={[
                                    { value: '', label: product?.unit || t('uom_piece', 'Piece') },
                                    ...(orphan ? [{ value: String(l.uom_id), label: `${l.uom_name ?? ''} ×${l.uom_factor ?? ''}`, disabled: true }] : []),
                                    ...units.map((u) => ({ value: String(u.id), label: `${u.name} ×${u.factor}` })),
                                  ]}
                                />
                              );
                            })()}
                            {l.uom_id != null && l.uom_factor ? (
                              <p className="text-xs text-text-3 num">= {l.quantity * l.uom_factor} {products.find((p) => p.id === l.product_id)?.unit || t('uom_piece_short', 'pcs')}</p>
                            ) : null}
                            {!isPurchase && l.catalogPrice !== undefined && (
                              <p className="text-xs text-text-3">{t('inv_editor_tier_price_hint', 'Catalog price: {price}').replace('{price}', fmt(l.catalogPrice))}</p>
                            )}
                            {below && <p className="text-xs text-danger">{t('inv_editor_min_price_warning', 'Below minimum price of {min}').replace('{min}', fmt(l.minPrice || 0))}</p>}
                            {priceError && <p className="text-xs text-danger">{priceError}</p>}
                            {qtyError && <p className="text-xs text-danger">{qtyError}</p>}
                          </td>
                          <td className="px-2 py-2">
                            <NumberInput
                              ref={(el) => { qtyRefs.current[l._key] = el; }}
                              value={l.quantity}
                              min={0.01}
                              step={1}
                              invalid={!!qtyError}
                              onChange={(v) => { updateLine(l._key, { quantity: v }); clearFieldError(`items.${idx}.quantity`); }}
                              className="w-20"
                            />
                          </td>
                          <td className="px-2 py-2">
                            <EntryMoneyInput usd={l.unit_price} rate={rate} decimals={priceDecimals} onUsdChange={(v) => { updateLine(l._key, { unit_price: v }); clearFieldError(`items.${idx}.unit_price`); }} invalid={!!below || !!priceError} className="w-32" />
                          </td>
                          <td className="px-2 py-2">
                            {l.discount.type === 'percentage' ? (
                              <NumberInput value={l.discount.value} min={0} onChange={(v) => updateLine(l._key, { discount: { ...l.discount, value: v } })} className="w-20" endAdornment="%" />
                            ) : (
                              <EntryMoneyInput usd={l.discount.value} rate={rate} decimals={totalDecimals} min={0} onUsdChange={(v) => updateLine(l._key, { discount: { ...l.discount, value: v } })} className="w-24" endAdornment={entryCur.symbol} />
                            )}
                          </td>
                          <td className="px-2 py-2">
                            <EntryMoneyInput usd={lineDraftTotal(l)} rate={rate} decimals={totalDecimals} min={0} aria-label={t('inv_editor_col_total', 'Total')} onUsdChange={(v) => setLineTotalUsd(l, v)} className="w-32 font-semibold" />
                          </td>
                          <td className="px-2 py-2">
                            <button type="button" aria-label={t('inv_editor_remove_line', 'Remove line')} className="text-danger hover:opacity-70 cursor-pointer" onClick={() => removeLine(l._key)}>
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
                    {globalDiscount.type === 'fixed' ? (
                      <EntryMoneyInput usd={globalDiscount.value} rate={rate} decimals={totalDecimals} min={0} onUsdChange={(v) => { setGlobalDiscount((d) => ({ ...d, value: v })); setDirty(true); }} className="flex-1" />
                    ) : (
                      <NumberInput value={globalDiscount.value} min={0} onChange={(v) => { setGlobalDiscount((d) => ({ ...d, value: v })); setDirty(true); }} className="flex-1" />
                    )}
                    <Select value={globalDiscount.type} onChange={(e) => { setGlobalDiscount((d) => ({ ...d, type: e.target.value as any })); setDirty(true); }} options={[{ value: 'percentage', label: '%' }, { value: 'fixed', label: entryCur.symbol }]} className="w-16" />
                  </div>
                </Field>
                <Field label={t('inv_editor_global_tax', 'Tax %')}>
                  <NumberInput value={globalTax.value} min={0} onChange={(v) => { setGlobalTax((tx) => ({ ...tx, value: v })); setDirty(true); }} />
                </Field>
              </div>
              <div className="space-y-1 border-t border-border pt-2 text-sm">
                <div className="flex justify-between text-text-3"><span>{t('inv_editor_totals_subtotal', 'Subtotal')}</span><span className="num">{fmt(totals.subtotal)}</span></div>
                {totals.discountAmount > 0 && <div className="flex justify-between text-text-3"><span>{t('inv_editor_totals_discount', 'Discount')}</span><span className="num">-{fmt(totals.discountAmount)}</span></div>}
                {totals.taxAmount > 0 && <div className="flex justify-between text-text-3"><span>{t('inv_editor_totals_tax', 'Tax')}</span><span className="num">+{fmt(totals.taxAmount)}</span></div>}
                <div className="flex justify-between text-base font-semibold text-text"><span>{t('inv_editor_totals_total', 'Total')}</span><span className="num">{fmt(totals.total)}</span></div>
                {entryCurrency !== 'USD'
                  ? <div className="flex justify-between text-xs text-text-3"><span>{t('inv_editor_saved_in_usd', 'Saved in USD: {amount}').replace('{amount}', formatMoney(totals.total, USD))}</span></div>
                  : local && <div className="flex justify-between text-xs text-text-3"><span>{t('inv_detail_local', 'Local')}</span><span className="num">{formatMoney(totals.total * local.rate, local)}</span></div>}
              </div>
            </div>

            {party && (
              <div className="rounded-[var(--radius-card)] border border-border p-3 space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-text-3">{t('inv_editor_balance_panel', 'Account balance')}</p>
                {(() => {
                  const oldB = formatBalance(oldBalance, USD, t);
                  const newB = formatBalance(newBalance, USD, t);
                  const variantClass = (v: 'danger' | 'success' | 'neutral') => v === 'danger' ? 'text-danger' : v === 'success' ? 'text-success' : 'text-text-3';
                  return (
                    <div className="flex justify-between text-sm">
                      <span className="text-text-3">{t('inv_editor_old_balance', 'Old balance')}: <span className={`num font-semibold ${variantClass(oldB.variant)}`}>{oldB.amount} {oldB.label}</span></span>
                      <span className="text-text-3">{t('inv_editor_new_balance', 'New balance')}: <span className={`num font-semibold ${variantClass(newB.variant)}`}>{newB.amount} {newB.label}</span></span>
                    </div>
                  );
                })()}
              </div>
            )}

            <div className="rounded-[var(--radius-card)] border border-border p-3 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-3">{t('inv_editor_payments', 'Payments')}</p>
              {fieldErrors.payments && <p className="text-xs text-danger">{fieldErrors.payments}</p>}
              {payments.map((p, i) => (
                <div key={p._key}>
                  <div className={['flex items-center justify-between rounded-md border border-border px-2 py-1.5 text-sm', p.removed ? 'opacity-40 line-through' : '', fieldErrors[`payments.${i}`] ? 'border-danger' : ''].join(' ')}>
                    <span className="text-text-2">{t(`inv_editor_payment_method_${p.method}`, p.method)}</span>
                    <span className="num text-text">{formatMoney(p.amount, currencies.find((c) => c.code === p.currency) || USD)}</span>
                    <button type="button" className="text-danger hover:opacity-70 cursor-pointer text-xs" onClick={() => removePayment(p._key)}>×</button>
                  </div>
                  {fieldErrors[`payments.${i}`] && <p className="text-xs text-danger">{fieldErrors[`payments.${i}`]}</p>}
                </div>
              ))}
              {availableStoreCredit > 0.005 && (
                <p className="text-xs text-text-3">{t('inv_editor_available_store_credit', 'Available balance: {amount}').replace('{amount}', formatMoney(availableStoreCredit, USD))}</p>
              )}
              <div className="grid grid-cols-3 gap-1.5">
                <MoneyInput value={newPayAmount} onChange={(v) => { setNewPayAmount(v); clearFieldError('payments'); }} className="col-span-1" />
                <Select value={newPayMethod} onChange={(e) => setNewPayMethod(e.target.value as PaymentMethod)} options={[
                  { value: 'cash', label: t('inv_editor_payment_method_cash', 'Cash') },
                  { value: 'card', label: t('inv_editor_payment_method_card', 'Card') },
                  { value: 'credit', label: t('inv_editor_payment_method_credit', 'Credit') },
                  { value: 'store_credit', label: t('inv_editor_payment_method_store_credit', 'From account balance'), disabled: availableStoreCredit <= 0.005 },
                ]} />
                <Select value={newPayCurrency} onChange={(e) => setNewPayCurrency(e.target.value)} options={currencies.map((c) => ({ value: c.code, label: c.code }))} />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    if (!newPayAmount || newPayAmount <= 0) { setFieldErrors((prev) => ({ ...prev, payments: t('inv_editor_validation_payment_amount', 'Payment amount must be greater than 0.') })); return; }
                    if (newPayMethod === 'store_credit') {
                      const cur = currencies.find((c) => c.code === newPayCurrency) || USD;
                      const amountUsd = newPayAmount / (cur.rate || 1);
                      if (storeCreditUsed + amountUsd > availableStoreCredit + 0.005) {
                        setFieldErrors((prev) => ({ ...prev, payments: t('inv_editor_validation_store_credit_exceeded', 'Exceeds the available account balance ({amount}).').replace('{amount}', formatMoney(availableStoreCredit, USD)) }));
                        return;
                      }
                    }
                    addPayment(newPayAmount);
                  }}
                >
                  <Plus size={14} /> {t('inv_editor_payments_add', 'Add payment')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { const cur = currencies.find((c) => c.code === newPayCurrency) || USD; addPayment(Number((due * cur.rate).toFixed(2))); }}>{t('inv_editor_pay_remaining', 'Pay remaining')}</Button>
              </div>
              <div className="flex justify-between text-xs text-text-3 pt-1">
                <span>{t('inv_editor_paid', 'Paid')}: <span className="num text-success">{fmt(paid)}</span></span>
                <span>{t('inv_editor_due', 'Due')}: <span className="num text-danger">{fmt(due)}</span></span>
              </div>
            </div>

            {editingId && (
              <Field label={t('inv_editor_reason_label', 'Reason for edit')} required error={fieldErrors.reason}>
                <Textarea rows={3} value={reason} onChange={(e) => { setReason(e.target.value); clearFieldError('reason'); }} placeholder={t('inv_editor_reason_placeholder')} />
              </Field>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function toLocalInput(iso: string): string {
  const d = parseServerDate(iso); // SQLite "YYYY-MM-DD HH:MM:SS" is UTC
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(local: string): string {
  // datetime-local has no timezone; treat it as local time and convert to an ISO instant.
  const d = new Date(local);
  return d.toISOString();
}

export default InvoiceEditor;
