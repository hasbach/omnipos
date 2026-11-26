// OmniPulse OR (paid add-on module) end-to-end tests:
// licensing gate, presets, Spendable Cash, Owner Draw, PO Cash-Lock & partial receiving,
// 5-Minute Blind Cycle Count + negative-stock anomaly hook, and idempotent Nightly Pipeline.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let n = 0;

before(async () => {
  app = await createTestApp();
});
after(async () => {
  await app.close();
});

function setupTenant(licensed = true) {
  n++;
  const tenantId = seedTenant(app.db, `OR Shop ${n}`, `or${n}-${Date.now()}@example.com`);
  const admin = (app.db.prepare("SELECT id FROM users WHERE tenant_id = ? AND role = 'admin'").get(tenantId) as any).id as number;
  if (licensed) {
    app.db.prepare("UPDATE tenants SET or_license_type = 'lifetime', or_license_expiry = NULL WHERE id = ?").run(tenantId);
  }
  const as = { tenantId, userId: admin };
  return { tenantId, admin, as };
}

test("unlicensed tenant is gated with 403 OR_LICENSE_REQUIRED while status remains readable", async () => {
  const s = setupTenant(false);
  const st = await app.api("GET", "/api/or/status", s.as);
  assert.equal(st.status, 200);
  assert.equal(st.body.licensed, false);
  assert.equal(st.body.license_type, "none");

  const br = await app.api("GET", "/api/or/briefing", s.as);
  assert.equal(br.status, 403);
  assert.equal(br.body.code, "OR_LICENSE_REQUIRED");
});

test("industry presets, fixed obligations, and Real Spendable Cash formula", async () => {
  const s = setupTenant(true);

  // Apply SERVICE preset -> cycle count disabled by default
  const svc = await app.api("POST", "/api/or/apply-preset", { ...s.as, body: { business_type: "SERVICE" } });
  assert.equal(svc.status, 200);
  assert.equal(svc.body.config.business_type, "SERVICE");
  assert.equal(svc.body.config.enable_cycle_count, 0);

  // Switch back to RETAIL preset (min_drawer_float = 30)
  const ret = await app.api("POST", "/api/or/apply-preset", { ...s.as, body: { business_type: "RETAIL" } });
  assert.equal(ret.status, 200);
  assert.equal(ret.body.config.min_drawer_float, 30);

  // Seed $500 cash into default Cash Drawer via Core cash_flow
  const cf = await app.api("POST", "/api/cash-flow", {
    ...s.as,
    body: { type: "in", amount: 500, currency: "USD", exchange_rate: 1, category: "top_up", reason: "Opening cash" },
  });
  assert.equal(cf.status, 200);

  // A $300/month rent obligation due TODAY: the reserve restarts at 0 on the due date (the bill is paid
  // from the real cash accounts) — it is derived, never accumulated.
  const today = new Date();
  const ob = await app.api("POST", "/api/or/obligations", {
    ...s.as,
    body: { name: "Store Rent", amount_usd: 300, frequency: "monthly", due_day: today.getDate() },
  });
  assert.equal(ob.status, 200);

  const run1 = await app.api("POST", "/api/or/pipeline/run", s.as);
  assert.equal(run1.status, 200);
  assert.equal(run1.body.opex_accrued_usd, 0);

  // Re-running any number of times never grows the reserve
  const run2 = await app.api("POST", "/api/or/pipeline/run", s.as);
  assert.equal(run2.status, 200);
  assert.equal(run2.body.opex_accrued_usd, 0);

  // Free Spendable Cash = 500 (drawer) - 30 (float) - 0 (OpEx reserve) - 0 (PO locks) = 470
  const sp = await app.api("GET", "/api/or/spendable-cash", s.as);
  assert.equal(sp.status, 200);
  assert.equal(sp.body.total_liquid_cash_usd, 500);
  assert.equal(sp.body.locked_opex_reserve_usd, 0);
  assert.equal(sp.body.free_spendable_cash_usd, 470);
});

