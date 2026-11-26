import React, { useEffect, useState } from 'react';
import { Button, Card, Input, Select, useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';

type Language = 'ar' | 'en' | 'fr';
interface Summary { text: string; language: Language; whatsapp_url: string }
interface Settings { owner_whatsapp: string; owner_summary_language: Language }

export default function OwnerSummaryCard({ settings = false }: { settings?: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const [data, setData] = useState<Summary | null>(null);
  const [language, setLanguage] = useState<Language>('ar');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const options = (['ar', 'en', 'fr'] as const).map(value => ({ value, label: t(`os_${value}`) }));

  const load = async (override?: Language) => {
    setBusy(true);
    setError(false);
    setData(null);
    try {
      if (settings) {
        const result = await api.get<Settings>('/api/or/owner-summary-settings');
        setLanguage(result.owner_summary_language);
        setPhone(result.owner_whatsapp);
      } else {
        const result = await api.get<Summary>('/api/or/owner-summary' + (override ? `?language=${override}` : ''));
        setData(result);
        setLanguage(result.language);
      }
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [settings]);

  const save = async () => {
    setBusy(true);
    try {
      const result = await api.put<Settings>('/api/or/owner-summary-settings', { owner_whatsapp: phone, owner_summary_language: language });
      setPhone(result.owner_whatsapp);
      toast.success(t('os_saved'));
    } catch { toast.error(t('os_error')); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(data!.text); toast.success(t('os_copied')); }
    catch { toast.error(t('os_error')); }
  };

  return (
    <Card className="p-5 space-y-4">
      <h3 className="font-semibold">{t('os_title')}</h3>
      {error && <p role="alert">{t('os_error')}</p>}
      {settings && <label className="block space-y-2">
        <span>{t('os_phone')}</span>
        <Input
          type="tel"
          value={phone}
          disabled={busy}
          onChange={event => setPhone(event.target.value)}
        />
      </label>}
      <label className="block space-y-2">
        <span>{t('os_language')}</span>
        <Select
          options={options}
          value={language}
          disabled={busy}
          onChange={event => {
            const next = event.target.value as Language;
            setLanguage(next);
            if (!settings) void load(next);
          }}
        />
      </label>
      {!settings && data && <pre
        dir={data.language === 'ar' ? 'rtl' : 'ltr'}
        className="whitespace-pre-wrap font-sans text-sm text-start"
      >{data.text}</pre>}
      <div className="flex flex-wrap gap-2">
        {settings ? <Button
          disabled={busy || error}
          onClick={() => void save()}
        >{t('os_save')}</Button> : <>
          <Button
            disabled={busy || !data}
            onClick={() => void copy()}
          >{t('os_copy')}</Button>
          <Button
            disabled={busy || !data}
            onClick={() => window.open(data!.whatsapp_url, '_blank', 'noopener')}
          >{t('os_send')}</Button>
        </>}
        <Button
          disabled={busy}
          onClick={() => void load(settings ? undefined : language)}
        >{t('os_refresh')}</Button>
      </div>
    </Card>
  );
}
