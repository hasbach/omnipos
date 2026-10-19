// Settings -> Online store (specs/001-commerce-domain-foundation, Slice A): turn commerce on, create
// the store, claim its web address, open / pause it, edit its details and display settings.
// The public storefront itself is a later feature; this is the back office for it.
import React, { useEffect, useState } from 'react';
import { Copy, Eye, ExternalLink, Globe, ImagePlus, ShoppingCart, Store as StoreIcon, Trash2 } from 'lucide-react';
import {
  Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, Input, MoneyInput, Select, Switch, Textarea, useConfirm, useToast,
} from '../../components/ui';
import { useI18n } from '../../intl/index';
import { commerceApi, photoUrl, type CommerceStatus, type Store, type StoreInput, type StoreSettings } from '../../lib/commerceApi';
import { ImageError, PHOTO_ACCEPT, resizeToWebp } from '../../lib/imageResize';
import { translateServerError } from '../../lib/serverErrors';
import { usePermissions } from '../../lib/usePermissions';

const STATUS_VARIANT = { draft: 'neutral', active: 'success', paused: 'warning' } as const;

type Details = Required<Pick<StoreInput, 'name' | 'mode' | 'description' | 'contact_phone' | 'contact_whatsapp' | 'contact_email' | 'address' | 'primary_color' | 'default_language'>>;

type Ordering = Pick<StoreSettings, 'ordering_mode' | 'pickup_note' | 'delivery_note'> & { pickup_enabled: boolean; delivery_enabled: boolean; min_order_usd: number | '' };

function orderingOf(s: Store): Ordering {
  const st = s.settings;
  return {
    ordering_mode: st.ordering_mode || 'off', pickup_enabled: st.pickup_enabled !== 0, pickup_note: st.pickup_note || '',
    delivery_enabled: st.delivery_enabled === 1, delivery_note: st.delivery_note || '', min_order_usd: st.min_order_usd ?? '',
  };
}

function detailsOf(s: Store): Details {
  return {
    name: s.name, mode: s.mode, description: s.description || '', contact_phone: s.contact_phone || '', contact_whatsapp: s.contact_whatsapp || '',
    contact_email: s.contact_email || '', address: s.address || '', primary_color: s.primary_color || '', default_language: s.default_language,
  };
}