test("Owner Draw enforces survival caps and links atomically to Core cash_flow and stock_adjustments", async () => {
  const s = setupTenant(true);
  // Seed cash + product
  await app.api("POST", "/api/cash-flow", {
    ...s.as,
    body: { type: "in", amount: 200, currency: "USD", exchange_rate: 1, category: "top_up", reason: "Float" },
  });
  const pInfo = app.db
    .prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'OR-1', 'Milk', 2.0, 1.2, 20, 1)")
    .run(s.tenantId);
  const prodId = Number(pInfo.lastInsertRowid);

  // Default RECOVERY cap is $25/day cash, $10/day goods -> $100 cash draw without override_reason must fail
  const blocked = await app.api("POST", "/api/or/owner-draws", {
    ...s.as,
    body: { cash_amount: 100 },
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.code, "OR_DRAW_CAP_EXCEEDED");

  // Mixed draw with override reason succeeds and deducts both Core cash_flow and Core stock_adjustments
  const ok = await app.api("POST", "/api/or/owner-draws", {
    ...s.as,
    body: {
      cash_amount: 40,
      items: [{ product_id: prodId, quantity: 3 }],
      override_reason: "Emergency family expense",
    },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.draw_type, "MIXED");
  assert.equal(ok.body.exceeded_cap, 1);
  assert.equal(ok.body.goods_cost_total, 3.6);
  assert.ok(ok.body.core_cash_tx_id > 0);
  assert.equal(ok.body.items.length, 1);
  assert.ok(ok.body.items[0].core_stock_tx_id > 0);

  // Verify Core product stock decreased from 20 -> 17
  const prodRow = app.db.prepare("SELECT stock FROM products WHERE id = ?").get(prodId) as any;
  assert.equal(prodRow.stock, 17);

  // Verify Core cash_flow row exists with category='owner_withdrawal'
  const cfRow = app.db.prepare("SELECT * FROM cash_flow WHERE id = ?").get(ok.body.core_cash_tx_id) as any;
  assert.equal(cfRow.category, "owner_withdrawal");
  assert.equal(cfRow.amount, 40);
});

test("PO Cash-Lock reserves cash, warns on collision, and partial receiving releases unused lock & creates Core purchase", async () => {
  const s = setupTenant(true);
  await app.api("POST", "/api/cash-flow", {
    ...s.as,
    body: { type: "in", amount: 330, currency: "USD", exchange_rate: 1, category: "top_up", reason: "Capital" },
  });
  // Free cash = 330 - 30 float = 300
  const supId = Number(
    app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Supplier I', 'supplier')").run(s.tenantId).lastInsertRowid
  );
  const prodId = Number(
    app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'OR-2', 'Rice 5kg', 10, 6, 5, 1)").run(s.tenantId).lastInsertRowid
  );

  // Draft PO for 20 units @ $6 = $120
  const draft = await app.api("POST", "/api/or/po-commitments", {
    ...s.as,
    body: {
      supplier_id: supId,
      expected_delivery_date: "2026-11-26",
      payment_plan: "CASH_ON_DELIVERY",
      items: [{ product_id: prodId, ordered_qty: 20, unit_cost: 6 }],
    },
  });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  assert.equal(draft.body.estimated_order_total, 120);
  assert.equal(draft.body.status, "DRAFT");

  // Approve & Lock -> $120 locked, Free Spendable Cash drops 300 -> 180
  const appRes = await app.api("POST", `/api/or/po-commitments/${draft.body.id}/approve`, s.as);
  assert.equal(appRes.status, 200);
  assert.equal(appRes.body.po.locked_cash_amount, 120);

  const spLocked = await app.api("GET", "/api/or/spendable-cash", s.as);
  assert.equal(spLocked.body.active_po_locks_usd, 120);
  assert.equal(spLocked.body.free_spendable_cash_usd, 180);

  // Partial delivery arrives: only 10 units received ($60), paid $60 cash, settled -> $60 unused lock released!
  const rec = await app.api("POST", `/api/or/po-commitments/${draft.body.id}/receive`, {
    ...s.as,
    body: {
      items: [{ product_id: prodId, received_qty: 10, unit_cost: 6 }],
      actual_cash_paid: 60,
      partial: false,
    },
  });
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  assert.equal(rec.body.releasedCash, 60);
  assert.equal(rec.body.po.status, "SETTLED");
  assert.ok(rec.body.coreTxId > 0);

  // Core stock increased 5 -> 15
  const prod = app.db.prepare("SELECT stock FROM products WHERE id = ?").get(prodId) as any;
  assert.equal(prod.stock, 15);

  // Supplier fill_rate_score updated to 0.5 (60/120)
  const prof = app.db.prepare("SELECT fill_rate_score FROM or_supplier_profiles WHERE tenant_id = ? AND supplier_id = ?").get(s.tenantId, supId) as any;
  assert.equal(prof.fill_rate_score, 0.5);

  // Active PO locks back to 0; Drawer dropped 330 -> 270; Free cash = 270 - 30 = 240
  const spAfter = await app.api("GET", "/api/or/spendable-cash", s.as);
  assert.equal(spAfter.body.active_po_locks_usd, 0);
  assert.equal(spAfter.body.free_spendable_cash_usd, 240);
});

test("5-Minute Blind Cycle Count hides snapshot, flags large variance for approval, adjusts Core stock, and resolves anomalies", async () => {
  const s = setupTenant(true);
  const prodId = Number(
    app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'OR-3', 'Coffee', 8, 5, 10, 1)").run(s.tenantId).lastInsertRowid
  );

  // Flag shelf empty anomaly
  const anom = await app.api("POST", "/api/or/anomalies", {
    ...s.as,
    body: { product_id: prodId, anomaly_type: "STAFF_SHELF_EMPTY" },
  });
  assert.equal(anom.status, 200);

  // Generate session -> anomaly product is prioritized
  const gen = await app.api("POST", "/api/or/cycle-counts/generate", { ...s.as, body: { force: true } });
  assert.equal(gen.status, 200);
  const sid = gen.body.id;

  // Blind GET hides system_qty_snapshot
  const blind = await app.api("GET", `/api/or/cycle-counts/${sid}?blind=1`, s.as);
  assert.equal(blind.status, 200);
  const item = blind.body.items.find((i: any) => i.product_id === prodId);
  assert.ok(item);
  assert.equal(item.priority_reason, "ANOMALY_FLAG");
  assert.equal(item.system_qty_snapshot, null);

  // Submit physical count = 7 (30% variance > 5% threshold -> PENDING_APPROVAL)
  const sub = await app.api("POST", `/api/or/cycle-counts/${sid}/submit`, {
    ...s.as,
    body: { counts: [{ item_id: item.id, product_id: prodId, counted_qty: 7 }] },
  });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.status, "PENDING_APPROVAL");

  // Owner approves -> Core stock becomes 7, stock_adjustments row linked, anomaly RESOLVED
  const appv = await app.api("POST", `/api/or/cycle-counts/${sid}/approve`, s.as);
  assert.equal(appv.status, 200);
  assert.equal(appv.body.status, "COMPLETED");
  const updatedItem = appv.body.items.find((i: any) => i.product_id === prodId);
  assert.ok(updatedItem.core_adjustment_tx_id > 0);

  const prod = app.db.prepare("SELECT stock FROM products WHERE id = ?").get(prodId) as any;
  assert.equal(prod.stock, 7);

  const openAnoms = await app.api("GET", "/api/or/anomalies?status=OPEN", s.as);
  assert.equal(openAnoms.body.length, 0);
});

