-- Supplier payment terms and the payables reserve horizon (OmniPulse OR, growth task 1).
-- Both tables already have RLS, the set_synced_at trigger and a sync_changed_tables entry; only columns are added.
ALTER TABLE public.or_supplier_profiles
  ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0);
ALTER TABLE public.or_tenant_config
  ADD COLUMN IF NOT EXISTS payables_reserve_days INTEGER NOT NULL DEFAULT 7 CHECK (payables_reserve_days >= 0);
