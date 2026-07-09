-- Enable Row Level Security on all tables
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_barcodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stakeholders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.currencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_flow ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashier_shifts ENABLE ROW LEVEL SECURITY;

-- Policy 1: Tenants can only see and update their own business record
CREATE POLICY "Tenants isolate" ON public.tenants
FOR ALL TO authenticated
USING (global_id::text = auth.uid()::text)
WITH CHECK (global_id::text = auth.uid()::text);

-- Policy 2: Products isolate (Business A cannot see Business B's products)
CREATE POLICY "Products isolate" ON public.products
FOR ALL TO authenticated
USING (tenant_id::text = auth.uid()::text)
WITH CHECK (tenant_id::text = auth.uid()::text);

-- Policy 3: Product Barcodes isolate
CREATE POLICY "Product Barcodes isolate" ON public.product_barcodes
FOR ALL TO authenticated
USING (product_id IN (SELECT global_id FROM public.products WHERE tenant_id::text = auth.uid()::text))
WITH CHECK (product_id IN (SELECT global_id FROM public.products WHERE tenant_id::text = auth.uid()::text));

-- Policy 4: Stakeholders isolate
CREATE POLICY "Stakeholders isolate" ON public.stakeholders
FOR ALL TO authenticated
USING (tenant_id::text = auth.uid()::text)
WITH CHECK (tenant_id::text = auth.uid()::text);

-- Policy 5: Users isolate
CREATE POLICY "Users isolate" ON public.users
FOR ALL TO authenticated
USING (tenant_id::text = auth.uid()::text)
WITH CHECK (tenant_id::text = auth.uid()::text);

-- Policy 6: Transactions isolate
CREATE POLICY "Transactions isolate" ON public.transactions
FOR ALL TO authenticated
USING (tenant_id::text = auth.uid()::text)
WITH CHECK (tenant_id::text = auth.uid()::text);

-- Policy 7: Transaction Items isolate
CREATE POLICY "Transaction Items isolate" ON public.transaction_items
FOR ALL TO authenticated
USING (transaction_id IN (SELECT global_id FROM public.transactions WHERE tenant_id::text = auth.uid()::text))
WITH CHECK (transaction_id IN (SELECT global_id FROM public.transactions WHERE tenant_id::text = auth.uid()::text));

-- Policy 8: Payments isolate
CREATE POLICY "Payments isolate" ON public.payments
FOR ALL TO authenticated
USING (transaction_id IN (SELECT global_id FROM public.transactions WHERE tenant_id::text = auth.uid()::text))
WITH CHECK (transaction_id IN (SELECT global_id FROM public.transactions WHERE tenant_id::text = auth.uid()::text));

-- Policy 9: Currencies isolate
CREATE POLICY "Currencies isolate" ON public.currencies
FOR ALL TO authenticated
USING (tenant_id::text = auth.uid()::text)
WITH CHECK (tenant_id::text = auth.uid()::text);

-- Policy 10: Settings isolate
CREATE POLICY "Settings isolate" ON public.settings
FOR ALL TO authenticated
USING (tenant_id::text = auth.uid()::text)
WITH CHECK (tenant_id::text = auth.uid()::text);

-- Policy 11: Cash Flow isolate
CREATE POLICY "Cash Flow isolate" ON public.cash_flow
FOR ALL TO authenticated
USING (tenant_id::text = auth.uid()::text)
WITH CHECK (tenant_id::text = auth.uid()::text);

-- Policy 12: Daily Reports isolate
CREATE POLICY "Daily Reports isolate" ON public.daily_reports
FOR ALL TO authenticated
USING (tenant_id::text = auth.uid()::text)
WITH CHECK (tenant_id::text = auth.uid()::text);

-- Policy 13: Cashier Shifts isolate
CREATE POLICY "Cashier Shifts isolate" ON public.cashier_shifts
FOR ALL TO authenticated
USING (tenant_id::text = auth.uid()::text)
WITH CHECK (tenant_id::text = auth.uid()::text);
