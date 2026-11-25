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

  // Add a $300/month rent obligation ($10/day) and run pipeline once
  const ob = await app.api("POST", "/api/or/obligations", {
    ...s.as,
    body: { name: "Store Rent", amount_usd: 300, frequency: "monthly", due_day: 1 },
  });
  assert.equal(ob.status, 200);

  const run1 = await app.api("POST", "/api/or/pipeline/run", s.as);
  assert.equal(run1.status, 200);
  assert.equal(run1.body.opex_accrued_usd, 10);

  // Re-running on same day must NOT double-accrue OpEx
  const run2 = await app.api("POST", "/api/or/pipeline/run", s.as);
  assert.equal(run2.status, 200);
  assert.equal(run2.body.opex_accrued_usd, 0);

  // Free Spendable Cash = 500 (drawer) - 30 (float) - 10 (OpEx reserve) - 0 (PO locks) = 460
  const sp = await app.api("GET", "/api/or/spendable-cash", s.as);
  assert.equal(sp.status, 200);
  assert.equal(sp.body.total_liquid_cash_usd, 500);
  assert.equal(sp.body.locked_opex_reserve_usd, 10);
  assert.equal(sp.body.free_spendable_cash_usd, 460);
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
