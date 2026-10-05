-- Product extra barcodes are now soft-deleted (deleted_at) instead of deleted, so a removal syncs and
-- stays recoverable in the cloud.
--
-- Why the global UNIQUE(barcode) goes: older desktop versions re-inserted a product's extra barcodes
-- with NEW global_ids on every save, while the previous rows (same barcodes) stayed live in the cloud.
-- Every push then failed on product_barcodes_barcode_key and was retried every 10 seconds, forever
-- (~1.2M failing requests/day). The constraint was also global across tenants, so one store's barcode
-- blocked another store's. Uniqueness is enforced per tenant by the desktop app; the cloud keeps one
-- live row per barcode by soft-deleting replaced rows (see server/sync.ts retireCloudBarcodeDuplicates).
--
-- Applying step 1 alone stops the retry loop of desktops still on the old version: their pending
-- pushes succeed. Run step 2 afterwards (re-runnable) to retire the replaced duplicates.

-- 1. Drop the global unique constraint; keep barcode lookups indexed.
ALTER TABLE public.product_barcodes DROP CONSTRAINT IF EXISTS product_barcodes_barcode_key;
CREATE INDEX IF NOT EXISTS idx_product_barcodes_barcode ON public.product_barcodes (barcode);
CREATE INDEX IF NOT EXISTS idx_product_barcodes_product ON public.product_barcodes (product_id);

-- 2. Within each tenant, keep the most recently updated live row per barcode and soft-delete the rest.
--    updated_at is left unchanged on purpose: desktops don't need to pull these old rows, and older
--    desktop versions can't store a second row with a barcode they already hold.
WITH ranked AS (
  SELECT pb.global_id,
         row_number() OVER (
           PARTITION BY p.tenant_id, pb.barcode
           ORDER BY pb.updated_at DESC NULLS LAST, pb.created_at DESC NULLS LAST
         ) AS rn
  FROM public.product_barcodes pb
  JOIN public.products p ON p.global_id = pb.product_id
  WHERE pb.deleted_at IS NULL
)
UPDATE public.product_barcodes pb
   SET deleted_at = now()
  FROM ranked r
 WHERE pb.global_id = r.global_id
   AND r.rn > 1;