test("Dynamic HiGHS MILP Optimizer produces distinct optimal plans for tight-cash retail vs perishable restaurant and creates Draft POs", async () => {
  // Tenant A: Tight-cash CRISIS Retail shop ($50 spendable cash, 2 SKUs: High-ROI Fast Mover vs Low-Margin Slow Mover)
  const retail = setupTenant(true);
  await app.api("PUT", "/api/or/config", { ...retail.as, body: { business_type: "RETAIL", survival_mode: "CRISIS", min_drawer_float: 0 } });
  await app.api("POST", "/api/cash-flow", {
    ...retail.as,
    body: { type: "in", amount: 50, currency: "USD", exchange_rate: 1, category: "top_up", reason: "Tight cash" },
  });
  const supA = Number(
    app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Retail Dist', 'supplier')").run(retail.tenantId).lastInsertRowid
  );
  // High-margin fast mover: cost $5, price $10 (100% margin), 5 units/day, 0 stock
  const fastId = Number(
    app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'FAST', 'Fast Margin SKU', 10, 5, 0, 1)").run(retail.tenantId).lastInsertRowid
  );
  // Low-margin slow mover: cost $5, price $5.50 (10% margin), 5 units/day, 0 stock
  const slowId = Number(
    app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'SLOW', 'Slow Low-Margin SKU', 5.5, 5, 0, 1)").run(retail.tenantId).lastInsertRowid
  );
  app.db.prepare(
    `INSERT INTO or_sku_metrics (tenant_id, product_id, weighted_daily_sales, demand_std_30d, safety_stock, primary_supplier_id, revenue_30d, abc_class)
     VALUES (?, ?, 5, 1, 2, ?, 1500, 'A'), (?, ?, 5, 1, 2, ?, 300, 'C')`
  ).run(retail.tenantId, fastId, supA, retail.tenantId, slowId, supA);

  const solRetail = await app.api("POST", "/api/or/optimizer/run", retail.as);
  assert.equal(solRetail.status, 200, JSON.stringify(solRetail.body));
  assert.equal(solRetail.body.solver, "highs-wasm");
  assert.equal(solRetail.body.status, "Optimal");
  assert.ok(solRetail.body.total_cash_used_usd <= 50.01, `Exceeded cash budget: ${solRetail.body.total_cash_used_usd}`);
  assert.ok(solRetail.body.supplier_plans.length === 1);
  // Solver MUST spend the entire $50 (10 units @ $5) on the High-Margin Class A SKU, NOT the Low-Margin SKU
  const fastLine = solRetail.body.supplier_plans[0].items.find((i: any) => i.product_id === fastId);
  const slowLine = solRetail.body.supplier_plans[0].items.find((i: any) => i.product_id === slowId);
  assert.equal(fastLine?.ordered_qty, 10);
  assert.equal(slowLine, undefined);
  assert.ok(solRetail.body.binding_constraints.some((b: any) => b.code === "CASH_BUDGET"));

  // Tenant B: Cash-rich RESTAURANT with the exact same fast SKU (5 units/day) -> shelf-life cap (4 days) caps order far below 14-day GROWTH retail
  const rest = setupTenant(true);
  await app.api("PUT", "/api/or/config", { ...rest.as, body: { business_type: "RESTAURANT", survival_mode: "GROWTH", min_drawer_float: 0 } });
  await app.api("POST", "/api/cash-flow", {
    ...rest.as,
    body: { type: "in", amount: 5000, currency: "USD", exchange_rate: 1, category: "top_up", reason: "Abundant cash" },
  });
  const supB = Number(
    app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Fresh Meat Co', 'supplier')").run(rest.tenantId).lastInsertRowid
  );
  const meatId = Number(
    app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'MEAT', 'Fresh Beef', 10, 5, 0, 1)").run(rest.tenantId).lastInsertRowid
  );
  app.db.prepare(
    `INSERT INTO or_sku_metrics (tenant_id, product_id, weighted_daily_sales, demand_std_30d, safety_stock, primary_supplier_id, revenue_30d, abc_class)
     VALUES (?, ?, 5, 1, 2, ?, 1500, 'A')`
  ).run(rest.tenantId, meatId, supB);

  const solRest = await app.api("POST", "/api/or/optimizer/run", rest.as);
  assert.equal(solRest.status, 200);
  assert.equal(solRest.body.status, "Optimal");
  const meatQty = solRest.body.supplier_plans[0].items[0].ordered_qty;
  // 4-day shelf life * 5/day + 2 safety stock = 22 max (instead of 14*5 = 70 for retail)
  assert.ok(meatQty <= 22 && meatQty > 0, `Expected perishable shelf-life cap <= 22, got ${meatQty}`);

  // Apply plan -> materializes DRAFT PO commitment with items
  const applied = await app.api("POST", "/api/or/optimizer/apply", retail.as);
  assert.equal(applied.status, 200);
  assert.equal(applied.body.created_pos.length, 1);
  assert.equal(applied.body.created_pos[0].status, "DRAFT");
  assert.equal(applied.body.created_pos[0].estimated_order_total, 50);
});

