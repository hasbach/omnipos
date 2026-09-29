// Who is signed in at the till and what may they do? Fetches GET /api/auth/whoami once, caches it for
// the session and refreshes when the window regains focus, on POS sync events and after the roles
// matrix is saved. Without a PIN user on the session (business owner signed in) nothing is restricted.
import React, { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { EmptyState } from '../components/ui';
import { useI18n } from '../intl/index';
import { ALL_PERMISSIONS, PAGE_PERMISSIONS, pagePermissions } from './permissions';

export interface SessionUser {
  id: number;
  name: string;
  role: string;
}

interface WhoAmI {
  user: SessionUser | null;
  permissions: string[];
  enforced: boolean;
}

const OPEN: WhoAmI = { user: null, permissions: ALL_PERMISSIONS, enforced: false };

let cache: WhoAmI | null = null;
let cachedAt = 0;
let inflight: Promise<WhoAmI> | null = null;
const listeners = new Set<(w: WhoAmI) => void>();

function load(): Promise<WhoAmI> {
  if (!inflight) {
    inflight = fetch('/api/auth/whoami')
      .then((res) => (res.ok ? res.json() : OPEN))
      .then((data): WhoAmI => ({
        user: data?.user ?? null,
        permissions: Array.isArray(data?.permissions) ? data.permissions : ALL_PERMISSIONS,
        enforced: !!data?.enforced,
      }))
      .catch(() => cache || OPEN)
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Re-read the session user/permissions (call after saving the roles matrix or locking the till). */
export function refreshPermissions(): Promise<WhoAmI> {
  return load().then((w) => {
    cache = w;
    cachedAt = Date.now();
    listeners.forEach((fn) => fn(w));
    return w;
  });
}

export function usePermissions() {
  const [who, setWho] = useState<WhoAmI | null>(cache);

  useEffect(() => {
    listeners.add(setWho);
    // Always re-read on mount: the cached value may predate a PIN sign-in / lock in another window.
    if (!cache || Date.now() - cachedAt > 5000) refreshPermissions();
    const refetch = () => { refreshPermissions(); };
    const onSync = (e: any) => {
      const type = e?.detail?.type;
      if (type === 'SETTINGS_UPDATED' || type === 'PERMISSIONS_UPDATED') refetch();
    };
    window.addEventListener('focus', refetch);
    window.addEventListener('pos-sync', onSync);
    return () => {
      listeners.delete(setWho);
      window.removeEventListener('focus', refetch);
      window.removeEventListener('pos-sync', onSync);
    };
  }, []);

  const ready = who !== null;
  const current = who || OPEN;
  // While loading, `can` says yes (the server is the real gate); guards wait for `ready` instead.
  const can = useCallback(
    (key: string) => !current.enforced || current.permissions.includes(key),
    [current],
  );
  const canAny = useCallback(
    (keys: string[] | null | undefined) => !keys || keys.length === 0 || keys.some((k) => can(k)),
    [can],
  );
  const isAdmin = !current.enforced || current.user?.role === 'admin';
  return { ready, user: current.user, enforced: current.enforced, permissions: current.permissions, can, canAny, isAdmin };
}

/** Friendly "No access" state for a page the signed-in user's role may not open. */
export function NoAccess() {
  const { t } = useI18n();
  return (
    <EmptyState
      icon={ShieldOff}
      title={t('perm_no_access_title', 'No access')}
      description={t('perm_no_access_desc', "Your role doesn't include this page. Ask an administrator if you need it.")}
    />
  );
}

/** Route guard: renders children only when the user holds ANY of `any` (null/undefined = open). */
export function RequirePermission({ any, children }: { any: string[] | null | undefined; children: React.ReactNode }) {
  const { ready, canAny } = usePermissions();
  if (!ready) return null;
  if (!canAny(any)) return <NoAccess />;
  return <>{children}</>;
}

/** Dashboard index: the overview, or the first page the user can open when overview is not allowed. */
export function DashboardHome({ children }: { children: React.ReactNode }) {
  const { ready, canAny } = usePermissions();
  if (!ready) return null;
  if (canAny(PAGE_PERMISSIONS['']!)) return <>{children}</>;
  const first = Object.keys(PAGE_PERMISSIONS).find((p) => p !== '' && p !== 'ui-kit' && canAny(pagePermissions(`/dashboard/${p}`)));
  if (first) return <Navigate to={`/dashboard/${first}`} replace />;
  return <NoAccess />;
}
