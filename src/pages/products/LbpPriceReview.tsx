import React, { useCallback, useEffect, useState } from 'react';
import { Button, DataTable, Field, Modal, NumberInput, Select, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { useI18n } from '../../intl/index';
import { usePermissions } from '../../lib/usePermissions';

interface Review {
  local: { rate: number; code: string } | null;
  tolerance: number;
  parties: { id: number; name: string; local_rate: number }[];
  products: { id: number; name: string; price_lbp: number; proposed: Record<string, number>; [key: string]: any }[];
  shares: { lbp_sales_pct: number | null; usd_costs_pct: number | null };
}

export function LbpPriceReview({ refreshKey }: { refreshKey?: unknown }) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [party, setParty] = useState('');
  const [tolerance, setTolerance] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const allowed = can('products.edit');
  const load = useCallback(async () => {
    if (!allowed) return;
    try {
      const data = await api.get<Review>(`/api/local-rate/stale-prices${party ? `?stakeholder_id=${party}` : ''}`);
      setReview(data);
      setTolerance(data.tolerance);
      setError(false);
    } catch { setError(true); }
  }, [party, allowed]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => {
    const refresh = (event: Event) => {
      const id = (event as CustomEvent).detail;
      if (typeof id === 'number' && (id > 0 ? String(id) : '') !== party) { setParty(id > 0 ? String(id) : ''); return; }
      void load();
    };
    window.addEventListener('lbp-rate-changed', refresh);
    window.addEventListener('pos-sync', refresh);
    return () => {
      window.removeEventListener('lbp-rate-changed', refresh);
      window.removeEventListener('pos-sync', refresh);
    };
  }, [load]);
  if (!allowed) return null;

  const update = async (ids: number[] | 'all') => {
    setBusy(true);
    try {
      await api.post('/api/local-rate/update-prices', { product_ids: ids, stakeholder_id: party || undefined });
      toast.success(t('lbp_updated'));
      await load();
      window.dispatchEvent(new Event('lbp-rate-changed'));
    } catch { toast.error(t('lbp_error')); }
    finally { setBusy(false); }
  };
  const saveTolerance = async () => {
    setBusy(true);
    try {
      await api.post('/api/settings', { lbp_stale_tolerance_pct: String(tolerance) });
      await load();
    } catch { toast.error(t('lbp_error')); }
    finally { setBusy(false); }
  };
  const percent = (value: number | null) => value == null ? t('lbp_none') : `${value.toFixed(1)}%`;
  return (
    <div className="space-y-2 p-3">
      {review && review.products.length > 0 && <p role="status">{t('lbp_stale').replace('{count}', String(review.products.length))}</p>}
      {error && <p role="alert">{t('lbp_error')}</p>}
      <Button variant="secondary" onClick={() => { setOpen(true); void load(); }}>
        {t('lbp_review')}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('lbp_review')} size="xl">
        <div className="space-y-4">
          <Field label={t('lbp_scope')}>
            <Select
              value={party}
              onChange={(e) => setParty(e.target.value)}
              options={[
                { value: '', label: t('lbp_global') },
                ...(review?.parties || []).map(p => ({ value: String(p.id), label: `${p.name} (${p.local_rate})` })),
              ]}
            />
          </Field>
          <p>{review?.local ? t('lbp_rate').replace('{rate}', String(review.local.rate)).replace('{code}', review.local.code) : t('lbp_empty')}</p>
          <p>{t('lbp_warning')}</p>
          <p>{t('lbp_tiers')}</p>
          <p>{t('lbp_sales')}: {review && percent(review.shares.lbp_sales_pct)}</p>
          <p>{t('lbp_costs')}: {review && percent(review.shares.usd_costs_pct)}</p>
          {can('settings.manage') && <div className="flex items-end gap-3">
            <Field label={t('lbp_tolerance')}>
              <NumberInput value={tolerance} onChange={setTolerance} min={0} max={100} />
            </Field>
            <Button disabled={busy} onClick={saveTolerance}>{t('lbp_save')}</Button>
          </div>}
          <Button disabled={busy || !review?.products.length || error} onClick={() => update('all')}>
            {t('lbp_update')}
          </Button>
          <DataTable
            data={review?.products || []}
            rowKey={p => p.id}
            columns={[
              { key: 'name', header: t('lbp_product'), render: p => p.name },
              { key: 'current', header: t('lbp_before'), render: p => (
                <div>{Object.keys(p.proposed).map(key => <div key={key}>{t(`lbp_tier_${key}`)}: {Number(p[key]).toLocaleString()}</div>)}</div>
              ) },
              { key: 'proposed', header: t('lbp_after'), render: p => (
                <div>{Object.entries(p.proposed).map(([key, value]) => <div key={key}>{t(`lbp_tier_${key}`)}: {value.toLocaleString()}</div>)}</div>
              ) },
              { key: 'update', header: t('lbp_update'), render: p => (
                <Button disabled={busy || error} onClick={() => update([p.id])}>
                  {t('lbp_update')}
                </Button>
              ) },
            ]}
          />
          {review?.products.length === 0 && <p>{t('lbp_empty')}</p>}
        </div>
      </Modal>
    </div>
  );
}
