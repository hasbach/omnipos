import React, { useEffect, useState } from 'react';
import { Badge, Button, Card, DataTable } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import type { loadCashierRisk } from '../../../server/or/cashierRiskData';

type Report = ReturnType<typeof loadCashierRisk>;
const metrics = ['voids', 'refunds', 'discounts', 'overrides', 'cash_difference'] as const;

export default function CashiersTab() {
  const { t } = useI18n();
  const [data, setData] = useState<Report | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const load = async () => {
    setState('loading');
    try { setData(await api.get<Report>('/api/or/cashier-risk')); setState('ready'); }
    catch { setState('error'); }
  };
  useEffect(() => { void load(); }, []);
  return (
    <div className="space-y-4">
      <p className="text-sm text-text-2">{t('cr_hint')}</p>
      <p className="text-xs text-text-3">{t('cr_limits')}</p>
      <Button
        onClick={() => void load()}
        disabled={state === 'loading'}
      >{t('cr_refresh')}</Button>
      {state === 'loading' && <p role="status">{t('cr_loading')}</p>}
      {state === 'error' && <p role="alert">{t('cr_error')}</p>}
      {data && <>
        <Card className="p-4 space-y-3">
          <h3>{t('cr_yesterday')} · {data.date}</h3>
          {data.cashiers.length === 0 && <p>{t('cr_empty')}</p>}
          <DataTable
            data={data.cashiers}
            rowKey={row => row.cashier}
            columns={[
              { key: 'name', header: t('cr_name') },
              { key: 'sales', header: t('cr_sales') },
              ...metrics.map(metric => ({ key: metric, header: t(`cr_${metric}`), render: (row: Report['cashiers'][number]) => (
                <span>{row[metric].toFixed(metric === 'cash_difference' ? 2 : 0)} {row.flags.some(f => f.metric === metric) && <Badge variant="warning">{t('cr_flag')}</Badge>}</span>
              ) })),
              { key: 'baseline_sales', header: t('cr_baseline') },
            ]}
          />
        </Card>
        <Card className="p-4 space-y-3">
          <h3>{t('cr_daily')}</h3>
          <DataTable
            data={data.daily}
            rowKey={row => `${row.cashier}:${row.date}`}
            columns={[
              { key: 'date', header: t('cr_date') },
              { key: 'name', header: t('cr_name') },
              { key: 'sales', header: t('cr_sales') },
              ...metrics.map(metric => ({ key: metric, header: t(`cr_${metric}`) })),
            ]}
          />
        </Card>
        <Card className="p-4 space-y-3">
          <h3>{t('cr_shifts')}</h3>
          <DataTable
            data={data.shifts}
            rowKey={row => row.shift}
            columns={[
              { key: 'closed_at', header: t('cr_date') },
              { key: 'name', header: t('cr_name') },
              { key: 'sales', header: t('cr_sales') },
              ...metrics.filter(m => m !== 'cash_difference').map(metric => ({ key: metric, header: t(`cr_${metric}`) })),
              { key: 'expected_cash', header: t('cr_expected') },
              { key: 'actual_cash', header: t('cr_counted') },
              { key: 'difference', header: t('cr_cash_difference') },
            ]}
          />
        </Card>
      </>}
    </div>
  );
}
