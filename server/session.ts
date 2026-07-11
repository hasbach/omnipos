import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';

// The desktop app is single-tenant-at-a-time: one business (or the super-admin) is logged in
// per running app. We hold that one authenticated Supabase session here so the sync engine and
// the admin endpoints can make RLS-scoped cloud calls AS that tenant — never with a shipped
// service-role key. autoRefreshToken keeps the access token fresh over a long POS shift.

export interface ActiveSession {
  localId: number;
  globalId: string;
  email: string;
  client: SupabaseClient;
  refreshToken: string;
}

let active: ActiveSession | null = null;

// Build a client authenticated as a given session, WITHOUT storing it as the active session.
// Used mid-login to read the tenant's own row before we've resolved its local integer id.
export async function createAuthedClient(tokens: { access_token: string; refresh_token: string }): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: true, persistSession: false },
  });
  const { error } = await client.auth.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
  if (error) throw error;
  active = { localId, globalId, email, client, refreshToken: tokens.refresh_token };
}

// Re-establish the active session from just a stored refresh token (e.g. after an app restart,
// where the Express cookie still says "logged in" but this in-memory session was lost).
export async function rehydrateActiveSession(
  localId: number,
  globalId: string,
  email: string,
  refreshToken: string
): Promise<boolean> {
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: true, persistSession: false },
    });
    const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) return false;
    active = {
      localId,
      globalId,
      email,
      client,
      refreshToken: data.session.refresh_token,
    };
    return true;
  } catch {
    return false;
  }
}

export function getActiveSession(): ActiveSession | null {
  return active;
}

export function clearActiveSession(): void {
  if (active) {
    active.client.auth.signOut().catch(() => {});
    active = null;
  }
}
