import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Radar, Trash2, AlertTriangle, Plus } from 'lucide-react';
import { Card, CardBody, CardHeader, Button, Field, Input, useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import type { StoreConnection } from '../../types';

const ERROR_KEYS: Record<string, string> = {
  NAME_INVALID: 'conn_err_name',
  URL_INVALID: 'conn_err_url',
  DUPLICATE: 'conn_err_duplicate',
  UNREACHABLE: 'conn_err_unreachable',
  TOO_MANY: 'conn_err_too_many',
};

export function ConnectionsSection() {
  const { t } = useI18n();
  const toast = useToast();
  const api = window.electronAPI?.connections;

  const [items, setItems] = useState<StoreConnection[]>([]);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<string[] | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const res = await api?.list();
    if (res?.ok) setItems(res.connections || []);
  }, [api]);

  useEffect(() => { reload(); }, [reload]);

  if (!api) return null;

  const errText = (code?: string) => t(ERROR_KEYS[code || ''] || 'conn_err_generic');

  const handleAdd = async () => {
    setError('');
    let url = address.trim();
    if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
    setBusy(true);
    try {
      const res = await api.add({ name: name.trim(), url });
      if (res.ok) {
        toast.success(t('conn_added'));
        setName('');
        setAddress('');
        setFound(null);
        await reload();
      } else {
        setError(errText(res.error));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleScan = async () => {
    setScanning(true);
    setFound(null);
    try {
      const res = await api.scan();
      setFound(res.ok ? res.servers || [] : []);
    } finally {
      setScanning(false);
    }
  };

  const handleRemove = async (c: StoreConnection) => {
    if (!window.confirm(`${c.name}\n\n${t('conn_remove_confirm')}`)) return;
    const res = await api.remove(c.id);
    if (res.ok) {
      toast.success(t('conn_removed'));
      reload();
    } else {
      toast.error(errText(res.error));
    }
  };

  const handleOpen = async (c: StoreConnection) => {
    const res = await api.open(c.id);
    if (!res.ok) toast.error(errText(res.error));
  };

  const handleResetMode = () => {
    api.resetConnectionMode({
      title: t('conn_mode_dialog_title'),
      message: t('conn_mode_dialog_message'),
      confirm: t('conn_mode_confirm'),
      cancel: t('conn_mode_cancel'),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold">{t('conn_title')}</h3>
        </CardHeader>
        <CardBody>
          <p className="mb-4 text-sm text-text-2">{t('conn_intro')}</p>
          {items.length === 0 ? (
            <p className="text-sm text-text-3">{t('conn_empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-[var(--radius-input)] border border-border">
              {items.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text">{c.name}</p>
                    <p className="truncate text-xs text-text-3" dir="ltr">{c.url}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button size="sm" onClick={() => handleOpen(c)}>
                      <ExternalLink size={14} />
                      {t('conn_open')}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => handleRemove(c)}>
                      <Trash2 size={14} />
                      {t('conn_remove')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold">{t('conn_add_title')}</h3>
        </CardHeader>
        <CardBody>
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t('conn_name')} htmlFor="conn-name">
                <Input id="conn-name" value={name} maxLength={60} placeholder={t('conn_name_ph')}
                  onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label={t('conn_address')} htmlFor="conn-address" helper={t('conn_address_help')} error={error || undefined}>
                <Input id="conn-address" dir="ltr" value={address} placeholder={t('conn_address_ph')}
                  onChange={(e) => setAddress(e.target.value)} />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={handleAdd} disabled={busy || !name.trim() || !address.trim()}>
                <Plus size={14} />
                {busy ? t('conn_adding') : t('conn_add')}
              </Button>
              <Button variant="secondary" onClick={handleScan} disabled={scanning}>
                <Radar size={14} />
                {scanning ? t('conn_scanning') : t('conn_scan')}
              </Button>
            </div>
            {found && (
              found.length === 0 ? (
                <p className="text-sm text-text-3">{t('conn_scan_none')}</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs text-text-3">{t('conn_scan_pick')}</p>
                  <div className="flex flex-wrap gap-2">
                    {found.map((u) => (
                      <button
                        key={u}
                        type="button"
                        dir="ltr"
                        onClick={() => setAddress(u)}
                        className="cursor-pointer rounded-[var(--radius-input)] border border-border px-2.5 py-1 text-xs text-text-2 hover:bg-surface-2 hover:text-text"
                      >
                        {u}
                      </button>
                    ))}
                  </div>
                </div>
              )
            )}
          </div>
        </CardBody>
      </Card>

      <Card className="border-danger/40">
        <CardHeader>
          <div className="flex items-center gap-2 text-danger">
            <AlertTriangle size={18} />
            <h3 className="text-sm font-semibold">{t('conn_mode_title')}</h3>
          </div>
        </CardHeader>
        <CardBody>
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-text-2">{t('conn_mode_warning')}</p>
            <Button variant="danger" onClick={handleResetMode}>{t('conn_mode_button')}</Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
