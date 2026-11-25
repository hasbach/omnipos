-- OmniPOS 1.13.2 — OmniPulse OR fixes (cloud side). Idempotent; safe to run more than once.
--
-- 1. Every synced or_* table gets the set_synced_at trigger (like every other synced table since
--    2026-10-07_synced_at.sql). Without it an UPDATE (PO settled, config changed, ...) kept its old
--    synced_at and other registers' pulls never saw it.
-- 2. or_owner_draws.core_cash_global_id: portable link to the Core cash_flow row (the integer
--    core_cash_tx_id is device-local and is no longer pushed).
-- 3. The 5-argument admin_update_tenant_license overload left behind by 2026-11-24 is dropped, so
--    every call resolves to the single 7-argument function (the OR params default to NULL = unchanged).
-- 4. Tenants can no longer edit their own email or license columns through the API. The tenant
--    isolation policy allows a tenant to UPDATE its own row; is_super_admin() trusts tenants.email,
--    and the license columns gate paid features. Only the super admin (via admin_update_tenant_license),
--    the service role and database roles may change them.

-- 1 ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
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
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_synced_at ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_synced_at BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_synced_at()', t, t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_tenant_synced ON public.%I (tenant_id, synced_at, global_id)', t, t);
  END LOOP;
END $$;

-- 2 ---------------------------------------------------------------------------------------------
ALTER TABLE public.or_owner_draws ADD COLUMN IF NOT EXISTS core_cash_global_id TEXT;

-- 3 ---------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_update_tenant_license(UUID, TEXT, TIMESTAMP, TEXT, TIMESTAMP);

-- 4 ---------------------------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: current_user is then the caller's role ('authenticated' for the REST
-- API, the function owner inside the SECURITY DEFINER admin RPC).
CREATE OR REPLACE FUNCTION public.guard_tenant_protected_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') OR public.is_super_admin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.or_license_type := 'none';
    NEW.or_license_expiry := NULL;
    RETURN NEW;
  END IF;
  IF NEW.email IS DISTINCT FROM OLD.email
     OR NEW.global_id IS DISTINCT FROM OLD.global_id
     OR NEW.local_license_type IS DISTINCT FROM OLD.local_license_type
     OR NEW.local_license_expiry IS DISTINCT FROM OLD.local_license_expiry
     OR NEW.online_license_type IS DISTINCT FROM OLD.online_license_type
     OR NEW.online_license_expiry IS DISTINCT FROM OLD.online_license_expiry
     OR NEW.or_license_type IS DISTINCT FROM OLD.or_license_type
     OR NEW.or_license_expiry IS DISTINCT FROM OLD.or_license_expiry THEN
    RAISE EXCEPTION 'Only the OmniPOS administrator can change the account email or licenses.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenants_guard_protected ON public.tenants;
CREATE TRIGGER trg_tenants_guard_protected
  BEFORE INSERT OR UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_protected_columns();
