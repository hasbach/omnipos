-- Cash accounts (Cash Drawer + Savings / Safe / Reserve funds) and account-scoped cash_flow / payments.
-- Additive, idempotent, safe to apply before or after desktop update.

CREATE TABLE IF NOT EXISTS public.cash_accounts (
  global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(global_id) ON DELETE CASCADE,
  local_id INTEGER,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'savings' CHECK (kind IN ('drawer', 'savings', 'bank')),
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cash_accounts_tenant ON public.cash_accounts(tenant_id);

ALTER TABLE public.cash_accounts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cash_accounts' AND policyname = 'cash_accounts_tenant_isolation'
  ) THEN
    CREATE POLICY cash_accounts_tenant_isolation ON public.cash_accounts
      USING (tenant_id = auth.uid())
      WITH CHECK (tenant_id = auth.uid());
  END IF;
END $$;

ALTER TABLE public.cash_flow ADD COLUMN IF NOT EXISTS account_id INTEGER;
ALTER TABLE public.cash_flow ADD COLUMN IF NOT EXISTS transfer_id TEXT;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS account_id INTEGER;
