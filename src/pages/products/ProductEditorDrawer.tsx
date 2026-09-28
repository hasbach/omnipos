import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import {
  Drawer,
  Button,
  Field,
  Input,
  NumberInput,
  MoneyInput,
  Select,
  Switch,
  Tabs,
  Badge,
  useToast,
  useConfirm,
} from '../../components/ui';
import { useI18n } from '../../intl/index';
import { Product } from '../../types';
import { translateServerError } from '../../lib/serverErrors';
import { putJson, postJson, ApiFieldError } from '../invoices/types';
import { UnitsOfMeasureCard, unitToDraft, draftToPayload, validateUnits, type UnitDraft } from './UnitsOfMeasureCard';
import { marginPct, markupPct, priceFromMarkup } from '../../lib/pricing';
import { AdjustStockModal, AdjustStockTarget } from '../stock/AdjustStockModal';

export interface ProductEditorDrawerProps {
  open: boolean;
  product: Product | null; // null => creating a new product
  categories: string[];
  localCurrency: { code: string; symbol: string; rate: number } | null;
  /** When false (Settings → Sales & Pricing → enable_price_levels off), hide the wholesale / super-wholesale tier cards. */
  priceLevelsEnabled?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

interface FormState {
  id?: number;
  name: string;
  barcodes: string[];
  category: string;
  unit: string;
  track_inventory: 0 | 1;
  active: 0 | 1;
  reorder_point: number;
  cost: number;
  cost_lbp: number;
  price: number;
  price_lbp: number;
  price_wholesale: number;
  price_wholesale_lbp: number;
  price_super_wholesale: number;
  price_super_wholesale_lbp: number;
  units: UnitDraft[];
  min_price: number;
  stock: number;
  initialStock: number;
  currency: string;
}

function blankForm(): FormState {
  return {
    name: '',
    barcodes: [],
    category: '',
    unit: 'pcs',
    track_inventory: 1,
    active: 1,
    reorder_point: 0,
    cost: 0,
    cost_lbp: 0,
    price: 0,
    price_lbp: 0,
    price_wholesale: 0,
    price_wholesale_lbp: 0,
    price_super_wholesale: 0,
    price_super_wholesale_lbp: 0,
    units: [],
    min_price: 0,
    stock: 0,
    initialStock: 0,
    currency: 'USD',
  };
}

function fromProduct(p: Product): FormState {
  return {
    id: p.id,
    name: p.name || '',
    barcodes: p.barcodes && p.barcodes.length ? p.barcodes : [p.barcode].filter(Boolean),
    category: p.category || '',
    unit: p.unit || 'pcs',
    track_inventory: p.track_inventory === 0 ? 0 : 1,
    active: p.active === 0 ? 0 : 1,
    reorder_point: p.reorder_point || 0,
    cost: p.cost || 0,
    cost_lbp: p.cost_lbp || 0,
    price: p.price || 0,
    price_lbp: p.price_lbp || 0,
    price_wholesale: p.price_wholesale || 0,
    price_wholesale_lbp: p.price_wholesale_lbp || 0,
    price_super_wholesale: p.price_super_wholesale || 0,
    price_super_wholesale_lbp: p.price_super_wholesale_lbp || 0,
    units: (p.units || []).map(unitToDraft),
    min_price: p.min_price || 0,
    stock: p.stock || 0,
    initialStock: p.stock || 0,
    currency: p.currency || 'USD',
  };
}

type TierKey = 'retail' | 'wholesale' | 'super_wholesale';

const TIER_FIELD: Record<TierKey, { usd: keyof FormState; lbp: keyof FormState }> = {
  retail: { usd: 'price', lbp: 'price_lbp' },
  wholesale: { usd: 'price_wholesale', lbp: 'price_wholesale_lbp' },
  super_wholesale: { usd: 'price_super_wholesale', lbp: 'price_super_wholesale_lbp' },
};

export function ProductEditorDrawer({ open, product, categories, localCurrency, priceLevelsEnabled = true, onClose, onSaved }: ProductEditorDrawerProps) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const rate = localCurrency?.rate || 89500;

