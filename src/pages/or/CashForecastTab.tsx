import React, { useEffect, useState } from 'react';
import { Button, Card, DataTable } from '../../components/ui';
import { LineChart } from '../../components/ui/charts/LineChart';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import type { CashForecast } from '../../../server/or/cashForecast';

export default function CashForecastTab() {
  const { t } = useI18n();
  const [data, setData] = useState<CashForecast | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const money = (value: number) => formatMoney(value, { code: 'USD', symbol: '$' });
  const load = async () => {
    setLoading(true);
    setError(false);
    try { setData(await api.get<CashForecast>('/api/or/cash-forecast')); }
    catch { setError(true); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-2">{t('cf_assumptions')}</p>
        <Button
          onClick={() => void load()}
          disabled={loading}
        >{t('cf_refresh')}</Button>
      </div>
      {error && <p role="alert">{t('cf_error')}</p>}
      {loading && <p role="status">{t('cf_loading')}</p>}
      {data && <>
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="p-5 space-y-2">
            <h3>{t('cf_lowest')}</h3>
            <p className="font-semibold">{data.lowest.date}: {money(data.lowest.closing)}</p>
          </Card>
          <Card className="p-5 space-y-2">
            <h3>{t('cf_shortfall')}</h3>
            <p className="font-semibold">{data.first_shortfall ? `${data.first_shortfall.date}: ${money(data.first_shortfall.closing)}` : t('cf_none')}</p>
          </Card>
        </div>
        <Card className="p-5">
          <h3>{t('cf_title')}</h3>
          <LineChart
            labels={data.days.map(d => d.date)}
            series={[
              { name: t('cf_closing'), data: data.days.map(d => d.closing) },
              { name: t('cf_float'), data: data.days.map(() => data.min_float_usd), reference: true, color: 'var(--color-danger)' },
            ]}
            valueFormatter={money}
          />
        </Card>
        <Card className="p-5 space-y-3">
          <h3>{t('cf_drivers')}</h3>
          <DataTable
            data={data.biggest_outflows}
            rowKey={row => `${row.date}-${row.kind}-${row.name}-${data.biggest_outflows.indexOf(row)}`}
            columns={[
              { key: 'date', header: t('cf_date') },
              { key: 'kind', header: t('cf_kind'), render: row => t(`cf_${row.kind}`) },
              { key: 'name', header: t('cf_name'), render: row => row.kind === 'draw' ? t('cf_draw') : row.name },
              { key: 'amount_usd', header: t('cf_amount'), render: row => money(row.amount_usd) },
            ]}
          />
        </Card>
        <Card className="p-5 space-y-3">
          <h3>{t('cf_daily')}</h3>
          <DataTable
            data={data.days}
            rowKey={row => row.date}
            columns={[
              { key: 'date', header: t('cf_date') },
              ...(['opening', 'inflows', 'outflows', 'closing'] as const).map(key => ({ key, header: t(`cf_${key}`), render: (row: CashForecast['days'][number]) => money(row[key]) })),
            ]}
          />
        </Card>
      </>}
    </div>
  );
}
