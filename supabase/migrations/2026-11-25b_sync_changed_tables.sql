-- OmniPOS 1.13.3 — one cheap "what changed?" call per sync cycle. Idempotent.
--
-- Registers used to poll ~17 endpoints every minute even when nothing changed. Every request is a
-- Supabase API-gateway log line (Free plan: 1 GB/month of log ingestion) and egress. A register now
-- sends its pull cursors here and only fetches the tables this returns.
--
-- p_cursors: {"<table>": "<ISO timestamp>" | null, ...}. A table is returned when the caller's tenant
-- has a row with synced_at > its cursor (a null cursor = never pulled: any row counts), or when the
-- table is not one this function knows (the caller then simply pulls it). SECURITY INVOKER: RLS still applies,
-- and every query is additionally scoped to the caller's own tenant (auth.uid() = tenants.global_id).

CREATE OR REPLACE FUNCTION public.sync_changed_tables(p_cursors jsonb)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  k text;
  c timestamptz;
  hit boolean;
  out text[] := '{}';
  tenant_tables text[] := ARRAY[
    'products', 'product_units', 'stores', 'store_listings', 'orders', 'order_lines', 'order_events',
    'stakeholders', 'users', 'transactions', 'currencies', 'settings', 'cash_flow_categories', 'cash_flow',
    'daily_reports', 'cashier_shifts', 'settlement_corrections',
    'or_tenant_config', 'or_draw_policies', 'or_fixed_obligations', 'or_cash_buckets', 'or_cash_bucket_ledger',
    'or_supplier_profiles', 'or_owner_draws', 'or_owner_draw_items', 'or_po_commitments', 'or_po_commitment_items',
    'or_stock_anomalies', 'or_cycle_count_sessions', 'or_cycle_count_items', 'or_action_queue'
  ];
BEGIN
  IF uid IS NULL OR p_cursors IS NULL OR jsonb_typeof(p_cursors) <> 'object' THEN
    RETURN NULL;
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_cursors) LOOP
    IF jsonb_typeof(p_cursors -> k) = 'null' THEN
      c := '-infinity'::timestamptz; -- never pulled: changed only if the tenant has any row at all
    ELSIF jsonb_typeof(p_cursors -> k) = 'string' THEN
      c := (p_cursors ->> k)::timestamptz;
    ELSE
      out := out || k;
      CONTINUE;
    END IF;
    IF k = 'tenants' THEN
      SELECT EXISTS (SELECT 1 FROM public.tenants WHERE global_id = uid AND synced_at > c) INTO hit;
    ELSIF k IN ('transaction_items', 'payments') THEN
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM public.%I x JOIN public.transactions t ON t.global_id = x.transaction_id
          WHERE x.synced_at > $2 AND t.tenant_id = $1)', k)
        INTO hit USING uid, c;
    ELSIF k = 'product_barcodes' THEN
      SELECT EXISTS (
        SELECT 1 FROM public.product_barcodes x JOIN public.products p ON p.global_id = x.product_id
         WHERE x.synced_at > c AND p.tenant_id = uid) INTO hit;
    ELSIF k = ANY (tenant_tables) THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE tenant_id = $1 AND synced_at > $2)', k)
        INTO hit USING uid, c;
    ELSE
      out := out || k;
      CONTINUE;
    END IF;
    IF hit THEN
      out := out || k;
    END IF;
  END LOOP;
  RETURN out;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_changed_tables(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_changed_tables(jsonb) TO authenticated;
