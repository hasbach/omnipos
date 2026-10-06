-- products.stock / reorder_point / units_per_package become NUMERIC.
--
-- Products are sold by kg and g, and unit factors are NUMERIC (product_units.factor), so these values
-- are fractional on the desktop (REAL in SQLite) — and floating-point arithmetic leaves noise such as
-- 1.8000000000000016 or -6.1e-30. The cloud columns were INTEGER, so every push of such a product
-- failed with "invalid input syntax for type integer" and was retried every sync cycle.
-- The desktop now rounds these to 6 decimals before pushing (server/sync.ts).
--
-- Applying this alone unblocks registers still on an older version: their pending pushes succeed.

ALTER TABLE public.products
  ALTER COLUMN stock TYPE NUMERIC USING stock::numeric,
  ALTER COLUMN reorder_point TYPE NUMERIC USING reorder_point::numeric,
  ALTER COLUMN units_per_package TYPE NUMERIC USING units_per_package::numeric;
