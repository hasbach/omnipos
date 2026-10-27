-- OmniPOS retail ordering, Slice 2 (online orders) — specs/003-retail-ordering/contracts/cloud-api-s2.md,
-- data-model-s2.md, research R12–R25.
--
-- Run AFTER 2026-10-21_retail_ordering_s1.sql, in the Supabase SQL editor, then
-- supabase/checks/2026-10-23_retail_ordering_s2_checks.sql. Safe to re-run.
--
-- Orders are cloud-authoritative: owners may only READ orders / order_lines / order_events (RLS); every write
-- goes through the functions below, which lock the order and check its current state, so across registers
-- exactly one conflicting action wins. Anonymous visitors never touch a table: the four public functions are
-- reachable only with the storefront's gateway key (storefront_gateway_keys holds its SHA-256). The key hash
-- is inserted separately by the owner (quickstart-s2 §1); until then every public call returns 'gateway'.
--
-- Nothing here changes stock, invoices, payments or balances (spec FR-038). Hashes use the core sha256()
-- function, so no extension is needed.

BEGIN;

-- ---- tables --------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.orders (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID NOT NULL REFERENCES public.tenants(global_id),
    store_id UUID NOT NULL REFERENCES public.stores(global_id),
    number INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'submitted'
        CHECK (state IN ('submitted', 'confirmed', 'ready', 'completed', 'rejected', 'cancelled', 'expired')),
    cancelled_by TEXT CHECK (cancelled_by IS NULL OR cancelled_by IN ('customer', 'shop')),
    reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 300),
    customer_name TEXT NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 80),
    customer_phone TEXT NOT NULL,
    fulfilment TEXT NOT NULL CHECK (fulfilment IN ('pickup', 'delivery')),
    address TEXT CHECK (address IS NULL OR char_length(address) <= 300),
    note TEXT CHECK (note IS NULL OR char_length(note) <= 300),
    local_currency TEXT,
    local_rate NUMERIC,
    total_usd NUMERIC(14, 2) NOT NULL,
    total_local NUMERIC,
    confirmed_total_usd NUMERIC(14, 2),
    confirmed_total_local NUMERIC,
    sale_global_id UUID,
    sale_total_usd NUMERIC(14, 2),
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    confirmed_at TIMESTAMPTZ,
    ready_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    idempotency_key TEXT NOT NULL,
    status_key_hash TEXT NOT NULL,
    network_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP,
    UNIQUE (store_id, number),
    UNIQUE (store_id, idempotency_key),
    UNIQUE (status_key_hash)
);

CREATE TABLE IF NOT EXISTS public.order_lines (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID NOT NULL REFERENCES public.tenants(global_id),
    order_id UUID NOT NULL REFERENCES public.orders(global_id),
    line_no SMALLINT NOT NULL CHECK (line_no BETWEEN 1 AND 50),
    listing_id UUID,
    product_id UUID REFERENCES public.products(global_id),
    product_name TEXT NOT NULL,
    unit_key TEXT NOT NULL,
    unit_name TEXT,
    unit_factor NUMERIC NOT NULL DEFAULT 1,
    ordered_qty NUMERIC NOT NULL CHECK (ordered_qty > 0 AND ordered_qty <= 999),
    confirmed_qty NUMERIC CHECK (confirmed_qty IS NULL OR (confirmed_qty >= 0 AND confirmed_qty <= ordered_qty)),
    shortfall_reason TEXT CHECK (shortfall_reason IS NULL OR shortfall_reason IN ('out_of_stock', 'damaged', 'customer_request', 'other')),
    unit_price_usd NUMERIC(14, 2) NOT NULL,
    unit_price_local NUMERIC,
    line_total_usd NUMERIC(14, 2) NOT NULL,
    line_total_local NUMERIC,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP,
    UNIQUE (order_id, line_no)
);

CREATE TABLE IF NOT EXISTS public.order_events (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID NOT NULL REFERENCES public.tenants(global_id),
    order_id UUID NOT NULL REFERENCES public.orders(global_id),
    at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    kind TEXT NOT NULL CHECK (kind IN ('submitted', 'confirmed', 'adjusted', 'ready', 'rejected', 'cancelled', 'expired',
                                       'completed', 'completion_undone')),
    from_state TEXT,
    to_state TEXT,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('customer', 'user', 'system')),
    actor_name TEXT,
    terminal TEXT,
    reason TEXT,
    detail JSONB,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);

