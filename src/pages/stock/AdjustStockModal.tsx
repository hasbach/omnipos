import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Button, Field, Select, NumberInput, Textarea } from '../../components/ui';
import { useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { translateServerError } from '../../lib/serverErrors';

export interface AdjustStockTarget {
  id: number;
  name: string;
  stock: number;
  unit?: string;
}

export interface AdjustStockModalProps {
  open: boolean;
  product: AdjustStockTarget | null;
  onClose: () => void;
  onSaved: (productId: number, newStock: number) => void;
}

type AdjustMode = 'set' | 'add' | 'remove';

const REASON_KEYS = [
  'stock_reason_count_correction',
  'stock_reason_damaged',
  'stock_reason_expired',
  'stock_reason_theft',
  'stock_reason_returned_supplier',
  'stock_reason_other',
] as const;

/** Shared "adjust stock" dialog — used by both the Products inventory tab and the Stock page. */
export function AdjustStockModal({ open, product, onClose, onSaved }: AdjustStockModalProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [mode, setMode] = useState<AdjustMode>('set');
  const [qty, setQty] = useState<number>(0);
  const [reasonKey, setReasonKey] = useState<string>(REASON_KEYS[0]);
  const [reasonOther, setReasonOther] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && product) {
      setMode('set');
      setQty(product.stock || 0);
      setReasonKey(REASON_KEYS[0]);
      setReasonOther('');
    }
  }, [open, product?.id]);

  const before = product?.stock || 0;
  const after = useMemo(() => {
    if (mode === 'set') return qty;
    if (mode === 'add') return before + qty;
    return before - qty;
  }, [mode, qty, before]);

  const reasonLabel = reasonKey === 'stock_reason_other' ? reasonOther.trim() : t(reasonKey);

  const handleSave = async () => {
    if (!product) return;
    setSaving(true);
    try {
      const userId = (() => {
        try {
          return sessionStorage.getItem('currentCashierId') || undefined;
        } catch {
          return undefined;
        }
      })();
      const body: Record<string, unknown> = { product_id: product.id, reason: reasonLabel || null, user_id: userId };
      if (mode === 'set') body.new_qty = qty;
      else body.delta = mode === 'add' ? qty : -qty;

      await api.post('/api/stock/adjust', body);
      toast.success(t('stock_adjust_success_toast', 'Stock adjusted.'));
      onSaved(product.id, after);
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
      size="sm"
      title={product ? t('stock_adjust_title', 'Adjust stock: {name}').replace('{name}', product.name) : ''}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('stock_cancel', 'Cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave} loading={saving}>
            {t('stock_save', 'Save adjustment')}
          </Button>
        </>
      }
    >
      {product && (
        <div
          className="space-y-4"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
              e.preventDefault();
              handleSave();
            }
          }}
        >
          <Field label={t('stock_adjust_mode', 'Mode')}>
            <Select
              value={mode}
              onChange={(e) => setMode(e.target.value as AdjustMode)}
              options={[
                { value: 'set', label: t('stock_adjust_mode_set', 'Set count') },
                { value: 'add', label: t('stock_adjust_mode_add', 'Add') },
                { value: 'remove', label: t('stock_adjust_mode_remove', 'Remove') },
              ]}
            />
          </Field>
          <Field label={`${t('stock_adjust_qty', 'Quantity')}${product.unit ? ` (${product.unit})` : ''}`}>
            <NumberInput value={qty} onChange={setQty} min={0} autoFocus />
          </Field>
          <Field label={t('stock_adjust_reason', 'Reason')}>
            <Select
              value={reasonKey}
              onChange={(e) => setReasonKey(e.target.value)}
              options={REASON_KEYS.map((k) => ({ value: k, label: t(k) }))}
            />
          </Field>
          {reasonKey === 'stock_reason_other' && (
            <Textarea
              value={reasonOther}
              onChange={(e) => setReasonOther(e.target.value)}
              placeholder={t('stock_reason_other_placeholder', 'Describe the reason…')}
              rows={2}
            />
          )}
          <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-border bg-surface-2 px-4 py-3">
            <div className="text-center">
              <p className="text-xs text-text-3">{t('stock_before', 'Before')}</p>
              <p className="num text-lg font-semibold text-text">{before}</p>
            </div>
            <span className="text-text-3">→</span>
            <div className="text-center">
              <p className="text-xs text-text-3">{t('stock_after', 'After')}</p>
              <p className="num text-lg font-semibold text-primary">{after}</p>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default AdjustStockModal;
