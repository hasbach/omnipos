import React, { useEffect, useState } from 'react';
import { Button, Card, DataTable } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { usePermissions } from '../../lib/usePermissions';
import type { loadForecastAccuracy } from '../../../server/or/demandForecastData';

type Accuracy = ReturnType<typeof loadForecastAccuracy>;
export default function ForecastTab() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [data, setData] = useState<Accuracy | null>(null);
  const [config, setConfig] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const percent = (n: number | null) => n === null ? t('df_unavailable') : `${(n * 100).toFixed(1)}%`;
  const load = async () => {
    setBusy(true);
    setError(false);
    try {
      const result = await api.get<Accuracy>('/api/or/forecast-accuracy');
      setData(result);
      setConfig(JSON.stringify(result.config, null, 2));
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  const save = async () => {
    setBusy(true);
    setError(false);
    try {
      await api.put('/api/or/forecast-config', JSON.parse(config));
      await load();
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-5">
      <p>{t('df_description')}</p>
      <Button
        onClick={() => void load()}
        disabled={busy}
      >{t('df_refresh')}</Button>
      {busy && <p role="status">{t('df_loading')}</p>}
      {error && <p role="alert">{t('df_error')}</p>}
      {data && <>
        <Card className="p-5">
          <DataTable
            data={data.classes}
            rowKey={row => row.abc_class}
            columns={[
              { key: 'abc_class', header: t('df_class') },
              { key: 'wape', header: t('df_wape'), render: row => percent(row.wape) },
            ]}
          />
        </Card>
        <Card className="p-5">
          <DataTable
            data={data.products}
            rowKey={row => row.product_id}
            columns={[
              { key: 'name', header: t('df_product') },
              { key: 'abc_class', header: t('df_class') },
              { key: 'predictions', header: t('df_days') },
              { key: 'wape', header: t('df_wape'), render: row => percent(row.wape) },
            ]}
          />
        </Card>
        {can('or.manage') && <Card className="p-5 space-y-3">
          <label htmlFor="forecast-config">{t('df_config')}</label>
          <p>{t('df_config_help')}</p>
          <textarea
            id="forecast-config"
            className="w-full rounded border p-3 font-mono text-sm"
            rows={10}
            value={config}
            onChange={event => setConfig(event.target.value)}
          />
          <Button
            onClick={() => void save()}
            disabled={busy}
          >{t('df_save')}</Button>
        </Card>}
      </>}
    </div>
  );
}
