-- OmniPOS 1.2.0 cloud schema additions. NOT applied automatically.
-- Until this runs, the desktop sync simply strips these columns when pushing (see
-- cloudMissingColumns in server/sync.ts), so price tiers / price levels / notes stay local to each
-- register. Run it in the Supabase SQL editor to share them across terminals.

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS price_wholesale NUMERIC;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS price_wholesale_lbp NUMERIC;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS price_super_wholesale NUMERIC;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS price_super_wholesale_lbp NUMERIC;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS min_price NUMERIC;

ALTER TABLE public.stakeholders ADD COLUMN IF NOT EXISTS price_level TEXT DEFAULT 'retail';
ALTER TABLE public.stakeholders ADD COLUMN IF NOT EXISTS credit_limit NUMERIC;

ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS price_level TEXT;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS reference TEXT;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS edit_count INTEGER DEFAULT 0;

ALTER TABLE public.transaction_items ADD COLUMN IF NOT EXISTS unit_cost NUMERIC;