test("Owner Draw unifies existing cash_flow owner_withdrawal rows and Owner Customer POS sales at cost", async () => {
  const s = setupTenant(true);
  // Seed an Owner Customer & product
  const ownerCustId = Number(
    app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type, balance) VALUES (?, 'Owner Personal', 'customer', -30)").run(s.tenantId).lastInsertRowid
  );
  const prodId = Number(
    app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'OWN-1', 'Olive Oil', 15, 9, 20, 1)").run(s.tenantId).lastInsertRowid
  );

  // Configure owner_stakeholder_id in OR config
  const cfg = await app.api("PUT", "/api/or/config", { ...s.as, body: { owner_stakeholder_id: ownerCustId } });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.owner_stakeholder_id, ownerCustId);

  // 1. Existing Cash Flow Register withdrawal (category='owner_withdrawal') — $20
  const cf = await app.api("POST", "/api/cash-flow", {
    ...s.as,
    body: { type: "out", amount: 20, currency: "USD", exchange_rate: 1, category: "owner_withdrawal", reason: "Legacy cash draw" },
  });
  assert.equal(cf.status, 200);

  // 2. POS sale of 2 Olive Oils to Owner Customer (retail $30, cost $18)
  const txId = Number(
    app.db
      .prepare("INSERT INTO transactions (tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, status) VALUES (?, ?, ?, 'sale', 30, 'USD', 1, 'completed')")
      .run(s.tenantId, ownerCustId, s.admin).lastInsertRowid
  );
  app.db
    .prepare("INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price, unit_cost) VALUES (?, ?, 2, 15, 9)")
    .run(txId, prodId);

  // Verify GET /api/or/owner-draws unifies BOTH ($20 cash + $18 goods at cost = $38 total)
  const dr = await app.api("GET", "/api/or/owner-draws", s.as);
  assert.equal(dr.status, 200);
  assert.equal(dr.body.usage.cash_today, 20);
  assert.equal(dr.body.usage.goods_today, 18);
  assert.equal(dr.body.usage.total_today, 38);
  assert.equal(dr.body.usage.owner_customer.name, "Owner Personal");
  assert.equal(dr.body.usage.owner_customer.goods_cost_all_time, 18);
  assert.ok(dr.body.draws.some((d: any) => d.source === "cash_flow" && d.cash_amount === 20));
  assert.ok(dr.body.draws.some((d: any) => d.source === "owner_customer_sale" && d.goods_cost_total === 18));
});

test("Core Purchase Invoice linked to an amount-only Locked PO updates stock and releases unused cash without double-counting", async () => {
  const s = setupTenant(true);
  await app.api("PUT", "/api/or/config", { ...s.as, body: { min_drawer_float: 0 } });
  await app.api("POST", "/api/cash-flow", {
    ...s.as,
    body: { type: "in", amount: 500, currency: "USD", exchange_rate: 1, category: "top_up", reason: "Drawer cash" },
  });
  const supId = Number(
    app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Wholesale Co', 'supplier')").run(s.tenantId).lastInsertRowid
  );
  const prodId = Number(
    app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'LK-1', 'Sugar 1kg', 3, 2, 10, 1)").run(s.tenantId).lastInsertRowid
  );

  // 1. Create amount-only PO ($200) and Approve & Lock -> Free Spendable Cash drops 500 -> 300
  const po = await app.api("POST", "/api/or/po-commitments", {
    ...s.as,
    body: { supplier_id: supId, expected_delivery_date: "2026-11-26", payment_plan: "CASH_ON_DELIVERY", estimated_order_total: 200 },
  });
  assert.equal(po.status, 200);
  await app.api("POST", `/api/or/po-commitments/${po.body.id}/approve`, s.as);
  const spLocked = await app.api("GET", "/api/or/spendable-cash", s.as);
  assert.equal(spLocked.body.free_spendable_cash_usd, 300);

  // 2. Staff enters itemized Purchase Invoice in Purchases for 60 units @ $2 = $120 cash, linked to the locked PO
  const tx = await app.api("POST", "/api/transactions", {
    ...s.as,
    body: {
      type: "purchase",
      stakeholder_id: supId,
      user_id: s.admin,
      currency: "USD",
      exchange_rate: 1,
      items: [{ id: prodId, quantity: 60, price: 2, unit_price: 2 }],
      payments: [{ amount: 120, method: "cash", currency: "USD", exchange_rate: 1 }],
      or_po_commitment_id: po.body.id,
    },
  });
  assert.equal(tx.status, 200, JSON.stringify(tx.body));

  // Verify stock updated (10 -> 70), PO is SETTLED with $80 released, and Free Spendable Cash = 500 - 120 = 380 (NO double count!)
  const prod = app.db.prepare("SELECT stock FROM products WHERE id = ?").get(prodId) as any;
  assert.equal(prod.stock, 70);

  const poAfter = await app.api("GET", `/api/or/po-commitments/${po.body.id}`, s.as);
  assert.equal(poAfter.body.status, "SETTLED");
  assert.equal(poAfter.body.locked_cash_amount, 0);
  assert.equal(poAfter.body.released_cash_amount, 80);
  assert.equal(poAfter.body.core_transaction_id, tx.body.id);

  const spAfter = await app.api("GET", "/api/or/spendable-cash", s.as);
  assert.equal(spAfter.body.active_po_locks_usd, 0);
  assert.equal(spAfter.body.free_spendable_cash_usd, 380);
});

test("OpEx reserve accrues toward each due date and resets on it (never piles up)", async () => {
  const { accruedObligationReserve } = await import("../server/or/spendableCash.js");
  // $300 monthly due on the 1st: 15 days into a 30-day month = $150
  assert.equal(accruedObligationReserve(300, "monthly", 1, "2026-11-16"), 150);
  assert.equal(accruedObligationReserve(300, "monthly", 1, "2026-11-01"), 0);
  assert.equal(accruedObligationReserve(300, "monthly", 1, "2026-11-30"), 290);
  // Due day 31 in a 30-day month is clamped to the 30th
  assert.equal(accruedObligationReserve(300, "monthly", 31, "2026-11-30"), 0);
  // Weekly, due Monday (1): 2026-11-25 is a Wednesday -> 2 of 7 days
  assert.equal(accruedObligationReserve(70, "weekly", 1, "2026-11-25"), 20);
  assert.equal(accruedObligationReserve(5, "daily", null, "2026-11-25"), 5);
});

