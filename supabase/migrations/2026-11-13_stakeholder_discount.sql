-- Loyalty: a customer's standing discount (percent off the whole sale). The POS applies it as the sale's
-- global discount when the customer is picked. NULL / 0 = no standing discount.
-- Safe to apply at any time: registers that do not know the column ignore it on pull, and registers
-- on >= 1.11.0 push it once the cloud accepts it (same optional-column probe as stakeholders.local_rate).
ALTER TABLE public.stakeholders ADD COLUMN IF NOT EXISTS discount_percent NUMERIC;
