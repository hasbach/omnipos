-- Users can be disabled instead of deleted (users.active: 1 = active, 0 = disabled). Registers push the
-- column once the cloud has it (OPTIONAL_CLOUD_COLUMNS) and re-push the rows that hold a value. Idempotent.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS active INTEGER NOT NULL DEFAULT 1;
