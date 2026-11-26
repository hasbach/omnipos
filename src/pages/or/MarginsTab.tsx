import React, { useEffect, useState } from 'react';
import { Button, Card } from '../../components/ui';
import { useI18n } from '../../intl';
import { api } from '../../lib/api';
import type { loadMarginAlerts } from '../../../server/or/marginAlerts';

type MarginRow = ReturnType<typeof loadMarginAlerts>[number];

export default function MarginsTab() {
  const { t } = useI18n();
  const [rows, setRows] = useState<MarginRow[]>([]);
  const [state, setState] = useState('loading');
  const load = async () => {
    setState('loading');
    try { setRows(await api.get<MarginRow[]>('/api/or/margins')); setState('ready'); }
    catch { setState('error'); }
  };
  useEffect(() => { void load(); }, []);
  return (
    <Card className="p-4 space-y-4">
      <Button
        variant="secondary"
        onClick={load}
        disabled={state === 'loading'}
      >{t('or_margin_refresh')}</Button>
      {state !== 'ready' ? <p role="status">{t(state === 'loading' ? 'or_margin_loading' : 'or_margin_error')}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-start">
            <thead><tr>{['product', 'cost', 'price', 'pct', 'suggested'].map(key => (
              <th key={key} className="p-2 text-start">{t(`or_margin_${key}`)}</th>
            ))}</tr></thead>
            <tbody>{rows.map(p => (
              <tr key={p.product_id} className="border-t border-border">
                <td className="p-2">{p.name}</td>
                <td className="p-2">{p.cost.toFixed(4)}</td>
                <td className="p-2">{p.price.toFixed(2)}{p.price_lbp != null && p.local_code && <div>{p.price_lbp.toLocaleString()} {p.local_code}</div>}</td>
                <td className="p-2">{p.margin.toFixed(1)}%{p.lbp_margin != null && <div>{p.lbp_margin.toFixed(1)}% {p.local_code}</div>}</td>
                <td className="p-2">{p.suggested_price.toFixed(2)}{p.suggested_price_lbp != null && <div>{p.suggested_price_lbp.toLocaleString()} {p.local_code}</div>}</td>
              </tr>
            ))}</tbody>
          </table>
          {rows.length === 0 && <p>{t('or_margin_empty')}</p>}
        </div>
      )}
    </Card>
  );
}
