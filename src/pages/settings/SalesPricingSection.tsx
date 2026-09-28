import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardHeader, Field, NumberInput, Select, Switch, Button, useToast } from '../../components/ui';
import { Tag } from 'lucide-react';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { invalidateSettingsCache } from '../../lib/useSettings';

export interface SalesPricingSectionProps {
  settings: Record<string, string>;
  onSaved: () => void;
}

interface FormState {
  tax_rate: string;
  default_price_level: string;
  allow_price_override: boolean;
  enforce_min_price: boolean;
  enforce_credit_limit: boolean;
  enable_price_levels: boolean;
}

function fromSettings(s: Record<string, string>): FormState {
  return {
    tax_rate: s.tax_rate || '0',
    default_price_level: s.default_price_level || 'retail',
    allow_price_override: s.allow_price_override === '1',
    enforce_min_price: s.enforce_min_price === '1',
    enforce_credit_limit: s.enforce_credit_limit === '1',
    // Missing key = enabled (default on), per spec.
    enable_price_levels: s.enable_price_levels !== '0',
  };
}

export function SalesPricingSection({ settings, onSaved }: SalesPricingSectionProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => fromSettings(settings));
  const [saving, setSaving] = useState(false);

  useEffect(() => setForm(fromSettings(settings)), [settings]);

  const dirty = JSON.stringify(form) !== JSON.stringify(fromSettings(settings));

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.post('/api/settings', {
        tax_rate: form.tax_rate,
        default_price_level: form.default_price_level,
        allow_price_override: form.allow_price_override ? '1' : '0',
        enforce_min_price: form.enforce_min_price ? '1' : '0',
        enforce_credit_limit: form.enforce_credit_limit ? '1' : '0',
        enable_price_levels: form.enable_price_levels ? '1' : '0',
      });
      toast.success(t('set_saved_toast'));
      invalidateSettingsCache();
      onSaved();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 text-text-2">
          <Tag size={18} />
          <h3 className="text-sm font-semibold">{t('set_nav_pricing')}</h3>
        </div>
        <Button variant="primary" size="sm" disabled={!dirty} loading={saving} onClick={handleSave}>
          {t('set_save')}
        </Button>
      </CardHeader>
      <CardBody>
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label={t('set_tax_rate')}>
              <NumberInput value={Number(form.tax_rate)} onChange={(v) => setForm({ ...form, tax_rate: String(v) })} min={0} max={100} step={0.5} />
            </Field>
            {form.enable_price_levels && (
              <Field label={t('set_default_price_level')} helper={t('set_default_price_level_help')}>
                <Select
                  value={form.default_price_level}
                  onChange={(e) => setForm({ ...form, default_price_level: e.target.value })}
                  options={[
                    { value: 'retail', label: t('stk_price_level_retail') },
                    { value: 'wholesale', label: t('stk_price_level_wholesale') },
                    { value: 'super_wholesale', label: t('stk_price_level_super_wholesale') },
                  ]}
                />
              </Field>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-border bg-surface-2 p-3">
              <div className="pe-4">
                <p className="text-sm font-medium text-text">{t('set_enable_price_levels')}</p>
                <p className="text-xs text-text-3">{t('set_enable_price_levels_help')}</p>
              </div>
              <Switch checked={form.enable_price_levels} onChange={(v) => setForm({ ...form, enable_price_levels: v })} />
            </div>
            <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-border bg-surface-2 p-3">
              <div className="pe-4">
                <p className="text-sm font-medium text-text">{t('set_allow_price_override')}</p>
                <p className="text-xs text-text-3">{t('set_allow_price_override_help')}</p>
              </div>
              <Switch checked={form.allow_price_override} onChange={(v) => setForm({ ...form, allow_price_override: v })} />
            </div>
            <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-border bg-surface-2 p-3">
              <div className="pe-4">
                <p className="text-sm font-medium text-text">{t('set_enforce_min_price')}</p>
                <p className="text-xs text-text-3">{t('set_enforce_min_price_help')}</p>
              </div>
              <Switch checked={form.enforce_min_price} onChange={(v) => setForm({ ...form, enforce_min_price: v })} />
            </div>
            <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-border bg-surface-2 p-3">
              <div className="pe-4">
                <p className="text-sm font-medium text-text">{t('set_enforce_credit_limit')}</p>
                <p className="text-xs text-text-3">{t('set_enforce_credit_limit_help')}</p>
              </div>
              <Switch checked={form.enforce_credit_limit} onChange={(v) => setForm({ ...form, enforce_credit_limit: v })} />
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

export default SalesPricingSection;
