import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// IMPORTANT: this client uses the Supabase SERVICE ROLE key and bypasses Row Level Security
// by design. It is only ever imported from server-side code (never from src/** — Vite does
// not bundle server/**, so this key is never shipped to a browser). The backend enforces
// tenant isolation itself (every query is scoped with `WHERE tenant_id = ?`), the same way
// the local Express routes already do — it does not rely on RLS for that.
//
// Do NOT use the anon key here. The anon key belongs only in src/lib/supabase.ts, where
// real per-tenant Supabase Auth sessions + RLS are what enforce isolation for browser clients.
const supabaseUrl = process.env.SUPABASE_URL || 'https://cqxoxrgjazgcfhozoeyr.supabase.co';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseServiceRoleKey) {
  console.error(
    'FATAL: SUPABASE_SERVICE_ROLE_KEY is not set in .env. Cloud sync, tenant registration, ' +
    'and login will fail without it. Get it from Supabase dashboard > Project Settings > API ' +
    '(the "service_role" secret key, not "anon"/"public"). The local POS will keep working ' +
    'normally — only cloud features are affected.'
  );
}

// createClient() throws synchronously if the key is falsy/empty, which would crash the whole
// server on startup — that must never happen just because cloud config is missing, since the
// local POS has to keep working regardless. Fall back to an obviously-invalid placeholder so
// construction succeeds; any actual Supabase call will then fail per-request (already handled
// by callers) instead of taking the whole process down.
export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey || 'service-role-key-not-configured');