test("cycle-count approval applies the counted difference and keeps sales made after the count", async () => {
  const s = setupTenant(true);
  const prodId = Number(
    app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'CC-1', 'Tea', 4, 2, 10, 1)").run(s.tenantId).lastInsertRowid
  );
  await app.api("POST", "/api/or/anomalies", { ...s.as, body: { product_id: prodId, anomaly_type: "STAFF_SHELF_EMPTY" } });
  const gen = await app.api("POST", "/api/or/cycle-counts/generate", { ...s.as, body: { force: true } });
  const sid = gen.body.id;
  const item = gen.body.items.find((i: any) => i.product_id === prodId);

  // 1 sells after the session was generated but BEFORE counting: the shelf shows it already.
  app.db.prepare("UPDATE products SET stock = 9 WHERE id = ?").run(prodId);
  // Staff counts 7 (variance vs the stock at count time = -2 -> needs approval)
  const sub = await app.api("POST", `/api/or/cycle-counts/${sid}/submit`, {
    ...s.as,
    body: { counts: [{ item_id: item.id, counted_qty: 7 }] },
  });
  assert.equal(sub.body.status, "PENDING_APPROVAL");
  assert.equal(sub.body.items.find((i: any) => i.id === item.id).variance_qty, -2);

  // 2 more sell before the owner approves
  app.db.prepare("UPDATE products SET stock = 7 WHERE id = ?").run(prodId);
  const appv = await app.api("POST", `/api/or/cycle-counts/${sid}/approve`, s.as);
  assert.equal(appv.body.status, "COMPLETED");
  // 7 on the system minus the -2 counted difference = 5 (an overwrite would have said 7)
  assert.equal((app.db.prepare("SELECT stock FROM products WHERE id = ?").get(prodId) as any).stock, 5);
});

test("blind count: a cashier never sees system quantities, even when asking for blind=0", async () => {
  const s = setupTenant(true);
  const cashier = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role) VALUES (?, 'Cash', 'cashier')").run(s.tenantId).lastInsertRowid);
  const prodId = Number(
    app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'BL-1', 'Salt', 1, 0.5, 12, 1)").run(s.tenantId).lastInsertRowid
  );
  await app.api("POST", "/api/or/anomalies", { ...s.as, body: { product_id: prodId } });
  const as = { tenantId: s.tenantId, userId: cashier };
  const gen = await app.api("POST", "/api/or/cycle-counts/generate", { ...as, body: {} });
  assert.equal(gen.status, 200, JSON.stringify(gen.body));
  assert.ok(gen.body.items.every((i: any) => i.system_qty_snapshot === null));
  const peek = await app.api("GET", `/api/or/cycle-counts/${gen.body.id}?blind=0`, as);
  assert.equal(peek.status, 200);
  assert.ok(peek.body.items.every((i: any) => i.system_qty_snapshot === null));
  // The owner still can
  const owner = await app.api("GET", `/api/or/cycle-counts/${gen.body.id}`, s.as);
  assert.ok(owner.body.items.some((i: any) => i.system_qty_snapshot === 12));
});

test("PO receiving: amount-only POs go through Purchases, itemized partial delivery keeps the rest locked and uses weighted cost", async () => {
  const s = setupTenant(true);
  await app.api("PUT", "/api/or/config", { ...s.as, body: { min_drawer_float: 0 } });
  await app.api("POST", "/api/cash-flow", { ...s.as, body: { type: "in", amount: 1000, currency: "USD", exchange_rate: 1, category: "top_up", reason: "Cash" } });
  const supId = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Sup R', 'supplier')").run(s.tenantId).lastInsertRowid);
  const prodId = Number(
    app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'RC-1', 'Oil', 12, 5, 100, 1)").run(s.tenantId).lastInsertRowid
  );
  const otherProd = Number(
    app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'RC-2', 'Not on PO', 1, 1, 0, 1)").run(s.tenantId).lastInsertRowid
  );

  // Amount-only PO cannot be "received" here (no cash or stock would move)
  const amountOnly = await app.api("POST", "/api/or/po-commitments", {
    ...s.as, body: { supplier_id: supId, expected_delivery_date: "2026-12-01", payment_plan: "CASH_ON_DELIVERY", estimated_order_total: 100 },
  });
  await app.api("POST", `/api/or/po-commitments/${amountOnly.body.id}/approve`, s.as);
  const rejected = await app.api("POST", `/api/or/po-commitments/${amountOnly.body.id}/receive`, { ...s.as, body: { actual_cash_paid: 100 } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, "OR_PO_RECEIVE_NEEDS_INVOICE");
  await app.api("POST", `/api/or/po-commitments/${amountOnly.body.id}/cancel`, s.as);

  // Itemized PO: 20 @ $10 = $200 locked
  const po = await app.api("POST", "/api/or/po-commitments", {
    ...s.as, body: { supplier_id: supId, expected_delivery_date: "2026-12-01", payment_plan: "CASH_ON_DELIVERY", items: [{ product_id: prodId, ordered_qty: 20, unit_cost: 10 }] },
  });
  await app.api("POST", `/api/or/po-commitments/${po.body.id}/approve`, s.as);

  // Lines must be on the PO; cash can't exceed the delivery
  const notOnPo = await app.api("POST", `/api/or/po-commitments/${po.body.id}/receive`, {
    ...s.as, body: { items: [{ product_id: otherProd, received_qty: 1 }], actual_cash_paid: 0, partial: true },
  });
  assert.equal(notOnPo.body.code, "OR_PO_ITEM_NOT_ON_PO");
  const overpaid = await app.api("POST", `/api/or/po-commitments/${po.body.id}/receive`, {
    ...s.as, body: { items: [{ product_id: prodId, received_qty: 10 }], actual_cash_paid: 150, partial: true },
  });
  assert.equal(overpaid.body.code, "PO_RECEIVE_OVERPAID");

  // First delivery: 10 arrive, $100 paid, more expected
  const first = await app.api("POST", `/api/or/po-commitments/${po.body.id}/receive`, {
    ...s.as, body: { items: [{ product_id: prodId, received_qty: 10 }], actual_cash_paid: 100, partial: true },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.po.status, "PARTIALLY_RECEIVED");
  assert.equal(first.body.po.locked_cash_amount, 100);
  const prod = app.db.prepare("SELECT stock, cost FROM products WHERE id = ?").get(prodId) as any;
  assert.equal(prod.stock, 110);
  // Weighted average: (100 x $5 + 10 x $10) / 110 = $5.4545...
  assert.ok(Math.abs(prod.cost - 600 / 110) < 1e-6, `cost ${prod.cost}`);
  const purchase = app.db.prepare("SELECT total_amount, status FROM transactions WHERE id = ?").get(first.body.coreTxId) as any;
  assert.equal(purchase.total_amount, 100);
  assert.equal(purchase.status, "completed");

  // Spendable: 1000 - 100 paid - 100 still locked = 800
  const sp = await app.api("GET", "/api/or/spendable-cash", s.as);
  assert.equal(sp.body.free_spendable_cash_usd, 800);

  // Final delivery: the rest (no lines = every remaining unit), $50 paid now, $50 on credit
  const last = await app.api("POST", `/api/or/po-commitments/${po.body.id}/receive`, { ...s.as, body: { actual_cash_paid: 50 } });
  assert.equal(last.status, 200, JSON.stringify(last.body));
  assert.equal(last.body.po.status, "SETTLED");
  assert.equal(last.body.releasedCash, 50);
  assert.equal(last.body.po.actual_received_total, 200);
  assert.equal(last.body.po.actual_credit_added, 50);
  const sup = app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(supId) as any;
  assert.equal(Math.abs(sup.balance), 50);
  const sp2 = await app.api("GET", "/api/or/spendable-cash", s.as);
  assert.equal(sp2.body.active_po_locks_usd, 0);
  // 1000 - 150 paid = 850 in hand, minus the $50 supplier credit due now (terms 0) held as a payables reserve
  assert.equal(sp2.body.payables_reserve_usd, 50);
  assert.equal(sp2.body.free_spendable_cash_usd, 800);
});

