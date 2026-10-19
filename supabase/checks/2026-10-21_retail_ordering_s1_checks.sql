-- Read-only checks for supabase/migrations/2026-10-21_retail_ordering_s1.sql (specs/003-retail-ordering, Slice 1).
-- Run in the Supabase SQL editor AFTER the migration. Nothing here writes. Each query lists its expected result.
-- (tests/commerce-sql.test.ts runs this file against PGlite too.)

-- 1. Function signatures and privileges. Expected: every row exists = true; anon and authenticated true only for
--    the three store_public_* functions, false for the internal helpers.
SELECT f AS function_name,
       to_regprocedure(f) IS NOT NULL AS "exists",
       CASE WHEN to_regprocedure(f) IS NOT NULL THEN has_function_privilege('anon', f, 'EXECUTE') END AS anon,
       CASE WHEN to_regprocedure(f) IS NOT NULL THEN has_function_privilege('authenticated', f, 'EXECUTE') END AS authenticated
FROM unnest(ARRAY[
  'public.store_public_get(text, text)',
  'public.store_public_listings(text, text, text, integer, integer, text)',
  'public.store_public_listing(text, uuid, text)',
  'public._store_public_settings(text)',
  'public._store_setting_on(jsonb)',
  'public._store_orderable_keys(text)'
]) AS f;

-- 2. New output columns. Expected: 3 rows, every flag true.
SELECT p.proname AS function_name,
       'ordering_mode' = ANY (p.proargnames) OR p.proname <> 'store_public_get' AS has_ordering_mode,
       'min_order_usd' = ANY (p.proargnames) OR p.proname <> 'store_public_get' AS has_min_order,
       'base_orderable' = ANY (p.proargnames) OR p.proname = 'store_public_get' AS has_base_orderable
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('store_public_get', 'store_public_listings', 'store_public_listing')
ORDER BY p.proname;

-- 3. Orderable keys parsing. Expected: {base,abc}, NULL, NULL, NULL, NULL.
SELECT public._store_orderable_keys('["base","abc"]') AS strings,
       public._store_orderable_keys('[3,5]') AS legacy_ids,
       public._store_orderable_keys('[]') AS empty_array,
       public._store_orderable_keys('not json') AS invalid,
       public._store_orderable_keys(NULL) AS no_value;

-- 4. Allow-list on the three public functions (same list as 2026-10-19 check 4). Expected: 0 rows.
SELECT p.proname AS function_name, a.name AS forbidden_column
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL unnest(p.proargnames, p.proargmodes) AS a(name, mode)
WHERE n.nspname = 'public'
  AND p.proname IN ('store_public_get', 'store_public_listings', 'store_public_listing')
  AND a.mode = 't'
  AND a.name IN ('cost', 'cost_lbp', 'min_price', 'price_wholesale', 'price_wholesale_lbp', 'price_super_wholesale',
                 'price_super_wholesale_lbp', 'reorder_point', 'track_inventory', 'tenant_id', 'local_id', 'global_id',
                 'product_id', 'barcode', 'email', 'password', 'orderable_unit_ids', 'settings');
