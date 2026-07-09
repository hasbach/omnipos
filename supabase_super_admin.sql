-- Lets the super-admin (hasbach) manage tenant licenses from Live Monitor (web), mirroring
-- the desktop app's SuperAdminDashboard.tsx / POST /api/admin/tenants/:id/license, which
-- currently only works against a local SQLite database on the desktop app's own machine.
--
-- Scope is deliberately narrow:
--   - The RLS bypass below is SELECT-only, and only for the tenants table — hasbach does not
--     gain read/write access to other businesses' products/transactions/customers.
--   - License updates go through a dedicated RPC that touches exactly the four license
--     columns (same as the desktop endpoint) — never password, email, or anything else —
--     even though the function runs as SECURITY DEFINER.

-- Helper: is the calling authenticated session the super-admin?
-- SECURITY DEFINER so this check itself isn't blocked by the very RLS it's used to bypass.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenants WHERE global_id = auth.uid() AND email = 'hasbach'
  );
$$;

REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

-- Additional (not replacing) SELECT policy: RLS policies for the same command are OR'd
-- together, so this lets hasbach see every tenant row while every other tenant keeps seeing
-- only their own, exactly as before.
DROP POLICY IF EXISTS "Super admin read all tenants" ON public.tenants;
CREATE POLICY "Super admin read all tenants" ON public.tenants
FOR SELECT TO authenticated
USING (public.is_super_admin());

-- License update — SECURITY DEFINER (so it can cross tenants), but internally re-checks
-- is_super_admin() itself rather than trusting RLS to have already gated the call.
CREATE OR REPLACE FUNCTION public.admin_update_tenant_license(
  p_tenant_id UUID,
  p_local_license_type TEXT,
  p_local_license_expiry TIMESTAMP,
  p_online_license_type TEXT,
  p_online_license_expiry TIMESTAMP
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
      updated_at = now()
  WHERE global_id = p_tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_tenant_license(UUID, TEXT, TIMESTAMP, TEXT, TIMESTAMP) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_tenant_license(UUID, TEXT, TIMESTAMP, TEXT, TIMESTAMP) TO authenticated;
