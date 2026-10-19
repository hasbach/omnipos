// Product editor -> "Online store" tab (specs 001 Slice A + 002 US5): publish this product in the store, add
// up to 4 photos and edit its online title, description, category and order. Price, units and
// stock always come from the product itself, so there is nothing to keep in sync here.
import React, { useEffect, useState } from 'react';
import { Badge, Button, Checkbox, Field, Input, NumberInput, Switch, Textarea, useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { commerceApi, type CommerceStatus, type ListingView } from '../../lib/commerceApi';
import { translateServerError } from '../../lib/serverErrors';
import { usePermissions } from '../../lib/usePermissions';
import { ListingPhotos } from './ListingPhotos';

const STOCK_VARIANT = { in_stock: 'success', low_stock: 'warning', out_of_stock: 'danger' } as const;

interface Draft {
  published: boolean; title: string; description: string; store_category: string; sort_order: number;
  /** 003: null = all units orderable; otherwise unit keys ("base" / unit global id). */
  unit_keys: string[] | null; min_quantity: number | '';
}

const toDraft = (l: ListingView | null): Draft => ({
  published: l?.published ?? false,
  title: l?.title ?? '',
  description: l?.description ?? '',
  store_category: l?.store_category ?? '',
  sort_order: l?.sort_order ?? 0,
  unit_keys: l?.orderable_unit_keys ?? null,
  min_quantity: l?.min_quantity ?? '',
});

export function OnlineStoreCard({ productId, productName, productCategory }: { productId: number; productName: string; productCategory: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const { can } = usePermissions();
  const canPublish = can('store.publish');

  const [status, setStatus] = useState<CommerceStatus | null>(null);
  const [listing, setListing] = useState<ListingView | null>(null);
  const [draft, setDraft] = useState<Draft>(toDraft(null));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const st = await commerceApi.status();
        if (!alive) return;
        setStatus(st);
        if (st.store) {
          const ls = await commerceApi.productListings(productId);
          if (!alive) return;
          const l = ls.find((x) => x.store_id === st.store!.id) || null;
          setListing(l);
          setDraft(toDraft(l));
        }
      } catch (err: any) {
        toast.error(translateServerError(err, t) || err?.message || String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [productId]);

  if (loading) return <p className="text-sm text-text-3">{t('commerce_loading')}</p>;
  if (!status?.enabled) return <p className="text-sm text-text-3">{t('commerce_product_off')}</p>;
  if (!status.store) return <p className="text-sm text-text-3">{t('commerce_product_no_store')}</p>;

  const editable = canPublish && !saving;
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    setSaving(true);
    setErrors({});
    try {
      const l = await commerceApi.upsertListing(status.store!.id, productId, {
        published: draft.published,
        title: draft.title,
        description: draft.description,
        store_category: draft.store_category,
        sort_order: Math.trunc(draft.sort_order || 0),
        orderable_unit_keys: draft.unit_keys,
        min_quantity: draft.min_quantity === '' || draft.min_quantity === 0 ? null : draft.min_quantity,
      });
      setListing(l);
      setDraft(toDraft(l));
      toast.success(t('commerce_listing_saved'));
    } catch (err: any) {
      const msg = translateServerError(err, t) || err?.message || String(err);
      if (err?.field) setErrors({ [err.field]: msg });
      else toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text">{status.store.name}</span>
        {listing ? (
          <>
            <Badge variant={listing.visible ? 'success' : 'neutral'}>
              {listing.visible ? t('commerce_listing_visible') : t(`commerce_reason_${listing.unavailable_reason}`)}
            </Badge>
            <Badge variant={STOCK_VARIANT[listing.stock_state]}>{t(`commerce_stock_${listing.stock_state}`)}</Badge>
          </>
        ) : (
          <Badge variant="neutral">{t('commerce_listing_none')}</Badge>
        )}
      </div>

      <ListingPhotos status={status} productId={productId} listing={listing} editable={editable} onChange={(l) => setListing(l)} />

      <Switch checked={draft.published} disabled={!editable} onChange={(v) => set({ published: v })} label={t('commerce_listing_published')} />

      <Field label={t('commerce_listing_title')} helper={t('commerce_listing_title_helper')} error={errors.title}>
        <Input value={draft.title} placeholder={productName} onChange={(e) => set({ title: e.target.value })} maxLength={120} invalid={!!errors.title} disabled={!editable} />
      </Field>
      <Field label={t('commerce_listing_description')} error={errors.description}>
        <Textarea value={draft.description} onChange={(e) => set({ description: e.target.value })} maxLength={4000} rows={4} disabled={!editable} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('commerce_listing_category')} helper={t('commerce_listing_category_helper')} error={errors.store_category}>
          <Input value={draft.store_category} placeholder={productCategory} onChange={(e) => set({ store_category: e.target.value })} maxLength={60} disabled={!editable} />
        </Field>
        <Field label={t('commerce_listing_sort')} error={errors.sort_order}>
          <NumberInput value={draft.sort_order} onChange={(v) => set({ sort_order: v })} disabled={!editable} />
        </Field>
      </div>
      {listing && listing.unit_options.length > 1 && (
        <Field label={t('commerce_listing_units')} error={errors.orderable_unit_keys}>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-4">
              <label className="inline-flex items-center gap-2 text-sm"><input type="radio" checked={draft.unit_keys === null} disabled={!editable} onChange={() => set({ unit_keys: null })} /> {t('commerce_listing_units_all')}</label>
              <label className="inline-flex items-center gap-2 text-sm"><input type="radio" checked={draft.unit_keys !== null} disabled={!editable} onChange={() => set({ unit_keys: listing.unit_options.map((u) => u.key) })} /> {t('commerce_listing_units_pick')}</label>
            </div>
            {draft.unit_keys !== null && (
              <div className="flex flex-wrap gap-4 ps-6">
                {listing.unit_options.map((u) => (
                  <Checkbox
                    key={u.key}
                    checked={draft.unit_keys!.includes(u.key)}
                    disabled={!editable}
                    label={u.key === 'base' ? u.name : `${u.name} (${u.factor} × ${listing.unit})`}
                    onChange={(e) => set({ unit_keys: e.target.checked ? [...draft.unit_keys!, u.key] : draft.unit_keys!.filter((k) => k !== u.key) })}
                  />
                ))}
              </div>
            )}
          </div>
        </Field>
      )}
      <Field label={t('commerce_listing_min_qty').replace('{unit}', listing?.unit || 'pcs')} helper={t('commerce_listing_min_qty_helper')} error={errors.min_quantity} className="sm:max-w-xs">
        <NumberInput value={draft.min_quantity} min={0} step={1} onChange={(v) => set({ min_quantity: v })} disabled={!editable} />
      </Field>
      <p className="text-xs text-text-3">{t('commerce_listing_derived_note')}</p>
      {canPublish && (
        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>{t('commerce_listing_save')}</Button>
        </div>
      )}
    </div>
  );
}

export default OnlineStoreCard;
