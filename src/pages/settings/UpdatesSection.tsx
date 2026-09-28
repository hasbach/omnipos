import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardHeader, Badge, Button } from '../../components/ui';
import { Monitor, RefreshCw, Shield } from 'lucide-react';
import { useI18n } from '../../intl/index';
import type { Tenant } from '../../types';

export interface UpdatesSectionProps {
  tenant: Tenant | null;
  onShowUpdate: () => void;
}

type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'latest' | 'error';

function licenseActive(type?: string, expiry?: string): boolean {
  if (type === 'lifetime') return true;
  if (!expiry) return false;
  return new Date(expiry) > new Date();
}

export function UpdatesSection({ tenant, onShowUpdate }: UpdatesSectionProps) {
  const { t, lang } = useI18n();
  // License types are stored as 'year' | 'lifetime' (local) and 'monthly' | 'lifetime' (online).
  const licenseTypeLabel = (type?: string | null) =>
    type === 'lifetime' ? t('sa_lifetime', 'Lifetime')
      : type === 'monthly' ? t('sa_monthly', 'Monthly')
      : type === 'year' || type === 'yearly' ? t('sa_yearly', 'Yearly')
      : (type || '');
  const [updateState, setUpdateState] = useState<UpdateState>('idle');
  const [updateInfo, setUpdateInfo] = useState<{ version?: string; percent?: number; message?: string }>({});

  useEffect(() => {
    if (!window.electronAPI?.onUpdateStatus) return;
    const cleanup = window.electronAPI.onUpdateStatus((data: any) => {
      switch (data.event) {
        case 'checking':
          setUpdateState('checking');
          setUpdateInfo({});
          break;
        case 'available':
          setUpdateState('downloading');
          setUpdateInfo({ version: data.version, percent: 0 });
          window.electronAPI?.downloadUpdate?.();
          break;
        case 'progress':
          setUpdateState('downloading');
          setUpdateInfo((prev) => ({ ...prev, percent: data.percent }));
          break;
        case 'downloaded':
          setUpdateState('downloaded');
          setUpdateInfo({ version: data.version });
          break;
        case 'not-available':
          setUpdateState('latest');
          setUpdateInfo({ version: data.version });
          break;
        case 'error':
          setUpdateState('error');
          setUpdateInfo({ message: data.message });
          break;
      }
    });
    return cleanup;
  }, []);

  const handleCheckForUpdates = async () => {
    if (!window.electronAPI?.checkForUpdates) {
      setUpdateState('error');
      setUpdateInfo({ message: t('set_update_error_desktop_only') });
      return;
    }
    setUpdateState('checking');
    setUpdateInfo({});

    const timeout = setTimeout(() => {
      setUpdateState((prev) => (prev === 'checking' ? 'error' : prev));
      setUpdateInfo((prev) => (prev.message ? prev : { message: t('set_update_error_no_response') }));
    }, 20000);

    try {
      const res: any = await window.electronAPI.checkForUpdates();
      clearTimeout(timeout);
      if (res && res.ok === false) {
        setUpdateState('error');
        setUpdateInfo({ message: res.error || 'Update check failed.' });
      } else if (res && res.checked === false) {
        setUpdateState('error');
        setUpdateInfo({ message: t('set_update_error_dev_build') });
      }
    } catch (e: any) {
      clearTimeout(timeout);
      setUpdateState('error');
      setUpdateInfo({ message: e?.message || 'Update check failed.' });
    }
  };

  if (!tenant) return null;

  const localActive = licenseActive(tenant.local_license_type, tenant.local_license_expiry);
  const onlineActive = licenseActive(tenant.online_license_type, tenant.online_license_expiry);
  const dateLocale = lang === 'ar' ? 'ar-LB' : lang === 'fr' ? 'fr-FR' : 'en-US';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 text-text-2">
          <Shield size={18} />
          <h3 className="text-sm font-semibold">{t('set_license_title')}</h3>
        </div>
      </CardHeader>
      <CardBody>
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-[var(--radius-card)] border border-border p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
                  <Monitor size={14} /> {t('set_license_local')}
                </span>
                <Badge variant={localActive ? 'success' : 'danger'}>{localActive ? t('set_license_active') : t('set_license_expired')}</Badge>
              </div>
              <p className="text-lg font-bold capitalize text-text">{licenseTypeLabel(tenant.local_license_type)}</p>
              {tenant.local_license_type !== 'lifetime' && tenant.local_license_expiry && (
                <p className="text-xs text-text-3">{t('set_license_expires').replace('{date}', new Date(tenant.local_license_expiry).toLocaleDateString(dateLocale))}</p>
              )}
            </div>

            <div className="rounded-[var(--radius-card)] border border-border p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
                  <Monitor size={14} /> {t('set_license_online')}
                </span>
                <Badge variant={onlineActive ? 'success' : 'danger'}>{onlineActive ? t('set_license_active') : t('set_license_expired')}</Badge>
              </div>
              <p className="text-lg font-bold capitalize text-text">{licenseTypeLabel(tenant.online_license_type)}</p>
              {tenant.online_license_type !== 'lifetime' && tenant.online_license_expiry && (
                <p className="text-xs text-text-3">{t('set_license_expires').replace('{date}', new Date(tenant.online_license_expiry).toLocaleDateString(dateLocale))}</p>
              )}
            </div>
          </div>

          <div className="rounded-[var(--radius-card)] border border-border p-4">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
                <RefreshCw size={14} /> {t('set_license_version')}
              </span>
              <div className="text-end">
                <p className="text-sm font-bold text-text">v{tenant.current_version}</p>
                {tenant.available_version && tenant.available_version !== tenant.current_version && (
                  <button type="button" onClick={onShowUpdate} className="cursor-pointer text-xs font-semibold text-success hover:underline">
                    {t('set_license_update_available').replace('{version}', tenant.available_version)}
                  </button>
                )}
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
              <span className="text-xs font-medium text-text-3">
                {updateState === 'checking' && t('set_update_checking')}
                {updateState === 'downloading' &&
                  t('set_update_downloading')
                    .replace('{version}', updateInfo.version || '')
                    .replace('{percent}', updateInfo.percent != null ? String(Math.round(updateInfo.percent)) : '')}
                {updateState === 'downloaded' && t('set_update_ready').replace('{version}', updateInfo.version || '')}
                {updateState === 'latest' && t('set_update_latest')}
                {updateState === 'error' && <span className="text-danger normal-case">{updateInfo.message || 'Update check failed'}</span>}
                {updateState === 'idle' && t('set_update_idle')}
              </span>

              {updateState === 'downloaded' ? (
                <Button variant="success" size="sm" onClick={() => window.electronAPI?.installUpdate?.()}>
                  {t('set_update_restart_install')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={updateState === 'checking' || updateState === 'downloading'}
                  onClick={handleCheckForUpdates}
                >
                  <RefreshCw size={13} className={updateState === 'checking' || updateState === 'downloading' ? 'animate-spin' : ''} />
                  {t('set_update_check')}
                </Button>
              )}
            </div>
          </div>

          <p className="text-center text-xs italic text-text-3">{t('set_license_contact_support')}</p>
        </div>
      </CardBody>
    </Card>
  );
}

export default UpdatesSection;
