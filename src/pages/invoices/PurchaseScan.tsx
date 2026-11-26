import React, { useRef, useState } from 'react';
import { Button, Combobox, Field, Input, Select } from '../../components/ui';
import { useI18n } from '../../intl';
import { api } from '../../lib/api';
import { effectiveLocalCurrency } from '../../lib/orderTotals';
import type { Product, Stakeholder } from '../../types';
import { nextKey, type CurrencyRow, type LineDraft } from './types';
interface ScanLine { name: string; quantity: number; unit_price: number; unit?: string; product_id: number; uom_id: string; candidates: { product_id: number; score: number }[] }
interface ScanDraft { supplier_id: number | null; supplier_name: string; invoice_date: string; invoice_number: string; currency: string; discount?: number; total: number; lines: ScanLine[] }
export function PurchaseScan({ products, suppliers, currencies, onApply }: {
  products: Product[]; suppliers: Stakeholder[]; currencies: CurrencyRow[];
  onApply: (draft: { lines: LineDraft[]; supplier: number; date: string; reference: string; discount: number }) => void;
}) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<ScanDraft | null>(null);
  const patch = (index: number, values: Partial<ScanLine>) => setDraft(d => d && ({ ...d, lines: d.lines.map((l, i) => i === index ? { ...l, ...values } : l) }));
  const supplier = suppliers.find(s => s.id === draft?.supplier_id);
  const local = effectiveLocalCurrency(currencies, supplier || null);
  const rate = draft?.currency === 'USD' ? 1 : draft?.currency === local?.code ? local.rate : currencies.find(c => c.code === draft?.currency)?.rate;
  const computedTotal = draft ? draft.lines.reduce((sum, l) => sum + l.quantity * l.unit_price, 0) - (draft.discount || 0) : 0;
  const totalsAgree = !!draft && Number.isFinite(computedTotal) && Math.abs(computedTotal - draft.total) <= Math.max(0.01, (rate || 1) * 0.01);
  async function scan(file?: File) {
    if (!file) return;
    setError('');
    if (file.size > 10 * 1024 * 1024) { setError(t('scan_too_large')); return; }
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type)) { setError(t('scan_invalid_file')); return; }
    setBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const result = await api.post<ScanDraft>('/api/purchase-scan', { media_type: file.type, data });
      setDraft({ ...result, lines: result.lines.map(l => {
        const id = l.candidates[0]?.product_id || 0;
        const product = products.find(p => p.id === id);
        const unit = product?.units?.find(u => u.name.toLowerCase() === l.unit?.toLowerCase());
        return { ...l, product_id: id, uom_id: unit ? String(unit.id) : l.unit && l.unit !== product?.unit ? '' : 'base' };
      }) });
    } catch (e) {
      const key = (e as any).code;
      setError(t(key?.startsWith('scan_') ? key : 'scan_failed'));
    } finally { setBusy(false); }
  }
  async function apply() {
    if (!draft || !supplier || !rate || rate <= 0 || !totalsAgree) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/api/purchase-scan/mappings', { supplier_id: supplier.id, lines: draft.lines.map(l => ({ name: l.name, product_id: l.product_id })) });
      onApply({ supplier: supplier.id, date: draft.invoice_date, reference: draft.invoice_number, discount: (draft.discount || 0) / rate,
        lines: draft.lines.map(l => {
          const p = products.find(p => p.id === l.product_id)!;
          const u = p.units?.find(u => String(u.id) === l.uom_id);
          return { _key: nextKey('scan'), product_id: p.id, name: p.name, quantity: l.quantity, unit_price: l.unit_price / rate,
            uom_id: u?.id || null, uom_name: u?.name || null, uom_factor: u?.factor || 1, discount: { type: 'fixed', value: 0 } };
        }),
      });
      setDraft(null);
    } catch { setError(t('scan_invalid_mapping')); }
    finally { setBusy(false); }
  }
  return (
    <div className="space-y-3 rounded border border-border p-3">
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        aria-label={t('scan_button')}
        className="hidden"
        onChange={e => { void scan(e.target.files?.[0]); e.target.value = ''; }}
      />
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
      >
        {t(busy ? 'scan_progress' : 'scan_button')}
      </Button>
      <input
        ref={cameraRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        aria-label={t('scan_camera')}
        className="hidden"
        onChange={e => { void scan(e.target.files?.[0]); e.target.value = ''; }}
      />
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => cameraRef.current?.click()}
      >
        {t('scan_camera')}
      </Button>
      {error && <p role="alert" className="text-danger">{error}</p>}
      {draft && <fieldset disabled={busy} className="space-y-3">
        <p>{t('scan_review')}</p>
        <p>{draft.supplier_name} · {draft.currency} · {draft.total}</p>
        <Field label={t('scan_supplier')}>
          <Combobox
            value={String(draft.supplier_id || '')}
            options={suppliers.map(s => ({ value: String(s.id), label: s.name }))}
            onChange={v => setDraft({ ...draft, supplier_id: Number(v) })}
          />
        </Field>
        <Field label={t('scan_date')}>
          <Input
            type="date"
            value={draft.invoice_date}
            onChange={e => setDraft({ ...draft, invoice_date: e.target.value })}
          />
        </Field>
        <Field label={t('scan_reference')}>
          <Input
            value={draft.invoice_number}
            onChange={e => setDraft({ ...draft, invoice_number: e.target.value })}
          />
        </Field>
        {draft.lines.map((l, i) => {
          const product = products.find(p => p.id === l.product_id);
          return <div key={i} className="space-y-2 border-t border-border pt-2">
            <p>{l.name}{l.unit ? ` · ${l.unit}` : ''}</p>
            <Field label={t('scan_product')}>
              <Combobox
                value={String(l.product_id || '')}
                options={products.filter(p => !p.is_bundle).map(p => ({ value: String(p.id), label: p.name }))}
                onChange={v => patch(i, { product_id: Number(v), uom_id: '' })}
              />
            </Field>
            <Field label={t('scan_unit')}>
              <Select
                value={l.uom_id}
                onChange={e => patch(i, { uom_id: e.target.value })}
                placeholder={t('scan_choose_unit')}
                options={[
                  { value: 'base', label: t('scan_base_unit') },
                  ...(product?.units || []).map(u => ({ value: String(u.id), label: u.name })),
                ]}
              />
            </Field>
            <Field label={t('scan_quantity')}>
              <Input
                type="number"
                min="0"
                step="any"
                value={l.quantity}
                onChange={e => patch(i, { quantity: Number(e.target.value) })}
              />
            </Field>
            <Field label={t('scan_price')}>
              <Input
                type="number"
                min="0"
                step="any"
                value={l.unit_price}
                onChange={e => patch(i, { unit_price: Number(e.target.value) })}
              />
            </Field>
          </div>;
        })}
        <Field label={t('scan_discount')}>
          <Input
            type="number"
            min="0"
            step="any"
            value={draft.discount || 0}
            onChange={e => setDraft({ ...draft, discount: Number(e.target.value) })}
          />
        </Field>
        {!totalsAgree && <p role="alert" className="text-danger">{t('scan_total_mismatch')} {computedTotal} / {draft.total} {draft.currency}</p>}
        {(!rate || rate <= 0) && <p role="alert">{t('scan_currency_error')}</p>}
        <Button
          disabled={busy || !totalsAgree || !supplier || !rate || rate <= 0 || !draft.invoice_date || draft.lines.some(l => !l.product_id || !l.uom_id || !Number.isFinite(l.quantity) || l.quantity <= 0 || !Number.isFinite(l.unit_price) || l.unit_price < 0)}
          onClick={apply}
        >
          {t('scan_apply')}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => setDraft(null)}
        >
          {t('scan_cancel')}
        </Button>
      </fieldset>}
    </div>
  );
}
