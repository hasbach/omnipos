import { createClient } from '@supabase/supabase-js';

// Fallback to the same credentials used by the desktop app
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://cqxoxrgjazgcfhozoeyr.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxeG94cmdqYXpnY2Zob3pvZXlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNzkyNTAsImV4cCI6MjA5Mjk1NTI1MH0.2jLq8kJT-Of1gC3fkY20d5Rgscge_x8C_BwHLW78oU8';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
