-- Read-only checks for supabase/migrations/2026-10-18_commerce_store_foundation.sql
-- (specs/001-commerce-domain-foundation, quickstart.md section 4). Run in the Supabase SQL editor
-- AFTER the migration. Nothing here writes. Every query should return the "expected" shown.

-- 1. Tables, RLS and policies: both tables have RLS on, and NO policy for anon on stores,
--    store_listings or products. Expected: rls_enabled = true for both; anon_policies = 0.
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
       (SELECT count(*) FROM pg_policies p
         WHERE p.schemaname = 'public' AND p.tablename = c.relname AND 'anon' = ANY (p.roles)) AS anon_policies
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('stores', 'store_listings', 'products')
ORDER BY 1;

-- 2. Function privileges. Expected: anon true for the two public functions, false for
--    claim_store_slug and every _store_public_* helper; authenticated true for claim_store_slug.
SELECT f AS function_name,
       has_function_privilege('anon', f, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', f, 'EXECUTE') AS authenticated
FROM unnest(ARRAY[
  'public.store_public_get(text)',
  'public.store_public_listings(text, text, text, integer, integer)',
  'public.claim_store_slug(uuid, text)',
  'public._store_public_store(text)',
  'public._store_public_settings(text)',
  'public._store_public_rows(uuid, boolean)'
]) AS f;

-- 3. Allow-list: result columns of the public functions. Expected: 0 rows (no forbidden column).
SELECT p.proname AS function_name, a.name AS column_name
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL unnest(p.proargnames, p.proargmodes) AS a(name, mode)
WHERE n.nspname = 'public'
  AND p.proname IN ('store_public_get', 'store_public_listings')
  AND a.mode = 't'
  AND a.name IN ('cost', 'cost_lbp', 'min_price', 'price_wholesale', 'price_wholesale_lbp', 'price_super_wholesale',
                 'price_super_wholesale_lbp', 'reorder_point', 'track_inventory', 'tenant_id', 'local_id', 'global_id',
                 'product_id', 'barcode', 'email', 'password');

-- 4. Slug index. Expected: one row, a UNIQUE index on lower(slug) WHERE deleted_at IS NULL.
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'stores' AND indexname = 'idx_stores_slug_live';

-- 5. Live data (after a register has pushed a store): which stores are publicly visible and why not.
--    Each row shows the gates; a store is public only when all four are true.
SELECT s.slug, s.name,
       s.deleted_at IS NULL AND s.status = 'active' AS store_open,
       EXISTS (SELECT 1 FROM public.settings st WHERE st.tenant_id = s.tenant_id AND st.key = 'commerce_enabled'
                                                AND st.value = '1' AND st.deleted_at IS NULL) AS commerce_on,
       (t.online_license_type = 'lifetime' OR t.online_license_expiry > now()) AS license_valid,
       t.deleted_at IS NULL AS tenant_live,
       (SELECT count(*) FROM public.store_public_get(s.slug)) = 1 AS publicly_visible
FROM public.stores s JOIN public.tenants t ON t.global_id = s.tenant_id
WHERE s.slug IS NOT NULL
ORDER BY s.slug;

-- 6. Try the public catalog for one store (replace the slug). Expected: store row; listings with
--    retail prices; stock NULL unless the store turned on "show exact stock".
-- SELECT * FROM public.store_public_get('your-store-slug');
-- SELECT title, price, price_lbp, stock_state, stock, total_count FROM public.store_public_listings('your-store-slug', NULL, NULL, 10, 0);
