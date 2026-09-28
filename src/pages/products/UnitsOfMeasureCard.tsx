import React from 'react';
import { Plus, Trash2, Package } from 'lucide-react';
import { Button, Field, Input, MoneyInput, NumberInput, IconButton } from '../../components/ui';
import { useI18n } from '../../intl/index';
import type { ProductUnit } from '../../types';

/** Editable unit-of-measure row (pack, carton...). `id` is set for rows that already exist on the server. */
export interface UnitDraft {
  _key: string;
  id?: number;
  name: string;
  /** Base pieces in one unit. */
  factor: number;
  barcode: string;
  price: number;
  price_lbp: number;
  price_wholesale: number;
  price_wholesale_lbp: number;
  price_super_wholesale: number;
  price_super_wholesale_lbp: number;
}

let unitKeySeq = 0;
export const newUnitKey = () => `u_${++unitKeySeq}`;

export function unitToDraft(u: ProductUnit): UnitDraft {
  return {
    _key: u.id ? `id_${u.id}` : newUnitKey(),
    id: u.id,
    name: u.name || '',
    factor: u.factor || 0,
    barcode: u.barcode || '',
    price: u.price || 0,
    price_lbp: u.price_lbp || 0,
    price_wholesale: u.price_wholesale || 0,
    price_wholesale_lbp: u.price_wholesale_lbp || 0,
    price_super_wholesale: u.price_super_wholesale || 0,
    price_super_wholesale_lbp: u.price_super_wholesale_lbp || 0,
  };
}

/** Body sent to POST/PUT /api/products (`units`). Blank tier prices become null. */
export function draftToPayload(u: UnitDraft) {
  return {
    ...(u.id ? { id: u.id } : {}),
    name: u.name.trim(),
    factor: u.factor,
    barcode: u.barcode.trim() || null,
    price: u.price,
    price_lbp: u.price_lbp || null,
    price_wholesale: u.price_wholesale || null,
    price_wholesale_lbp: u.price_wholesale_lbp || null,
    price_super_wholesale: u.price_super_wholesale || null,
    price_super_wholesale_lbp: u.price_super_wholesale_lbp || null,
  };
}

/** Client-side mirror of the server's unit checks; returns errors keyed like the server's `field` (`units.<i>.<name>`). */
export function validateUnits(units: UnitDraft[], t: (k: string, f?: string) => string): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Map<number, number>();
  units.forEach((u, i) => {
    if (!u.name.trim()) errors[`units.${i}.name`] = t('err_uom_name_required', 'Enter a name for this unit.');
    if (!(u.factor > 1)) errors[`units.${i}.factor`] = t('err_uom_factor_invalid', 'A unit must contain more than 1 piece.');
    else if (seen.has(u.factor)) errors[`units.${i}.factor`] = t('err_uom_factor_duplicate', 'Two units have the same size. Each unit needs a different quantity.');
    else seen.set(u.factor, i);
    if (!(u.price > 0)) errors[`units.${i}.price`] = t('err_uom_price_required', 'Enter a price for this unit.');
  });
  return errors;
}

const PRESETS: Array<{ key: string; fallback: string; factor: number }> = [
  { key: 'uom_preset_pack', fallback: 'Pack', factor: 6 },
  { key: 'uom_preset_box', fallback: 'Box', factor: 10 },
  { key: 'uom_preset_dozen', fallback: 'Dozen', factor: 12 },
  { key: 'uom_preset_carton', fallback: 'Carton', factor: 24 },
];

export interface UnitsOfMeasureCardProps {
  units: UnitDraft[];
  onChange: (units: UnitDraft[]) => void;
  /** The product's base unit label (pcs, kg...). */
  baseUnit: string;
  /** Retail price of ONE base piece, used for the "saves x%" hint and to prefill a new unit. */
  retailPrice: number;
  /** LBP per USD. */
  rate: number;
  priceLevelsEnabled: boolean;
  errors: Record<string, string>;
  onClearError: (key: string) => void;
}

const fill = (tpl: string, vars: Record<string, string>) => Object.entries(vars).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(v), tpl);
const fmt = (n: number) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 3 }) : '0');