  const [tab, setTab] = useState<'general' | 'pricing' | 'inventory'>('general');
  const [form, setForm] = useState<FormState>(blankForm());
  const [initialSnapshot, setInitialSnapshot] = useState('');
  const [barcodeInput, setBarcodeInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  // Inline server/validation errors keyed by the server's `field` (`barcodes`, `units.<i>.barcode`, ...).
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const clearFieldError = (key: string) => setFieldErrors((prev) => {
    if (!(key in prev)) return prev;
    const next = { ...prev };
    delete next[key];
    return next;
  });
  const [markupDrafts, setMarkupDrafts] = useState<Record<TierKey, string>>({ retail: '', wholesale: '', super_wholesale: '' });
  const [showAdjust, setShowAdjust] = useState(false);

  useEffect(() => {
    if (!open) return;
    const next = product ? fromProduct(product) : blankForm();
    setForm(next);
    setInitialSnapshot(JSON.stringify(next));
    setTab('general');
    setBarcodeInput('');
    setNameError(null);
    setFieldErrors({});
    setMarkupDrafts({ retail: '', wholesale: '', super_wholesale: '' });
  }, [open, product?.id]);

  const isDirty = JSON.stringify(form) !== initialSnapshot;

  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const addBarcode = () => {
    const code = barcodeInput.trim();
    if (!code) return;
    if (form.barcodes.includes(code)) {
      setBarcodeInput('');
      return;
    }
    update({ barcodes: [...form.barcodes, code] });
    clearFieldError('barcodes');
    setBarcodeInput('');
  };

  const removeBarcode = (code: string) => update({ barcodes: form.barcodes.filter((b) => b !== code) });

  const handleClose = async () => {
    if (isDirty) {
      const ok = await confirm({
        title: t('prod_unsaved_changes_title', 'Discard unsaved changes?'),
        description: t('prod_unsaved_changes_desc'),
        confirmLabel: t('prod_discard', 'Discard'),
        cancelLabel: t('prod_keep_editing', 'Keep editing'),
      });
      if (!ok) return;
    }
    onClose();
  };

  const validate = (): boolean => {
    if (!form.name.trim()) {
      setNameError(t('prod_name_required', 'Name is required.'));
      setTab('general');
      return false;
    }
    setNameError(null);
    const unitErrors = validateUnits(form.units, t);
    setFieldErrors(unitErrors);
    if (Object.keys(unitErrors).length > 0) {
      setTab('pricing');
      return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const barcodes = form.barcodes.length ? form.barcodes : [];
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        barcodes,
        category: form.category || 'General',
        unit: form.unit || 'pcs',
        track_inventory: form.track_inventory,
        active: form.active,
        reorder_point: form.track_inventory === 0 ? 0 : form.reorder_point,
        cost: form.cost,
        cost_lbp: form.cost_lbp,
        price: form.price,
        price_lbp: form.price_lbp,
        price_wholesale: form.price_wholesale || null,
        price_wholesale_lbp: form.price_wholesale_lbp || null,
        price_super_wholesale: form.price_super_wholesale || null,
        price_super_wholesale_lbp: form.price_super_wholesale_lbp || null,
        units: form.units.map(draftToPayload),
        min_price: form.min_price || null,
        currency: form.currency || 'USD',
      };

      if (form.id) {
        // Never send `stock` on update — the server keeps the current value when it's omitted;
        // stock changes go exclusively through the audited /api/stock/adjust endpoint.
        await putJson(`/api/products/${form.id}`, payload);
      } else {
        payload.stock = form.track_inventory === 0 ? 0 : form.initialStock || 0;
        await postJson('/api/products', payload);
      }

      toast.success(t('prod_saved_toast', 'Product saved.'));
      onSaved();
      onClose();
    } catch (err: any) {
      const translated = translateServerError(err, t) || err.message || t('prod_save_error_toast', 'Could not save product.');
      toast.error(translated);
      if (err instanceof ApiFieldError && err.field) {
        // Show the message next to the offending input (barcodes live on General, units on Pricing).
        setFieldErrors((prev) => ({ ...prev, [err.field as string]: translated }));
        setTab(err.field.startsWith('units.') ? 'pricing' : err.field === 'barcodes' ? 'general' : tab);
      }
    } finally {
      setSaving(false);
    }
  };

  const adjustTarget: AdjustStockTarget | null = form.id ? { id: form.id, name: form.name, stock: form.stock, unit: form.unit } : null;

