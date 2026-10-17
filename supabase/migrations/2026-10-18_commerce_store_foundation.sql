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
