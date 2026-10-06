import React from 'react';
import { CloudOff } from 'lucide-react';
import { useI18n } from '../intl/index';

interface SyncStatus {
  state: 'ok' | 'offline' | 'auth_expired' | 'not_signed_in';
  email?: string;
  pendingCounts?: Record<string, number>;
}

// Red banner shown while the cloud session is dead (refresh token rejected). Without it, sync
// silently stops for days. "Sign in" opens a small password prompt that re-authenticates the
// CURRENT business only (POST /api/auth/cloud-reconnect); local data is never touched.
export default function CloudSyncBanner() {
  const { t, dir } = useI18n();
  const [status, setStatus] = React.useState<SyncStatus | null>(null);
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/sync/status');
      if (res.ok) setStatus(await res.json());
    } catch { /* offline: keep the last known status */ }
  }, []);

  React.useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  if (status?.state !== 'auth_expired') return null;
  const pending = Object.values(status.pendingCounts || {}).reduce((a, b) => a + b, 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/cloud-reconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: status.email, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || t('cloudsync_failed', 'Could not reconnect.'));
      setPassword('');
      setOpen(false);
      await load();
    } catch (err: any) {
      setError(err?.message || t('cloudsync_failed', 'Could not reconnect.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div dir={dir} role="alert" className="flex items-center gap-3 bg-red-600 text-white px-4 py-2 text-sm font-medium">
        <CloudOff size={16} className="shrink-0" />
        <span className="flex-1 min-w-0">
          {t('cloudsync_stopped', 'Cloud sync stopped — sign in again to resume')}
          {pending > 0 && (
            <span className="opacity-90 font-normal"> · {t('cloudsync_pending', '{n} change(s) are waiting to upload. Nothing is lost.').replace('{n}', String(pending))}</span>
          )}
        </span>
        <button
          type="button"
          onClick={() => { setOpen(true); setError(''); }}
          className="shrink-0 rounded bg-white/20 hover:bg-white/30 px-3 py-1 font-semibold"
        >
          {t('cloudsync_sign_in', 'Sign in')}
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-6" dir={dir}>
          <form onSubmit={submit} className="w-full max-w-sm rounded-xl bg-surface text-text border border-border shadow-xl p-5 space-y-3">
            <h2 className="text-base font-bold">{t('cloudsync_reconnect_title', 'Resume cloud sync')}</h2>
            <p className="text-xs opacity-70">{t('cloudsync_reconnect_hint', 'Enter the password for this business account. Your local data is not changed.')}</p>
            <label className="block text-xs font-semibold">
              {t('cloudsync_email', 'Account')}
              <input value={status.email || ''} readOnly className="mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-sm opacity-80" />
            </label>
            <label className="block text-xs font-semibold">
              {t('cloudsync_password', 'Password')}
              <input
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-sm"
              />
            </label>
            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => { setOpen(false); setPassword(''); }} className="rounded px-3 py-2 text-sm border border-border">
                {t('cloudsync_cancel', 'Cancel')}
              </button>
              <button type="submit" disabled={busy || !password} className="rounded px-3 py-2 text-sm font-semibold bg-red-600 text-white disabled:opacity-50">
                {t('cloudsync_reconnect', 'Reconnect')}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
