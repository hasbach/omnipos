import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Button, Field, Select, NumberInput } from '../../components/ui';
import { useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { Product } from '../../types';
import { formatMoney } from '../../lib/format';

export type BulkTier = 'retail' | 'wholesale' | 'super_wholesale';
export type BulkMode = 'percent_change' | 'markup_on_cost' | 'set';
export type BulkScope = 'selected' | 'category' | 'all';

export interface BulkPriceModalProps {
  open: boolean;
  onClose: () => void;
  products: Product[];
  selectedIds: Set<number | string>;
  categories: string[];
  /** When false (Settings → Sales & Pricing → enable_price_levels off), only retail is offered. */
  priceLevelsEnabled?: boolean;
  onApplied: () => void;
}

const ROUND_OPTIONS = [0, 0.05, 0.1, 0.25, 1];

function tierColumn(tier: BulkTier): keyof Product {
  return tier === 'retail' ? 'price' : tier === 'wholesale' ? 'price_wholesale' : 'price_super_wholesale';
}

/** Mirrors server/routes.ts POST /api/products/bulk-price so the preview matches exactly. */
function computeNewPrice(p: Product, tier: BulkTier, mode: BulkMode, value: number, roundTo: number): number | null {
  if (mode === 'markup_on_cost' && !(p.cost && p.cost > 0)) return null;
  const column = tierColumn(tier);
  let newPrice: number;
  if (mode === 'set') {
    newPrice = value;
  } else if (mode === 'markup_on_cost') {
    newPrice = (p.cost || 0) * (1 + value / 100);
  } else {
    const base = tier === 'retail' ? p.price : (p as any)[column] || p.price;
    newPrice = base * (1 + value / 100);
  }
  newPrice = Math.max(0, newPrice);
  if (roundTo > 0) newPrice = Math.round(newPrice / roundTo) * roundTo;
  return newPrice;
}

export function BulkPriceModal({ open, onClose, products, selectedIds, categories, priceLevelsEnabled = true, onApplied }: BulkPriceModalProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [scope, setScope] = useState<BulkScope>(selectedIds.size > 0 ? 'selected' : 'all');
  const [category, setCategory] = useState(categories[0] || '');
  const [tier, setTier] = useState<BulkTier>('retail');
  const [mode, setMode] = useState<BulkMode>('percent_change');
  const [value, setValue] = useState<number>(0);
  const [roundTo, setRoundTo] = useState<number>(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!priceLevelsEnabled) setTier('retail');
  }, [priceLevelsEnabled, open]);

  const affected = useMemo(() => {
    if (scope === 'selected') return products.filter((p) => selectedIds.has(p.id));
    if (scope === 'category') return products.filter((p) => p.category === category);
    return products;
  }, [scope, category, products, selectedIds]);

  const preview = useMemo(
    () =>
      affected.slice(0, 10).map((p) => ({
        product: p,
        oldPrice: (p as any)[tierColumn(tier)] || p.price,
        newPrice: computeNewPrice(p, tier, mode, value, roundTo),
      })),
    [affected, tier, mode, value, roundTo],
  );

  const handleApply = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { tier, mode, value, round_to: roundTo || undefined };
      if (scope === 'selected') body.product_ids = Array.from(selectedIds);
      else if (scope === 'category') body.category = category;

      const res = await api.post<{ updated: number }>('/api/products/bulk-price', body);
      toast.success(t('prod_bulk_success_toast', '{count} product prices updated.').replace('{count}', String(res.updated)));
      onApplied();
      onClose();
    } catch (err: any) {
      toast.error(err.message || t('prod_bulk_error_toast', 'Bulk price update failed.'));
    } finally {
      setSaving(false);
    }
  };

  const valueHelper =
    mode === 'percent_change'
      ? t('prod_bulk_value_percent_helper')
      : mode === 'markup_on_cost'
      ? t('prod_bulk_value_markup_helper')
      : t('prod_bulk_value_set_helper');

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('prod_bulk_title', 'Bulk price update')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('prod_cancel', 'Cancel')}
          </Button>
          <Button variant="primary" onClick={handleApply} loading={saving} disabled={affected.length === 0}>
            {t('prod_bulk_apply', 'Apply update')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label={t('prod_bulk_scope', 'Scope')}>
            <Select
              value={scope}
              onChange={(e) => setScope(e.target.value as BulkScope)}
              options={[
                { value: 'selected', label: t('prod_bulk_scope_selected').replace('{count}', String(selectedIds.size)), disabled: selectedIds.size === 0 },
                { value: 'category', label: t('prod_bulk_scope_category', 'By category') },
                { value: 'all', label: t('prod_bulk_scope_all', 'Entire catalog') },
              ]}
            />
          </Field>
          {scope === 'category' && (
            <Field label={t('prod_category', 'Category')}>
              <Select value={category} onChange={(e) => setCategory(e.target.value)} options={categories.map((c) => ({ value: c, label: c }))} />
            </Field>
          )}
          {priceLevelsEnabled && (
            <Field label={t('prod_bulk_tier', 'Price tier')}>
              <Select
                value={tier}
                onChange={(e) => setTier(e.target.value as BulkTier)}
                options={[
                  { value: 'retail', label: t('prod_tier_retail', 'Retail') },
                  { value: 'wholesale', label: t('prod_tier_wholesale', 'Wholesale (جملة)') },
                  { value: 'super_wholesale', label: t('prod_tier_super_wholesale', 'Super wholesale (جملة الجملة)') },
                ]}
              />
            </Field>
          )}
          <Field label={t('prod_bulk_mode', 'Mode')}>
            <Select
              value={mode}
              onChange={(e) => setMode(e.target.value as BulkMode)}
              options={[
                { value: 'percent_change', label: t('prod_bulk_mode_percent_change', 'Percent change') },
                { value: 'markup_on_cost', label: t('prod_bulk_mode_markup_on_cost', 'Markup on cost') },
                { value: 'set', label: t('prod_bulk_mode_set', 'Set exact price') },
              ]}
            />
          </Field>
          <Field label={t('prod_bulk_value', 'Value')} helper={valueHelper}>
            <NumberInput value={value} onChange={setValue} step={0.01} />
          </Field>
          <Field label={t('prod_bulk_rounding', 'Round to nearest')}>
            <Select
              value={String(roundTo)}
              onChange={(e) => setRoundTo(Number(e.target.value))}
              options={ROUND_OPTIONS.map((r) => ({ value: String(r), label: r === 0 ? t('prod_bulk_rounding_none', 'No rounding') : String(r) }))}
            />
          </Field>
        </div>

        <p className="text-sm text-text-2">{t('prod_bulk_affected', '{count} products will be updated.').replace('{count}', String(affected.length))}</p>

        <div className="max-h-64 overflow-y-auto rounded-[var(--radius-card)] border border-border">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-surface-2 text-xs text-text-3">
              <tr>
                <th className="px-3 py-2 text-start font-medium">{t('prod_bulk_col_product', 'Product')}</th>
                <th className="px-3 py-2 text-end font-medium">{t('prod_bulk_col_old', 'Old price')}</th>
                <th className="px-3 py-2 text-end font-medium">{t('prod_bulk_col_new', 'New price')}</th>
              </tr>
            </thead>
            <tbody>
              {preview.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-text-3">
                    {t('prod_bulk_preview_empty', 'No products match this scope.')}
                  </td>
                </tr>
              )}
              {preview.map(({ product, oldPrice, newPrice }) => (
                <tr key={product.id} className="border-t border-border">
                  <td className="px-3 py-2 text-text">{product.name}</td>
                  <td className="num px-3 py-2 text-end text-text-3">{formatMoney(oldPrice, { code: 'USD', symbol: '$' })}</td>
                  <td className="num px-3 py-2 text-end font-medium">
                    {newPrice == null ? <span className="text-text-3">—</span> : formatMoney(newPrice, { code: 'USD', symbol: '$' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}

export default BulkPriceModal;
