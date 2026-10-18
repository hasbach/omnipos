-- OmniPOS public storefront (feature 002) — specs/002-tenant-online-store/contracts/cloud-api.md.
--
-- Run AFTER 2026-10-18_commerce_store_foundation.sql, in the Supabase SQL editor. Safe to re-run.
-- Changes:
--   * Wholesale stores are never public (only retail / hybrid), unless the owner previews with a token.
--   * Owner preview tokens (30 minutes) for draft / paused / wholesale stores.
--   * store_public_listing(): one product for the product page.
--   * Reserved store addresses extended for subdomains (same list as storefront/src/reserved.ts).
-- The photo bucket and its storage policies are in 2026-10-19b_storefront_storage.sql (run it after this
-- file): storage tables are owned by supabase_storage_admin and, if that file is refused, the bucket and
-- policies can be created in the dashboard without blocking everything here.

-- ---- preview tokens ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.store_preview_tokens (
    token TEXT PRIMARY KEY,
    store_id UUID NOT NULL REFERENCES public.stores(global_id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_preview_tokens_store ON public.store_preview_tokens (store_id);
-- Reachable only through the SECURITY DEFINER functions below: RLS on, no policies.
ALTER TABLE public.store_preview_tokens ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.create_store_preview_token(p_store uuid)
RETURNS TABLE (token text, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_token text;
  v_expires timestamptz := now() + interval '30 minutes';
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.stores s WHERE s.global_id = p_store AND s.tenant_id = v_uid AND s.deleted_at IS NULL
  ) THEN
    RETURN;
  END IF;
  DELETE FROM public.store_preview_tokens t WHERE t.tenant_id = v_uid AND t.expires_at < now();
  -- Two v4 UUIDs (gen_random_uuid() uses the server's strong random source) = 32 bytes, ~244 random bits,
  -- encoded base64url without padding (43 characters).
  v_token := rtrim(translate(encode(
               decode(replace(gen_random_uuid()::text, '-', ''), 'hex') || decode(replace(gen_random_uuid()::text, '-', ''), 'hex'),
               'base64'), '+/', '-_'), '=');
  INSERT INTO public.store_preview_tokens (token, store_id, tenant_id, expires_at) VALUES (v_token, p_store, v_uid, v_expires);
  RETURN QUERY SELECT v_token, v_expires;
END;
$$;
REVOKE ALL ON FUNCTION public.create_store_preview_token(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_store_preview_token(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_store_preview_token(uuid) TO authenticated;

-- ---- gate: retail / hybrid only, preview bypass --------------------------------------------------

-- The 1-argument gate and public functions from 2026-10-18 are replaced by versions with a trailing
-- p_preview argument (Postgres can't add an argument with CREATE OR REPLACE).
DROP FUNCTION IF EXISTS public.store_public_get(text);
DROP FUNCTION IF EXISTS public.store_public_listings(text, text, text, integer, integer);
DROP FUNCTION IF EXISTS public._store_public_store(text);

CREATE OR REPLACE FUNCTION public._store_public_store(p_slug text, p_preview text DEFAULT NULL)
RETURNS SETOF public.stores
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.*
  FROM public.stores s
  JOIN public.tenants t ON t.global_id = s.tenant_id AND t.deleted_at IS NULL
  WHERE lower(s.slug) = lower(btrim(coalesce(p_slug, '')))
    AND s.deleted_at IS NULL
    AND (t.online_license_type = 'lifetime' OR t.online_license_expiry > now())
    AND EXISTS (
      SELECT 1 FROM public.settings st
      WHERE st.tenant_id = s.tenant_id AND st.key = 'commerce_enabled' AND st.value = '1' AND st.deleted_at IS NULL
    )
    AND (
      (s.status = 'active' AND s.mode IN ('retail', 'hybrid'))
      OR EXISTS (
        SELECT 1 FROM public.store_preview_tokens pt
        WHERE pt.token = p_preview AND pt.store_id = s.global_id AND pt.expires_at > now()
      )
    )
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public._store_public_store(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._store_public_store(text, text) FROM anon;
REVOKE ALL ON FUNCTION public._store_public_store(text, text) FROM authenticated;

-- Is this request an owner preview (token valid for the store)? Internal.
CREATE OR REPLACE FUNCTION public._store_public_is_preview(p_store uuid, p_preview text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_preview IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.store_preview_tokens pt WHERE pt.token = p_preview AND pt.store_id = p_store AND pt.expires_at > now()
  )
$$;
REVOKE ALL ON FUNCTION public._store_public_is_preview(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._store_public_is_preview(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public._store_public_is_preview(uuid, text) FROM authenticated;

-- ---- public functions (same columns as 2026-10-18, plus preview) -----------------------------------

CREATE OR REPLACE FUNCTION public.store_public_get(p_slug text, p_preview text DEFAULT NULL)
RETURNS TABLE (
  slug text, name text, description text, mode text, logo_path text, cover_path text, primary_color text,
  contact_phone text, contact_whatsapp text, contact_email text, address text, default_language text,
  show_local_price boolean, hide_out_of_stock boolean, show_exact_stock boolean,
  local_currency_code text, local_currency_symbol text, local_rate numeric,
  categories jsonb, is_preview boolean
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
  is_preview := public._store_public_is_preview(s.global_id, p_preview);
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.store_public_listings(
  p_slug text, p_category text DEFAULT NULL, p_search text DEFAULT NULL, p_limit integer DEFAULT 48,
  p_offset integer DEFAULT 0, p_preview text DEFAULT NULL
)
RETURNS TABLE (
  listing_id uuid, title text, description text, images jsonb, category text,
  price numeric, price_lbp numeric, unit text, units jsonb,
  stock_state text, stock numeric, min_quantity numeric, total_count bigint
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
    ), '[]'::jsonb),
    r.stock_state,
    CASE WHEN (cfg->>'show_exact_stock')::int = 1 THEN r.stock ELSE NULL END,
    r.min_quantity,
    count(*) OVER ()
  FROM public._store_public_rows(s.global_id, (cfg->>'hide_out_of_stock')::int = 1) r
  WHERE (v_category IS NULL OR r.category = v_category)
    AND (v_search = '' OR strpos(lower(r.title), v_search) > 0 OR strpos(lower(coalesce(r.barcode, '')), v_search) > 0)
  ORDER BY r.sort_order, lower(r.title), r.listing_id
  LIMIT v_limit OFFSET v_offset;
END;
$$;

-- One visible product for the product page (same columns as store_public_listings minus total_count).
CREATE OR REPLACE FUNCTION public.store_public_listing(p_slug text, p_listing uuid, p_preview text DEFAULT NULL)
RETURNS TABLE (
  listing_id uuid, title text, description text, images jsonb, category text,
  price numeric, price_lbp numeric, unit text, units jsonb,
  stock_state text, stock numeric, min_quantity numeric
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
    ), '[]'::jsonb),
    r.stock_state,
    CASE WHEN (cfg->>'show_exact_stock')::int = 1 THEN r.stock ELSE NULL END,
    r.min_quantity
  FROM public._store_public_rows(s.global_id, (cfg->>'hide_out_of_stock')::int = 1) r
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

-- ---- reserved addresses (storefront/src/reserved.ts) ------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_store_slug(p_store uuid, p_slug text)
RETURNS TABLE (ok boolean, code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_owner uuid;
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, 'not_owner'::text; RETURN;
  END IF;
  IF length(v_slug) < 3 OR length(v_slug) > 40 OR v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RETURN QUERY SELECT false, 'invalid'::text; RETURN;
  END IF;
  IF v_slug = ANY (ARRAY['www','api','app','admin','mail','email','smtp','ftp','monitor','status','help','support','docs','blog','shop','store','stores','cdn','static','assets','media','img','images','login','signup','account','dashboard','omnipos','test','demo']) THEN
    RETURN QUERY SELECT false, 'reserved'::text; RETURN;
  END IF;

  SELECT s.tenant_id INTO v_owner FROM public.stores s WHERE s.global_id = p_store;
  IF FOUND AND v_owner IS DISTINCT FROM v_uid THEN
    RETURN QUERY SELECT false, 'not_owner'::text; RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.stores s
    WHERE lower(s.slug) = v_slug AND s.deleted_at IS NULL AND s.global_id <> p_store
  ) THEN
    RETURN QUERY SELECT false, 'taken'::text; RETURN;
  END IF;

  BEGIN
    IF v_owner IS NULL THEN
      INSERT INTO public.stores (global_id, tenant_id, name, slug) VALUES (p_store, v_uid, 'Store', v_slug);
    ELSE
      UPDATE public.stores SET slug = v_slug, updated_at = now() WHERE global_id = p_store;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT false, 'taken'::text; RETURN;
  END;

  RETURN QUERY SELECT true, 'ok'::text;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_store_slug(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_store_slug(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_store_slug(uuid, text) TO authenticated;