export function UnitsOfMeasureCard({ units, onChange, baseUnit, retailPrice, rate, priceLevelsEnabled, errors, onClearError }: UnitsOfMeasureCardProps) {
  const { t } = useI18n();
  const baseLabel = baseUnit || t('uom_piece', 'Piece');

  const patch = (key: string, p: Partial<UnitDraft>) => onChange(units.map((u) => (u._key === key ? { ...u, ...p } : u)));
  const remove = (key: string) => onChange(units.filter((u) => u._key !== key));
  const add = (name = '', factor = 0) => {
    const price = factor > 1 && retailPrice > 0 ? Math.round(retailPrice * factor * 100) / 100 : 0;
    onChange([
      ...units,
      {
        _key: newUnitKey(),
        name,
        factor,
        barcode: '',
        price,
        price_lbp: price ? Math.round(price * rate) : 0,
        price_wholesale: 0,
        price_wholesale_lbp: 0,
        price_super_wholesale: 0,
        price_super_wholesale_lbp: 0,
      },
    ]);
  };

  return (
    <div className="space-y-3 rounded-[var(--radius-card)] border border-border p-3">
      <div className="flex items-start gap-2">
        <Package size={18} className="mt-0.5 shrink-0 text-text-3" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text">{t('uom_card_title', 'Units of measure')}</p>
          <p className="text-xs text-text-3">
            {fill(t('uom_card_helper', 'Stock is counted in {unit}. Add packs or cartons with their own barcode and price; selling one deducts the right number of {unit}.'), { unit: baseLabel })}
          </p>
        </div>
      </div>

      {units.length === 0 && (
        <p className="rounded-[var(--radius-input)] bg-surface-2 px-3 py-2 text-xs text-text-3">
          {fill(t('uom_none_yet', 'No extra units yet. This product is sold by the {unit} only.'), { unit: baseLabel })}
        </p>
      )}

      {units.map((u, i) => {
        const err = (name: string) => errors[`units.${i}.${name}`];
        const perPiece = u.factor > 0 ? u.price / u.factor : 0;
        const piecesTotal = retailPrice * u.factor;
        const saving = piecesTotal > 0 && u.price > 0 ? ((piecesTotal - u.price) / piecesTotal) * 100 : 0;
        return (
          <div key={u._key} className="space-y-3 rounded-[var(--radius-card)] border border-border bg-surface-2 p-3">
            <div className="grid grid-cols-[1fr_120px_auto] items-start gap-2">
              <Field label={t('uom_name', 'Name')} required error={err('name')}>
                <Input
                  value={u.name}
                  invalid={!!err('name')}
                  placeholder={t('uom_name_placeholder', 'e.g. Carton')}
                  onChange={(e) => { patch(u._key, { name: e.target.value }); onClearError(`units.${i}.name`); }}
                />
              </Field>
              <Field label={t('uom_contains', 'Contains')} required error={err('factor')}>
                <NumberInput
                  value={u.factor || ''}
                  min={2}
                  step={1}
                  invalid={!!err('factor')}
                  endAdornment={baseLabel}
                  onChange={(v) => { patch(u._key, { factor: v }); onClearError(`units.${i}.factor`); }}
                />
              </Field>
              <div className="pt-[26px]">
                <IconButton aria-label={t('uom_remove', 'Remove unit')} variant="danger" onClick={() => remove(u._key)}>
                  <Trash2 size={15} />
                </IconButton>
              </div>
            </div>

            <Field label={t('uom_barcode', 'Unit barcode')} error={err('barcode')} helper={t('uom_barcode_helper', 'Scanning this barcode at the till adds this unit.')}>
              <Input
                value={u.barcode}
                invalid={!!err('barcode')}
                className="font-mono"
                onChange={(e) => { patch(u._key, { barcode: e.target.value }); onClearError(`units.${i}.barcode`); }}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label={t('uom_price_retail_usd', 'Retail price (USD)')} required error={err('price')}>
                <MoneyInput
                  currencySymbol="$"
                  value={u.price}
                  invalid={!!err('price')}
                  onChange={(v) => { patch(u._key, { price: v, price_lbp: Math.round(v * rate) }); onClearError(`units.${i}.price`); }}
                />
              </Field>
              <Field label={t('uom_price_retail_lbp', 'Retail price (LBP)')}>
                <MoneyInput
                  currencySymbol="LL"
                  step={1}
                  value={u.price_lbp}
                  onChange={(v) => patch(u._key, { price_lbp: v, price: rate ? Math.round((v / rate) * 100) / 100 : 0 })}
                />
              </Field>
              {priceLevelsEnabled && (
                <>
                  <Field label={t('uom_price_wholesale', 'Wholesale (USD)')} helper={t('uom_tier_helper', 'Leave empty to use the product tier price × pieces.')}>
                    <MoneyInput
                      currencySymbol="$"
                      value={u.price_wholesale}
                      onChange={(v) => patch(u._key, { price_wholesale: v, price_wholesale_lbp: v ? Math.round(v * rate) : 0 })}
                    />
                  </Field>
                  <Field label={t('uom_price_super_wholesale', 'Super wholesale (USD)')}>
                    <MoneyInput
                      currencySymbol="$"
                      value={u.price_super_wholesale}
                      onChange={(v) => patch(u._key, { price_super_wholesale: v, price_super_wholesale_lbp: v ? Math.round(v * rate) : 0 })}
                    />
                  </Field>
                </>
              )}
            </div>

            {u.factor > 1 && u.price > 0 && (
              <p className="text-xs text-text-3 num">
                ${fmt(perPiece)} / {baseLabel}
                {saving > 0.05 && (
                  <span className="ms-1 font-semibold text-success">
                    · {fill(t('uom_saves', 'saves {pct}%'), { pct: fmt(Math.round(saving * 10) / 10) })}
                  </span>
                )}
                {saving < -0.05 && (
                  <span className="ms-1 font-semibold text-accent">
                    · {fill(t('uom_costs_more', '{pct}% more than selling {unit} one by one'), { pct: fmt(Math.round(-saving * 10) / 10), unit: baseLabel })}
                  </span>
                )}
              </p>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => add()}>
          <Plus size={14} /> {t('uom_add', 'Add unit')}
        </Button>
        <span className="text-xs text-text-3">{t('uom_quick_add', 'Quick add:')}</span>
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => add(t(p.key, p.fallback), p.factor)}
            className="min-h-[30px] cursor-pointer rounded-[var(--radius-chip)] border border-border bg-surface px-2.5 text-xs font-medium text-text-2 transition-colors hover:border-primary hover:text-primary"
          >
            {t(p.key, p.fallback)} ×{p.factor}
          </button>
        ))}
      </div>
    </div>
  );
}

export default UnitsOfMeasureCard;
