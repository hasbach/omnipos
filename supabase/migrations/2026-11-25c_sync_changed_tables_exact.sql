-- OmniPOS 1.13.4 — sync_changed_tables compares EXACT pull cursors. Idempotent; replaces 2026-11-25b.
--
-- 1.13.3 registers send "cursor minus the 2-minute pull overlap" as a string, so the rows they last
-- pulled always looked new and every table with data was reported as changed on every check.
-- Cursor values now accepted:
--   null                 -> never pulled: changed if the tenant has any row
--   {"s": ts, "g": uuid} -> 1.13.4+: changed if a row is after (synced_at, global_id) in keyset order
--   "ts" (string)        -> 1.13.3: the overlap is added back (+2 minutes) before comparing
-- 1.13.4 registers also do a full pull (with the overlap) every 15 minutes, which catches a row that
-- committed late with an older synced_at.

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
  v jsonb;
  c timestamptz;
  g text;
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
    v := p_cursors -> k;
    g := '';
    IF jsonb_typeof(v) = 'null' THEN
      c := '-infinity'::timestamptz;
    ELSIF jsonb_typeof(v) = 'string' THEN
      c := (v #>> '{}')::timestamptz + interval '2 minutes';
      g := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    ELSIF jsonb_typeof(v) = 'object' AND jsonb_typeof(v -> 's') = 'string' THEN
      c := (v ->> 's')::timestamptz;
      g := COALESCE(v ->> 'g', '');
    ELSE
      out := out || k;
      CONTINUE;
    END IF;
    IF k = 'tenants' THEN
      SELECT EXISTS (SELECT 1 FROM public.tenants
                      WHERE global_id = uid AND (synced_at > c OR (synced_at = c AND global_id::text > g))) INTO hit;
    ELSIF k IN ('transaction_items', 'payments') THEN
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM public.%I x JOIN public.transactions t ON t.global_id = x.transaction_id
          WHERE x.synced_at >= $2 AND (x.synced_at > $2 OR x.global_id::text > $3) AND t.tenant_id = $1)', k)
        INTO hit USING uid, c, g;
    ELSIF k = 'product_barcodes' THEN
      SELECT EXISTS (
        SELECT 1 FROM public.product_barcodes x JOIN public.products p ON p.global_id = x.product_id
         WHERE x.synced_at >= c AND (x.synced_at > c OR x.global_id::text > g) AND p.tenant_id = uid) INTO hit;
    ELSIF k = ANY (tenant_tables) THEN
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM public.%I WHERE tenant_id = $1 AND synced_at >= $2 AND (synced_at > $2 OR global_id::text > $3))', k)
        INTO hit USING uid, c, g;
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
