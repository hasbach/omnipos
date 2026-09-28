import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CloudOff, Trash2 } from 'lucide-react';
import { Card, CardBody, CardHeader, Checkbox, Button, Modal, Field, Input, useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { translateServerError } from '../../lib/serverErrors';

type Scope = 'transactions' | 'stock' | 'products' | 'parties';

interface Preview {
  transactions: number;
  products: number;
  parties: number;
  stock_units: number;
  cloud: { connected: boolean; hasSyncedData: boolean };
}

const SCOPES: Scope[] = ['transactions', 'stock', 'products', 'parties'];

// Danger zone: wipes the current tenant's business data (server/tenantReset.ts). The server
// re-validates everything (scopes, dependency, DELETE text, admin PIN) — this UI only guides.
export function DataResetSection() {
  const { t } = useI18n();
  const toast = useToast();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<Set<Scope>>(new Set());
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ pin?: string; confirm?: string; general?: string }>({});

  const fmt = (key: string, n: number) => t(key).replace('{n}', n.toLocaleString());

  const load = useCallback(() => {
    setLoadFailed(false);
    api.get<Preview>('/api/tenant/reset/preview').then(setPreview).catch(() => setLoadFailed(true));
  }, []);
  useEffect(load, [load]);

  const toggle = (scope: Scope) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        // transactions can't be unticked while products/parties depend on it
        if (scope === 'transactions' && (next.has('products') || next.has('parties'))) return prev;
        next.delete(scope);
      } else {
        next.add(scope);
        if (scope === 'products' || scope === 'parties') next.add('transactions');
      }
      return next;
    });
  };

  const allSelected = selected.size === SCOPES.length;
  const selectAll = () => setSelected(allSelected ? new Set() : new Set(SCOPES));

  const label = (s: Scope) => t(`rst_scope_${s}`);
  const countText = (s: Scope) =>
    !preview ? '' : s === 'transactions' ? fmt('rst_count_transactions', preview.transactions)
      : s === 'stock' ? fmt('rst_count_stock', preview.stock_units)
      : s === 'products' ? fmt('rst_count_products', preview.products)
      : fmt('rst_count_parties', preview.parties);

  const cloudBlocked = !!preview && preview.cloud.hasSyncedData && !preview.cloud.connected;
  const canOpen = selected.size > 0 && !cloudBlocked;
  const canConfirm = pin.trim().length > 0 && confirmText === 'DELETE' && !busy;
  const ordered = useMemo(() => SCOPES.filter((s) => selected.has(s)), [selected]);

  const openModal = () => {
    setPin('');
    setConfirmText('');
    setErrors({});
    setOpen(true);
  };

  const submit = async () => {
    setBusy(true);
    setErrors({});
    try {
      const res = await api.post<{ backup: string }>('/api/tenant/reset', { scopes: ordered, confirm: confirmText, admin_pin: pin });
      setOpen(false);
      setSelected(new Set());
      toast.success(t('rst_success').replace('{path}', res.backup));
      load();
      // Make every open page refetch (the server also broadcasts these over the websocket).
      for (const type of ['PRODUCTS_UPDATED', 'TRANSACTIONS_UPDATED', 'CASH_FLOW_UPDATED', 'STAKEHOLDERS_UPDATED', 'PURCHASES_UPDATED']) {
        window.dispatchEvent(new CustomEvent('pos-sync', { detail: { type } }));
      }
    } catch (err: any) {
      const msg = translateServerError(err, t);
      if (err.field === 'admin_pin') setErrors({ pin: msg });
      else if (err.field === 'confirm') setErrors({ confirm: msg });
      else setErrors({ general: msg });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card className="border-danger/40">
        <CardHeader>
          <div className="flex items-center gap-2 text-danger">
            <AlertTriangle size={18} />
            <h3 className="text-sm font-semibold">{t('rst_title')}</h3>
          </div>
        </CardHeader>
        <CardBody>
          <div className="flex flex-col gap-5">
            <p className="text-sm text-text-2">{t('rst_intro')}</p>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-[var(--radius-input)] border border-border bg-surface-2 p-3">
                <p className="text-sm font-medium text-text">{t('rst_deleted_title')}</p>
                <p className="mt-1 text-xs text-text-3">{t('rst_deleted_body')}</p>
              </div>
              <div className="rounded-[var(--radius-input)] border border-border bg-surface-2 p-3">
                <p className="text-sm font-medium text-text">{t('rst_kept_title')}</p>
                <p className="mt-1 text-xs text-text-3">{t('rst_kept_body')}</p>
              </div>
            </div>
            <ul className="list-disc space-y-1 ps-5 text-xs text-text-3">
              <li>{t('rst_backup_note')}</li>
              <li>{t('rst_multi_register')}</li>
            </ul>

            {cloudBlocked && (
              <div role="alert" className="flex items-start gap-2 rounded-[var(--radius-input)] border border-danger/30 bg-danger-soft p-3 text-sm text-danger">
                <CloudOff size={16} className="mt-0.5 shrink-0" />
                <span>{t('rst_needs_cloud_warning')}</span>
              </div>
            )}
            {loadFailed && <p className="text-sm text-danger">{t('rst_loading_failed')}</p>}

            <div className="flex flex-col gap-1">
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={selectAll}>
                  {allSelected ? t('rst_clear_all') : t('rst_select_all')}
                </Button>
              </div>
              {SCOPES.map((s) => {
                const locked = s === 'transactions' && (selected.has('products') || selected.has('parties'));
                return (
                  <div key={s} className="flex items-start gap-3 rounded-[var(--radius-input)] border border-border p-3">
                    <Checkbox
                      id={`rst-${s}`}
                      checked={selected.has(s)}
                      disabled={locked}
                      onChange={() => toggle(s)}
                      aria-label={label(s)}
                      className="mt-0.5"
                    />
                    <label htmlFor={`rst-${s}`} className="min-w-0 flex-1 cursor-pointer">
                      <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-text">
                        {label(s)}
                        {preview && <span className="text-xs font-normal text-text-3">({countText(s)})</span>}
                      </span>
                      <span className="block text-xs text-text-3">{t(`rst_scope_${s}_desc`)}</span>
                      {(s === 'products' || s === 'parties') && (
                        <span className="block text-xs text-text-3">{t('rst_requires_transactions')}</span>
                      )}
                    </label>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end">
              <Button variant="danger" disabled={!canOpen} onClick={openModal}>
                <Trash2 size={16} />
                {t('rst_button')}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        title={t('rst_modal_title')}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              {t('ui_cancel', 'Cancel')}
            </Button>
            <Button variant="danger" disabled={!canConfirm} loading={busy} onClick={submit}>
              {t('rst_confirm_final')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-sm text-text-2">{t('rst_modal_summary')}</p>
            <ul className="mt-2 list-disc space-y-1 ps-5 text-sm font-medium text-text">
              {ordered.map((s) => (
                <li key={s}>
                  {label(s)} <span className="font-normal text-text-3">({countText(s)})</span>
                </li>
              ))}
            </ul>
          </div>
          <Field label={t('rst_pin_label')} helper={t('rst_pin_help')} error={errors.pin} htmlFor="rst-pin">
            <Input
              id="rst-pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label={t('rst_confirm_label')} error={errors.confirm} htmlFor="rst-confirm">
            <Input
              id="rst-confirm"
              autoComplete="off"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              dir="ltr"
            />
          </Field>
          {errors.general && (
            <div role="alert" className="rounded-[var(--radius-input)] border border-danger/30 bg-danger-soft p-3 text-sm text-danger">
              {errors.general}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

export default DataResetSection;
