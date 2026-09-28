import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardHeader, Field, Input, Textarea, Switch, Button, useToast } from '../../components/ui';
import { Store } from 'lucide-react';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';

export interface GeneralSectionProps {
  settings: Record<string, string>;
  onSaved: () => void;
}

interface FormState {
  store_name: string;
  business_phone: string;
  business_email: string;
  business_address: string;
  business_website: string;
  business_logo: string;
}

function fromSettings(s: Record<string, string>): FormState {
  return {
    store_name: s.store_name || '',
    business_phone: s.business_phone || '',
    business_email: s.business_email || '',
    business_address: s.business_address || '',
    business_website: s.business_website || '',
    business_logo: s.business_logo || '',
  };
}

export function GeneralSection({ settings, onSaved }: GeneralSectionProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => fromSettings(settings));
  const [saving, setSaving] = useState(false);

  useEffect(() => setForm(fromSettings(settings)), [settings]);

  const dirty = JSON.stringify(form) !== JSON.stringify(fromSettings(settings));

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.post('/api/settings', form);
      toast.success(t('set_saved_toast'));
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
          <Store size={18} />
          <h3 className="text-sm font-semibold">{t('set_nav_general')}</h3>
        </div>
        <Button variant="primary" size="sm" disabled={!dirty} loading={saving} onClick={handleSave}>
          {t('set_save')}
        </Button>
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label={t('set_store_name')} className="md:col-span-2">
            <Input value={form.store_name} onChange={(e) => setForm({ ...form, store_name: e.target.value })} />
          </Field>
          <Field label={t('set_business_phone')}>
            <Input value={form.business_phone} onChange={(e) => setForm({ ...form, business_phone: e.target.value })} />
          </Field>
          <Field label={t('set_business_email')}>
            <Input type="email" value={form.business_email} onChange={(e) => setForm({ ...form, business_email: e.target.value })} />
          </Field>
          <Field label={t('set_business_address')} className="md:col-span-2">
            <Textarea rows={2} value={form.business_address} onChange={(e) => setForm({ ...form, business_address: e.target.value })} />
          </Field>
          <Field label={t('set_business_website')}>
            <Input value={form.business_website} onChange={(e) => setForm({ ...form, business_website: e.target.value })} />
          </Field>
          <Field label={t('set_business_logo')}>
            <Input placeholder="https://…" value={form.business_logo} onChange={(e) => setForm({ ...form, business_logo: e.target.value })} />
          </Field>
        </div>
      </CardBody>
    </Card>
  );
}

export default GeneralSection;
