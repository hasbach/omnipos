-- Emergency online sales (Live Monitor "Make a Sale") — run this in the Supabase SQL Editor,
-- after supabase_schema.sql / supabase_rls.sql are up to date (needs products.track_inventory).
--
-- One atomic RPC, callable from an authenticated browser client via supabase.rpc(...). It runs
-- as SECURITY INVOKER (the caller's own privileges), so Row Level Security applies to every
-- statement inside it exactly as if the client had issued them directly — this function does
-- NOT bypass RLS. It also independently scopes every query by tenant_id itself (defense in
-- depth), and never trusts client-supplied prices — it looks up the authoritative price from
-- `products` server-side, mirroring server/routes.ts's POST /api/transactions trust model.

-- Idempotency guard: lets the client safely retry a submit (e.g. after a dropped connection)
-- without creating a duplicate sale.
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS transactions_tenant_idempotency_key
  ON public.transactions (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Unlike local SQLite (which has a `trg_<table>_updated_at` trigger on every table, see
-- server/db.ts), these Supabase tables only default `updated_at` on INSERT — a plain UPDATE
-- never bumps it. The offline-first pull sync (server/sync.ts) is entirely driven by
-- `updated_at` timestamps, so without this, the stock/balance changes this RPC makes would
-- never be picked up by the desktop app when it reconnects. Add the same auto-touch behavior
-- here for the two tables this RPC mutates via UPDATE (products.stock, stakeholders.balance).
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_updated_at ON public.products;
CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_stakeholders_updated_at ON public.stakeholders;
CREATE TRIGGER trg_stakeholders_updated_at
  BEFORE UPDATE ON public.stakeholders
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.record_online_sale(
  p_items JSONB,               -- [{ "product_id": "uuid", "quantity": number }, ...]
  p_stakeholder_id UUID,
  p_method TEXT,               -- 'cash' | 'credit'
  p_idempotency_key TEXT,
  p_user_id UUID DEFAULT NULL  -- optional staff member who made the sale
)
RETURNS TABLE (transaction_id UUID, total_amount NUMERIC)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := auth.uid();
  v_item JSONB;
  v_product RECORD;
  v_quantity NUMERIC;
  v_num_packages NUMERIC;
  v_remainder NUMERIC;
  v_unit_price NUMERIC;
  v_item_total NUMERIC;
  v_total NUMERIC := 0;
  v_computed JSONB := '[]'::jsonb;
  v_transaction_id UUID;
  v_existing RECORD;
BEGIN
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_method NOT IN ('cash', 'credit') THEN
    RAISE EXCEPTION 'Invalid payment method: %', p_method;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No items in sale';
  END IF;

  -- Idempotent retry: if this exact sale was already recorded, return it instead of duplicating.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT t.global_id, t.total_amount INTO v_existing
    FROM public.transactions t
    WHERE t.tenant_id = v_tenant_id AND t.idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      RETURN QUERY SELECT v_existing.global_id, v_existing.total_amount;
      RETURN;
    END IF;
  END IF;

  -- Pass 1: look up authoritative price/stock server-side (never trust the client), locking
  -- each product row so concurrent sales can't race the stock check.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT p.global_id, p.price, p.package_price, p.units_per_package, p.track_inventory, p.stock
      INTO v_product
      FROM public.products p
      WHERE p.global_id = (v_item->>'product_id')::uuid
        AND p.tenant_id = v_tenant_id
      FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product % not found for this business', (v_item->>'product_id');
    END IF;

    v_quantity := (v_item->>'quantity')::numeric;
    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid quantity for product %', v_product.global_id;
    END IF;

    IF v_product.package_price IS NOT NULL AND v_product.units_per_package > 1 THEN
      v_num_packages := floor(v_quantity / v_product.units_per_package);
      v_remainder := v_quantity - (v_num_packages * v_product.units_per_package);
      v_item_total := (v_num_packages * v_product.package_price) + (v_remainder * v_product.price);
      v_unit_price := v_item_total / v_quantity;
    ELSE
      v_unit_price := v_product.price;
      v_item_total := v_unit_price * v_quantity;
    END IF;

    v_total := v_total + v_item_total;

    v_computed := v_computed || jsonb_build_object(
      'product_id', v_product.global_id,
      'quantity', v_quantity,
      'unit_price', v_unit_price,
      'track_inventory', v_product.track_inventory
    );
  END LOOP;

  -- If a staff member was given, make sure it actually belongs to this tenant.
  IF p_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users WHERE global_id = p_user_id AND tenant_id = v_tenant_id
  ) THEN
    RAISE EXCEPTION 'User % not found for this business', p_user_id;
  END IF;

  -- Transaction header.
  INSERT INTO public.transactions (tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, status, idempotency_key)
  VALUES (v_tenant_id, p_stakeholder_id, p_user_id, 'sale', v_total, 'USD', 1, 'completed', p_idempotency_key)
  RETURNING global_id INTO v_transaction_id;

  -- Pass 2: line items + stock decrement (skipping service/non-stock items).
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_computed)
  LOOP
    INSERT INTO public.transaction_items (transaction_id, product_id, quantity, unit_price)
    VALUES (v_transaction_id, (v_item->>'product_id')::uuid, (v_item->>'quantity')::numeric, (v_item->>'unit_price')::numeric);

    IF (v_item->>'track_inventory')::int IS DISTINCT FROM 0 THEN
      UPDATE public.products
        SET stock = stock - (v_item->>'quantity')::numeric
        WHERE global_id = (v_item->>'product_id')::uuid AND tenant_id = v_tenant_id;
    END IF;
  END LOOP;

  -- Cash vs. credit, mirroring server/routes.ts's POST /api/transactions exactly.
  IF p_method = 'cash' THEN
    INSERT INTO public.payments (transaction_id, amount, method, currency, exchange_rate)
    VALUES (v_transaction_id, v_total, 'cash', 'USD', 1);
  ELSE
    UPDATE public.stakeholders
      SET balance = balance + v_total
      WHERE global_id = p_stakeholder_id AND tenant_id = v_tenant_id;
  END IF;

  RETURN QUERY SELECT v_transaction_id, v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.record_online_sale(JSONB, UUID, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_online_sale(JSONB, UUID, TEXT, TEXT, UUID) TO authenticated;
