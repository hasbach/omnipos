-- OmniPulse OR: the "owner as a customer" setting (or_tenant_config.owner_stakeholder_id) exists on the
-- registers since 1.13.0 but was never added to the cloud table, so it was stripped from every push and
-- never reached other registers. Registers on 1.13.5+ re-push the rows that hold a value once this exists.
-- Idempotent.
ALTER TABLE public.or_tenant_config
  ADD COLUMN IF NOT EXISTS owner_stakeholder_id UUID REFERENCES public.stakeholders(global_id) ON DELETE SET NULL;
