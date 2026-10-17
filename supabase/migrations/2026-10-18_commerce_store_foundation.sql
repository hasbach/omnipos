-- OmniPOS commerce foundation, Slice A: a tenant's online store and its product listings.
-- Spec / plan: specs/001-commerce-domain-foundation/ (plan.md, data-model.md, contracts/public-catalog.md).
--
-- NOT applied automatically: run it in the Supabase SQL editor. Safe to re-run. Until it runs, the
-- desktop sync skips the stores / store_listings tables (one warning, the rest of sync keeps working),
-- so store data simply stays local.
--
-- Security model: owners read/write their own rows through RLS (same rule as products). There is NO
-- anon policy on any table: anonymous visitors read only through the allow-listed public functions
-- (added below by later tasks), never through raw tables — products carries cost and exact stock.

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
