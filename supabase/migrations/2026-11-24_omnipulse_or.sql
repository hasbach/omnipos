-- OmniPulse OR (Paid Add-On Module) — Supabase PostgreSQL migration
-- Additive, idempotent, safe to apply before or after desktop update.

ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS or_license_type TEXT DEFAULT 'none';
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS or_license_expiry TIMESTAMP;

-- Extend super-admin license RPC with optional OR license params (backwards-compatible defaults).
CREATE OR REPLACE FUNCTION public.admin_update_tenant_license(
  p_tenant_id UUID,
  p_local_license_type TEXT,
  p_local_license_expiry TIMESTAMP,
  p_online_license_type TEXT,
  p_online_license_expiry TIMESTAMP,
  p_or_license_type TEXT DEFAULT NULL,
  p_or_license_expiry TIMESTAMP DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE public.tenants
  SET local_license_type = p_local_license_type,
      local_license_expiry = p_local_license_expiry,
      online_license_type = p_online_license_type,
      online_license_expiry = p_online_license_expiry,
      or_license_type = COALESCE(p_or_license_type, or_license_type),
      or_license_expiry = CASE WHEN p_or_license_type IS NOT NULL THEN p_or_license_expiry ELSE or_license_expiry END,
      updated_at = now()
  WHERE global_id = p_tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_tenant_license(UUID, TEXT, TIMESTAMP, TEXT, TIMESTAMP, TEXT, TIMESTAMP) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_tenant_license(UUID, TEXT, TIMESTAMP, TEXT, TIMESTAMP, TEXT, TIMESTAMP) TO authenticated;

CREATE TABLE IF NOT EXISTS public.or_tenant_config (
  global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id INTEGER,
  tenant_id UUID NOT NULL UNIQUE REFERENCES public.tenants(global_id) ON DELETE CASCADE,
  business_type TEXT NOT NULL DEFAULT 'RETAIL',
  survival_mode TEXT NOT NULL DEFAULT 'RECOVERY',
  enable_owner_draw INTEGER NOT NULL DEFAULT 1,
  enable_po_cash_lock INTEGER NOT NULL DEFAULT 1,
  enable_cycle_count INTEGER NOT NULL DEFAULT 1,
  enable_recipe_deduction INTEGER NOT NULL DEFAULT 0,
  min_drawer_float NUMERIC NOT NULL DEFAULT 30.0,
  cycle_count_daily_limit INTEGER NOT NULL DEFAULT 8,
  variance_alert_pct NUMERIC NOT NULL DEFAULT 5.0,
  owner_stakeholder_id UUID REFERENCES public.stakeholders(global_id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.or_draw_policies (
  global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id INTEGER,
  tenant_id UUID NOT NULL REFERENCES public.tenants(global_id) ON DELETE CASCADE,
  survival_mode TEXT NOT NULL,
  max_daily_cash NUMERIC NOT NULL DEFAULT 0,
  max_daily_goods_cost NUMERIC NOT NULL DEFAULT 0,
  max_monthly_total NUMERIC NOT NULL DEFAULT 0,
  require_override_reason INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(tenant_id, survival_mode)
);

CREATE TABLE IF NOT EXISTS public.or_fixed_obligations (
  global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id INTEGER,
  tenant_id UUID NOT NULL REFERENCES public.tenants(global_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'opex',
  amount_usd NUMERIC NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'monthly',
  due_day INTEGER DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.or_cash_buckets (
  global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id INTEGER,
  tenant_id UUID NOT NULL REFERENCES public.tenants(global_id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  target_amount NUMERIC NOT NULL DEFAULT 0,
  current_balance NUMERIC NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(tenant_id, code)
);

CREATE TABLE IF NOT EXISTS public.or_cash_bucket_ledger (
  global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id INTEGER,
  tenant_id UUID NOT NULL REFERENCES public.tenants(global_id) ON DELETE CASCADE,
  bucket_id UUID NOT NULL REFERENCES public.or_cash_buckets(global_id) ON DELETE CASCADE,
  tx_type TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  reference_type TEXT,
  reference_id INTEGER,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.or_supplier_profiles (
  global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id INTEGER,
  tenant_id UUID NOT NULL REFERENCES public.tenants(global_id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES public.stakeholders(global_id) ON DELETE CASCADE,
  lead_time_days INTEGER NOT NULL DEFAULT 2,
  fill_rate_score NUMERIC NOT NULL DEFAULT 1.0,
  deliveries_count INTEGER NOT NULL DEFAULT 0,
  default_payment_plan TEXT NOT NULL DEFAULT 'CASH_ON_DELIVERY',
  min_order_usd NUMERIC NOT NULL DEFAULT 0,
  delivery_fee_usd NUMERIC NOT NULL DEFAULT 0,
  delivery_days TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(tenant_id, supplier_id)
);

CREATE TABLE IF NOT EXISTS public.or_owner_draws (
  global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id INTEGER,
  tenant_id UUID NOT NULL REFERENCES public.tenants(global_id) ON DELETE CASCADE,
  owner_user_id UUID REFERENCES public.users(global_id),
  recorded_by_user_id UUID REFERENCES public.users(global_id),
  draw_date TEXT NOT NULL,
  draw_type TEXT NOT NULL,
  cash_amount NUMERIC NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  exchange_rate NUMERIC DEFAULT 1,
  goods_cost_total NUMERIC NOT NULL DEFAULT 0,
  total_draw_value NUMERIC NOT NULL DEFAULT 0,
  cash_source TEXT,
  account_id INTEGER,
  exceeded_cap INTEGER NOT NULL DEFAULT 0,
  override_reason TEXT,
  core_cash_tx_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.or_owner_draw_items (
  global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id INTEGER,
  tenant_id UUID NOT NULL REFERENCES public.tenants(global_id) ON DELETE CASCADE,
  owner_draw_id UUID NOT NULL REFERENCES public.or_owner_draws(global_id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(global_id),
  quantity NUMERIC NOT NULL,
  unit_cost_snapshot NUMERIC NOT NULL DEFAULT 0,
  line_cost_total NUMERIC NOT NULL DEFAULT 0,
  core_stock_tx_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.or_po_commitments (
  global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id INTEGER,
  tenant_id UUID NOT NULL REFERENCES public.tenants(global_id) ON DELETE CASCADE,
  po_number TEXT,
  core_transaction_id INTEGER,
  supplier_id UUID NOT NULL REFERENCES public.stakeholders(global_id),
  expected_delivery_date TEXT NOT NULL,
  payment_plan TEXT NOT NULL DEFAULT 'CASH_ON_DELIVERY',
  estimated_order_total NUMERIC NOT NULL DEFAULT 0,
  locked_cash_amount NUMERIC NOT NULL DEFAULT 0,
  actual_received_total NUMERIC NOT NULL DEFAULT 0,
  actual_cash_paid NUMERIC NOT NULL DEFAULT 0,
  actual_credit_added NUMERIC NOT NULL DEFAULT 0,
  released_cash_amount NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  approved_by_user_id UUID REFERENCES public.users(global_id),
  approved_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.or_po_commitment_items (
  global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id INTEGER,
  tenant_id UUID NOT NULL REFERENCES public.tenants(global_id) ON DELETE CASCADE,
  po_commitment_id UUID NOT NULL REFERENCES public.or_po_commitments(global_id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(global_id),
  ordered_qty NUMERIC NOT NULL,
  received_qty NUMERIC NOT NULL DEFAULT 0,
  unit_cost NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.or_stock_anomalies (
  global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id INTEGER,
  tenant_id UUID NOT NULL REFERENCES public.tenants(global_id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(global_id),
  anomaly_type TEXT NOT NULL,
  reported_by_user_id UUID REFERENCES public.users(global_id),
  status TEXT NOT NULL DEFAULT 'OPEN',
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.or_cycle_count_sessions (
  global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id INTEGER,
  tenant_id UUID NOT NULL REFERENCES public.tenants(global_id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  session_type TEXT NOT NULL DEFAULT 'DAILY_ABC',
  assigned_user_id UUID REFERENCES public.users(global_id),
  status TEXT NOT NULL DEFAULT 'OPEN',
  total_items_planned INTEGER NOT NULL DEFAULT 0,
  total_variance_cost NUMERIC NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.or_cycle_count_items (
  global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id INTEGER,
  tenant_id UUID NOT NULL REFERENCES public.tenants(global_id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES public.or_cycle_count_sessions(global_id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(global_id),
  priority_reason TEXT,
  system_qty_snapshot NUMERIC NOT NULL DEFAULT 0,
  counted_qty NUMERIC,
  variance_qty NUMERIC,
  unit_cost_snapshot NUMERIC NOT NULL DEFAULT 0,
  variance_cost NUMERIC,
  core_adjustment_tx_id INTEGER,
  counted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.or_action_queue (
  global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id INTEGER,
  tenant_id UUID NOT NULL REFERENCES public.tenants(global_id) ON DELETE CASCADE,
  action_date TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'MEDIUM',
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT,
  reference_type TEXT,
  reference_id INTEGER,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- Enable RLS and tenant isolation policy on every synced OR table
DO $$
DECLARE
  t TEXT;
  pol TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'or_tenant_config', 'or_draw_policies', 'or_fixed_obligations',
    'or_cash_buckets', 'or_cash_bucket_ledger', 'or_supplier_profiles',
    'or_owner_draws', 'or_owner_draw_items',
    'or_po_commitments', 'or_po_commitment_items',
    'or_stock_anomalies', 'or_cycle_count_sessions', 'or_cycle_count_items',
    'or_action_queue'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    pol := t || '_tenant_isolation';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = pol
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I USING (tenant_id = auth.uid()) WITH CHECK (tenant_id = auth.uid())',
        pol, t
      );
    END IF;
  END LOOP;
END $$;
