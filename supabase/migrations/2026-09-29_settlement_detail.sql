-- OmniPOS settlement detail: full closing snapshot per End-of-Day report + admin corrections.
-- NOT applied automatically. Until this runs, the desktop sync strips the new daily_reports columns
-- when pushing (cloudMissingColumns in server/sync.ts) and skips settlement_corrections (missing
-- cloud tables are skipped with one warning), so the detail stays local to each register.
-- Run it in the Supabase SQL editor. (settled_at/period_start are TEXT on purpose: they are compared as
-- "YYYY-MM-DD HH:MM:SS" strings locally, and a TIMESTAMP column would round-trip as ISO "...T...".)

ALTER TABLE public.daily_reports ADD COLUMN IF NOT EXISTS settled_at TEXT;
ALTER TABLE public.daily_reports ADD COLUMN IF NOT EXISTS period_start TEXT;
ALTER TABLE public.daily_reports ADD COLUMN IF NOT EXISTS total_refunds NUMERIC DEFAULT 0;
ALTER TABLE public.daily_reports ADD COLUMN IF NOT EXISTS counted_json TEXT;
ALTER TABLE public.daily_reports ADD COLUMN IF NOT EXISTS snapshot_json TEXT;
ALTER TABLE public.daily_reports ADD COLUMN IF NOT EXISTS corrected_actual_balance NUMERIC;
ALTER TABLE public.daily_reports ADD COLUMN IF NOT EXISTS adjustments_total NUMERIC DEFAULT 0;

-- Append-only corrections to a closed settlement (the original report numbers are never edited).
-- report_id / user_id are translated to global UUIDs by the sync (fkMap in server/sync.ts).
CREATE TABLE IF NOT EXISTS public.settlement_corrections (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID REFERENCES public.tenants(global_id),
    report_id UUID REFERENCES public.daily_reports(global_id),
    user_id UUID REFERENCES public.users(global_id),
    kind TEXT NOT NULL CHECK (kind IN ('counted', 'adjustment')),
    currency TEXT,
    old_value NUMERIC,
    new_value NUMERIC,
    amount_usd NUMERIC,
    reason TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_settlement_corrections_report ON public.settlement_corrections (report_id);

ALTER TABLE public.settlement_corrections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Settlement Corrections isolate" ON public.settlement_corrections;
CREATE POLICY "Settlement Corrections isolate" ON public.settlement_corrections
FOR ALL TO authenticated
USING (tenant_id::text = auth.uid()::text)
WITH CHECK (tenant_id::text = auth.uid()::text);
