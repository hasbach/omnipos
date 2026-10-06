-- Server-time pull cursor for the offline-first sync (OmniPOS 1.7.8).
--
-- SAFE TO APPLY while registers run >= 1.7.6: they copy only the columns they know on pull (unknown
-- cloud columns such as synced_at are dropped), so nothing breaks. Registers on 1.7.8+ detect the
-- column and switch from the clock-based updated_at cursor to a (synced_at, global_id) keyset cursor;
-- until it exists they fall back to an overlapped updated_at cursor.
--
-- Why: `updated_at` is whatever clock the PUSHING register had. A cursor on it can skip rows - a
-- register's own later edit moves its cursor past another register's earlier-stamped row, and an
-- offline register that reconnects pushes a backlog with OLD timestamps that no other cursor will
-- ever reach. `synced_at` is stamped by the database (clock_timestamp()) on every insert/update. It is
-- write time, not commit time, so a row can become visible slightly after a later-stamped one; the pull
-- re-reads a 2-minute overlap, which comfortably exceeds the API roles' statement_timeout (8 s), so no
-- committed row is missed. Existing rows all receive the migration's timestamp, so an interrupted first
-- re-download restarts inside that same batch (cursor - overlap) and skips nothing. The first pull per table on a 1.7.8
-- register starts from the epoch (a one-time re-download that heals rows missed earlier; rows
-- identical locally are skipped, rows with pending local edits are never overwritten).
--
-- Applied to every table the registers pull that exists in this project; tables that are missing are
-- skipped, so this is safe to re-run.

CREATE OR REPLACE FUNCTION public.set_synced_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.synced_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t text;
  has_tenant boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenants',
    'products', 'product_barcodes', 'product_units', 'stakeholders', 'users',
    'transactions', 'transaction_items', 'payments',
    'currencies', 'settings', 'cash_flow_categories', 'cash_flow', 'daily_reports', 'cashier_shifts', 'settlement_corrections'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'skipping %: table does not exist', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS synced_at timestamptz NOT NULL DEFAULT now()', t);

    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_synced_at ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_synced_at BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_synced_at()', t, t);

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'tenant_id'
    ) INTO has_tenant;

    IF has_tenant THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_tenant_synced_at ON public.%I (tenant_id, synced_at, global_id)', t, t);
    ELSE
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_synced_at ON public.%I (synced_at, global_id)', t, t);
    END IF;
  END LOOP;
END;
$$;
