import React, { useEffect, useState } from 'react';
import { Button, Field, Input, Card, CardBody } from '../../components/ui';
import { api } from '../../lib/api';
import { useI18n } from '../../intl';
export function PurchaseScanSection() {
  const { t } = useI18n();
  const [isSet, setIsSet] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/api/purchase-scan/key').then(v => setIsSet(v.set)).catch(() => setError(t('scan_settings_error'))); }, []);
  async function save() {
    setBusy(true);
    setError('');
    try {
      const result = await api.post('/api/purchase-scan/key', { key });
      setIsSet(result.set);
      setKey('');
    } catch { setError(t('scan_settings_error')); }
    finally { setBusy(false); }
  }
  return (
    <Card>
      <CardBody>
        <Field label={t('scan_key')} helper={t(isSet ? 'scan_key_set' : 'scan_key_unset')}>
          <Input
            type="password"
            autoComplete="new-password"
            value={key}
            onChange={e => setKey(e.target.value)}
          />
        </Field>
        <p className="my-2 text-sm text-text-2">{t('scan_key_help')}</p>
        {error && <p role="alert">{error}</p>}
        <Button
          disabled={busy}
          onClick={save}
        >
          {t('scan_save_key')}
        </Button>
      </CardBody>
    </Card>
  );
}