test("a purchase invoice only touches a PO lock when linked, and a non-final link keeps the PO open", async () => {
  const s = setupTenant(true);
  await app.api("PUT", "/api/or/config", { ...s.as, body: { min_drawer_float: 0 } });
  await app.api("POST", "/api/cash-flow", { ...s.as, body: { type: "in", amount: 500, currency: "USD", exchange_rate: 1, category: "top_up", reason: "Cash" } });
  const supId = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Sup L', 'supplier')").run(s.tenantId).lastInsertRowid);
  const prodId = Number(
    app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'LN-1', 'Flour', 3, 2, 0, 1)").run(s.tenantId).lastInsertRowid
  );
  const po = await app.api("POST", "/api/or/po-commitments", {
    ...s.as, body: { supplier_id: supId, expected_delivery_date: "2026-12-01", payment_plan: "CASH_ON_DELIVERY", estimated_order_total: 300 },
  });
  await app.api("POST", `/api/or/po-commitments/${po.body.id}/approve`, s.as);
  const purchase = (extra: any) => app.api("POST", "/api/transactions", {
    ...s.as,
    body: {
      type: "purchase", stakeholder_id: supId, user_id: s.admin, currency: "USD", exchange_rate: 1,
      items: [{ id: prodId, quantity: 25, price: 2, unit_price: 2 }],
      payments: [{ amount: 50, method: "cash", currency: "USD", exchange_rate: 1 }],
      ...extra,
    },
  });

  // Unrelated purchase from the same supplier: the lock is untouched
  assert.equal((await purchase({})).status, 200);
  let cur = await app.api("GET", `/api/or/po-commitments/${po.body.id}`, s.as);
  assert.equal(cur.body.status, "APPROVED_LOCKED");
  assert.equal(cur.body.locked_cash_amount, 300);

  // Linked, not the last delivery: $50 paid comes off the lock, PO stays open
  assert.equal((await purchase({ or_po_commitment_id: po.body.id, or_po_final: false })).status, 200);
  cur = await app.api("GET", `/api/or/po-commitments/${po.body.id}`, s.as);
  assert.equal(cur.body.status, "PARTIALLY_RECEIVED");
  assert.equal(cur.body.locked_cash_amount, 250);

  // Last delivery: closes and releases the rest
  assert.equal((await purchase({ or_po_commitment_id: po.body.id })).status, 200);
  cur = await app.api("GET", `/api/or/po-commitments/${po.body.id}`, s.as);
  assert.equal(cur.body.status, "SETTLED");
  assert.equal(cur.body.locked_cash_amount, 0);
  assert.equal(cur.body.released_cash_amount, 200);
});

test("SKU revenue is the stored USD price for LBP-keyed invoices too (no second rate division)", async () => {
  const s = setupTenant(true);
  const usdP = Number(app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'FX-1', 'Usd Item', 10, 5, 50, 1)").run(s.tenantId).lastInsertRowid);
  const lbpP = Number(app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'FX-2', 'Lbp Item', 10, 5, 50, 1)").run(s.tenantId).lastInsertRowid);
  const sale = (pid: number, currency: string, rate: number) => {
    const tx = Number(app.db.prepare("INSERT INTO transactions (tenant_id, user_id, type, total_amount, currency, exchange_rate, status) VALUES (?, ?, 'sale', 20, ?, ?, 'completed')").run(s.tenantId, s.admin, currency, rate).lastInsertRowid);
    app.db.prepare("INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price, unit_cost) VALUES (?, ?, 2, 10, 5)").run(tx, pid);
  };
  sale(usdP, "USD", 1);
  sale(lbpP, "LBP", 89500);
  await app.api("POST", "/api/or/pipeline/run", s.as);
  const m = app.db.prepare("SELECT product_id, revenue_30d, gross_margin_30d FROM or_sku_metrics WHERE tenant_id = ?").all(s.tenantId) as any[];
  const usd = m.find((r) => r.product_id === usdP);
  const lbp = m.find((r) => r.product_id === lbpP);
  assert.equal(usd.revenue_30d, 20);
  assert.equal(lbp.revenue_30d, 20);
  assert.equal(lbp.gross_margin_30d, 10);
});

