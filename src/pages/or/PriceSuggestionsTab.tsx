import React, { useEffect, useState } from 'react';
import { Button, Card } from '../../components/ui';
import { useI18n } from '../../intl';
import { api } from '../../lib/api';
import { usePermissions } from '../../lib/usePermissions';
import { ProductEditorDrawer } from '../products/ProductEditorDrawer';
import type { Product } from '../../types';
import type { loadPriceSuggestions } from '../../../server/or/priceSuggestionsData';

type Report = ReturnType<typeof loadPriceSuggestions>;
export default function PriceSuggestionsTab({ products, onSaved }: { products: Product[]; onSaved: () => void }) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [data, setData] = useState<Report | null>(null);
  const [state, setState] = useState('loading');
  const [editing, setEditing] = useState<Product | null>(null);
  const load = async () => {
    setState('loading');
    try { setData(await api.get<Report>('/api/or/price-suggestions')); setState('ready'); }
    catch { setState('error'); }
  };
  useEffect(() => { void load(); }, []);
  const productsById = new Map(products.map(product => [product.id, product]));
  const money = (v: number) => `$${v.toFixed(2)}`;
  return (
    <Card className="p-4 space-y-4">
      <p className="text-sm text-text-3">{t('ps_hint')}</p>
      <Button
        variant="secondary"
        onClick={load}
        disabled={state === 'loading'}
      >{t('ps_refresh')}</Button>
      {state !== 'ready' && <p role="status">{t(state === 'error' ? 'ps_error' : 'ps_loading')}</p>}
      {state === 'ready' && <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr>{['product', 'current', 'suggested', 'change', 'confidence', 'action'].map(key => (
            <th
              key={key}
              className="p-2 text-start"
            >{t(`ps_${key}`)}</th>
          ))}</tr></thead>
          <tbody>{data?.products.map(p => (
            <tr
              key={p.id}
              className="border-t border-border"
            >
              <td className="p-2">{p.name}</td>
              <td className="p-2">
                <div>{t('ps_price')}: {money(p.price)}</div>
                <div>{t('ps_cost')}: {money(p.cost)}</div>
                <div>{t('ps_margin')}: {p.margin.toFixed(1)}% / {t('ps_target')}: {p.target_pct}%</div>
              </td>
              <td className="p-2">{p.candidate ? <>
                <div>{money(p.candidate.suggested_price)}</div>
                {p.suggested_price_lbp != null && <div>{p.suggested_price_lbp.toLocaleString()} {data.localCurrency?.code}</div>}
              </> : t('ps_infeasible')}</td>
              <td className="p-2">{p.candidate && <>
                <div>{t('ps_profit')}: {money(p.candidate.profit_change)}</div>
                <div>{t('ps_units')}: {p.candidate.units_change.toFixed(2)} ({p.candidate.volume_change_pct.toFixed(1)}%)</div>
                <div>{t('ps_baseline')}: {p.current_units.toFixed(2)}</div>
              </>}</td>
              <td className="p-2">
                <div>{t(`ps_${p.confidence}`)}</div>
                <div>{t(`ps_${p.source}`)}</div>
                {p.fit && <div>{t('ps_elasticity')}: {p.fit.elasticity.toFixed(2)}; {t('ps_se')}: {p.fit.standard_error.toFixed(2)}; {t('ps_r2')}: {p.fit.r_squared.toFixed(2)}</div>}
              </td>
              <td className="p-2"><Button
                size="sm"
                variant="secondary"
                disabled={!can('products.edit') || !productsById.has(p.id)}
                onClick={() => setEditing(productsById.get(p.id) ?? null)}
              >{t('ps_open')}</Button></td>
            </tr>
          ))}</tbody>
        </table>
        {data?.products.length === 0 && <p>{t('ps_empty')}</p>}
      </div>}
      <ProductEditorDrawer
        open={editing !== null}
        product={editing}
        products={products}
        categories={[...new Set(products.map(p => p.category).filter(Boolean))]}
        localCurrency={data?.localCurrency ?? null}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); onSaved(); void load(); }}
      />
    </Card>
  );
}