-- Private tables: RLS on and no policy, so only the SECURITY DEFINER functions below can reach them.
CREATE TABLE IF NOT EXISTS public.order_counters (
    store_id UUID PRIMARY KEY REFERENCES public.stores(global_id),
    last_no INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS public.order_blocked_phones (
    tenant_id UUID NOT NULL REFERENCES public.tenants(global_id),
    store_id UUID NOT NULL REFERENCES public.stores(global_id),
    phone TEXT NOT NULL,
    note TEXT CHECK (note IS NULL OR char_length(note) <= 120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (store_id, phone)
);

CREATE TABLE IF NOT EXISTS public.storefront_gateway_keys (
    key_hash TEXT PRIMARY KEY,
    label TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

-- The POS sale that fulfilled an order (desktop pushes it once the cloud has the column).
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS order_global_id UUID;

-- ---- indexes -------------------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_orders_phone_window ON public.orders (store_id, customer_phone, submitted_at);
CREATE INDEX IF NOT EXISTS idx_orders_network_window ON public.orders (network_hash, submitted_at);
CREATE INDEX IF NOT EXISTS idx_orders_tenant_state ON public.orders (tenant_id, state);
CREATE INDEX IF NOT EXISTS idx_order_lines_order ON public.order_lines (order_id);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON public.order_events (order_id);

-- ---- server-time pull cursor (same as 2026-10-07_synced_at.sql) ----------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['orders', 'order_lines', 'order_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS synced_at timestamptz NOT NULL DEFAULT now()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_synced_at ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_synced_at BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_synced_at()', t, t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_tenant_synced_at ON public.%I (tenant_id, synced_at, global_id)', t, t);
  END LOOP;
END;
$$;

-- ---- row level security --------------------------------------------------------------------------
-- Owners read their own orders (the desktop sync pulls them); nobody writes them directly.

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Orders owner read" ON public.orders;
CREATE POLICY "Orders owner read" ON public.orders
FOR SELECT TO authenticated USING (tenant_id::text = auth.uid()::text);

ALTER TABLE public.order_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Order Lines owner read" ON public.order_lines;
CREATE POLICY "Order Lines owner read" ON public.order_lines
FOR SELECT TO authenticated USING (tenant_id::text = auth.uid()::text);

ALTER TABLE public.order_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Order Events owner read" ON public.order_events;
CREATE POLICY "Order Events owner read" ON public.order_events
FOR SELECT TO authenticated USING (tenant_id::text = auth.uid()::text);

ALTER TABLE public.order_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_blocked_phones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storefront_gateway_keys ENABLE ROW LEVEL SECURITY;

-- Table privileges on top of RLS (Supabase grants ALL on new tables to anon/authenticated by default).
REVOKE ALL ON public.orders, public.order_lines, public.order_events FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.orders, public.order_lines, public.order_events FROM authenticated;
REVOKE ALL ON public.order_counters, public.order_blocked_phones, public.storefront_gateway_keys FROM anon, authenticated;

-- ---- settings defaults: + order_expiry_hours (Slice 1 defaults unchanged) --------------------------

CREATE OR REPLACE FUNCTION public._store_public_settings(p_settings text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  defaults jsonb := '{"show_exact_stock":0,"hide_out_of_stock":0,"show_local_price":1,"category_order":[],"ordering_mode":"off","pickup_enabled":1,"pickup_note":"","delivery_enabled":0,"delivery_note":"","min_order_usd":null,"order_expiry_hours":24}'::jsonb;
BEGIN
  RETURN defaults || coalesce(nullif(btrim(p_settings), '')::jsonb, '{}'::jsonb);
EXCEPTION WHEN others THEN
  RETURN defaults;
END;
$$;
REVOKE ALL ON FUNCTION public._store_public_settings(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._store_public_settings(text) FROM anon;
REVOKE ALL ON FUNCTION public._store_public_settings(text) FROM authenticated;

-- ---- internal helpers ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._order_sha256(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex')
$$;

-- The storefront's gateway key is valid (its hash is listed and not revoked).
CREATE OR REPLACE FUNCTION public._gateway_ok(p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(length(p_key), 0) >= 32 AND EXISTS (
    SELECT 1 FROM public.storefront_gateway_keys k
    WHERE k.key_hash = public._order_sha256(p_key) AND k.revoked_at IS NULL
  )
$$;

-- Phone in international form, same rule as storefront/src/phone.ts (whatsappDigits): a number typed
-- without a country code is Lebanese. '+<8–15 digits>' or NULL.
CREATE OR REPLACE FUNCTION public._order_phone(p text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  t text := btrim(coalesce(p, ''));
  d text := regexp_replace(t, '\D', '', 'g');
BEGIN
  IF left(t, 1) = '+' THEN
    NULL;
  ELSIF left(d, 2) = '00' THEN
    d := substr(d, 3);
  ELSE
    IF left(d, 1) = '0' THEN d := substr(d, 2); END IF;
    IF length(d) IN (7, 8) THEN d := '961' || d; END IF;
  END IF;
  IF length(d) BETWEEN 8 AND 15 THEN RETURN '+' || d; END IF;
  RETURN NULL;
END;
$$;

-- Base unit sold by measure (kg, l, m …): quantities may have up to 3 decimals. Same list as
-- storefront/src/ordering.ts isMeasuredUnit.
CREATE OR REPLACE FUNCTION public._order_measured(p_unit text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT lower(regexp_replace(btrim(coalesce(p_unit, '')), '\.$', '')) = ANY (ARRAY[
    'kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'kilogramme', 'g', 'gr', 'gram', 'grams', 'gramme',
    'l', 'lt', 'ltr', 'liter', 'liters', 'litre', 'litres', 'ml', 'm', 'meter', 'metre', 'mètre', 'cm',
    'كغ', 'كلغ', 'كيلو', 'كيلوغرام', 'غ', 'غرام', 'ل', 'لتر', 'مل', 'م', 'متر', 'سم'])
$$;

-- Re-price and validate a cart against the store's CURRENT public catalog (research R14). Totals use the
-- storefront's rounding (cart.js lineAmounts): line USD = round(price × qty, 2); local unit = the unit's own
-- price_lbp when > 0, else round(USD × rate); line local = round(local unit × qty). Lines with a blocking
-- problem are returned with "ok": false and left out of the totals; 'price_changed' is informational.
CREATE OR REPLACE FUNCTION public._order_quote(p_store uuid, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.stores%ROWTYPE;
  cfg jsonb;
  cur record;
  v_rate numeric;
  ln jsonb;
  i integer := 0;
  keys text[];
  v_product uuid;
  v_title text;
  v_stock_state text;
  v_base_unit text;
  v_min_q numeric;
  v_base_price numeric;
  v_base_plbp numeric;
  v_listing uuid;
  v_unit text;
  v_qty numeric;
  v_sent numeric;
  v_price numeric;
  v_plbp numeric;
  v_local numeric;
  v_name text;
  v_factor numeric;
  v_problem text;
  v_line_usd numeric;
  v_line_local numeric;
  out_lines jsonb := '[]'::jsonb;
  problems jsonb := '[]'::jsonb;
  base_qty jsonb := '{}'::jsonb;
  min_qty jsonb := '{}'::jsonb;
  tot_usd numeric := 0;
  tot_local numeric := 0;
  local_ok boolean;
  v_min numeric;
  k text;
BEGIN
  SELECT * INTO s FROM public.stores WHERE global_id = p_store;
  cfg := public._store_public_settings(s.settings);

  SELECT cu.code, cu.rate INTO cur
  FROM public.currencies cu
  WHERE cu.tenant_id = s.tenant_id AND cu.deleted_at IS NULL AND upper(cu.code) <> 'USD'
  ORDER BY cu.local_id NULLS LAST
  LIMIT 1;
  v_rate := CASE WHEN cur.rate > 0 THEN cur.rate END;
  local_ok := cur.code IS NOT NULL;

  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    problems := problems || jsonb_build_object('code', 'empty');
  ELSIF jsonb_array_length(p_lines) > 50 THEN
    problems := problems || jsonb_build_object('code', 'too_many_lines');
  ELSE
    FOR ln IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      i := i + 1;
      v_problem := NULL; v_price := NULL; v_plbp := NULL; v_name := NULL; v_factor := 1; v_qty := NULL;
      v_listing := NULL; v_product := NULL; v_title := NULL; v_stock_state := NULL; v_base_unit := NULL; v_min_q := NULL;
      v_unit := ln->>'unit';

      IF coalesce(ln->>'listing', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_problem := 'listing_unavailable';
      ELSE
        v_listing := (ln->>'listing')::uuid;
        SELECT pr.product_id, pr.title, pr.stock_state, pr.unit, pr.min_quantity, pr.price, pr.price_lbp
        INTO v_product, v_title, v_stock_state, v_base_unit, v_min_q, v_base_price, v_base_plbp
        FROM public._store_public_rows(p_store, false) pr WHERE pr.listing_id = v_listing;
        IF NOT FOUND THEN v_problem := 'listing_unavailable'; END IF;
      END IF;

      IF v_problem IS NULL THEN
        SELECT public._store_orderable_keys(sl.orderable_unit_ids) INTO keys FROM public.store_listings sl WHERE sl.global_id = v_listing;
        IF v_unit = 'base' THEN
          IF keys IS NOT NULL AND NOT ('base' = ANY (keys)) THEN v_problem := 'unit_not_orderable'; END IF;
          v_price := v_base_price; v_plbp := v_base_plbp; v_name := v_base_unit; v_factor := 1;
        ELSIF coalesce(v_unit, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          SELECT pu.name, coalesce(pu.factor, 1), pu.price, pu.price_lbp INTO v_name, v_factor, v_price, v_plbp
          FROM public.product_units pu
          WHERE pu.global_id = v_unit::uuid AND pu.product_id = v_product AND pu.deleted_at IS NULL
            AND (keys IS NULL OR v_unit = ANY (keys));
          IF NOT FOUND THEN v_problem := 'unit_not_orderable'; v_factor := 1; END IF;
        ELSE
          v_problem := 'unit_not_orderable';
        END IF;
      END IF;

      IF v_problem IS NULL AND v_stock_state = 'out_of_stock' THEN v_problem := 'out_of_stock'; END IF;

      IF v_problem IS NULL THEN
        IF jsonb_typeof(ln->'qty') <> 'number' THEN
          v_problem := 'invalid_quantity';
        ELSE
          v_qty := (ln->>'qty')::numeric;
          IF v_qty <= 0 OR v_qty > 999 THEN
            v_problem := 'invalid_quantity';
          ELSIF v_unit = 'base' AND public._order_measured(v_base_unit) THEN
            IF round(v_qty, 3) <> v_qty THEN v_problem := 'invalid_quantity'; END IF;
          ELSIF v_qty <> trunc(v_qty) THEN
            v_problem := 'invalid_quantity';
          END IF;
        END IF;
      END IF;

      IF v_problem IS NULL THEN
        v_line_usd := round(v_price * v_qty, 2);
        v_local := CASE WHEN NOT local_ok THEN NULL
                        WHEN v_plbp IS NOT NULL AND v_plbp > 0 THEN v_plbp
                        WHEN v_rate IS NOT NULL THEN round(v_price * v_rate)
                        ELSE NULL END;
        v_line_local := CASE WHEN v_local IS NULL THEN NULL ELSE round(v_local * v_qty) END;
        tot_usd := tot_usd + v_line_usd;
        IF v_line_local IS NULL THEN local_ok := false; ELSE tot_local := tot_local + v_line_local; END IF;
        k := v_listing::text;
        base_qty := jsonb_set(base_qty, ARRAY[k], to_jsonb(coalesce((base_qty->>k)::numeric, 0) + v_qty * v_factor));
        IF v_min_q IS NOT NULL AND v_min_q > 0 THEN
          min_qty := jsonb_set(min_qty, ARRAY[k], to_jsonb(v_min_q));
        END IF;
        IF jsonb_typeof(ln->'price') = 'number' AND (ln->>'price')::numeric <> v_price THEN
          problems := problems || jsonb_build_object('line', i, 'code', 'price_changed');
        END IF;
      ELSE
        problems := problems || jsonb_build_object('line', i, 'code', v_problem);
      END IF;

      out_lines := out_lines || jsonb_build_object(
        'line', i, 'ok', v_problem IS NULL, 'problem', v_problem,
        'listing', ln->>'listing', 'unit', v_unit, 'qty', v_qty,
        'product_id', v_product, 'product_name', v_title,
        'unit_name', v_name, 'unit_factor', v_factor,
        'unit_price_usd', v_price, 'unit_price_local', CASE WHEN v_problem IS NULL THEN v_local END,
        'line_total_usd', CASE WHEN v_problem IS NULL THEN v_line_usd END,
        'line_total_local', CASE WHEN v_problem IS NULL THEN v_line_local END);
    END LOOP;

    -- Listing minimum, in base units, summed over the listing's lines (Slice 1 rule).
    FOR k IN SELECT jsonb_object_keys(min_qty) LOOP
      v_min := (min_qty->>k)::numeric;
      IF coalesce((base_qty->>k)::numeric, 0) < v_min THEN
        SELECT (l->>'line')::int INTO i FROM jsonb_array_elements(out_lines) l WHERE l->>'listing' = k LIMIT 1;
        problems := problems || jsonb_build_object('line', i, 'code', 'below_listing_minimum', 'min', v_min);
      END IF;
    END LOOP;

    IF jsonb_typeof(cfg->'min_order_usd') = 'number' AND (cfg->>'min_order_usd')::numeric > 0
       AND tot_usd < (cfg->>'min_order_usd')::numeric THEN
      problems := problems || jsonb_build_object('code', 'below_store_minimum', 'min', (cfg->>'min_order_usd')::numeric);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'lines', out_lines,
    'total_usd', tot_usd,
    'total_local', CASE WHEN local_ok THEN tot_local END,
    'local', CASE WHEN cur.code IS NOT NULL THEN jsonb_build_object('code', cur.code, 'rate', v_rate) END,
    'problems', problems);
END;
$$;

-- One history row.
CREATE OR REPLACE FUNCTION public._order_event(
  p_order public.orders, p_kind text, p_from text, p_to text, p_actor_kind text, p_actor jsonb,
  p_reason text DEFAULT NULL, p_detail jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.order_events (tenant_id, order_id, kind, from_state, to_state, actor_kind, actor_name, terminal, reason, detail)
  VALUES (p_order.tenant_id, p_order.global_id, p_kind, p_from, p_to, p_actor_kind,
          left(nullif(btrim(coalesce(p_actor->>'name', '')), ''), 80),
          left(nullif(btrim(coalesce(p_actor->>'terminal', '')), ''), 40),
          p_reason, p_detail)
$$;

-- Overdue New orders become Expired (research R17). Called by every order function and by orders_sweep.
CREATE OR REPLACE FUNCTION public._orders_expire(p_tenant uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  WITH x AS (
    UPDATE public.orders SET state = 'expired', closed_at = now(), updated_at = now()
    WHERE tenant_id = p_tenant AND state = 'submitted' AND expires_at < now()
    RETURNING global_id, tenant_id
  )
  INSERT INTO public.order_events (tenant_id, order_id, kind, from_state, to_state, actor_kind)
  SELECT tenant_id, global_id, 'expired', 'submitted', 'expired', 'system' FROM x;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Lines of an order as JSON (owner and public views share it).
CREATE OR REPLACE FUNCTION public._order_lines_json(p_order uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(l) - 'tenant_id' - 'local_id' - 'deleted_at' - 'synced_at' ORDER BY l.line_no), '[]'::jsonb)
  FROM public.order_lines l WHERE l.order_id = p_order
$$;

-- What the customer's private status page may show (FR-042/FR-043): first name only, no phone, note or keys.
CREATE OR REPLACE FUNCTION public._order_public(o public.orders)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'number', 'W-' || o.number,
    'state', CASE WHEN o.state = 'submitted' AND o.expires_at < now() THEN 'expired' ELSE o.state END,
    'reason', CASE WHEN o.state = 'rejected' OR (o.state = 'cancelled' AND o.cancelled_by = 'shop') THEN o.reason END,
    'cancelled_by', o.cancelled_by,
    'first_name', split_part(btrim(o.customer_name), ' ', 1),
    'fulfilment', o.fulfilment,
    'address', CASE WHEN o.fulfilment = 'delivery' THEN o.address END,
    'submitted_at', o.submitted_at, 'confirmed_at', o.confirmed_at, 'ready_at', o.ready_at, 'closed_at', o.closed_at,
    'total_usd', o.total_usd, 'total_local', o.total_local,
    'confirmed_total_usd', o.confirmed_total_usd, 'confirmed_total_local', o.confirmed_total_local,
    'local_currency', o.local_currency,
    'lines', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'product_name', l.product_name, 'unit_name', l.unit_name, 'ordered_qty', l.ordered_qty,
                'confirmed_qty', l.confirmed_qty, 'shortfall_reason', l.shortfall_reason,
                'unit_price_usd', l.unit_price_usd, 'unit_price_local', l.unit_price_local,
                'line_total_usd', l.line_total_usd, 'line_total_local', l.line_total_local) ORDER BY l.line_no), '[]'::jsonb)
              FROM public.order_lines l WHERE l.order_id = o.global_id),
    'store', (SELECT jsonb_build_object('slug', s.slug, 'name', s.name, 'logo_path', s.logo_path,
                'contact_phone', s.contact_phone, 'contact_whatsapp', s.contact_whatsapp, 'contact_email', s.contact_email,
                'default_language', s.default_language,
                'pickup_note', left(btrim(coalesce(public._store_public_settings(s.settings)->>'pickup_note', '')), 200))
              FROM public.stores s WHERE s.global_id = o.store_id))
$$;

-- Owner result: the full row minus the cloud-only secrets, with lines.
CREATE OR REPLACE FUNCTION public._order_owner_result(o public.orders, p_ok boolean, p_code text, p_extra jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'ok', p_ok, 'code', p_code,
    'order', CASE WHEN o.global_id IS NULL THEN NULL
                  ELSE to_jsonb(o) - 'network_hash' - 'idempotency_key' - 'status_key_hash' - 'local_id' END,
    'lines', CASE WHEN o.global_id IS NULL THEN '[]'::jsonb ELSE public._order_lines_json(o.global_id) END
  ) || coalesce(p_extra, '{}'::jsonb)
$$;

-- ---- public functions (storefront only: gateway key required) ------------------------------------

-- Re-price a cart for the checkout's review step. Read-only.
CREATE OR REPLACE FUNCTION public.order_quote(p_gateway text, p_slug text, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.stores%ROWTYPE;
  cfg jsonb;
BEGIN
  IF NOT public._gateway_ok(p_gateway) THEN RETURN jsonb_build_object('ok', false, 'code', 'gateway'); END IF;
  SELECT * INTO s FROM public._store_public_store(p_slug, NULL);
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'store_unavailable'); END IF;
  cfg := public._store_public_settings(s.settings);
  IF cfg->>'ordering_mode' IS DISTINCT FROM 'online'
     OR NOT (public._store_setting_on(cfg->'pickup_enabled') OR public._store_setting_on(cfg->'delivery_enabled')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'store_unavailable');
  END IF;
  RETURN jsonb_build_object('ok', true, 'code', 'ok', 'quote', public._order_quote(s.global_id, p_lines));
END;
$$;

-- Place an order (contracts/cloud-api-s2.md "order_submit": the checks run in this order).
CREATE OR REPLACE FUNCTION public.order_submit(
  p_gateway text, p_slug text, p_idempotency text, p_status_key text, p_network text,
  p_customer jsonb, p_lines jsonb, p_expected_total_usd numeric, p_trap text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.stores%ROWTYPE;
  cfg jsonb;
  o public.orders%ROWTYPE;
  q jsonb;
  ln jsonb;
  v_hash text;
  v_name text := btrim(coalesce(p_customer->>'name', ''));
  v_phone text := public._order_phone(p_customer->>'phone');
  v_fulfilment text := p_customer->>'fulfilment';
  v_address text := nullif(btrim(coalesce(p_customer->>'address', '')), '');
  v_note text := nullif(btrim(coalesce(p_customer->>'note', '')), '');
  v_hours integer;
  v_no integer;
  v_blocking boolean;
  invalid jsonb := NULL;
BEGIN
  IF NOT public._gateway_ok(p_gateway) THEN RETURN jsonb_build_object('ok', false, 'code', 'gateway'); END IF;
  SELECT * INTO s FROM public._store_public_store(p_slug, NULL);
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'store_unavailable'); END IF;
  cfg := public._store_public_settings(s.settings);
  IF cfg->>'ordering_mode' IS DISTINCT FROM 'online'
     OR NOT (public._store_setting_on(cfg->'pickup_enabled') OR public._store_setting_on(cfg->'delivery_enabled')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'store_unavailable');
  END IF;
  PERFORM public._orders_expire(s.tenant_id);

  IF coalesce(p_idempotency, '') !~ '^[A-Za-z0-9-]{8,64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid', 'field', 'attempt');
  END IF;
  IF coalesce(p_status_key, '') !~ '^[A-Za-z0-9_-]{32}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid', 'field', 'status_key');
  END IF;
  v_hash := public._order_sha256(p_status_key);

  -- A retry of the same checkout (dropped connection, double tap) gets the same order (FR-020).
  SELECT * INTO o FROM public.orders WHERE store_id = s.global_id AND idempotency_key = p_idempotency;
  IF FOUND THEN
    IF o.status_key_hash = v_hash THEN
      RETURN jsonb_build_object('ok', true, 'code', 'existing', 'number', 'W-' || o.number, 'order', public._order_public(o));
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'refused');
  END IF;

  IF coalesce(btrim(p_trap), '') <> '' THEN RETURN jsonb_build_object('ok', false, 'code', 'refused'); END IF;

  IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN invalid := jsonb_build_object('field', 'name');
  ELSIF v_phone IS NULL THEN invalid := jsonb_build_object('field', 'phone');
  ELSIF v_fulfilment IS NULL OR v_fulfilment NOT IN ('pickup', 'delivery')
        OR NOT public._store_setting_on(cfg->(v_fulfilment || '_enabled')) THEN invalid := jsonb_build_object('field', 'fulfilment');
  ELSIF v_fulfilment = 'delivery' AND v_address IS NULL THEN invalid := jsonb_build_object('field', 'address');
  ELSIF char_length(coalesce(v_address, '')) > 300 THEN invalid := jsonb_build_object('field', 'address');
  ELSIF char_length(coalesce(v_note, '')) > 300 THEN invalid := jsonb_build_object('field', 'note');
  ELSIF coalesce(p_network, '') !~ '^[0-9a-f]{16,128}$' THEN invalid := jsonb_build_object('field', 'network');
  END IF;
  IF invalid IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'invalid') || invalid; END IF;

  IF EXISTS (SELECT 1 FROM public.order_blocked_phones b WHERE b.store_id = s.global_id AND b.phone = v_phone) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'refused');
  END IF;

  -- Abuse limits (FR-041, research R16): per phone per store, then per network.
  IF (SELECT count(*) FROM public.orders WHERE store_id = s.global_id AND customer_phone = v_phone
        AND submitted_at > now() - interval '1 hour') >= 5
     OR (SELECT count(*) FROM public.orders WHERE store_id = s.global_id AND customer_phone = v_phone
        AND state = 'submitted') >= 3 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'phone_limit');
  END IF;
  IF (SELECT count(*) FROM public.orders WHERE store_id = s.global_id AND network_hash = p_network
        AND submitted_at > now() - interval '1 hour') >= 10
     OR (SELECT count(*) FROM public.orders WHERE network_hash = p_network
        AND submitted_at > now() - interval '1 hour') >= 30 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'network_limit');
  END IF;

  -- Prices come from the catalog, never from the browser (FR-018): any difference returns the fresh quote.
  q := public._order_quote(s.global_id, p_lines);
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(q->'problems')) INTO v_blocking;
  IF v_blocking OR p_expected_total_usd IS NULL OR round(p_expected_total_usd, 2) <> round((q->>'total_usd')::numeric, 2) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'changed', 'quote', q);
  END IF;

  v_hours := CASE WHEN jsonb_typeof(cfg->'order_expiry_hours') = 'number'
                  THEN least(greatest((cfg->>'order_expiry_hours')::numeric::int, 1), 72) ELSE 24 END;

  BEGIN
    INSERT INTO public.order_counters (store_id, last_no) VALUES (s.global_id, 1001)
    ON CONFLICT (store_id) DO UPDATE SET last_no = public.order_counters.last_no + 1
    RETURNING last_no INTO v_no;

    INSERT INTO public.orders (tenant_id, store_id, number, state, customer_name, customer_phone, fulfilment, address, note,
                               local_currency, local_rate, total_usd, total_local, submitted_at, expires_at,
                               idempotency_key, status_key_hash, network_hash)
    VALUES (s.tenant_id, s.global_id, v_no, 'submitted', v_name, v_phone, v_fulfilment,
            CASE WHEN v_fulfilment = 'delivery' THEN v_address END, v_note,
            q->'local'->>'code', (q->'local'->>'rate')::numeric,
            (q->>'total_usd')::numeric, (q->>'total_local')::numeric, now(), now() + make_interval(hours => v_hours),
            p_idempotency, v_hash, p_network)
    RETURNING * INTO o;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO o FROM public.orders WHERE store_id = s.global_id AND idempotency_key = p_idempotency;
    IF FOUND AND o.status_key_hash = v_hash THEN
      RETURN jsonb_build_object('ok', true, 'code', 'existing', 'number', 'W-' || o.number, 'order', public._order_public(o));
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'refused');
  END;

  FOR ln IN SELECT * FROM jsonb_array_elements(q->'lines') LOOP
    INSERT INTO public.order_lines (tenant_id, order_id, line_no, listing_id, product_id, product_name, unit_key, unit_name,
                                    unit_factor, ordered_qty, unit_price_usd, unit_price_local, line_total_usd, line_total_local)
    VALUES (o.tenant_id, o.global_id, (ln->>'line')::smallint, (ln->>'listing')::uuid, (ln->>'product_id')::uuid,
            ln->>'product_name', ln->>'unit', ln->>'unit_name', (ln->>'unit_factor')::numeric, (ln->>'qty')::numeric,
            (ln->>'unit_price_usd')::numeric, (ln->>'unit_price_local')::numeric,
            (ln->>'line_total_usd')::numeric, (ln->>'line_total_local')::numeric);
  END LOOP;
  PERFORM public._order_event(o, 'submitted', NULL, 'submitted', 'customer', NULL);

  RETURN jsonb_build_object('ok', true, 'code', 'created', 'number', 'W-' || o.number, 'order', public._order_public(o));
