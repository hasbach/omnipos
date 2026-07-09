import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || 'https://cqxoxrgjazgcfhozoeyr.supabase.co';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxeG94cmdqYXpnY2Zob3pvZXlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNzkyNTAsImV4cCI6MjA5Mjk1NTI1MH0.2jLq8kJT-Of1gC3fkY20d5Rgscge_x8C_BwHLW78oU8';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Missing Supabase credentials in .env file. Cloud sync will be disabled.');
}

// Initialize the Supabase client
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