export function OnlineStoreSection() {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const { can } = usePermissions();
  const canManage = can('store.manage');

  const [status, setStatus] = useState<CommerceStatus | null>(null);
  const [store, setStore] = useState<Store | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [newName, setNewName] = useState('');
  const [newMode, setNewMode] = useState<Store['mode']>('retail');
  const [slug, setSlug] = useState('');
  const [details, setDetails] = useState<Details | null>(null);
  const [ordering, setOrdering] = useState<Ordering | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = async () => {
    try {
      const [st, stores] = await Promise.all([commerceApi.status(), commerceApi.stores()]);
      setStatus(st);
      const s = stores[0] || null;
      setStore(s);
      if (s) { setDetails(detailsOf(s)); setOrdering(orderingOf(s)); setSlug(s.slug || ''); }
    } catch (err: any) {
      toast.error(translateServerError(err, t) || err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const showError = (err: any) => {
    const msg = translateServerError(err, t) || err?.message || String(err);
    if (err?.field) setErrors((e) => ({ ...e, [err.field]: msg }));
    else toast.error(msg);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErrors({});
    try {
      await fn();
      setStatus(await commerceApi.status()); // keeps the "visible to customers" badge current
    } catch (err: any) { showError(err); } finally { setBusy(false); }
  };

  const applyStore = (s: Store) => { setStore(s); setDetails(detailsOf(s)); setOrdering(orderingOf(s)); setSlug(s.slug || ''); };

  const toggleCommerce = async (enabled: boolean) => {
    const ok = await confirm({
      title: enabled ? t('commerce_enable_confirm_title') : t('commerce_disable_confirm_title'),
      description: enabled ? t('commerce_enable_confirm_desc') : t('commerce_disable_confirm_desc'),
      confirmLabel: enabled ? t('commerce_enable') : t('commerce_disable'),
      variant: enabled ? 'primary' : 'danger',
    });
    if (!ok) return;
    await run(async () => {
      setStatus(await commerceApi.setEnabled(enabled));
      toast.success(enabled ? t('commerce_enabled_toast') : t('commerce_disabled_toast'));
    });
  };

  const createStore = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      applyStore(await commerceApi.createStore({ name: newName, mode: newMode }));
      toast.success(t('commerce_store_created'));
      setStatus(await commerceApi.status());
    });
  };

  const claim = () => run(async () => {
    if (!store) return;
    applyStore(await commerceApi.claimSlug(store.id, slug));
    toast.success(t('commerce_slug_saved'));
  });

  const changeStatus = (next: 'active' | 'paused') => run(async () => {
    if (!store) return;
    applyStore(await commerceApi.setStatus(store.id, next));
    toast.success(next === 'active' ? t('commerce_store_opened') : t('commerce_store_paused'));
  });

  const saveDetails = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (!store || !details) return;
      applyStore(await commerceApi.updateStore(store.id, details));
      toast.success(t('commerce_store_saved'));
    });
  };

  const saveSetting = (key: keyof StoreSettings, value: boolean) => run(async () => {
    if (!store) return;
    applyStore(await commerceApi.updateStore(store.id, { settings: { [key]: value ? 1 : 0 } as Partial<StoreSettings> }));
  });

  const saveOrdering = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (!store || !ordering) return;
      applyStore(await commerceApi.updateStore(store.id, {
        settings: {
          ordering_mode: ordering.ordering_mode, pickup_enabled: ordering.pickup_enabled ? 1 : 0, pickup_note: ordering.pickup_note,
          delivery_enabled: ordering.delivery_enabled ? 1 : 0, delivery_note: ordering.delivery_note,
          min_order_usd: ordering.min_order_usd === '' || ordering.min_order_usd === 0 ? null : ordering.min_order_usd,
        },
      }));
      toast.success(t('commerce_ordering_saved'));
    });
  };

  const copyAddress = async () => {
    if (!store?.public_url) return;
    try {
      await navigator.clipboard.writeText(store.public_url);
      toast.success(t('commerce_address_copied'));
    } catch {
      toast.error(t('commerce_address_copy_failed'));
    }
  };

  const openStore = () => { if (store?.public_url) window.open(store.public_url, '_blank', 'noopener'); };

  const preview = () => run(async () => {
    if (!store) return;
    const { url } = await commerceApi.previewLink(store.id);
    window.open(url, '_blank', 'noopener');
  });

  const uploadBranding = async (kind: 'logo' | 'cover', file: File | undefined) => {
    if (!store || !file) return;
    await run(async () => {
      try {
        applyStore(await commerceApi.setBranding(store.id, kind, await resizeToWebp(file)));
      } catch (e: any) {
        if (e instanceof ImageError) { toast.error(t(`commerce_photo_err_${e.code.toLowerCase()}`)); return; }
        throw e;
      }
    });
  };

  const removeBranding = (kind: 'logo' | 'cover') => run(async () => {
    if (!store) return;
    applyStore(await commerceApi.clearBranding(store.id, kind));
  });

  const removeStore = async () => {
    if (!store) return;
    const ok = await confirm({
      title: t('commerce_delete_confirm_title'),
      description: t('commerce_delete_confirm_desc'),
      confirmText: store.name,
      confirmLabel: t('commerce_delete_store'),
      variant: 'danger',
    });
    if (!ok) return;
    await run(async () => {
      await commerceApi.deleteStore(store.id);
      setStore(null);
      setDetails(null);
      setSlug('');
      toast.success(t('commerce_store_deleted'));
    });
  };

  if (loading) return <Card><CardBody><p className="text-sm text-text-3">{t('commerce_loading')}</p></CardBody></Card>;
  if (!status) return <Card><EmptyState title={t('perm_no_access_title', 'No access')} description={t('commerce_no_access')} /></Card>;

  const enabled = status.enabled;
  const editable = canManage && enabled && !busy;
  const set = (patch: Partial<Details>) => setDetails((d) => (d ? { ...d, ...patch } : d));
  const setOrder = (patch: Partial<Ordering>) => setOrdering((o) => (o ? { ...o, ...patch } : o));
  const err = (f: string) => errors[f];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 text-text-2">
            <Globe size={18} />
            <h3 className="text-sm font-semibold">{t('commerce_title')}</h3>
          </div>
        </CardHeader>
        <CardBody>
          <p className="mb-4 text-sm text-text-3">{t('commerce_subtitle')}</p>
          <Switch
            checked={enabled}
            disabled={!canManage || busy}
            onChange={toggleCommerce}
            label={enabled ? t('commerce_status_on') : t('commerce_status_off')}
          />
          {!canManage && <p className="mt-3 text-xs text-text-3">{t('commerce_manage_only')}</p>}
          {enabled && !status.online_license_valid && (
            <p className="mt-3 rounded-[var(--radius-input)] bg-accent-soft px-3 py-2 text-sm text-accent">{t('commerce_license_inactive')}</p>
          )}
        </CardBody>
      </Card>

      {enabled && !store && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2 text-text-2">
              <StoreIcon size={18} />
              <h3 className="text-sm font-semibold">{t('commerce_create_title')}</h3>
            </div>
          </CardHeader>
          <CardBody>
            {canManage ? (
              <form onSubmit={createStore} className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
                <Field label={t('commerce_store_name')} error={err('name')}>
                  <Input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} invalid={!!err('name')} />
                </Field>
                <Field label={t('commerce_store_mode')} error={err('mode')}>
                  <Select value={newMode} onChange={(e) => setNewMode(e.target.value as Store['mode'])} options={[
                    { value: 'retail', label: t('commerce_mode_retail') },
                    { value: 'wholesale', label: t('commerce_mode_wholesale') },
                    { value: 'hybrid', label: t('commerce_mode_hybrid') },
                  ]} />
                </Field>
                <Button type="submit" disabled={busy || !newName.trim()}>{t('commerce_create_store')}</Button>
              </form>
            ) : (
              <p className="text-sm text-text-3">{t('commerce_no_store_yet')}</p>
            )}
          </CardBody>
        </Card>
      )}

      {store && details && (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-text-2">
                  <StoreIcon size={18} />
                  <h3 className="text-sm font-semibold">{store.name}</h3>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={STATUS_VARIANT[store.status]}>{t(`commerce_status_${store.status}`)}</Badge>
                  {status.store && (status.store.publicly_visible
                    ? <Badge variant="success">{t('commerce_public_yes')}</Badge>
                    : <Badge variant="warning">{t(`commerce_not_public_${status.store.not_public_reason}`)}</Badge>)}
                </div>
              </div>
            </CardHeader>
            <CardBody>
              <div className="flex flex-col gap-4">
                <Field label={t('commerce_slug')} helper={t('commerce_slug_helper')} error={err('slug')}>
                  <div className="flex gap-2">
                    <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} maxLength={40} dir="ltr" placeholder="abc-market" invalid={!!err('slug')} disabled={!editable} />
                    <Button variant="secondary" className="shrink-0 whitespace-nowrap" onClick={claim} disabled={!editable || !slug.trim() || slug === store.slug}>{t('commerce_slug_claim')}</Button>
                  </div>
                </Field>
                {store.public_url && (
                  <div className="flex flex-col gap-2 rounded-[var(--radius-input)] border border-border bg-surface-2 p-3">
                    <span className="text-xs font-medium text-text-3">{t('commerce_slug_current')}</span>
                    <code dir="ltr" className="break-all text-sm text-text">{store.public_url}</code>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" onClick={copyAddress}><Copy size={14} /> {t('commerce_copy_address')}</Button>
                      <Button size="sm" variant="secondary" onClick={openStore} disabled={!status.store?.publicly_visible}><ExternalLink size={14} /> {t('commerce_open_public')}</Button>
                      {!status.store?.publicly_visible && (
                        <Button size="sm" variant="secondary" onClick={preview} disabled={busy}><Eye size={14} /> {t('commerce_preview')}</Button>
                      )}
                    </div>
                    {!status.store?.publicly_visible && <span className="text-xs text-text-3">{t('commerce_preview_helper')}</span>}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {store.status !== 'active' && store.mode !== 'wholesale' && (
                    <Button onClick={() => changeStatus('active')} disabled={!editable || !store.slug}>{store.status === 'paused' ? t('commerce_resume_store') : t('commerce_open_store')}</Button>
                  )}
                  {store.status === 'active' && (
                    <Button variant="secondary" onClick={() => changeStatus('paused')} disabled={!editable}>{t('commerce_pause_store')}</Button>
                  )}
                  {!store.slug && store.mode !== 'wholesale' && <span className="text-xs text-text-3">{t('commerce_open_needs_slug')}</span>}
                </div>
                {store.mode === 'wholesale' && (
                  <p className="rounded-[var(--radius-input)] bg-surface-2 px-3 py-2 text-sm text-text-2">{t('commerce_wholesale_note')}</p>
                )}
                {(err('status') || err('mode')) && <p className="text-sm text-danger">{err('status') || err('mode')}</p>}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader><h3 className="text-sm font-semibold text-text-2">{t('commerce_branding_title')}</h3></CardHeader>
            <CardBody>
              <div className="grid gap-4 sm:grid-cols-2">
                {(['logo', 'cover'] as const).map((kind) => {
                  const path = kind === 'logo' ? store.logo_path : store.cover_path;
                  return (
                    <div key={kind} className="flex flex-col gap-2">
                      <span className="text-sm font-medium text-text">{t(`commerce_${kind}`)}</span>
                      <div className={`flex items-center justify-center overflow-hidden rounded-[var(--radius-input)] border border-border bg-surface-2 ${kind === 'logo' ? 'h-24 w-24' : 'aspect-[3/1] w-full'}`}>
                        {path ? <img src={photoUrl(status, path)} alt="" className="h-full w-full object-cover" /> : <ImagePlus size={22} className="text-text-3" />}
                      </div>
                      {editable && (
                        <div className="flex flex-wrap gap-2">
                          <label className={`inline-flex cursor-pointer items-center gap-1 rounded-[var(--radius-input)] border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text-2 hover:bg-surface-2 ${busy ? 'pointer-events-none opacity-50' : ''}`}>
                            <ImagePlus size={14} /> {path ? t('commerce_replace_image') : t('commerce_upload_image')}
                            <input type="file" accept={PHOTO_ACCEPT} hidden onChange={(e) => { uploadBranding(kind, e.target.files?.[0]); e.target.value = ''; }} />
                          </label>
                          {path && <Button size="sm" variant="secondary" onClick={() => removeBranding(kind)} disabled={busy}><Trash2 size={14} /> {t('commerce_remove_image')}</Button>}
                        </div>
                      )}
                      <span className="text-xs text-text-3">{t(`commerce_${kind}_helper`)}</span>
                    </div>
                  );
                })}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader><h3 className="text-sm font-semibold text-text-2">{t('commerce_details_title')}</h3></CardHeader>
            <CardBody>
              <form onSubmit={saveDetails} className="grid gap-3 sm:grid-cols-2">
                <Field label={t('commerce_store_name')} error={err('name')}>
                  <Input value={details.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} invalid={!!err('name')} disabled={!editable} />
                </Field>
                <Field label={t('commerce_store_mode')} helper={t('commerce_mode_helper')} error={err('mode')}>
                  <Select value={details.mode} onChange={(e) => set({ mode: e.target.value as Store['mode'] })} disabled={!editable} options={[
                    { value: 'retail', label: t('commerce_mode_retail') },
                    { value: 'wholesale', label: t('commerce_mode_wholesale') },
                    { value: 'hybrid', label: t('commerce_mode_hybrid') },
                  ]} />
                </Field>
                <Field label={t('commerce_description')} error={err('description')} className="sm:col-span-2">
                  <Textarea value={details.description} onChange={(e) => set({ description: e.target.value })} maxLength={1000} rows={3} disabled={!editable} />
                </Field>
                <Field label={t('commerce_contact_phone')} error={err('contact_phone')}>
                  <Input value={details.contact_phone} onChange={(e) => set({ contact_phone: e.target.value })} maxLength={30} dir="ltr" disabled={!editable} />
                </Field>
                <Field label={t('commerce_contact_whatsapp')} helper={t('commerce_whatsapp_hint')} error={err('contact_whatsapp')}>
                  <Input value={details.contact_whatsapp} onChange={(e) => set({ contact_whatsapp: e.target.value })} maxLength={30} dir="ltr" placeholder="+961 70 123 456" invalid={!!err('contact_whatsapp')} disabled={!editable} />
                </Field>
                <Field label={t('commerce_contact_email')} error={err('contact_email')}>
                  <Input type="email" value={details.contact_email} onChange={(e) => set({ contact_email: e.target.value })} maxLength={120} dir="ltr" invalid={!!err('contact_email')} disabled={!editable} />
                </Field>
                <Field label={t('commerce_default_language')} error={err('default_language')}>
                  <Select value={details.default_language} onChange={(e) => set({ default_language: e.target.value as Details['default_language'] })} disabled={!editable} options={[
                    { value: 'en', label: 'English' }, { value: 'ar', label: 'العربية' }, { value: 'fr', label: 'Français' },
                  ]} />
                </Field>
                <Field label={t('commerce_address')} error={err('address')} className="sm:col-span-2">
                  <Input value={details.address} onChange={(e) => set({ address: e.target.value })} maxLength={300} disabled={!editable} />
                </Field>
                <Field label={t('commerce_primary_color')} helper="#1a2b3c" error={err('primary_color')}>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label={t('commerce_primary_color')}
                      value={/^#[0-9a-f]{6}$/i.test(details.primary_color) ? details.primary_color : '#0f766e'}
                      onChange={(e) => set({ primary_color: e.target.value })}
                      disabled={!editable}
                      className="h-9 w-12 cursor-pointer rounded-[var(--radius-input)] border border-border bg-surface"
                    />
                    <Input value={details.primary_color} onChange={(e) => set({ primary_color: e.target.value })} maxLength={7} dir="ltr" invalid={!!err('primary_color')} disabled={!editable} />
                  </div>
                </Field>
                <div className="flex items-end justify-end sm:col-span-2">
                  <Button type="submit" disabled={!editable}>{t('commerce_save')}</Button>
                </div>
              </form>
            </CardBody>
          </Card>

          {ordering && (
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2 text-text-2">
                  <ShoppingCart size={18} />
                  <h3 className="text-sm font-semibold">{t('commerce_ordering_title')}</h3>
                </div>
              </CardHeader>
              <CardBody>
                <form onSubmit={saveOrdering} className="flex flex-col gap-4">
                  <p className="text-sm text-text-3">{t('commerce_ordering_subtitle')}</p>
                  <Field label={t('commerce_ordering_mode')} error={err('settings.ordering_mode')}>
                    <Select value={ordering.ordering_mode} disabled={!editable} onChange={(e) => setOrder({ ordering_mode: e.target.value as Ordering['ordering_mode'] })} options={[
                      { value: 'off', label: t('commerce_ordering_off') },
                      { value: 'whatsapp', label: t('commerce_ordering_whatsapp') },
                      { value: 'online', label: t('commerce_ordering_online'), disabled: true },
                    ]} />
                  </Field>
                  {ordering.ordering_mode === 'whatsapp' && !store.contact_whatsapp && (
                    <p className="rounded-[var(--radius-input)] bg-accent-soft px-3 py-2 text-sm text-accent">{t('commerce_ordering_needs_whatsapp')}</p>
                  )}
                  {err('contact_whatsapp') && <p className="text-sm text-danger">{err('contact_whatsapp')}</p>}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="flex flex-col gap-2">
                      <Switch checked={ordering.pickup_enabled} disabled={!editable} onChange={(v) => setOrder({ pickup_enabled: v })} label={t('commerce_ordering_pickup')} />
                      <Field label={t('commerce_ordering_pickup_note')} error={err('settings.pickup_note')}>
                        <Input value={ordering.pickup_note} maxLength={200} disabled={!editable || !ordering.pickup_enabled} onChange={(e) => setOrder({ pickup_note: e.target.value })} />
                      </Field>
                    </div>
                    <div className="flex flex-col gap-2">
                      <Switch checked={ordering.delivery_enabled} disabled={!editable} onChange={(v) => setOrder({ delivery_enabled: v })} label={t('commerce_ordering_delivery')} />
                      <Field label={t('commerce_ordering_delivery_note')} helper={t('commerce_ordering_delivery_helper')} error={err('settings.delivery_note')}>
                        <Input value={ordering.delivery_note} maxLength={200} disabled={!editable || !ordering.delivery_enabled} onChange={(e) => setOrder({ delivery_note: e.target.value })} />
                      </Field>
                    </div>
                  </div>
                  {err('settings.pickup_enabled') && <p className="text-sm text-danger">{err('settings.pickup_enabled')}</p>}
                  <Field label={t('commerce_ordering_min_order')} helper={t('commerce_ordering_min_helper')} error={err('settings.min_order_usd')} className="sm:max-w-xs">
                    <MoneyInput value={ordering.min_order_usd} currencySymbol="$" min={0} disabled={!editable} invalid={!!err('settings.min_order_usd')} onChange={(v) => setOrder({ min_order_usd: v })} />
                  </Field>
                  <div className="flex justify-end">
                    <Button type="submit" disabled={!editable}>{t('commerce_save')}</Button>
                  </div>
                </form>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader><h3 className="text-sm font-semibold text-text-2">{t('commerce_display_title')}</h3></CardHeader>
            <CardBody>
              <div className="flex flex-col gap-3">
                <Switch checked={store.settings.show_local_price === 1} disabled={!editable} onChange={(v) => saveSetting('show_local_price', v)} label={t('commerce_setting_show_local_price')} />
                <Switch checked={store.settings.hide_out_of_stock === 1} disabled={!editable} onChange={(v) => saveSetting('hide_out_of_stock', v)} label={t('commerce_setting_hide_out_of_stock')} />
                <Switch checked={store.settings.show_exact_stock === 1} disabled={!editable} onChange={(v) => saveSetting('show_exact_stock', v)} label={t('commerce_setting_show_exact_stock')} />
                <p className="text-xs text-text-3">{t('commerce_stock_lag_note')}</p>
              </div>
            </CardBody>
          </Card>

          {canManage && enabled && (
            <Card>
              <CardBody>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-text-3">{t('commerce_delete_help')}</p>
                  <Button variant="danger" onClick={removeStore} disabled={busy}><Trash2 size={16} /> {t('commerce_delete_store')}</Button>
                </div>
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

export default OnlineStoreSection;
