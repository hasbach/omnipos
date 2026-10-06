-- DO NOT APPLY until every register runs >= 1.7.6 (older versions copy every cloud column on pull
-- and would fail).
--
-- Local-currency exchange rates (units of the tenant's local currency per USD):
--  - transactions.local_rate / local_currency: the rate (the party's own, else the global one) and
--    that currency's code frozen at sale time. The cloud has no archived_transactions table
--    (archives are local-only structures), so only transactions is altered.
--  - stakeholders.local_rate: a customer/supplier's own rate; NULL = use the global currency rate.
-- Registers push these columns once they exist (they learn that from the cloud's PGRST204 answer,
-- strip them until then, and re-push rows holding a value the first time the cloud accepts them).
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS local_rate NUMERIC;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS local_currency TEXT;
ALTER TABLE public.stakeholders ADD COLUMN IF NOT EXISTS local_rate NUMERIC;
