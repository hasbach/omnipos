-- OmniPOS custom cash-flow categories (admin-defined, Settings -> Cash flow categories).
-- NOT applied automatically. Until this runs, the desktop sync skips the cash_flow_categories table
-- (one warning, sync itself keeps working) so custom categories stay local to each register.
-- Run it in the Supabase SQL editor.
--
-- key: stable slug ("c_" + random hex) stored in cash_flow.category; unique per tenant. The built-in
--      categories (top_up, loan_in, ...) are fixed in the app and are NOT rows here.
-- direction: 'in' | 'out' | 'both'.  active: 1 = offered in pickers, 0 = hidden (old rows keep the key).

CREATE TABLE IF NOT EXISTS public.cash_flow_categories (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID REFERENCES public.tenants(global_id),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'both')),
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_flow_categories_tenant_key ON public.cash_flow_categories (tenant_id, key);

ALTER TABLE public.cash_flow_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Cash Flow Categories isolate" ON public.cash_flow_categories;
CREATE POLICY "Cash Flow Categories isolate" ON public.cash_flow_categories
FOR ALL TO authenticated
USING (tenant_id::text = auth.uid()::text)
WITH CHECK (tenant_id::text = auth.uid()::text);
