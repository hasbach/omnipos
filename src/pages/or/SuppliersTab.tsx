import React, { useEffect, useState } from 'react';
import { Button, Card } from '../../components/ui';
import { useI18n } from '../../intl';
import { api } from '../../lib/api';
import type { SupplierScorecard } from '../../../server/or/supplierScorecard';
import type { supplierComparisons } from '../../../server/or/supplierScorecard';

type Response = { suppliers: SupplierScorecard[]; comparisons: ReturnType<typeof supplierComparisons> };
// Totals in cents; per-piece purchase prices keep up to 4 decimals (cheap items cost fractions of a cent).
const total = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

export default function SuppliersTab({ supplierId }: { supplierId?: number }) {
  const { t } = useI18n();
  const [data, setData] = useState<Response | null>(null);
  const [selected, setSelected] = useState<number | null>(supplierId ?? null);
  const [state, setState] = useState('loading');
  const load = async () => {
    setState('loading');
    try {
      setData(await api.get<Response>(supplierId ? `/api/or/suppliers/${supplierId}/scorecard` : '/api/or/suppliers/scorecard'));
      setState('ready');
    } catch { setState('error'); }
  };
  useEffect(() => { setData(null); setSelected(supplierId ?? null); void load(); }, [supplierId]);
  const comparisons = new Map(data?.comparisons.map(c => [c.product_id, c]));
  const percent = (n: number | null) => n === null ? t('sc_unknown') : `${(n * 100).toFixed(0)}%`;
  return (
    <Card className="p-4 space-y-4">
      <h3 className="font-semibold">{t('sc_title')}</h3>
      <Button
        variant="secondary"
        onClick={load}
        disabled={state === 'loading'}
      >{t('sc_refresh')}</Button>
      {state !== 'ready' ? <p role="status">{t(state === 'error' ? 'sc_error' : 'sc_loading')}</p> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-start">
              <thead><tr>{['supplier', 'fill', 'terms', 'ontime', 'recent', 'total', 'owed'].map(key => (
                <th key={key} className="p-2 text-start">{t(`sc_${key}`)}</th>
              ))}</tr></thead>
              <tbody>{data?.suppliers.map(s => (
                <tr key={s.id} className="border-t border-border">
                  <td className="p-2"><Button
                    variant="secondary"
                    onClick={() => setSelected(selected === s.id ? null : s.id)}
                  >{s.name}</Button></td>
                  <td className="p-2">{percent(s.fill_rate_score)}</td>
                  <td className="p-2">{s.payment_terms_days === null ? t('sc_unknown') : `${s.payment_terms_days} ${t('sc_days')}`}</td>
                  <td className="p-2">{percent(s.on_time_rate)} ({s.delivery_count})</td>
                  <td className="p-2">{total(s.bought_90d_usd)}</td>
                  <td className="p-2">{total(s.bought_all_usd)}</td>
                  <td className="p-2">{total(s.owed_usd)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {data?.suppliers.length === 0 && <p>{t('sc_empty')}</p>}
          {data?.suppliers.filter(s => s.id === selected).map(s => (
            <div key={s.id} className="space-y-3">
              <h4 className="font-semibold">{s.name} · {t('sc_trend')}</h4>
              {s.products.length === 0 && <p>{t('sc_empty')}</p>}
              {s.products.map(p => {
                const comparison = comparisons.get(p.product_id);
                return (
                  <div key={p.product_id} className="border-t border-border py-2 space-y-1">
                    <p>{p.product_name}: {money(p.last_price)} <span aria-label={t(p.change === null || p.change === 0 ? 'sc_flat' : p.change > 0 ? 'sc_up' : 'sc_down')}>{p.change === null || p.change === 0 ? '→' : p.change > 0 ? '↑' : '↓'}</span></p>
                    <p>{t('sc_average')}: {p.average_90d === null ? t('sc_unknown') : money(p.average_90d)}</p>
                    {comparison && <p>{t('sc_cheapest')}: {comparison.cheapest_last.name} {money(comparison.cheapest_last.last_price)}; {t('sc_average')}: {comparison.cheapest_average_90d ? `${comparison.cheapest_average_90d.name} ${money(comparison.cheapest_average_90d.average_90d!)}` : t('sc_unknown')}</p>}
                    {!supplierId && <ul>{p.history.map((h, i) => <li key={i}>{h.date.slice(0, 10)}: {money(h.price)}</li>)}</ul>}
                  </div>
                );
              })}
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

export function SupplierDrawerScorecard({ supplierId }: { supplierId: number }) {
  const [licensed, setLicensed] = useState(false);
  useEffect(() => {
    api.get<{ licensed?: boolean }>('/api/or/status').then(s => setLicensed(!!s.licensed)).catch(() => setLicensed(false));
  }, []);
  return licensed ? <SuppliersTab supplierId={supplierId} /> : null;
}
