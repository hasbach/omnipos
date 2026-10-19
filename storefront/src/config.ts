// Runtime configuration (Vercel environment variables). Defaults let the dev server and tests run as-is.
export { RESERVED_SLUGS as RESERVED_SUBDOMAINS } from './reserved.js';

export interface StorefrontConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** e.g. "myomnipos.com" — stores live at <address>.<domain> and <domain>/s/<address>. */
  storefrontDomain: string;
  /** Where the bare storefront domain redirects. */
  websiteUrl: string;
}

// The anon key is public by design (it ships in the Live Monitor web app); RLS and the allow-listed RPCs protect data.
const DEFAULT_SUPABASE_URL = 'https://cqxoxrgjazgcfhozoeyr.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxeG94cmdqYXpnY2Zob3pvZXlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNzkyNTAsImV4cCI6MjA5Mjk1NTI1MH0.2jLq8kJT-Of1gC3fkY20d5Rgscge_x8C_BwHLW78oU8';

export function loadConfig(env: Record<string, string | undefined> = process.env): StorefrontConfig {
  return {
    supabaseUrl: (env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, ''),
    supabaseAnonKey: env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY,
    storefrontDomain: (env.STOREFRONT_DOMAIN || 'myomnipos.com').toLowerCase(),
    websiteUrl: env.OMNIPOS_WEBSITE_URL || 'https://github.com/hasbach/omnipos',
  };
}
