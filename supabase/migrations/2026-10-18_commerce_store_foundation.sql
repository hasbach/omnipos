-- OmniPOS commerce foundation, Slice A: a tenant's online store and its product listings.
-- Spec / plan: specs/001-commerce-domain-foundation/ (plan.md, data-model.md, contracts/public-catalog.md).
--
-- NOT applied automatically: run it in the Supabase SQL editor. Safe to re-run. Until it runs, the
-- desktop sync skips the stores / store_listings tables (one warning, the rest of sync keeps working),
-- so store data simply stays local.
--
-- Security model: owners read/write their own rows through RLS (same rule as products). There is NO
-- anon policy on any table: anonymous visitors read only through the allow-listed public functions
-- (store_public_get / store_public_listings, at the end of this file), never through raw tables —
-- products carries cost and exact stock.

-- ---- tables --------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.stores (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID REFERENCES public.tenants(global_id),
    name TEXT NOT NULL,
    slug TEXT,
    mode TEXT NOT NULL DEFAULT 'retail',
    status TEXT NOT NULL DEFAULT 'draft',
    description TEXT,
    logo_path TEXT,
    cover_path TEXT,
    primary_color TEXT,
    contact_phone TEXT,
    contact_whatsapp TEXT,
    contact_email TEXT,
    address TEXT,
    default_language TEXT DEFAULT 'en',
    settings TEXT DEFAULT '{}',
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.store_listings (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID REFERENCES public.tenants(global_id),
    store_id UUID REFERENCES public.stores(global_id),
    product_id UUID REFERENCES public.products(global_id),
    published INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    description TEXT,
    images TEXT DEFAULT '[]',
    store_category TEXT,
    sort_order INTEGER DEFAULT 0,
    min_quantity NUMERIC,
    orderable_unit_ids TEXT,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);

-- ---- indexes -------------------------------------------------------------------------------------

-- Store slugs are one global namespace (the public URL); a deleted store frees its slug.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_slug_live
    ON public.stores (lower(slug)) WHERE deleted_at IS NULL AND slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stores_tenant ON public.stores (tenant_id);
CREATE INDEX IF NOT EXISTS idx_store_listings_store_published
    ON public.store_listings (store_id, published) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_store_listings_product ON public.store_listings (product_id);

-- ---- server-time pull cursor (same as 2026-10-07_synced_at.sql) ----------------------------------

CREATE OR REPLACE FUNCTION public.set_synced_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.synced_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stores', 'store_listings'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS synced_at timestamptz NOT NULL DEFAULT now()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_synced_at ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_synced_at BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_synced_at()', t, t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_tenant_synced_at ON public.%I (tenant_id, synced_at, global_id)', t, t);
  END LOOP;
END;
$$;

-- ---- row level security (owners only; no anon policy) --------------------------------------------

ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Stores isolate" ON public.stores;
CREATE POLICY "Stores isolate" ON public.stores
FOR ALL TO authenticated
USING (tenant_id::text = auth.uid()::text)
WITH CHECK (tenant_id::text = auth.uid()::text);

ALTER TABLE public.store_listings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Store Listings isolate" ON public.store_listings;
CREATE POLICY "Store Listings isolate" ON public.store_listings
FOR ALL TO authenticated
USING (tenant_id::text = auth.uid()::text)
WITH CHECK (tenant_id::text = auth.uid()::text);

-- ---- claim_store_slug: the one store action that needs the cloud (contracts/public-catalog.md) ------
-- Store web addresses are one global namespace, so the desktop claims a slug here BEFORE saving it
-- locally (server/commerce.ts claimSlug). Same format rules and reserved list as the desktop
-- (RESERVED_SLUGS). The unique index idx_stores_slug_live is the final guard against races.
-- If the store row hasn't been pushed yet, a placeholder owned by the caller is inserted; the next
-- push upserts the real row on global_id.

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
  IF v_slug = ANY (ARRAY['admin','api','app','www','monitor','store','stores','omnipos','login','signup','help','support','static','assets']) THEN
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

-- ---- public catalog (anonymous, read-only) — contracts/public-catalog.md ---------------------------
-- The ONLY way an anonymous visitor reads a store. Each function returns an explicit list of columns
-- (never cost, cost_lbp, min_price, wholesale tiers, reorder point, local ids, tenant data) and returns
-- NOTHING unless every gate holds: store active and not deleted, commerce_enabled = '1', online license
-- valid, tenant not deleted. A paused / unlicensed / unknown store looks exactly like a missing slug.
--
-- Prices are the RETAIL tier only (product.price / product_units.price), mirroring tierUnitPrice and
-- uomUnitPrice(..., 'retail') in server/pricing.ts. Stock data is as fresh as the last register push.
-- Units: every live unit of the product. listing.orderable_unit_ids holds the authoring register's
-- LOCAL unit ids (sync doesn't translate ids inside JSON), so it is not applied here; ordering (003)
-- must switch it to unit global ids before enforcing it.
--
-- Supabase grants EXECUTE on new public functions to anon/authenticated by default, so the internal
-- helpers (prefixed _store_public_) revoke it explicitly.

-- Gate: the one store a slug may show, or no row. Internal.
CREATE OR REPLACE FUNCTION public._store_public_store(p_slug text)
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
    AND s.status = 'active'
    AND (t.online_license_type = 'lifetime' OR t.online_license_expiry > now())
    AND EXISTS (
      SELECT 1 FROM public.settings st
      WHERE st.tenant_id = s.tenant_id AND st.key = 'commerce_enabled' AND st.value = '1' AND st.deleted_at IS NULL
    )
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public._store_public_store(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._store_public_store(text) FROM anon;
REVOKE ALL ON FUNCTION public._store_public_store(text) FROM authenticated;

-- Store settings JSON, tolerant of an empty or malformed value (same defaults as server/commerce.ts).
CREATE OR REPLACE FUNCTION public._store_public_settings(p_settings text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  defaults jsonb := '{"show_exact_stock":0,"hide_out_of_stock":0,"show_local_price":1,"category_order":[]}'::jsonb;
BEGIN
  RETURN defaults || coalesce(nullif(btrim(p_settings), '')::jsonb, '{}'::jsonb);
EXCEPTION WHEN others THEN
  RETURN defaults;
END;
$$;
REVOKE ALL ON FUNCTION public._store_public_settings(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._store_public_settings(text) FROM anon;
REVOKE ALL ON FUNCTION public._store_public_settings(text) FROM authenticated;

-- Visible listings of a gated store, with derived fields. Internal.
CREATE OR REPLACE FUNCTION public._store_public_rows(p_store uuid, p_hide_out_of_stock boolean)
RETURNS TABLE (
  listing_id uuid, product_id uuid, title text, description text, images text, category text,
  price numeric, price_lbp numeric, unit text, stock numeric, stock_state text, min_quantity numeric,
  sort_order integer, barcode text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM (
    SELECT
      l.global_id,
      p.global_id,
      coalesce(nullif(btrim(l.title), ''), p.name),
      l.description,
      coalesce(l.images, '[]'),
      coalesce(nullif(btrim(l.store_category), ''), p.category),
      p.price,
      p.price_lbp,
      coalesce(p.unit, 'pcs'),
      p.stock,
      CASE
        WHEN coalesce(p.track_inventory, 1) = 0 THEN 'in_stock'
        WHEN coalesce(p.stock, 0) <= 0 THEN 'out_of_stock'
        WHEN coalesce(p.reorder_point, 0) > 0 AND p.stock <= p.reorder_point THEN 'low_stock'
        ELSE 'in_stock'
      END,
      l.min_quantity,
      coalesce(l.sort_order, 0),
      p.barcode
    FROM public.store_listings l
    JOIN public.products p ON p.global_id = l.product_id AND p.tenant_id = l.tenant_id
    WHERE l.store_id = p_store
      AND l.deleted_at IS NULL
      AND l.published = 1
      AND p.deleted_at IS NULL
      AND coalesce(p.active, 1) = 1
  ) v (listing_id, product_id, title, description, images, category, price, price_lbp, unit, stock, stock_state, min_quantity, sort_order, barcode)
  WHERE NOT (p_hide_out_of_stock AND v.stock_state = 'out_of_stock')
$$;
REVOKE ALL ON FUNCTION public._store_public_rows(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._store_public_rows(uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public._store_public_rows(uuid, boolean) FROM authenticated;

-- One row (or none): the store's public identity, display settings, local currency and categories.
CREATE OR REPLACE FUNCTION public.store_public_get(p_slug text)
RETURNS TABLE (
  slug text, name text, description text, mode text, logo_path text, cover_path text, primary_color text,
  contact_phone text, contact_whatsapp text, contact_email text, address text, default_language text,
  show_local_price boolean, hide_out_of_stock boolean, show_exact_stock boolean,
  local_currency_code text, local_currency_symbol text, local_rate numeric,
  categories jsonb
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
  SELECT * INTO s FROM public._store_public_store(p_slug);
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
  RETURN NEXT;
END;
$$;

-- One page of visible listings. p_limit is clamped to 1-100 (default 48); p_search (trimmed, at most
-- 60 characters) matches the title or the barcode, case-insensitively, as plain text (no wildcards).
CREATE OR REPLACE FUNCTION public.store_public_listings(
  p_slug text, p_category text DEFAULT NULL, p_search text DEFAULT NULL, p_limit integer DEFAULT 48, p_offset integer DEFAULT 0
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
  SELECT * INTO s FROM public._store_public_store(p_slug);
  IF NOT FOUND THEN RETURN; END IF;
  cfg := public._store_public_settings(s.settings);

  RETURN QUERY
  SELECT
    r.listing_id,
    r.title,
    r.description,
    CASE WHEN left(btrim(r.images), 1) = '[' THEN r.images::jsonb ELSE '[]'::jsonb END,
    r.category,
    r.price,
    r.price_lbp,
    r.unit,
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

REVOKE ALL ON FUNCTION public.store_public_get(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.store_public_listings(text, text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_public_get(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_public_listings(text, text, text, integer, integer) TO anon, authenticated;