  return (
    <>
      <Drawer
        open={open}
        onClose={handleClose}
        size="lg"
        title={product ? t('prod_editor_edit', 'Edit product') : t('prod_editor_new', 'New product')}
        footer={
          <>
            <Button variant="secondary" onClick={handleClose} disabled={saving}>
              {t('prod_cancel', 'Cancel')}
            </Button>
            <Button variant="primary" onClick={handleSave} loading={saving}>
              {t('prod_save', 'Save')}
            </Button>
          </>
        }
      >
        <div
          className="space-y-5"
          onKeyDown={(e) => {
            const target = e.target as HTMLElement;
            if (e.key === 'Enter' && target.tagName !== 'TEXTAREA' && !(target as HTMLInputElement).list) {
              e.preventDefault();
              handleSave();
            }
          }}
        >
          <Tabs
            value={tab}
            onChange={(v) => setTab(v as any)}
            items={[
              { value: 'general', label: t('prod_tab_general', 'General') },
              { value: 'pricing', label: t('prod_tab_pricing', 'Pricing') },
              { value: 'inventory', label: t('prod_tab_inventory', 'Inventory') },
            ]}
          />

          {tab === 'general' && (
            <div className="space-y-4">
              <Field label={t('prod_name', 'Name')} required error={nameError}>
                <Input value={form.name} onChange={(e) => update({ name: e.target.value })} autoFocus />
              </Field>

              <Field label={t('prod_barcodes', 'Barcodes')} helper={t('prod_barcodes_helper')} error={fieldErrors.barcodes}>
                <div className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius-input)] border border-border bg-surface p-1.5">
                  {form.barcodes.map((code, i) => (
                    <span
                      key={code}
                      className="inline-flex items-center gap-1 rounded-[var(--radius-chip)] bg-surface-2 px-2 py-1 text-xs font-mono text-text"
                    >
                      {i === 0 && <Badge variant="primary" className="px-1 py-0 text-[10px]">{t('prod_barcode_primary', 'Primary')}</Badge>}
                      {code}
                      <button
                        type="button"
                        aria-label={`${t('prod_remove_barcode', 'Remove barcode')} ${code}`}
                        onClick={() => removeBarcode(code)}
                        className="cursor-pointer text-text-3 hover:text-danger"
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                  <input
                    value={barcodeInput}
                    onChange={(e) => setBarcodeInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        e.stopPropagation();
                        addBarcode();
                      }
                    }}
                    onBlur={addBarcode}
                    placeholder={t('prod_barcodes_placeholder', 'Type a barcode and press Enter…')}
                    className="min-w-[160px] flex-1 border-0 bg-transparent p-1 text-sm outline-none placeholder:text-text-3"
                  />
                </div>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label={t('prod_category', 'Category')}>
                  <Input value={form.category} onChange={(e) => update({ category: e.target.value })} list="prod-category-list" />
                  <datalist id="prod-category-list">
                    {categories.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </Field>
                <Field label={t('prod_unit', 'Unit')}>
                  <Input value={form.unit} onChange={(e) => update({ unit: e.target.value })} placeholder={t('prod_unit_placeholder')} />
                </Field>
              </div>

              <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-border bg-surface-2 px-4 py-3">
                <div className="pe-4">
                  <p className="text-sm font-medium text-text">{t('prod_active', 'Active')}</p>
                  <p className="text-xs text-text-3">{t('prod_active_helper', "Disabled products can't be sold and are hidden from the POS; purchases and history keep working.")}</p>
                </div>
                <Switch checked={form.active === 1} onChange={(checked) => update({ active: checked ? 1 : 0 })} />
              </div>

              <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-border bg-surface-2 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-text">{t('prod_track_inventory', 'Track inventory')}</p>
                  <p className="text-xs text-text-3">{t('prod_track_inventory_helper')}</p>
                </div>
                <Switch checked={form.track_inventory === 1} onChange={(checked) => update({ track_inventory: checked ? 1 : 0 })} />
              </div>

              {form.track_inventory === 1 && (
                <Field label={t('prod_reorder_point', 'Reorder point')}>
                  <NumberInput value={form.reorder_point} onChange={(v) => update({ reorder_point: v })} min={0} />
                </Field>
              )}
            </div>
          )}

          {tab === 'pricing' && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3 rounded-[var(--radius-card)] border border-border bg-surface-2 p-3">
                <Field label={t('prod_cost_usd', 'Cost (USD)')}>
                  <MoneyInput
                    currencySymbol="$"
                    value={form.cost}
                    onChange={(v) => update({ cost: v, cost_lbp: Math.round(v * rate) })}
                  />
                </Field>
                <Field label={t('prod_cost_lbp', 'Cost (LBP)')}>
                  <MoneyInput
                    currencySymbol="LL"
                    step={1}
                    value={form.cost_lbp}
                    onChange={(v) => update({ cost_lbp: v, cost: rate ? Math.round((v / rate) * 100) / 100 : 0 })}
                  />
                </Field>
              </div>

              {(['retail', ...(priceLevelsEnabled ? ['wholesale', 'super_wholesale'] as TierKey[] : [])] as TierKey[]).map((tier) => {
                const { usd, lbp } = TIER_FIELD[tier];
                const priceUsd = form[usd] as number;
                const priceLbp = form[lbp] as number;
                const margin = marginPct(priceUsd, form.cost);
                const markup = markupPct(priceUsd, form.cost);
                const belowCost = form.cost > 0 && priceUsd > 0 && priceUsd < form.cost;
                const aboveRetail = tier !== 'retail' && priceUsd > 0 && form.price > 0 && priceUsd > form.price;
                const tierLabel =
                  tier === 'retail' ? t('prod_tier_retail') : tier === 'wholesale' ? t('prod_tier_wholesale') : t('prod_tier_super_wholesale');

                return (
                  <div key={tier} className="space-y-2 rounded-[var(--radius-card)] border border-border p-3">
                    <p className="text-sm font-semibold text-text">{tierLabel}</p>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label={t('prod_price_usd', 'Price (USD)')}>
                        <MoneyInput
                          currencySymbol="$"
                          value={priceUsd}
                          onChange={(v) => update({ [usd]: v, [lbp]: Math.round(v * rate) } as Partial<FormState>)}
                        />
                      </Field>
                      <Field label={t('prod_price_lbp', 'Price (LBP)')}>
                        <MoneyInput
                          currencySymbol="LL"
                          step={1}
                          value={priceLbp}
                          onChange={(v) => update({ [lbp]: v, [usd]: rate ? Math.round((v / rate) * 100) / 100 : 0 } as Partial<FormState>)}
                        />
                      </Field>
                    </div>
                    <div className="flex flex-wrap items-center gap-4 text-xs">
                      <span className="text-text-3">
                        {t('prod_margin_short', 'Margin')}:{' '}
                        <span className={`num font-semibold ${margin < 0 ? 'text-danger' : 'text-success'}`}>{margin.toFixed(1)}%</span>
                      </span>
                      <span className="text-text-3">
                        {t('prod_markup_short', 'Markup')}:{' '}
                        <span className={`num font-semibold ${markup < 0 ? 'text-danger' : 'text-text'}`}>{markup.toFixed(1)}%</span>
                      </span>
                      <div className="ms-auto flex items-center gap-1.5">
                        <span className="text-text-3">{t('prod_set_from_markup', 'Set from markup %')}</span>
                        <input
                          type="number"
                          value={markupDrafts[tier]}
                          onChange={(e) => setMarkupDrafts((d) => ({ ...d, [tier]: e.target.value }))}
                          className="num h-7 w-16 rounded-[var(--radius-input)] border border-border bg-surface px-1.5 text-xs outline-none focus:border-primary"
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-7 px-2 text-xs"
                          onClick={() => {
                            const pct = Number(markupDrafts[tier]);
                            if (!Number.isFinite(pct) || !form.cost) return;
                            const newPrice = Math.round(priceFromMarkup(form.cost, pct) * 100) / 100;
                            update({ [usd]: newPrice, [lbp]: Math.round(newPrice * rate) } as Partial<FormState>);
                          }}
                        >
                          {t('prod_set_from_markup_apply', 'Apply')}
                        </Button>
                      </div>
                    </div>
                    {belowCost && <p className="text-xs text-danger">{t('prod_warn_below_cost', 'This price is below cost.')}</p>}
                    {aboveRetail && <p className="text-xs text-accent">{t('prod_warn_wholesale_above_retail')}</p>}
                  </div>
                );
              })}

              <UnitsOfMeasureCard
                units={form.units}
                onChange={(units) => update({ units })}
                baseUnit={form.unit}
                retailPrice={form.price}
                rate={rate}
                priceLevelsEnabled={priceLevelsEnabled}
                errors={fieldErrors}
                onClearError={clearFieldError}
              />

              <Field label={t('prod_min_price', 'Minimum price (USD)')} helper={t('prod_min_price_helper')}>
                <MoneyInput currencySymbol="$" value={form.min_price} onChange={(v) => update({ min_price: v })} />
              </Field>
            </div>
          )}

          {tab === 'inventory' && (
            <div className="space-y-4">
              {form.track_inventory === 0 ? (
                <p className="text-sm text-text-3">{t('prod_track_inventory_helper')}</p>
              ) : form.id ? (
                <>
                  <Field label={t('prod_current_stock', 'Current stock')} helper={t('prod_stock_locked_helper')}>
                    <Input value={`${form.stock} ${form.unit || ''}`.trim()} disabled />
                  </Field>
                  <Button variant="secondary" onClick={() => setShowAdjust(true)}>
                    {t('prod_adjust_stock', 'Adjust stock')}
                  </Button>
                </>
              ) : (
                <Field label={t('prod_initial_stock', 'Initial stock')}>
                  <NumberInput value={form.initialStock} onChange={(v) => update({ initialStock: v })} min={0} />
                </Field>
              )}
            </div>
          )}
        </div>
      </Drawer>

      <AdjustStockModal
        open={showAdjust}
        product={adjustTarget}
        onClose={() => setShowAdjust(false)}
        onSaved={(_id, newStock) => {
          update({ stock: newStock });
          onSaved();
        }}
      />
    </>
  );
}

export default ProductEditorDrawer;
