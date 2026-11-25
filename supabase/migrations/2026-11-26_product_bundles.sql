-- OmniPOS product bundles (docs/superpowers/specs/2026-11-26-product-bundles-design.md).
-- NOT applied automatically. Idempotent: run it in the Supabase SQL editor.
-- Until it runs, the desktop sync skips the product_bundle_items table (one warning, sync keeps
-- working) and strips the new products / transaction_items columns when pushing (cloudMissingColumns
-- in server/sync.ts), so bundle definitions stay on the register that made them. Sales are still
-- complete without it: a sold bundle is stored as ordinary component lines.

-- A product flagged as a bundle (1) sells as a set of existing products.
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS is_bundle INTEGER DEFAULT 0;

-- Components of each bundle: how many base pieces of `component_id` one bundle holds.
-- No REFERENCES on bundle_id / component_id (same as product_units' siblings): products are
-- hard-deleted locally and a stale row must not block a push.
CREATE TABLE IF NOT EXISTS public.product_bundle_items (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID REFERENCES public.tenants(global_id),
    bundle_id UUID,
    component_id UUID,
    quantity NUMERIC NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_bundle_items_tenant_bundle ON public.product_bundle_items (tenant_id, bundle_id);
CREATE INDEX IF NOT EXISTS idx_product_bundle_items_tenant_synced_at ON public.product_bundle_items (tenant_id, synced_at, global_id);

-- Server-time pull cursor, like every synced table (2026-10-07_synced_at.sql).
DROP TRIGGER IF EXISTS trg_product_bundle_items_synced_at ON public.product_bundle_items;
CREATE TRIGGER trg_product_bundle_items_synced_at BEFORE INSERT OR UPDATE ON public.product_bundle_items
FOR EACH ROW EXECUTE FUNCTION public.set_synced_at();

ALTER TABLE public.product_bundle_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Product Bundle Items isolate" ON public.product_bundle_items;
CREATE POLICY "Product Bundle Items isolate" ON public.product_bundle_items
FOR ALL TO authenticated
USING (tenant_id::text = auth.uid()::text)
WITH CHECK (tenant_id::text = auth.uid()::text);

-- Bundle snapshot on the component lines of a bundle sale. bundle_id is a product UUID (translated
-- by the sync's fkMap); no REFERENCES constraint, like uom_id.
ALTER TABLE public.transaction_items ADD COLUMN IF NOT EXISTS bundle_id UUID;
ALTER TABLE public.transaction_items ADD COLUMN IF NOT EXISTS bundle_name TEXT;
ALTER TABLE public.transaction_items ADD COLUMN IF NOT EXISTS bundle_qty NUMERIC;
ALTER TABLE public.transaction_items ADD COLUMN IF NOT EXISTS bundle_line INTEGER;

-- The change check (2026-11-25c_sync_changed_tables_exact.sql) must know the new tenant table;
-- without this, product_bundle_items is reported as changed on every check (pulled every cycle).
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
    'products', 'product_units', 'product_bundle_items', 'stores', 'store_listings', 'orders', 'order_lines', 'order_events',
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
