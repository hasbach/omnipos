import React, { useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import { Combobox, NumberInput, IconButton, Field } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { Product } from '../../types';
import { bundleSaving, allocateBundleAmount } from '../../lib/pricing';

export interface BundleDraftItem {
  component_id: number;
  quantity: number;
}

interface Props {
  /** Product being edited (excluded from the picker); undefined while creating. */
  productId?: number;
  items: BundleDraftItem[];
  onChange: (items: BundleDraftItem[]) => void;
  /** Every product of the tenant (bundles are filtered out: no nesting). */
  products: Product[];
  /** The bundle's own retail price (USD). */
  bundlePrice: number;
  errors?: Record<string, string>;
  onClearError?: (key: string) => void;
}

const money = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

/** Client-side check before saving; keys follow the server's `field` (bundle_items.<i>.quantity). */
export function validateBundle(items: BundleDraftItem[], t: (k: string, f?: string) => string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!items.length) errors.bundle_items = t('err_bundle_empty', 'A bundle needs at least one product.');
  items.forEach((it, i) => {
    if (!(Number.isFinite(it.quantity) && it.quantity > 0)) errors[`bundle_items.${i}.quantity`] = t('err_bundle_qty_invalid', 'Enter a quantity greater than 0.');
  });
  return errors;
}

/**
 * Product editor card for a bundle: pick the products it contains and how many of each, and see
 * what the products cost on their own, the bundle price, the customer's saving, and how the bundle
 * price is split over the products in reports.
 */
export function BundleCard({ productId, items, onChange, products, bundlePrice, errors = {}, onClearError }: Props) {
  const { t } = useI18n();
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const options = useMemo(() => products
    .filter((p) => !p.is_bundle && p.id !== productId && !items.some((it) => it.component_id === p.id))
    .map((p) => ({
      value: String(p.id),
      label: p.name,
      secondary: `${money(p.price || 0)}${p.barcode ? ` · ${p.barcode}` : ''}`,
      keywords: [p.barcode, ...(p.barcodes || [])].filter(Boolean).join(' '),
    })), [products, productId, items]);

  const priced = items.map((it) => ({ listPrice: Number(byId.get(it.component_id)?.price) || 0, quantity: it.quantity || 0 }));
  const { listTotal, saving } = bundleSaving(bundlePrice, priced);
  const split = allocateBundleAmount(bundlePrice || 0, priced);
  const savingPct = listTotal > 0 ? (saving / listTotal) * 100 : 0;

  const add = (value: string) => {
    const id = Number(value);
    if (!id) return;
    onChange([...items, { component_id: id, quantity: 1 }]);
    onClearError?.('bundle_items');
  };
  const setQty = (i: number, quantity: number) => {
    onChange(items.map((it, k) => (k === i ? { ...it, quantity } : it)));
    onClearError?.(`bundle_items.${i}.quantity`);
  };
  const remove = (i: number) => onChange(items.filter((_, k) => k !== i));

  return (
    <div className="space-y-3 rounded-[var(--radius-card)] border border-border p-3">
      <div>
        <p className="text-sm font-semibold text-text">{t('bundle_card_title', 'Products in this bundle')}</p>
        <p className="text-xs text-text-3">{t('bundle_card_helper', 'Selling the bundle takes stock from these products. Its price is split over them in reports by their regular prices.')}</p>
      </div>

      <Field label={t('bundle_add_product', 'Add a product')} error={errors.bundle_items}>
        <Combobox
          options={options}
          value=""
          onChange={add}
          placeholder={t('bundle_search_placeholder', 'Search by name or barcode…')}
          aria-label={t('bundle_add_product', 'Add a product')}
        />
      </Field>

      {items.length === 0 ? (
        <p className="text-sm text-text-3">{t('bundle_none_yet', 'No products yet.')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-start text-xs text-text-3">
              <th className="py-1 text-start font-medium">{t('bundle_col_product', 'Product')}</th>
              <th className="w-28 py-1 text-start font-medium">{t('bundle_col_qty', 'Qty')}</th>
              <th className="py-1 text-end font-medium">{t('bundle_col_regular', 'Regular')}</th>
              <th className="py-1 text-end font-medium">{t('bundle_col_in_bundle', 'In bundle')}</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const p = byId.get(it.component_id);
              const regular = (Number(p?.price) || 0) * (it.quantity || 0);
              return (
                <tr key={it.component_id} className="border-t border-border">
                  <td className="py-1.5 pe-2">
                    {p ? (
                      <span className="text-text">{p.name}</span>
                    ) : (
                      <span className="text-danger">{t('err_bundle_component_missing', 'A product of this bundle no longer exists. Edit the bundle.')}</span>
                    )}
                    {p && p.track_inventory !== 0 && (
                      <span className="ms-2 text-[11px] text-text-3">{t('bundle_in_stock', '{n} in stock').replace('{n}', String(Math.round((Number(p.stock) || 0) * 1000) / 1000))}</span>
                    )}
                  </td>
                  <td className="py-1.5 pe-2">
                    <NumberInput
                      value={it.quantity}
                      onChange={(v) => setQty(i, v)}
                      min={0}
                      step={1}
                      aria-label={t('bundle_col_qty', 'Qty')}
                      invalid={!!errors[`bundle_items.${i}.quantity`]}
                    />
                  </td>
                  <td className="num py-1.5 text-end text-text-2">{money(regular)}</td>
                  <td className="num py-1.5 text-end text-text">{money(split[i] || 0)}</td>
                  <td className="py-1.5 text-end">
                    <IconButton aria-label={t('bundle_remove', 'Remove from bundle')} size="sm" variant="ghost" onClick={() => remove(i)}>
                      <Trash2 size={14} />
                    </IconButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="grid grid-cols-3 gap-2 rounded-[var(--radius-card)] bg-surface-2 p-3 text-sm">
        <div>
          <p className="text-xs text-text-3">{t('bundle_regular_total', 'Bought separately')}</p>
          <p className="num font-semibold text-text">{money(listTotal)}</p>
        </div>
        <div>
          <p className="text-xs text-text-3">{t('bundle_price', 'Bundle price')}</p>
          <p className="num font-semibold text-text">{money(bundlePrice || 0)}</p>
        </div>
        <div>
          <p className="text-xs text-text-3">{t('bundle_saving', 'Customer saves')}</p>
          <p className={`num font-semibold ${saving < 0 ? 'text-danger' : 'text-success'}`}>
            {money(saving)}{listTotal > 0 ? ` (${savingPct.toFixed(0)}%)` : ''}
          </p>
        </div>
      </div>
      {saving < 0 && <p className="text-xs text-danger">{t('bundle_warn_above_regular', 'The bundle costs more than buying its products separately.')}</p>}
    </div>
  );
}

export default BundleCard;
