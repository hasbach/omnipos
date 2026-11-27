import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Button, Field, Select, NumberInput, Textarea } from '../../components/ui';
import { useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { translateServerError } from '../../lib/serverErrors';
import { Product } from '../../types';

export type BulkStockScope = 'out' | 'negative' | 'selected';

export interface BulkStockModalProps {
  open: boolean;
  onClose: () => void;
  products: Product[];
  /** Ids selected in the calling table; enables the "Selected" scope when non-empty. */
  selectedIds?: Set<number | string>;
  onApplied: () => void;
}

const REASON_KEYS = [
  'stock_reason_count_correction',
  'stock_reason_damaged',
  'stock_reason_expired',
  'stock_reason_theft',
  'stock_reason_returned_supplier',
  'stock_reason_other',
] as const;

/** Mirrors server POST /api/stock/bulk-adjust: tracked, non-bundle products only. */
function adjustable(p: Product): boolean {
  return p.track_inventory !== 0 && !p.is_bundle;
}

/** Set many products' stock to one quantity at once (e.g. zero out every negative item). */
export function BulkStockModal({ open, onClose, products, selectedIds, onApplied }: BulkStockModalProps) {
  const { t } = useI18n();
  const toast = useToast();
  const selectedCount = selectedIds?.size ?? 0;
  const [scope, setScope] = useState<BulkStockScope>('out');
  const [qty, setQty] = useState<number>(0);
  const [reasonKey, setReasonKey] = useState<string>(REASON_KEYS[0]);
  const [reasonOther, setReasonOther] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setScope(selectedCount > 0 ? 'selected' : 'out');
      setQty(0);
      setReasonKey(REASON_KEYS[0]);
      setReasonOther('');
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const affected = useMemo(() => {
    const base = products.filter(adjustable);
    const inScope =
      scope === 'selected'
        ? base.filter((p) => selectedIds?.has(p.id))
        : scope === 'negative'
        ? base.filter((p) => (p.stock || 0) < 0)
        : base.filter((p) => (p.stock || 0) <= 0);
    return inScope.filter((p) => Math.abs((p.stock || 0) - qty) > 1e-9);
  }, [products, scope, selectedIds, qty]);

  const reasonLabel = reasonKey === 'stock_reason_other' ? reasonOther.trim() : t(reasonKey);

  const handleApply = async () => {
    setSaving(true);
    try {
      const userId = (() => {
        try {
          return sessionStorage.getItem('currentCashierId') || undefined;
        } catch {
          return undefined;
        }
      })();
      const body: Record<string, unknown> = { new_qty: qty, reason: reasonLabel || null, user_id: userId };
      // Send the exact ids previewed so the change matches what the user saw.
      body.product_ids = affected.map((p) => p.id);
      const res = await api.post<{ updated: number }>('/api/stock/bulk-adjust', body);
      toast.success(t('stock_bulk_success_toast', '{count} products updated.').replace('{count}', String(res.updated)));
      onApplied();
      onClose();
    } catch (err: any) {
      toast.error(translateServerError(err, t) || t('stock_adjust_error_toast', 'Could not adjust stock.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('stock_bulk_title', 'Bulk stock update')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('stock_cancel', 'Cancel')}
          </Button>
          <Button variant="primary" onClick={handleApply} loading={saving} disabled={affected.length === 0 || !(qty >= 0)}>
            {t('stock_bulk_apply', 'Apply to {count} products').replace('{count}', String(affected.length))}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t('stock_bulk_scope', 'Products')}>
            <Select
              value={scope}
              onChange={(e) => setScope(e.target.value as BulkStockScope)}
              options={[
                { value: 'out', label: t('stock_bulk_scope_out', 'All out of stock (0 or less)') },
                { value: 'negative', label: t('stock_bulk_scope_negative', 'Negative stock only') },
                {
                  value: 'selected',
                  label: t('stock_bulk_scope_selected', 'Selected ({count})').replace('{count}', String(selectedCount)),
                  disabled: selectedCount === 0,
                },
              ]}
            />
          </Field>
          <Field label={t('stock_bulk_new_qty', 'Set quantity to')} helper={t('stock_bulk_new_qty_helper', 'Use 0 to clear negative stock.')}>
            <NumberInput value={qty} onChange={setQty} min={0} autoFocus />
          </Field>
          <Field label={t('stock_adjust_reason', 'Reason')}>
            <Select value={reasonKey} onChange={(e) => setReasonKey(e.target.value)} options={REASON_KEYS.map((k) => ({ value: k, label: t(k) }))} />
          </Field>
        </div>
        {reasonKey === 'stock_reason_other' && (
          <Textarea
            value={reasonOther}
            onChange={(e) => setReasonOther(e.target.value)}
            placeholder={t('stock_reason_other_placeholder', 'Describe the reason…')}
            rows={2}
          />
        )}

        <p className="text-sm text-text-2">
          {t('stock_bulk_affected', '{count} products will be changed. Each change is recorded in stock adjustments.').replace('{count}', String(affected.length))}
        </p>

        <div className="max-h-64 overflow-y-auto rounded-[var(--radius-card)] border border-border">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-surface-2 text-xs text-text-3">
              <tr>
                <th className="px-3 py-2 text-start font-medium">{t('stock_col_product', 'Product')}</th>
                <th className="px-3 py-2 text-end font-medium">{t('stock_before', 'Before')}</th>
                <th className="px-3 py-2 text-end font-medium">{t('stock_after', 'After')}</th>
              </tr>
            </thead>
            <tbody>
              {affected.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-text-3">
                    {t('stock_bulk_preview_empty', 'No products need changing.')}
                  </td>
                </tr>
              )}
              {affected.slice(0, 100).map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-3 py-2 text-text">{p.name}</td>
                  <td className={`num px-3 py-2 text-end ${(p.stock || 0) < 0 ? 'text-danger' : 'text-text-3'}`}>{p.stock || 0}</td>
                  <td className="num px-3 py-2 text-end font-medium">{qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}

export default BulkStockModal;
