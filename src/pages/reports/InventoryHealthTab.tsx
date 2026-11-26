import React, { useEffect, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Select, Skeleton } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { usePermissions } from '../../lib/usePermissions';
import { formatMoney } from '../../lib/format';
import type { CurrencyLike } from '../../lib/format';
import { ProductEditorDrawer } from '../products/ProductEditorDrawer';
import type { Product } from '../../types';
import type { InventoryHealthReport } from '../../../server/reports/inventoryHealth';

const usd = (value: number) => formatMoney(value, { code: 'USD', symbol: '$' });

export function InventoryHealthTab({ localCurrency }: { localCurrency: CurrencyLike | null }) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [report, setReport] = useState<InventoryHealthReport | null>(null);
  const [error, setError] = useState(false);
  const [days, setDays] = useState('60');
  const [products, setProducts] = useState<Product[]>([]);
  const [editing, setEditing] = useState<Product | null>(null);
  const [queued, setQueued] = useState<number[]>([]);
  const [pending, setPending] = useState<number[]>([]);
  const load = () => api.get<InventoryHealthReport>('/api/reports/inventory-health').then(setReport).catch(() => setError(true));

  useEffect(() => { void load(); }, []);

  const edit = async (id: number) => {
    try {
      const rows = await api.get<Product[]>('/api/products');
      setProducts(rows);
      const product = rows.find(p => p.id === id);
      if (product) setEditing(product);
      else setError(true);
    } catch { setError(true); }
  };
  const count = async (id: number) => {
    setPending(rows => [...rows, id]);
    try {
      await api.post('/api/or/anomalies', { product_id: id, anomaly_type: 'NEGATIVE_STOCK_SALE' });
      setQueued(rows => [...rows, id]);
    } catch { setError(true); }
    finally { setPending(rows => rows.filter(row => row !== id)); }
  };

  if (!report) return error
    ? <p role="alert">{t('ih_error')}</p>
    : <Skeleton className="h-48" />;
  const dead = report.deadStock.find(row => row.days === Number(days))!;
  const label = (value: string | null) => value || t('ih_unknown');

  return (
    <div className="space-y-4">
      {error && <p role="alert">{t('ih_error')}</p>}
      <p className="text-sm text-text-2">{t('ih_basis')}</p>
      <Card>
        <CardHeader><h3 className="font-semibold">{t('ih_total')}</h3></CardHeader>
        <CardBody><p className="text-2xl num">{usd(report.totalValue)}</p></CardBody>
      </Card>
      <Card>
        <CardHeader><h3 className="font-semibold">{t('ih_categories')}</h3></CardHeader>
        <CardBody>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-start">
              <thead><tr>
                <th>{t('ih_category')}</th><th>{t('ih_value')}</th><th>{t('ih_cogs')}</th>
                <th>{t('ih_margin')}</th><th>{t('ih_turns')}</th><th>{t('ih_gmroi')}</th>
              </tr></thead>
              <tbody>{report.categories.map(row => (
                <tr key={row.category}>
                  <td>{label(row.category)}</td><td>{usd(row.value)}</td><td>{usd(row.cogs)}</td>
                  <td>{usd(row.grossMargin)}</td>
                  <td>{row.turns?.toFixed(2) ?? t('ih_na')}</td>
                  <td>{row.gmroi?.toFixed(2) ?? t('ih_na')}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader><h3 className="font-semibold">{t('ih_suppliers')}</h3></CardHeader>
        <CardBody>
          {report.suppliers.map(row => (
            <div key={String(row.supplierId)} className="flex justify-between gap-4">
              <span>{label(row.supplier)}</span><span>{usd(row.value)}</span>
            </div>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader><h3 className="font-semibold">{t('ih_dead')}</h3></CardHeader>
        <CardBody>
          <Select
            value={days}
            onChange={e => setDays(e.target.value)}
            aria-label={t('ih_dead')}
            options={[{ value: '60', label: t('ih_60') }, { value: '90', label: t('ih_90') }]}
          />
          <p className="my-3 num">{usd(dead.value)}</p>
          {dead.items.length === 0 && <p>{t('ih_empty')}</p>}
          {dead.items.map(row => (
            <div key={row.id} className="flex items-center justify-between gap-4 py-2 border-b border-border">
              <span>{row.name} · {row.stock} · {usd(row.value)}</span>
              {can('products.edit') && <Button
                variant="secondary"
                onClick={() => void edit(row.id)}
              >
                {t('ih_discount')}
              </Button>}
            </div>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader><h3 className="font-semibold">{t('ih_negatives')}</h3></CardHeader>
        <CardBody>
          <p className="text-sm text-text-2">{t('ih_causes')}</p>
          {report.negatives.map(group => (
            <div key={group.cause} className="mt-4">
              <h4 className="font-semibold">{t(`ih_${group.cause}`)}</h4>
              {group.items.length === 0 && <p>{t('ih_empty')}</p>}
              {group.items.map(row => (
                <div key={row.id} className="flex items-center justify-between gap-4 py-2">
                  <span>{row.name} · {row.stock}</span>
                  <Button
                    variant="secondary"
                    disabled={queued.includes(row.id) || pending.includes(row.id)}
                    onClick={() => void count(row.id)}
                  >
                    {t(queued.includes(row.id) ? 'ih_queued' : 'ih_count')}
                  </Button>
                </div>
              ))}
            </div>
          ))}
        </CardBody>
      </Card>
      <ProductEditorDrawer
        open={editing !== null}
        product={editing}
        products={products}
        categories={[...new Set(products.map(p => p.category).filter(Boolean))] as string[]}
        localCurrency={localCurrency ? { ...localCurrency, rate: localCurrency.rate ?? 1 } : null}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void load(); }}
      />
    </div>
  );
}
