import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cqxoxrgjazgcfhozoeyr.supabase.co';

// PUBLIC anon key — safe to ship inside the desktop installer (this is the same key the web
// Live Monitor already uses). It grants nothing on its own: Row Level Security + real Supabase
// Auth sessions are what enforce tenant isolation. The packaged app uses THIS for all cloud
// access (sign-in, calling the register-tenant edge function, and — once signed in — per-tenant
// RLS-scoped reads/writes via an authenticated session, see server/session.ts).
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxeG94cmdqYXpnY2Zob3pvZXlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNzkyNTAsImV4cCI6MjA5Mjk1NTI1MH0.2jLq8kJT-Of1gC3fkY20d5Rgscge_x8C_BwHLW78oU8';

// Anon client: used for signInWithPassword and functions.invoke('register-tenant').
// No session by default; per-tenant authenticated clients are built in server/session.ts.
export const anonSupabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// SERVICE-ROLE client — bypasses RLS. This must NEVER run in the shipped desktop app; it is
// only for developer/maintenance scripts run locally with SUPABASE_SERVICE_ROLE_KEY set in
// .env (e.g. scripts/backfill-supabase-auth.ts). If the key is absent (the normal case in a
// packaged install), this is constructed with an invalid placeholder so importing modules that
// merely reference it don't crash — any actual call will simply fail. Nothing in the app's
// runtime paths uses this anymore; see anonSupabase + server/session.ts instead.
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  supabaseServiceRoleKey || 'service-role-key-not-configured',
  { auth: { autoRefreshToken: false, persistSession: false } }
);
