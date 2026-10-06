import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';
import { db } from './db.js';

// The desktop app is single-tenant-at-a-time: one business (or the super-admin) is logged in
// per running app. We hold that one authenticated Supabase session here so the sync engine and
// the admin endpoints can make RLS-scoped cloud calls AS that tenant — never with a shipped
// service-role key. autoRefreshToken keeps the access token fresh over a long POS shift.
//
// Refresh tokens ROTATE: every refresh invalidates the previous token, and GoTrue treats a second
// use of an old token as theft and revokes the whole session family. So this module guarantees:
//   1. only ONE refresh of the stored token is ever in flight (single-flight rehydration);
//   2. the newest refresh token is always persisted (local SQLite `cloud_session`, never synced),
//      so a restart resumes from the latest token and not an already-used one;
//   3. an auth rejection (token not found / already used / invalid grant) is remembered and never
//      retried — the UI then asks the cashier to sign in again — while a network failure is
//      retried with backoff.

export interface ActiveSession {
  localId: number;
  globalId: string;
  email: string;
  client: SupabaseClient;
  refreshToken: string;
  /** Detaches the auth-state listener (set by watchClient). */
  unsubscribe?: () => void;
}

let active: ActiveSession | null = null;

// ---- Supabase client factory (overridable by tests) ------------------------------------------
type ClientFactory = (autoRefreshToken: boolean) => SupabaseClient;
const defaultFactory: ClientFactory = (autoRefreshToken) =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken, persistSession: false } });
let clientFactory: ClientFactory = defaultFactory;
/** Test seam: replace the Supabase client constructor. Call with no argument to restore. */
export function __setClientFactory(f?: ClientFactory): void { clientFactory = f || defaultFactory; }

