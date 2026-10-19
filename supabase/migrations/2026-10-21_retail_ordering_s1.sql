-- OmniPOS retail ordering, Slice 1 (WhatsApp order) — specs/003-retail-ordering/contracts/cloud-api.md.
--
-- Run AFTER 2026-10-19_storefront.sql, in the Supabase SQL editor, then
-- supabase/checks/2026-10-21_retail_ordering_s1_checks.sql. Safe to re-run.
-- Changes:
--   * Store ordering settings (stores.settings JSON) exposed by store_public_get: ordering mode, pickup /
--     delivery switches and texts, minimum order. Nothing is stored about visitors or orders.
--   * Orderable units: store_listings.orderable_unit_ids now holds unit keys ("base" or a product_units
--     global id). The listing functions return only orderable units plus base_orderable. Legacy integer
--     arrays (registers before 003) are ignored, i.e. every unit stays orderable.
-- The storefront treats missing fields as "ordering off / all units", so it can be deployed before or after
-- this file. The public-store gate (_store_public_store) is unchanged.
-- Do NOT re-run 2026-10-19_storefront.sql after this file: its CREATE OR REPLACE of the public functions would fail
-- on the changed return columns ("cannot change return type"). Re-running this file itself is fine.

BEGIN;

-- ---- settings defaults -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._store_public_settings(p_settings text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  defaults jsonb := '{"show_exact_stock":0,"hide_out_of_stock":0,"show_local_price":1,"category_order":[],"ordering_mode":"off","pickup_enabled":1,"pickup_note":"","delivery_enabled":0,"delivery_note":"","min_order_usd":null}'::jsonb;
BEGIN
  RETURN defaults || coalesce(nullif(btrim(p_settings), '')::jsonb, '{}'::jsonb);
EXCEPTION WHEN others THEN
  RETURN defaults;
END;
$$;
REVOKE ALL ON FUNCTION public._store_public_settings(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._store_public_settings(text) FROM anon;
REVOKE ALL ON FUNCTION public._store_public_settings(text) FROM authenticated;

-- A settings switch stored as 1 / "1" / true. Internal.
CREATE OR REPLACE FUNCTION public._store_setting_on(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT coalesce(p_value #>> '{}', '0') IN ('1', 'true')
$$;
REVOKE ALL ON FUNCTION public._store_setting_on(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._store_setting_on(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public._store_setting_on(jsonb) FROM authenticated;

-- Orderable unit keys of a listing: the array when orderable_unit_ids is a non-empty JSON array of strings,
-- otherwise NULL = no restriction (NULL, legacy integer ids, invalid JSON). Internal.
CREATE OR REPLACE FUNCTION public._store_orderable_keys(p_value text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v jsonb;
BEGIN
  IF p_value IS NULL OR btrim(p_value) = '' THEN RETURN NULL; END IF;
  v := p_value::jsonb;
  IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) = 0 THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e) <> 'string') THEN RETURN NULL; END IF;
  RETURN ARRAY(SELECT jsonb_array_elements_text(v));
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._store_orderable_keys(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._store_orderable_keys(text) FROM anon;
REVOKE ALL ON FUNCTION public._store_orderable_keys(text) FROM authenticated;

-- ---- public functions (RETURNS TABLE changes, so drop and recreate) --------------------------------

DROP FUNCTION IF EXISTS public.store_public_get(text, text);
DROP FUNCTION IF EXISTS public.store_public_listings(text, text, text, integer, integer, text);
DROP FUNCTION IF EXISTS public.store_public_listing(text, uuid, text);

CREATE FUNCTION public.store_public_get(p_slug text, p_preview text DEFAULT NULL)
RETURNS TABLE (
  slug text, name text, description text, mode text, logo_path text, cover_path text, primary_color text,
  contact_phone text, contact_whatsapp text, contact_email text, address text, default_language text,
  show_local_price boolean, hide_out_of_stock boolean, show_exact_stock boolean,
  local_currency_code text, local_currency_symbol text, local_rate numeric,
  categories jsonb,
  ordering_mode text, pickup_enabled boolean, pickup_note text, delivery_enabled boolean, delivery_note text,
  min_order_usd numeric,
  is_preview boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.stores%ROWTYPE;
  cfg jsonb;
  cur record;
  cats jsonb;
BEGIN
  SELECT * INTO s FROM public._store_public_store(p_slug, p_preview);
  IF NOT FOUND THEN RETURN; END IF;
  cfg := public._store_public_settings(s.settings);

  SELECT cu.code, cu.symbol, cu.rate INTO cur
  FROM public.currencies cu
  WHERE cu.tenant_id = s.tenant_id AND cu.deleted_at IS NULL AND upper(cu.code) <> 'USD'
  ORDER BY cu.local_id NULLS LAST
  LIMIT 1;

  SELECT coalesce(jsonb_agg(jsonb_build_object('name', g.category, 'count', g.n) ORDER BY g.pos NULLS LAST, lower(g.category)), '[]'::jsonb)
  INTO cats
  FROM (
    SELECT r.category, count(*) AS n,
           (SELECT o.ord FROM jsonb_array_elements_text(coalesce(cfg->'category_order', '[]'::jsonb)) WITH ORDINALITY AS o(cat, ord)
            WHERE o.cat = r.category LIMIT 1) AS pos
    FROM public._store_public_rows(s.global_id, (cfg->>'hide_out_of_stock')::int = 1) r
    WHERE r.category IS NOT NULL
    GROUP BY r.category
  ) g;

  slug := s.slug; name := s.name; description := s.description; mode := s.mode;
  logo_path := s.logo_path; cover_path := s.cover_path; primary_color := s.primary_color;
  contact_phone := s.contact_phone; contact_whatsapp := s.contact_whatsapp; contact_email := s.contact_email;
  address := s.address; default_language := s.default_language;
  show_local_price := (cfg->>'show_local_price')::int = 1;
  hide_out_of_stock := (cfg->>'hide_out_of_stock')::int = 1;
  show_exact_stock := (cfg->>'show_exact_stock')::int = 1;
  local_currency_code := cur.code; local_currency_symbol := cur.symbol; local_rate := cur.rate;
  categories := cats;
  ordering_mode := CASE WHEN cfg->>'ordering_mode' IN ('off', 'whatsapp', 'online') THEN cfg->>'ordering_mode' ELSE 'off' END;
  pickup_enabled := public._store_setting_on(cfg->'pickup_enabled');
  pickup_note := left(btrim(coalesce(cfg->>'pickup_note', '')), 200);
  delivery_enabled := public._store_setting_on(cfg->'delivery_enabled');
  delivery_note := left(btrim(coalesce(cfg->>'delivery_note', '')), 200);
  min_order_usd := CASE WHEN jsonb_typeof(cfg->'min_order_usd') = 'number' AND (cfg->>'min_order_usd')::numeric > 0
                        THEN (cfg->>'min_order_usd')::numeric ELSE NULL END;
  is_preview := public._store_public_is_preview(s.global_id, p_preview);
  RETURN NEXT;
END;
$$;

CREATE FUNCTION public.store_public_listings(
  p_slug text, p_category text DEFAULT NULL, p_search text DEFAULT NULL, p_limit integer DEFAULT 48,
  p_offset integer DEFAULT 0, p_preview text DEFAULT NULL
)
RETURNS TABLE (
  listing_id uuid, title text, description text, images jsonb, category text,
  price numeric, price_lbp numeric, unit text, units jsonb,
  stock_state text, stock numeric, min_quantity numeric, base_orderable boolean, total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.stores%ROWTYPE;
  cfg jsonb;
  v_limit integer := least(greatest(coalesce(p_limit, 48), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := lower(left(btrim(coalesce(p_search, '')), 60));
  v_category text := nullif(btrim(coalesce(p_category, '')), '');
BEGIN
  SELECT * INTO s FROM public._store_public_store(p_slug, p_preview);
  IF NOT FOUND THEN RETURN; END IF;
  cfg := public._store_public_settings(s.settings);

  RETURN QUERY
  SELECT
    r.listing_id, r.title, r.description,
    CASE WHEN left(btrim(r.images), 1) = '[' THEN r.images::jsonb ELSE '[]'::jsonb END,
    r.category, r.price, r.price_lbp, r.unit,
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('unit_id', u.global_id, 'name', u.name, 'factor', u.factor, 'price', u.price, 'price_lbp', u.price_lbp)
                       ORDER BY u.sort_order, u.factor)
      FROM public.product_units u
      WHERE u.product_id = r.product_id AND u.deleted_at IS NULL
        AND (ok.keys IS NULL OR u.global_id::text = ANY (ok.keys))
    ), '[]'::jsonb),
    r.stock_state,
    CASE WHEN (cfg->>'show_exact_stock')::int = 1 THEN r.stock ELSE NULL END,
    r.min_quantity,
    (ok.keys IS NULL OR 'base' = ANY (ok.keys)),
    count(*) OVER ()
  FROM public._store_public_rows(s.global_id, (cfg->>'hide_out_of_stock')::int = 1) r
  LEFT JOIN LATERAL (
    SELECT public._store_orderable_keys(sl.orderable_unit_ids) AS keys
    FROM public.store_listings sl WHERE sl.global_id = r.listing_id
  ) ok ON true
  WHERE (v_category IS NULL OR r.category = v_category)
    AND (v_search = '' OR strpos(lower(r.title), v_search) > 0 OR strpos(lower(coalesce(r.barcode, '')), v_search) > 0)
  ORDER BY r.sort_order, lower(r.title), r.listing_id
  LIMIT v_limit OFFSET v_offset;
END;
$$;

-- One visible product for the product page (same columns as store_public_listings minus total_count).
CREATE FUNCTION public.store_public_listing(p_slug text, p_listing uuid, p_preview text DEFAULT NULL)
RETURNS TABLE (
  listing_id uuid, title text, description text, images jsonb, category text,
  price numeric, price_lbp numeric, unit text, units jsonb,
  stock_state text, stock numeric, min_quantity numeric, base_orderable boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.stores%ROWTYPE;
  cfg jsonb;
BEGIN
  SELECT * INTO s FROM public._store_public_store(p_slug, p_preview);
  IF NOT FOUND THEN RETURN; END IF;
  cfg := public._store_public_settings(s.settings);

  RETURN QUERY
  SELECT
    r.listing_id, r.title, r.description,
    CASE WHEN left(btrim(r.images), 1) = '[' THEN r.images::jsonb ELSE '[]'::jsonb END,
    r.category, r.price, r.price_lbp, r.unit,
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('unit_id', u.global_id, 'name', u.name, 'factor', u.factor, 'price', u.price, 'price_lbp', u.price_lbp)
                       ORDER BY u.sort_order, u.factor)
      FROM public.product_units u
      WHERE u.product_id = r.product_id AND u.deleted_at IS NULL
        AND (ok.keys IS NULL OR u.global_id::text = ANY (ok.keys))
    ), '[]'::jsonb),
    r.stock_state,
    CASE WHEN (cfg->>'show_exact_stock')::int = 1 THEN r.stock ELSE NULL END,
    r.min_quantity,
    (ok.keys IS NULL OR 'base' = ANY (ok.keys))
  FROM public._store_public_rows(s.global_id, (cfg->>'hide_out_of_stock')::int = 1) r
  LEFT JOIN LATERAL (
    SELECT public._store_orderable_keys(sl.orderable_unit_ids) AS keys
    FROM public.store_listings sl WHERE sl.global_id = r.listing_id
  ) ok ON true
  WHERE r.listing_id = p_listing
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.store_public_get(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.store_public_listings(text, text, text, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.store_public_listing(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_public_get(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_public_listings(text, text, text, integer, integer, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_public_listing(text, uuid, text) TO anon, authenticated;

COMMIT;