test("owner cash draws are counted once (from cash_flow) and linked by global id", async () => {
  const s = setupTenant(true);
  await app.api("PUT", "/api/or/config", { ...s.as, body: { survival_mode: "GROWTH" } });
  await app.api("POST", "/api/cash-flow", { ...s.as, body: { type: "in", amount: 300, currency: "USD", exchange_rate: 1, category: "top_up", reason: "Cash" } });
  const d = await app.api("POST", "/api/or/owner-draws", { ...s.as, body: { cash_amount: 15, override_reason: "test draw" } });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const cfGid = (app.db.prepare("SELECT global_id FROM cash_flow WHERE id = ?").get(d.body.core_cash_tx_id) as any).global_id;
  assert.equal(d.body.core_cash_global_id, cfGid);
  // Simulate this draw arriving on ANOTHER register: its local cash_flow id link does not exist there.
  app.db.prepare("UPDATE or_owner_draws SET core_cash_tx_id = NULL WHERE id = ?").run(d.body.id);
  const usage = await app.api("GET", "/api/or/owner-draws", s.as);
  assert.equal(usage.body.usage.cash_today, 15);
  assert.equal(usage.body.draws.filter((r: any) => r.cash_amount === 15).length, 1);
});

test("briefing re-runs update items in place (stable ids) and retire stale ones softly", async () => {
  const s = setupTenant(true);
  await app.api("PUT", "/api/or/config", { ...s.as, body: { min_drawer_float: 100 } }); // negative free cash -> CRITICAL item
  await app.api("POST", "/api/or/pipeline/run", s.as);
  const first = app.db.prepare("SELECT id, global_id FROM or_action_queue WHERE tenant_id = ? AND deleted_at IS NULL").all(s.tenantId) as any[];
  assert.ok(first.length >= 1);
  await app.api("POST", "/api/or/pipeline/run", s.as);
  const second = app.db.prepare("SELECT id, global_id FROM or_action_queue WHERE tenant_id = ? AND deleted_at IS NULL").all(s.tenantId) as any[];
  assert.deepEqual(second.map((r) => r.global_id).sort(), first.map((r) => r.global_id).sort());
  // Cash arrives: the CRITICAL item no longer applies and is soft-deleted (so the deletion syncs)
  await app.api("POST", "/api/cash-flow", { ...s.as, body: { type: "in", amount: 500, currency: "USD", exchange_rate: 1, category: "top_up", reason: "Cash" } });
  await app.api("POST", "/api/or/pipeline/run", s.as);
  const retired = app.db.prepare("SELECT COUNT(*) c FROM or_action_queue WHERE tenant_id = ? AND category = 'CASH_RUNWAY' AND deleted_at IS NOT NULL").get(s.tenantId) as any;
  assert.equal(retired.c, 1);
});

test("optimizer apply uses the reviewed plan once (idempotent per plan_id)", async () => {
  const s = setupTenant(true);
  await app.api("PUT", "/api/or/config", { ...s.as, body: { min_drawer_float: 0 } });
  await app.api("POST", "/api/cash-flow", { ...s.as, body: { type: "in", amount: 100, currency: "USD", exchange_rate: 1, category: "top_up", reason: "Cash" } });
  const sup = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Opt Sup', 'supplier')").run(s.tenantId).lastInsertRowid);
  const p = Number(app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'OP-1', 'Opt', 10, 5, 0, 1)").run(s.tenantId).lastInsertRowid);
  app.db.prepare(
    `INSERT INTO or_sku_metrics (tenant_id, product_id, weighted_daily_sales, demand_std_30d, safety_stock, primary_supplier_id, revenue_30d, abc_class)
     VALUES (?, ?, 3, 1, 2, ?, 900, 'A')`
  ).run(s.tenantId, p, sup);
  const run = await app.api("POST", "/api/or/optimizer/run", s.as);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.ok(run.body.plan_id);
  const a1 = await app.api("POST", "/api/or/optimizer/apply", { ...s.as, body: { plan_id: run.body.plan_id } });
  assert.equal(a1.status, 200);
  assert.equal(a1.body.created_pos.length, 1);
  const a2 = await app.api("POST", "/api/or/optimizer/apply", { ...s.as, body: { plan_id: run.body.plan_id } });
  assert.equal(a2.body.already_applied, true);
  const count = app.db.prepare("SELECT COUNT(*) c FROM or_po_commitments WHERE tenant_id = ?").get(s.tenantId) as any;
  assert.equal(count.c, 1);
  const expired = await app.api("POST", "/api/or/optimizer/apply", { ...s.as, body: { plan_id: "nope" } });
  assert.equal(expired.status, 409);
});

test("sync: pulling a cloud OR config row adopts the local twin instead of failing on the natural key", async () => {
  const s = setupTenant(true);
  await app.api("GET", "/api/or/config", s.as); // seeds the local config row
  const local = app.db.prepare("SELECT id, global_id FROM or_tenant_config WHERE tenant_id = ?").get(s.tenantId) as any;
  const sync = await import("../server/sync.js");
  assert.deepEqual(sync.NATURAL_KEYS.or_tenant_config, ["tenant_id"]);
  const { stableGlobalId } = await import("../server/or/stableId.js");
  const tg = (app.db.prepare("SELECT global_id FROM tenants WHERE id = ?").get(s.tenantId) as any).global_id;
  if (tg) {
    assert.equal(local.global_id, stableGlobalId(s.tenantId, "or_tenant_config"));
    assert.equal(stableGlobalId(s.tenantId, "x"), stableGlobalId(s.tenantId, "x"));
  }
});

