import React, { useEffect, useState } from 'react';
import { Modal, Button, Checkbox, useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, formatPercent } from '../../lib/format';
import { markupPct, priceFromMarkup } from '../../lib/pricing';
import type { Product } from '../../types';

export interface PriceSuggestionRow {
  product: Product; // snapshot BEFORE the purchase changed its cost
  newCost: number; // this product's cost after the purchase was applied
}

export interface UpdateSellingPricesModalProps {
  open: boolean;
  onClose: () => void;
  rows: PriceSuggestionRow[];
  onApplied: (count: number) => void;
}

interface Suggestion {
  productId: number;
  name: string;
  newCost: number;
  markup: number;
  suggestedRetail: number;
  suggestedWholesale: number | null;
  suggestedSuperWholesale: number | null;
  product: Product;
}

export function UpdateSellingPricesModal({ open, onClose, rows, onApplied }: UpdateSellingPricesModalProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  const suggestions: Suggestion[] = rows.map(({ product, newCost }) => {
    const oldCost = product.cost || 0;
    const markup = markupPct(product.price, oldCost);
    const suggestedRetail = Number(priceFromMarkup(newCost, markup).toFixed(2));
    const suggestedWholesale = product.price_wholesale
      ? Number(priceFromMarkup(newCost, markupPct(product.price_wholesale, oldCost)).toFixed(2))
      : null;
    const suggestedSuperWholesale = product.price_super_wholesale
      ? Number(priceFromMarkup(newCost, markupPct(product.price_super_wholesale, oldCost)).toFixed(2))
      : null;
    return { productId: product.id, name: product.name, newCost, markup, suggestedRetail, suggestedWholesale, suggestedSuperWholesale, product };
  });

  useEffect(() => {
    if (open) setSelected(new Set(suggestions.map((s) => s.productId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows.length]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const apply = async () => {
    setSaving(true);
    let count = 0;
    try {
      for (const s of suggestions) {
        if (!selected.has(s.productId)) continue;
        const p = s.product;
        // Full product payload the PUT handler expects — `stock` intentionally omitted (server
        // treats it as optional and keeps the current value; sending it here would be stale by
        // the time this modal is used, right after the purchase already moved stock).
        await api.put(`/api/products/${p.id}`, {
          name: p.name,
          price: s.suggestedRetail,
          price_lbp: p.price_lbp,
          package_price: p.package_price,
          package_price_lbp: p.package_price_lbp,
          cost: s.newCost,
          cost_lbp: p.cost_lbp,
          units_per_package: p.units_per_package,
          reorder_point: p.reorder_point,
          track_inventory: p.track_inventory,
          category: p.category,
          currency: p.currency,
          unit: p.unit,
          barcodes: p.barcodes && p.barcodes.length ? p.barcodes : [p.barcode],
          price_wholesale: s.suggestedWholesale ?? p.price_wholesale,
          price_wholesale_lbp: p.price_wholesale_lbp,
          price_super_wholesale: s.suggestedSuperWholesale ?? p.price_super_wholesale,
          price_super_wholesale_lbp: p.price_super_wholesale_lbp,
          min_price: p.min_price,
        });
        count += 1;
      }
      toast.success(t('inv_editor_update_prices_done', 'Selling prices updated for {n} product(s).').replace('{n}', String(count)));
      onApplied(count);
      onClose();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('inv_editor_update_prices_title', 'Update selling prices?')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('inv_editor_update_prices_skip', 'Skip')}</Button>
          <Button variant="primary" loading={saving} onClick={apply}>{t('inv_editor_update_prices_save', 'Apply selected')}</Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-text-2">{t('inv_editor_update_prices_desc')}</p>
      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface-2">
            <tr className="text-xs uppercase tracking-wide text-text-3">
              <th className="w-8 px-2 py-2" />
              <th className="px-2 py-2 text-start">{t('inv_editor_update_prices_col_product', 'Product')}</th>
              <th className="px-2 py-2 text-end num">{t('inv_editor_update_prices_col_cost', 'New cost')}</th>
              <th className="px-2 py-2 text-end num">{t('inv_editor_update_prices_col_markup', 'Markup')}</th>
              <th className="px-2 py-2 text-end num">{t('inv_editor_update_prices_col_retail', 'Retail')}</th>
              <th className="px-2 py-2 text-end num">{t('inv_editor_update_prices_col_wholesale', 'Wholesale')}</th>
              <th className="px-2 py-2 text-end num">{t('inv_editor_update_prices_col_super_wholesale', 'Super wholesale')}</th>
            </tr>
          </thead>
          <tbody>
            {suggestions.map((s) => (
              <tr key={s.productId} className="border-t border-border">
                <td className="px-2 py-2"><Checkbox checked={selected.has(s.productId)} onChange={() => toggle(s.productId)} /></td>
                <td className="px-2 py-2 font-medium text-text">{s.name}</td>
                <td className="px-2 py-2 text-end num">{formatMoney(s.newCost, { code: 'USD', symbol: '$' })}</td>
                <td className="px-2 py-2 text-end num text-text-3">{formatPercent(s.markup)}</td>
                <td className="px-2 py-2 text-end num">{formatMoney(s.suggestedRetail, { code: 'USD', symbol: '$' })}</td>
                <td className="px-2 py-2 text-end num">{s.suggestedWholesale != null ? formatMoney(s.suggestedWholesale, { code: 'USD', symbol: '$' }) : '—'}</td>
                <td className="px-2 py-2 text-end num">{s.suggestedSuperWholesale != null ? formatMoney(s.suggestedSuperWholesale, { code: 'USD', symbol: '$' }) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

export default UpdateSellingPricesModal;
