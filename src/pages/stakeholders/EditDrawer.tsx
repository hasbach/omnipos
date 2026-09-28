import React, { useEffect, useState } from 'react';
import { Drawer, Field, Input, Select, MoneyInput, Switch, Button } from '../../components/ui';
import { useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import type { PriceLevel, Stakeholder } from '../../types';

export interface EditDrawerProps {
  open: boolean;
  onClose: () => void;
  /** null = create new. */
  stakeholder: Stakeholder | null;
  /** Default type when creating (driven by the active tab). */
  defaultType: 'customer' | 'supplier';
  onSaved: () => void;
}

interface FormState {
  name: string;
  type: 'customer' | 'supplier';
  phone: string;
  email: string;
  address: string;
  price_level: PriceLevel;
  credit_limit: string; // blank = unlimited
  overrideBalance: boolean;
  balance: string;
}

function emptyForm(defaultType: 'customer' | 'supplier'): FormState {
  return {
    name: '',
    type: defaultType,
    phone: '',
    email: '',
    address: '',
    price_level: 'retail',
    credit_limit: '',
    overrideBalance: false,
    balance: '0',
  };
}

export function EditDrawer({ open, onClose, stakeholder, defaultType, onSaved }: EditDrawerProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(emptyForm(defaultType));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (stakeholder) {
      setForm({
        name: stakeholder.name || '',
        type: stakeholder.type,
        phone: stakeholder.phone || '',
        email: stakeholder.email || '',
        address: stakeholder.address || '',
        price_level: stakeholder.price_level || 'retail',
        credit_limit: stakeholder.credit_limit ? String(stakeholder.credit_limit) : '',
        overrideBalance: false,
        balance: String(stakeholder.balance ?? 0),
      });
    } else {
      setForm(emptyForm(defaultType));
    }
  }, [open, stakeholder, defaultType]);

  const isEdit = !!stakeholder?.id;
  const title = isEdit
    ? form.type === 'customer' ? t('stk_edit_customer') : t('stk_edit_supplier')
    : form.type === 'customer' ? t('stk_new_customer') : t('stk_new_supplier');

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        type: form.type,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        address: form.address.trim() || null,
        price_level: form.price_level,
        credit_limit: form.credit_limit.trim() === '' ? null : Number(form.credit_limit),
      };
      // The PUT/POST handler treats `balance` as an override of the derived balance — only
      // send it when the user explicitly opted in, or on create (starting balance).
      if (!isEdit || form.overrideBalance) {
        payload.balance = Number(form.balance) || 0;
      }

      if (isEdit && stakeholder?.id) {
        await api.put(`/api/stakeholders/${stakeholder.id}`, payload);
      } else {
        await api.post('/api/stakeholders', payload);
      }
      toast.success(t('set_saved_toast', 'Saved'));
      onSaved();
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Error');
    } finally {
      setSaving(false);
    }
  };

  const priceLevelOptions = [
    { value: 'retail', label: t('stk_price_level_retail') },
    { value: 'wholesale', label: t('stk_price_level_wholesale') },
    { value: 'super_wholesale', label: t('stk_price_level_super_wholesale') },
  ];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('stk_cancel')}</Button>
          <Button variant="primary" loading={saving} disabled={!form.name.trim()} onClick={handleSave}>{t('stk_save')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('stk_field_name')} required>
          <Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>

        <Field label={t('stk_field_type')}>
          <Select
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value as 'customer' | 'supplier' })}
            options={[
              { value: 'customer', label: t('stk_type_customer') },
              { value: 'supplier', label: t('stk_type_supplier') },
            ]}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('stk_field_phone')}>
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label={t('stk_field_email')}>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
        </div>

        <Field label={t('stk_field_address')}>
          <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>

        <Field label={t('stk_field_price_level')} helper={t('stk_price_level_help')}>
          <Select
            value={form.price_level}
            onChange={(e) => setForm({ ...form, price_level: e.target.value as PriceLevel })}
            options={priceLevelOptions}
          />
        </Field>

        <Field label={t('stk_field_credit_limit')} helper={t('stk_credit_limit_help')}>
          <MoneyInput
            currencySymbol="$"
            placeholder={t('stk_unlimited')}
            value={form.credit_limit === '' ? '' : Number(form.credit_limit)}
            onChange={(v) => setForm({ ...form, credit_limit: v === 0 ? '' : String(v) })}
          />
        </Field>

        {isEdit ? (
          <div className="rounded-[var(--radius-card)] border border-border bg-surface-2 p-3">
            <Switch
              checked={form.overrideBalance}
              onChange={(v) => setForm({ ...form, overrideBalance: v })}
              label={t('stk_balance_override_toggle')}
            />
            {form.overrideBalance && (
              <div className="mt-3 flex flex-col gap-2">
                <p className="text-xs text-danger">{t('stk_balance_override_warning')}</p>
                <Field label={t('stk_field_balance_override')}>
                  <MoneyInput
                    currencySymbol="$"
                    value={Number(form.balance)}
                    onChange={(v) => setForm({ ...form, balance: String(v) })}
                  />
                </Field>
              </div>
            )}
          </div>
        ) : (
          <Field label={t('stk_field_opening_balance')}>
            <MoneyInput
              currencySymbol="$"
              value={Number(form.balance)}
              onChange={(v) => setForm({ ...form, balance: String(v) })}
            />
          </Field>
        )}
      </div>
    </Drawer>
  );
}

export default EditDrawer;