// ---- Durable (local-only) copy of the latest refresh token -----------------------------------
let tableReady = false;
function ensureTable(): void {
  if (tableReady) return;
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_session (
    tenant_id INTEGER PRIMARY KEY,
    global_id TEXT,
    email TEXT,
    refresh_token TEXT,
    auth_expired INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  )`);
  tableReady = true;
}

interface PersistedSession { global_id: string | null; email: string | null; refresh_token: string | null; auth_expired: number }
function readPersisted(localId: number): PersistedSession | null {
  try {
    ensureTable();
    return (db.prepare('SELECT global_id, email, refresh_token, auth_expired FROM cloud_session WHERE tenant_id = ?').get(localId) as any) || null;
  } catch { return null; }
}
function persistToken(localId: number, globalId: string, email: string, refreshToken: string): void {
  try {
    ensureTable();
    db.prepare(`INSERT INTO cloud_session (tenant_id, global_id, email, refresh_token, auth_expired, updated_at)
                VALUES (?, ?, ?, ?, 0, ?)
                ON CONFLICT(tenant_id) DO UPDATE SET global_id = excluded.global_id, email = excluded.email,
                  refresh_token = excluded.refresh_token, auth_expired = 0, updated_at = excluded.updated_at`)
      .run(localId, globalId, email, refreshToken, new Date().toISOString());
  } catch (e: any) { console.error('[SESSION] could not persist cloud session:', e?.message); }
}
function markPersistedExpired(localId: number): void {
  try {
    ensureTable();
    db.prepare('UPDATE cloud_session SET auth_expired = 1, updated_at = ? WHERE tenant_id = ?').run(new Date().toISOString(), localId);
  } catch { /* best effort */ }
}
export function clearPersistedCloudSession(localId: number): void {
  try { ensureTable(); db.prepare('DELETE FROM cloud_session WHERE tenant_id = ?').run(localId); } catch { /* best effort */ }
}
/** Test/diagnostic helper: the stored refresh token for a tenant (never exposed over HTTP). */
export function __peekPersistedRefreshToken(localId: number): string | null {
  return readPersisted(localId)?.refresh_token ?? null;
}

// ---- Auth health -----------------------------------------------------------------------------
// Tenants whose cloud refresh token was rejected by the auth server. Until they sign in again no
// refresh is attempted (retrying a dead token only triggers reuse detection / hammers auth).
const expiredTenants = new Set<number>();
let networkRetryAt = 0;
let networkFailures = 0;
let lastAuthEvent: { at: number; kind: 'auth_expired' | 'network' | 'ok' } | null = null;

export function isAuthExpired(localId: number): boolean {
  if (expiredTenants.has(localId)) return true;
  return readPersisted(localId)?.auth_expired === 1;
}
function noteAuthExpired(localId: number): void {
  expiredTenants.add(localId);
  markPersistedExpired(localId);
  lastAuthEvent = { at: Date.now(), kind: 'auth_expired' };
}
export function getAuthHealth(): { lastEvent: typeof lastAuthEvent; networkRetryAt: number } {
  return { lastEvent: lastAuthEvent, networkRetryAt };
}

type AuthFailureKind = 'auth' | 'network';
// 4xx from the auth server (except 408/429) means the token itself is bad; anything else (fetch
// failure, 5xx, 522 from an overloaded project, timeouts) is transient.
export function classifyAuthError(error: any): AuthFailureKind {
  if (!error) return 'network';
  const name = String(error.name || '');
  if (name === 'AuthRetryableFetchError') return 'network';
  const status = Number(error.status);
  if (status === 408 || status === 429) return 'network';
  if (status >= 400 && status < 500) return 'auth';
  const code = String(error.code || error.error_code || '');
  if (['refresh_token_not_found', 'refresh_token_already_used', 'invalid_grant', 'session_not_found', 'bad_jwt'].includes(code)) return 'auth';
  if (/refresh token (not found|is not valid|already used)|invalid refresh token|invalid_grant/i.test(String(error.message || ''))) return 'auth';
  return 'network';
}

// ---- Active session --------------------------------------------------------------------------
let intentionalSignOut = false;

// Keep our stored copy of the refresh token current whenever the client rotates it on its own.
function watchClient(entry: ActiveSession): void {
  try {
    const sub: any = entry.client.auth.onAuthStateChange((event: string, session: any) => {
      if (active !== entry) return; // a newer session replaced this client
      if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && session?.refresh_token) {
        entry.refreshToken = session.refresh_token;
        expiredTenants.delete(entry.localId);
        persistToken(entry.localId, entry.globalId, entry.email, session.refresh_token);
        lastAuthEvent = { at: Date.now(), kind: 'ok' };
      } else if (event === 'SIGNED_OUT' && !intentionalSignOut) {
        // supabase-js drops the session itself when an auto-refresh is rejected by the server.
        active = null;
        noteAuthExpired(entry.localId);
      }
    });
    entry.unsubscribe = () => { try { sub?.data?.subscription?.unsubscribe?.(); } catch { /* ignore */ } };
  } catch { /* a client without events still works; we just persist on setActive/rehydrate */ }
}

// Stop a client we no longer use: detach its listener and its auto-refresh timer, so two clients
// never refresh the same session family (that looks like token reuse and revokes the session).
// Deliberately NO signOut here — a replaced client may share the new session.
function retireClient(entry: ActiveSession | null): void {
  if (!entry) return;
  entry.unsubscribe?.();
  try { (entry.client.auth as any).stopAutoRefresh?.(); } catch { /* ignore */ }
}

// Build a client authenticated as a given session, WITHOUT storing it as the active session.
// Used mid-login to read the tenant's own row before we've resolved its local integer id.
export async function createAuthedClient(tokens: { access_token: string; refresh_token: string }): Promise<SupabaseClient> {
  const client = clientFactory(false);
  const { error } = await client.auth.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
  if (error) throw error;
  return client;
}

export async function setActiveSession(
  localId: number,
  globalId: string,
  email: string,
  tokens: { access_token: string; refresh_token: string }
): Promise<void> {
  const client = clientFactory(true);
  const { data, error } = await client.auth.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
  if (error) throw error;
  // setSession may itself rotate the token; keep whichever is newest.
  const latest = (data as any)?.session?.refresh_token || tokens.refresh_token;
  const entry: ActiveSession = { localId, globalId, email, client, refreshToken: latest };
  retireClient(active);
  active = entry;
  expiredTenants.delete(localId);
  networkFailures = 0;
  networkRetryAt = 0;
  persistToken(localId, globalId, email, latest);
  lastAuthEvent = { at: Date.now(), kind: 'ok' };
  watchClient(entry);
}

export type RehydrateResult = 'ok' | 'auth_expired' | 'network' | 'no_token';
// Keyed by tenant so a stale request for another tenant never borrows this tenant's result.
const rehydrateInFlight = new Map<number, Promise<RehydrateResult>>();

// Re-establish the active session from just a stored refresh token (e.g. after an app restart,
// where the Express cookie still says "logged in" but this in-memory session was lost).
// Single-flight: concurrent callers share ONE refresh — a second refresh of the same token would
// look like token reuse to the auth server and revoke the whole session family.
// The persisted (latest) token wins over the cookie copy, which may be a rotation behind.
export function rehydrateActiveSession(
  localId: number,
  globalId: string,
  email: string,
  cookieRefreshToken?: string | null
): Promise<RehydrateResult> {
  if (active && active.localId === localId) return Promise.resolve('ok');
  const pending = rehydrateInFlight.get(localId);
  if (pending) return pending;
  const p = doRehydrate(localId, globalId, email, cookieRefreshToken || null)
    .finally(() => { rehydrateInFlight.delete(localId); });
  rehydrateInFlight.set(localId, p);
  return p;
}

async function doRehydrate(localId: number, globalId: string, email: string, cookieToken: string | null): Promise<RehydrateResult> {
  if (isAuthExpired(localId)) return 'auth_expired';
  if (Date.now() < networkRetryAt) return 'network';
  const persisted = readPersisted(localId);
  const token = persisted?.refresh_token || cookieToken;
  if (!token) return 'no_token';

  let client: SupabaseClient;
  try {
    client = clientFactory(true);
    const { data, error } = await client.auth.refreshSession({ refresh_token: token });
    if (error || !data?.session) {
      if (classifyAuthError(error) === 'auth') {
        noteAuthExpired(localId);
        return 'auth_expired';
      }
      throw error || new Error('no session');
    }
    const entry: ActiveSession = { localId, globalId, email, client, refreshToken: data.session.refresh_token };
    retireClient(active);
    active = entry;
    networkFailures = 0;
    networkRetryAt = 0;
    persistToken(localId, globalId, email, data.session.refresh_token);
    lastAuthEvent = { at: Date.now(), kind: 'ok' };
    watchClient(entry);
    return 'ok';
  } catch (e: any) {
    // Thrown/transient: retry later with exponential backoff (5s .. 2min). The token is untouched.
    networkFailures++;
    networkRetryAt = Date.now() + Math.min(5000 * 2 ** (networkFailures - 1), 120000);
    lastAuthEvent = { at: Date.now(), kind: 'network' };
    return 'network';
  }
}

export function getActiveSession(): ActiveSession | null {
  return active;
}

export function clearActiveSession(): void {
  if (active) {
    const entry = active;
    const { localId, client } = entry;
    active = null;
    intentionalSignOut = true;
    clearPersistedCloudSession(localId);
    expiredTenants.delete(localId);
    retireClient(entry);
    // scope 'local' ends ONLY this register's session. The default ('global') would sign the shared
    // business account out on every register and the Live Monitor, killing their sync.
    client.auth.signOut({ scope: 'local' }).catch(() => {}).finally(() => { intentionalSignOut = false; });
  }
}

/** Forget everything about a tenant's cloud session (logout while the session was already gone). */
export function forgetCloudSession(localId: number): void {
  clearPersistedCloudSession(localId);
  expiredTenants.delete(localId);
}

/** Test helper: drop in-memory state without touching the network. */
export function __resetSessionStateForTests(): void {
  active = null;
  expiredTenants.clear();
  rehydrateInFlight.clear();
  networkRetryAt = 0;
  networkFailures = 0;
  lastAuthEvent = null;
  intentionalSignOut = false;
}