END;
$$;

-- The customer's status page.
CREATE OR REPLACE FUNCTION public.order_status(p_gateway text, p_status_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.orders%ROWTYPE;
BEGIN
  IF NOT public._gateway_ok(p_gateway) THEN RETURN jsonb_build_object('ok', false, 'code', 'gateway'); END IF;
  SELECT * INTO o FROM public.orders WHERE status_key_hash = public._order_sha256(p_status_key);
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  PERFORM public._orders_expire(o.tenant_id);
  SELECT * INTO o FROM public.orders WHERE global_id = o.global_id;
  RETURN jsonb_build_object('ok', true, 'code', 'ok', 'order', public._order_public(o));
END;
$$;

-- The customer cancels a New order.
CREATE OR REPLACE FUNCTION public.order_cancel(p_gateway text, p_status_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.orders%ROWTYPE;
BEGIN
  IF NOT public._gateway_ok(p_gateway) THEN RETURN jsonb_build_object('ok', false, 'code', 'gateway'); END IF;
  SELECT * INTO o FROM public.orders WHERE status_key_hash = public._order_sha256(p_status_key);
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  PERFORM public._orders_expire(o.tenant_id);
  SELECT * INTO o FROM public.orders WHERE global_id = o.global_id FOR UPDATE;
  IF o.state <> 'submitted' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_cancellable', 'order', public._order_public(o));
  END IF;
  UPDATE public.orders SET state = 'cancelled', cancelled_by = 'customer', closed_at = now(), updated_at = now()
  WHERE global_id = o.global_id RETURNING * INTO o;
  PERFORM public._order_event(o, 'cancelled', 'submitted', 'cancelled', 'customer', NULL);
  RETURN jsonb_build_object('ok', true, 'code', 'cancelled', 'order', public._order_public(o));
END;
$$;

-- ---- owner functions (the desktop, with the shop's session) --------------------------------------
-- p_expected_state is the state the user saw: when it no longer matches, the call returns 'handled' with
-- the current row, so the second of two users acting at once is told what happened (FR-027, US4 AS5).

-- Shared preamble: expire, lock, compare. Returns the refusal JSON, or NULL to go on.
CREATE OR REPLACE FUNCTION public._order_owner_check(o public.orders, p_expected text, p_allowed text[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF o.global_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found', 'order', NULL, 'lines', '[]'::jsonb); END IF;
  IF o.state = 'expired' AND p_expected = 'submitted' THEN RETURN public._order_owner_result(o, false, 'expired'); END IF;
  IF o.state IS DISTINCT FROM p_expected THEN RETURN public._order_owner_result(o, false, 'handled'); END IF;
  IF NOT (o.state = ANY (p_allowed)) THEN RETURN public._order_owner_result(o, false, 'invalid_transition'); END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public._order_lock(p_order uuid)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RETURN o; END IF;
  PERFORM public._orders_expire(auth.uid());
  SELECT * INTO o FROM public.orders WHERE global_id = p_order AND tenant_id::text = auth.uid()::text FOR UPDATE;
  RETURN o;
END;
$$;

CREATE OR REPLACE FUNCTION public.order_accept(p_order uuid, p_expected_state text, p_lines jsonb, p_actor jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.orders%ROWTYPE := public._order_lock(p_order);
  refusal jsonb := public._order_owner_check(o, p_expected_state, ARRAY['submitted']);
  ol record;
  given jsonb;
  v_conf numeric;
  v_reason text;
  changes jsonb := '[]'::jsonb;
  any_kept boolean := false;
BEGIN
  IF refusal IS NOT NULL THEN RETURN refusal; END IF;
  IF p_lines IS NOT NULL AND jsonb_typeof(p_lines) <> 'array' THEN
    RETURN public._order_owner_result(o, false, 'invalid');
  END IF;

  -- Validate every given line first; nothing is written unless all pass.
  FOR ol IN SELECT * FROM public.order_lines WHERE order_id = o.global_id ORDER BY line_no LOOP
    SELECT e INTO given FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e WHERE (e->>'line_no')::int = ol.line_no LIMIT 1;
    IF given IS NULL THEN
      v_conf := ol.ordered_qty; v_reason := NULL;
    ELSE
      IF jsonb_typeof(given->'confirmed_qty') <> 'number' OR (given->>'confirmed_qty')::numeric < 0 THEN
        RETURN public._order_owner_result(o, false, 'invalid', jsonb_build_object('line_no', ol.line_no));
      END IF;
      v_conf := (given->>'confirmed_qty')::numeric;
      v_reason := nullif(given->>'reason', '');
      IF v_conf > ol.ordered_qty THEN
        RETURN public._order_owner_result(o, false, 'confirm_exceeds', jsonb_build_object('line_no', ol.line_no));
      END IF;
      IF v_conf < ol.ordered_qty AND (v_reason IS NULL OR v_reason NOT IN ('out_of_stock', 'damaged', 'customer_request', 'other')) THEN
        RETURN public._order_owner_result(o, false, 'reason_required', jsonb_build_object('line_no', ol.line_no));
      END IF;
      IF v_conf = ol.ordered_qty THEN v_reason := NULL; END IF;
    END IF;
    IF v_conf > 0 THEN any_kept := true; END IF;
    IF v_conf < ol.ordered_qty THEN
      changes := changes || jsonb_build_object('line_no', ol.line_no, 'ordered', ol.ordered_qty, 'confirmed', v_conf, 'reason', v_reason);
    END IF;
  END LOOP;
  -- Every line at zero is a rejection, not an acceptance (001 edge case, US4 AS4).
  IF NOT any_kept THEN RETURN public._order_owner_result(o, false, 'all_zero'); END IF;

  UPDATE public.order_lines l SET
    confirmed_qty = coalesce((SELECT (e->>'confirmed_qty')::numeric FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e
                              WHERE (e->>'line_no')::int = l.line_no LIMIT 1), l.ordered_qty),
    updated_at = now()
  WHERE l.order_id = o.global_id;
  UPDATE public.order_lines l SET
    shortfall_reason = CASE WHEN l.confirmed_qty < l.ordered_qty
                            THEN (SELECT e->>'reason' FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e
                                  WHERE (e->>'line_no')::int = l.line_no LIMIT 1) END
  WHERE l.order_id = o.global_id;

  UPDATE public.orders SET
    state = 'confirmed', confirmed_at = now(), updated_at = now(),
    confirmed_total_usd = (SELECT sum(round(l.unit_price_usd * l.confirmed_qty, 2)) FROM public.order_lines l WHERE l.order_id = o.global_id),
    confirmed_total_local = (SELECT CASE WHEN bool_and(l.unit_price_local IS NOT NULL) THEN sum(round(l.unit_price_local * l.confirmed_qty)) END
                             FROM public.order_lines l WHERE l.order_id = o.global_id)
  WHERE global_id = o.global_id RETURNING * INTO o;

  PERFORM public._order_event(o, 'confirmed', 'submitted', 'confirmed', 'user', p_actor);
  IF jsonb_array_length(changes) > 0 THEN
    PERFORM public._order_event(o, 'adjusted', 'confirmed', 'confirmed', 'user', p_actor, NULL, changes);
  END IF;
  RETURN public._order_owner_result(o, true, 'ok');
END;
$$;

CREATE OR REPLACE FUNCTION public.order_reject(p_order uuid, p_expected_state text, p_reason text, p_actor jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.orders%ROWTYPE := public._order_lock(p_order);
  refusal jsonb := public._order_owner_check(o, p_expected_state, ARRAY['submitted']);
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF refusal IS NOT NULL THEN RETURN refusal; END IF;
  IF char_length(v_reason) NOT BETWEEN 1 AND 300 THEN RETURN public._order_owner_result(o, false, 'reason_required'); END IF;
  UPDATE public.orders SET state = 'rejected', reason = v_reason, closed_at = now(), updated_at = now()
  WHERE global_id = o.global_id RETURNING * INTO o;
  PERFORM public._order_event(o, 'rejected', 'submitted', 'rejected', 'user', p_actor, v_reason);
  RETURN public._order_owner_result(o, true, 'ok');
END;
$$;

CREATE OR REPLACE FUNCTION public.order_ready(p_order uuid, p_expected_state text, p_actor jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.orders%ROWTYPE := public._order_lock(p_order);
  refusal jsonb := public._order_owner_check(o, p_expected_state, ARRAY['confirmed']);
BEGIN
  IF refusal IS NOT NULL THEN RETURN refusal; END IF;
  UPDATE public.orders SET state = 'ready', ready_at = now(), updated_at = now()
  WHERE global_id = o.global_id RETURNING * INTO o;
  PERFORM public._order_event(o, 'ready', 'confirmed', 'ready', 'user', p_actor);
  RETURN public._order_owner_result(o, true, 'ok');
END;
$$;

CREATE OR REPLACE FUNCTION public.order_cancel_by_shop(p_order uuid, p_expected_state text, p_reason text, p_actor jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.orders%ROWTYPE := public._order_lock(p_order);
  refusal jsonb := public._order_owner_check(o, p_expected_state, ARRAY['confirmed', 'ready']);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_from text;
BEGIN
  IF refusal IS NOT NULL THEN RETURN refusal; END IF;
  IF char_length(v_reason) NOT BETWEEN 1 AND 300 THEN RETURN public._order_owner_result(o, false, 'reason_required'); END IF;
  v_from := o.state;
  UPDATE public.orders SET state = 'cancelled', cancelled_by = 'shop', reason = v_reason, closed_at = now(), updated_at = now()
  WHERE global_id = o.global_id RETURNING * INTO o;
  PERFORM public._order_event(o, 'cancelled', v_from, 'cancelled', 'user', p_actor, v_reason);
  RETURN public._order_owner_result(o, true, 'ok');
END;
$$;

-- Claim the order for a POS sale (research R20): first completion wins; the same sale id again is a no-op.
CREATE OR REPLACE FUNCTION public.order_complete(p_order uuid, p_sale_global_id uuid, p_sale_total_usd numeric, p_actor jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.orders%ROWTYPE := public._order_lock(p_order);
  v_from text;
BEGIN
  IF o.global_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found', 'order', NULL, 'lines', '[]'::jsonb); END IF;
  IF p_sale_global_id IS NULL THEN RETURN public._order_owner_result(o, false, 'invalid'); END IF;
  IF o.state = 'completed' THEN
    RETURN public._order_owner_result(o, o.sale_global_id = p_sale_global_id,
                                      CASE WHEN o.sale_global_id = p_sale_global_id THEN 'ok' ELSE 'handled' END);
  END IF;
  IF o.state = 'submitted' THEN RETURN public._order_owner_result(o, false, 'invalid_transition'); END IF;
  IF o.state NOT IN ('confirmed', 'ready') THEN
    RETURN public._order_owner_result(o, false, CASE WHEN o.state = 'expired' THEN 'expired' ELSE 'handled' END);
  END IF;
  v_from := o.state;
  UPDATE public.orders SET state = 'completed', sale_global_id = p_sale_global_id,
    sale_total_usd = round(p_sale_total_usd, 2), closed_at = now(), updated_at = now()
  WHERE global_id = o.global_id RETURNING * INTO o;
  PERFORM public._order_event(o, 'completed', v_from, 'completed', 'user', p_actor, NULL,
                              jsonb_build_object('sale_global_id', p_sale_global_id, 'sale_total_usd', round(p_sale_total_usd, 2)));
  RETURN public._order_owner_result(o, true, 'ok');
END;
$$;

-- Compensation only: the sale could not be written after the order was claimed for it.
CREATE OR REPLACE FUNCTION public.order_complete_undo(p_order uuid, p_sale_global_id uuid, p_actor jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.orders%ROWTYPE := public._order_lock(p_order);
  v_prev text;
BEGIN
  IF o.global_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found', 'order', NULL, 'lines', '[]'::jsonb); END IF;
  IF o.state <> 'completed' OR o.sale_global_id IS DISTINCT FROM p_sale_global_id THEN
    RETURN public._order_owner_result(o, false, 'handled');
  END IF;
  SELECT e.from_state INTO v_prev FROM public.order_events e
  WHERE e.order_id = o.global_id AND e.kind = 'completed' ORDER BY e.at DESC LIMIT 1;
  v_prev := CASE WHEN v_prev IN ('confirmed', 'ready') THEN v_prev ELSE 'confirmed' END;
  UPDATE public.orders SET state = v_prev, sale_global_id = NULL, sale_total_usd = NULL, closed_at = NULL, updated_at = now()
  WHERE global_id = o.global_id RETURNING * INTO o;
  PERFORM public._order_event(o, 'completion_undone', 'completed', v_prev, 'user', p_actor, NULL,
                              jsonb_build_object('sale_global_id', p_sale_global_id));
  RETURN public._order_owner_result(o, true, 'ok');
END;
$$;

-- Called by the desktop before each orders pull so registers see Expired within one pull.
CREATE OR REPLACE FUNCTION public.orders_sweep()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'not_owner'); END IF;
  RETURN jsonb_build_object('ok', true, 'code', 'ok', 'expired', public._orders_expire(auth.uid()));
END;
$$;

-- Blocked phones (FR-041): per store, managed online by users with orders.manage.
CREATE OR REPLACE FUNCTION public.order_blocked_phones(p_store uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.stores WHERE global_id = p_store AND tenant_id::text = auth.uid()::text) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_owner');
  END IF;
  RETURN jsonb_build_object('ok', true, 'code', 'ok', 'rows',
    (SELECT coalesce(jsonb_agg(jsonb_build_object('phone', b.phone, 'note', b.note, 'created_at', b.created_at) ORDER BY b.created_at DESC), '[]'::jsonb)
     FROM public.order_blocked_phones b WHERE b.store_id = p_store));
END;
$$;

CREATE OR REPLACE FUNCTION public.order_block_phone(p_store uuid, p_phone text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.stores%ROWTYPE;
  v_phone text := public._order_phone(p_phone);
BEGIN
  SELECT * INTO s FROM public.stores WHERE global_id = p_store AND tenant_id::text = auth.uid()::text;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_owner'); END IF;
  IF v_phone IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'invalid', 'field', 'phone'); END IF;
  INSERT INTO public.order_blocked_phones (tenant_id, store_id, phone, note)
  VALUES (s.tenant_id, s.global_id, v_phone, left(nullif(btrim(coalesce(p_note, '')), ''), 120))
  ON CONFLICT (store_id, phone) DO UPDATE SET note = excluded.note;
  RETURN jsonb_build_object('ok', true, 'code', 'ok', 'phone', v_phone);
END;
$$;

CREATE OR REPLACE FUNCTION public.order_unblock_phone(p_store uuid, p_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.stores WHERE global_id = p_store AND tenant_id::text = auth.uid()::text) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_owner');
  END IF;
  DELETE FROM public.order_blocked_phones WHERE store_id = p_store AND phone = coalesce(public._order_phone(p_phone), p_phone);
  RETURN jsonb_build_object('ok', true, 'code', 'ok');
END;
$$;

-- ---- grants ----------------------------------------------------------------------------------------
-- Supabase grants EXECUTE on new functions to anon/authenticated by default: revoke everything, then grant
-- exactly the contract's matrix (contracts/cloud-api-s2.md "Grants").

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._order_sha256(text)', 'public._gateway_ok(text)', 'public._order_phone(text)', 'public._order_measured(text)',
    'public._order_quote(uuid, jsonb)', 'public._order_event(public.orders, text, text, text, text, jsonb, text, jsonb)',
    'public._orders_expire(uuid)', 'public._order_lines_json(uuid)', 'public._order_public(public.orders)',
    'public._order_owner_result(public.orders, boolean, text, jsonb)', 'public._order_owner_check(public.orders, text, text[])',
    'public._order_lock(uuid)',
    'public.order_quote(text, text, jsonb)',
    'public.order_submit(text, text, text, text, text, jsonb, jsonb, numeric, text)',
    'public.order_status(text, text)', 'public.order_cancel(text, text)',
    'public.order_accept(uuid, text, jsonb, jsonb)', 'public.order_reject(uuid, text, text, jsonb)',
    'public.order_ready(uuid, text, jsonb)', 'public.order_cancel_by_shop(uuid, text, text, jsonb)',
    'public.order_complete(uuid, uuid, numeric, jsonb)', 'public.order_complete_undo(uuid, uuid, jsonb)',
    'public.orders_sweep()', 'public.order_blocked_phones(uuid)', 'public.order_block_phone(uuid, text, text)',
    'public.order_unblock_phone(uuid, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.order_quote(text, text, jsonb)',
    'public.order_submit(text, text, text, text, text, jsonb, jsonb, numeric, text)',
    'public.order_status(text, text)', 'public.order_cancel(text, text)'
  ] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated', f);
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.order_accept(uuid, text, jsonb, jsonb)', 'public.order_reject(uuid, text, text, jsonb)',
    'public.order_ready(uuid, text, jsonb)', 'public.order_cancel_by_shop(uuid, text, text, jsonb)',
    'public.order_complete(uuid, uuid, numeric, jsonb)', 'public.order_complete_undo(uuid, uuid, jsonb)',
    'public.orders_sweep()', 'public.order_blocked_phones(uuid)', 'public.order_block_phone(uuid, text, text)',
    'public.order_unblock_phone(uuid, text)'
  ] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END;
$$;

COMMIT;
