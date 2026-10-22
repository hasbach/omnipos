-- Read-only checks for 2026-10-23_retail_ordering_s2.sql (003 Slice 2). Run in the Supabase SQL editor after the
-- migration; every row should show ok = true. The gateway-key row is informational (0 until the owner inserts the
-- hash, quickstart-s2 §1.3) and never shows a key or hash.

-- 1. Order tables exist with RLS on.
SELECT c.relname AS "table", c.relrowsecurity AS ok
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orders', 'order_lines', 'order_events', 'order_counters', 'order_blocked_phones', 'storefront_gateway_keys')
ORDER BY 1;

-- 2. Policies: exactly one owner SELECT policy on each synced order table, none on the private ones.
SELECT t.tbl AS "table",
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl) = t.expected
       AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl AND p.cmd <> 'SELECT') AS ok
FROM (VALUES ('orders', 1), ('order_lines', 1), ('order_events', 1),
             ('order_counters', 0), ('order_blocked_phones', 0), ('storefront_gateway_keys', 0)) AS t(tbl, expected)
ORDER BY 1;

-- 3. Function grants match contracts/cloud-api-s2.md.
SELECT f.fn,
       has_function_privilege('anon', 'public.' || f.fn, 'EXECUTE') = f.anon
       AND has_function_privilege('authenticated', 'public.' || f.fn, 'EXECUTE') = f.auth AS ok
FROM (VALUES
  ('order_quote(text, text, jsonb)', true, true),
  ('order_submit(text, text, text, text, text, jsonb, jsonb, numeric, text)', true, true),
  ('order_status(text, text)', true, true),
  ('order_cancel(text, text)', true, true),
  ('order_accept(uuid, text, jsonb, jsonb)', false, true),
  ('order_reject(uuid, text, text, jsonb)', false, true),
  ('order_ready(uuid, text, jsonb)', false, true),
  ('order_cancel_by_shop(uuid, text, text, jsonb)', false, true),
  ('order_complete(uuid, uuid, numeric, jsonb)', false, true),
  ('order_complete_undo(uuid, uuid, jsonb)', false, true),
  ('orders_sweep()', false, true),
  ('order_blocked_phones(uuid)', false, true),
  ('order_block_phone(uuid, text, text)', false, true),
  ('order_unblock_phone(uuid, text)', false, true),
  ('_gateway_ok(text)', false, false),
  ('_order_quote(uuid, jsonb)', false, false),
  ('_orders_expire(uuid)', false, false),
  ('_order_lock(uuid)', false, false),
  ('_order_phone(text)', false, false)
) AS f(fn, anon, auth)
ORDER BY 1;

-- 4. Table privileges: anon has none; owners can't write order tables directly.
SELECT t.tbl AS "table",
       NOT has_table_privilege('anon', 'public.' || t.tbl, 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public.' || t.tbl, 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.' || t.tbl, 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.' || t.tbl, 'DELETE') AS ok
FROM (VALUES ('orders'), ('order_lines'), ('order_events'), ('order_counters'), ('order_blocked_phones'), ('storefront_gateway_keys')) AS t(tbl)
ORDER BY 1;

-- 5. transactions.order_global_id exists (the desktop pushes it once present).
SELECT 'transactions.order_global_id' AS "column",
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'order_global_id') AS ok;

-- 6. Store settings default includes order_expiry_hours = 24.
SELECT 'order_expiry_hours default' AS check, (public._store_public_settings('{}')->>'order_expiry_hours') = '24' AS ok;

-- 7. Data consistency: order totals equal the sum of their lines; completed orders have a sale.
SELECT 'order totals = sum of lines' AS check, NOT EXISTS (
  SELECT 1 FROM public.orders o
  WHERE o.total_usd <> (SELECT coalesce(sum(l.line_total_usd), 0) FROM public.order_lines l WHERE l.order_id = o.global_id)
) AS ok;
SELECT 'completed orders have a sale' AS check,
       NOT EXISTS (SELECT 1 FROM public.orders WHERE state = 'completed' AND sale_global_id IS NULL) AS ok;

-- 8. Informational: number of active gateway keys (expect 1 after quickstart-s2 §1.3).
SELECT 'active gateway keys' AS check, count(*) AS keys FROM public.storefront_gateway_keys WHERE revoked_at IS NULL;
