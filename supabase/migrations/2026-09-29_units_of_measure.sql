-- OmniPOS units of measure (packs, cartons with their own barcodes/prices). NOT applied automatically.
-- Until this runs, the desktop sync skips the product_units table (one warning, sync itself keeps
-- working) and strips the new transaction_items columns when pushing (cloudMissingColumns in
-- server/sync.ts), so units stay local to each register. Run it in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.product_units (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID REFERENCES public.tenants(global_id),
    product_id UUID REFERENCES public.products(global_id),
    name TEXT NOT NULL,
    factor NUMERIC NOT NULL,
    barcode TEXT,
    price NUMERIC NOT NULL,
    price_lbp NUMERIC,
    price_wholesale NUMERIC,
    price_wholesale_lbp NUMERIC,
    price_super_wholesale NUMERIC,
    price_super_wholesale_lbp NUMERIC,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_product_units_tenant_product ON public.product_units (tenant_id, product_id);
CREATE INDEX IF NOT EXISTS idx_product_units_tenant_barcode ON public.product_units (tenant_id, barcode);

ALTER TABLE public.product_units ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Product Units isolate" ON public.product_units;
CREATE POLICY "Product Units isolate" ON public.product_units
FOR ALL TO authenticated
USING (tenant_id::text = auth.uid()::text)
WITH CHECK (tenant_id::text = auth.uid()::text);

-- Line-level unit snapshot. Quantity/unit_price/unit_cost stay in BASE PIECES / per piece.
-- uom_id / original_item_id are foreign keys translated to global UUIDs by the sync (server/sync.ts
-- fkMap), like product_id. No REFERENCES constraint: the refunded line may be archived locally.
ALTER TABLE public.transaction_items ADD COLUMN IF NOT EXISTS uom_id UUID;
ALTER TABLE public.transaction_items ADD COLUMN IF NOT EXISTS uom_name TEXT;
ALTER TABLE public.transaction_items ADD COLUMN IF NOT EXISTS uom_factor NUMERIC;
ALTER TABLE public.transaction_items ADD COLUMN IF NOT EXISTS uom_qty NUMERIC;
ALTER TABLE public.transaction_items ADD COLUMN IF NOT EXISTS original_item_id UUID;