test("runway counts the gross profit the shop earns: profit covering bills is not a crisis", async () => {
  const s = setupTenant(true);
  await app.api("PUT", "/api/or/config", { ...s.as, body: { min_drawer_float: 0 } });
  await app.api("POST", "/api/cash-flow", { ...s.as, body: { type: "in", amount: 50, currency: "USD", exchange_rate: 1, category: "top_up", reason: "Cash" } });
  // Bills: $20/day
  await app.api("POST", "/api/or/obligations", { ...s.as, body: { name: "Bread", amount_usd: 20, frequency: "daily" } });
  const p = Number(app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'RW-1', 'Item', 10, 6, 1000, 1)").run(s.tenantId).lastInsertRowid);
  // 10 days ago .. today: 10 units/day at $4 margin = $40/day gross profit
  for (let d = 0; d < 10; d++) {
    const tx = Number(app.db.prepare(`INSERT INTO transactions (tenant_id, user_id, type, total_amount, currency, exchange_rate, status, created_at) VALUES (?, ?, 'sale', 100, 'USD', 1, 'completed', datetime('now', '-${d} days'))`).run(s.tenantId, s.admin).lastInsertRowid);
    app.db.prepare("INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price, unit_cost) VALUES (?, ?, 10, 10, 6)").run(tx, p);
  }
  const sp = await app.api("GET", "/api/or/spendable-cash", s.as);
  assert.equal(sp.body.avg_daily_gross_profit_usd, 40);
  assert.equal(sp.body.daily_opex_burn_usd, 20);
  assert.equal(sp.body.net_daily_burn_usd, -20);
  assert.equal(sp.body.runway_days, null, "profit covers the bills: no runway limit");
  const run = await app.api("POST", "/api/or/pipeline/run", s.as);
  assert.equal(run.body.survival_mode, "GROWTH", "profitable and today's bills are covered ($50 cash - $20 reserve)");

  // Owner draws bigger than the margin bring the runway back
  await app.api("POST", "/api/cash-flow", { ...s.as, body: { type: "out", amount: 900, currency: "USD", exchange_rate: 1, category: "owner_withdrawal", reason: "Owner" } });
  const sp2 = await app.api("GET", "/api/or/spendable-cash", s.as);
  assert.equal(sp2.body.avg_daily_owner_draws_usd, 30);
  assert.equal(sp2.body.net_daily_burn_usd, 10);
});

test("an invoice paid later through a Balance Payment shows as paid (oldest invoices first)", async () => {
  const s = setupTenant(true);
  await app.api("POST", "/api/cash-flow", { ...s.as, body: { type: "in", amount: 500, currency: "USD", exchange_rate: 1, category: "top_up", reason: "Cash" } });
  const sup = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Later Sup', 'supplier')").run(s.tenantId).lastInsertRowid);
  const p = Number(app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'LP-1', 'Thing', 3, 2, 0, 1)").run(s.tenantId).lastInsertRowid);
  const buy = async (qty: number) => (await app.api("POST", "/api/transactions", {
    ...s.as,
    body: { type: "purchase", stakeholder_id: sup, user_id: s.admin, currency: "USD", exchange_rate: 1, items: [{ id: p, quantity: qty, price: 2, unit_price: 2 }], payments: [] },
  })).body.id as number;
  const older = await buy(50); // $100 on account
  const newer = await buy(30); // $60 on account
  const pay = await app.api("POST", "/api/balance-payment", { ...s.as, body: { stakeholder_id: sup, amount: 120, currency: "USD", exchange_rate: 1, direction: "pay" } });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));

  const list = await app.api("GET", `/api/purchases?supplier_id=${sup}`, s.as);
  const byId = new Map(list.body.map((r: any) => [r.id, r]));
  assert.equal((byId.get(older) as any).paid_amount, 100, "older invoice fully covered");
  assert.equal((byId.get(older) as any).paid_later, 100);
  assert.equal((byId.get(newer) as any).paid_amount, 20, "the rest goes to the newer one");
  const unpaid = await app.api("GET", `/api/purchases?supplier_id=${sup}&status=unpaid`, s.as);
  assert.deepEqual(unpaid.body.map((r: any) => r.id), [newer]);
  const paid = await app.api("GET", `/api/purchases?supplier_id=${sup}&status=paid`, s.as);
  assert.deepEqual(paid.body.map((r: any) => r.id), [older]);
  const detail = await app.api("GET", `/api/purchases/${newer}`, s.as);
  assert.equal(detail.body.balance, 40);
});

test("the optimizer orders in the shop's usual purchase pack when no box unit is defined", async () => {
  const { purchaseHistoryPackSizes } = await import("../server/or/optimizer.js");
  const s = setupTenant(true);
  const sup = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Gum Co', 'supplier')").run(s.tenantId).lastInsertRowid);
  const gum = Number(app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'GUM', 'Gum', 0.1, 0.05, 0, 1)").run(s.tenantId).lastInsertRowid);
  const single = Number(app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, cost, stock, track_inventory) VALUES (?, 'ONE', 'Single', 5, 3, 0, 1)").run(s.tenantId).lastInsertRowid);
  const buy = (pid: number, qty: number) => {
    const tx = Number(app.db.prepare("INSERT INTO transactions (tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, status) VALUES (?, ?, ?, 'purchase', 1, 'USD', 1, 'completed')").run(s.tenantId, sup, s.admin).lastInsertRowid);
    app.db.prepare("INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price, unit_cost) VALUES (?, ?, ?, 0.05, 0.05)").run(tx, pid, qty);
  };
  buy(gum, 65); buy(gum, 130); buy(gum, 65); buy(single, 1); buy(single, 1);
  const packs = purchaseHistoryPackSizes(s.tenantId);
  assert.equal(packs.get(gum), 65);
  assert.equal(packs.has(single), false);
});
