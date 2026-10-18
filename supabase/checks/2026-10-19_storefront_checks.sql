-- Read-only checks for supabase/migrations/2026-10-19_storefront.sql and 2026-10-19b_storefront_storage.sql
-- (specs/002-tenant-online-store). Checks 6-7 are about the storage file / the dashboard equivalent.
-- Run in the Supabase SQL editor AFTER the migration. Nothing here writes. Each query lists its expected result.
-- (tests/commerce-sql.test.ts runs this file against PGlite too.)

-- 1. Function signatures and privileges. Expected: every row exists = true;
--    anon true only for the three store_public_* functions; authenticated true for those plus
--    claim_store_slug and create_store_preview_token; both false for every _store_public_* helper.
SELECT f AS function_name,
       to_regprocedure(f) IS NOT NULL AS "exists",
       CASE WHEN to_regprocedure(f) IS NOT NULL THEN has_function_privilege('anon', f, 'EXECUTE') END AS anon,
       CASE WHEN to_regprocedure(f) IS NOT NULL THEN has_function_privilege('authenticated', f, 'EXECUTE') END AS authenticated
FROM unnest(ARRAY[
  'public.store_public_get(text, text)',
  'public.store_public_listings(text, text, text, integer, integer, text)',
  'public.store_public_listing(text, uuid, text)',
  'public.claim_store_slug(uuid, text)',
  'public.create_store_preview_token(uuid)',
  'public._store_public_store(text, text)',
  'public._store_public_is_preview(uuid, text)',
  'public._store_public_rows(uuid, boolean)',
  'public._store_public_settings(text)'
]) AS f;

-- 2. Old 001 signatures are gone. Expected: 0.
SELECT count(*) AS old_signatures
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND ((p.proname IN ('store_public_get', '_store_public_store') AND p.pronargs = 1)
    OR (p.proname = 'store_public_listings' AND p.pronargs = 5));

-- 3. Wholesale stores are never public: the gate mentions the retail / hybrid rule. Expected: true.
SELECT position('retail' IN pg_get_functiondef('public._store_public_store(text, text)'::regprocedure)) > 0
   AND position('hybrid' IN pg_get_functiondef('public._store_public_store(text, text)'::regprocedure)) > 0 AS wholesale_gate_present;

-- 4. Allow-list on the three public functions. Expected: 0 rows.
SELECT p.proname AS function_name, a.name AS forbidden_column
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL unnest(p.proargnames, p.proargmodes) AS a(name, mode)
WHERE n.nspname = 'public'
  AND p.proname IN ('store_public_get', 'store_public_listings', 'store_public_listing')
  AND a.mode = 't'
  AND a.name IN ('cost', 'cost_lbp', 'min_price', 'price_wholesale', 'price_wholesale_lbp', 'price_super_wholesale',
                 'price_super_wholesale_lbp', 'reorder_point', 'track_inventory', 'tenant_id', 'local_id', 'global_id',
                 'product_id', 'barcode', 'email', 'password');

-- 5. Preview tokens table: RLS on, no policies (reachable only through the functions). Expected: true, 0.
SELECT c.relrowsecurity AS rls_enabled,
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'store_preview_tokens') AS policies
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'store_preview_tokens';

-- 6. Photo bucket. Expected: public = true, file_size_limit = 2097152, allowed_mime_types = {image/webp}.
SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'store-images';

-- 7. Storage policies: owner-only insert / update / delete, none for anon. Expected: 3 rows, roles {authenticated}.
SELECT policyname, cmd, roles FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'store-images %'
ORDER BY policyname;
