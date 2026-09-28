// Backend for the data import wizard (docs/plans/2026-09-28-import-wizard.md) —
// POST /api/import/:entity for products/customers/suppliers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Import Test Co", "import-test@example.com");
});

after(async () => {
  await app.close();
});

const imp = (entity: string, body: any) => app.api("POST", `/api/import/${entity}`, { tenantId, body });

// --------------------------------------------------------------------------------------
// Products
// --------------------------------------------------------------------------------------

test("products: create with all fields, extra barcodes, tiers, opening stock -> adjustment row", async () => {
  const res = await imp("products", {
    mode: "upsert",
    dry_run: false,
    rows: [
      {
        name: "Olive Oil 1L",
        barcode: "1000001",
        barcodes: "1000001, 1000002; 1000003",
        category: "Pantry",
        unit: "bottle",
        cost: "6.40",
        price: "9.90",
        price_lbp: "886000",
        price_wholesale: "8.50",
        price_super_wholesale: "8.00",
        package_price: "110",
        units_per_package: "12",
        min_price: "7",
        stock: "24",
        reorder_point: "5",
        track_inventory: "yes",
      },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.created, 1);
  assert.equal(res.body.errors.length, 0);
  const id = res.body.results[0].id;
  assert.ok(id);

  const product = app.db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  assert.equal(product.name, "Olive Oil 1L");
  assert.equal(product.price, 9.9);
  assert.equal(product.cost, 6.4);
  assert.equal(product.price_wholesale, 8.5);
  assert.equal(product.stock, 24);
  assert.equal(product.units_per_package, 12);
  assert.equal(product.track_inventory, 1);

  const extraBarcodes = app.db.prepare("SELECT barcode FROM product_barcodes WHERE product_id = ?").all(id).map((r: any) => r.barcode).sort();
  assert.deepEqual(extraBarcodes, ["1000002", "1000003"]);

  const adj = app.db.prepare("SELECT * FROM stock_adjustments WHERE product_id = ?").get(id);
  assert.ok(adj, "opening stock should create a stock_adjustments row");
  assert.equal(adj.qty_before, 0);
  assert.equal(adj.qty_after, 24);
  assert.equal(adj.delta, 24);
  assert.equal(adj.reason, "Import: opening stock");
});

test("products: upsert updates only present columns and adjusts stock count with a stock_adjustments row", async () => {
  const create = await imp("products", {
    mode: "upsert",
    dry_run: false,
    rows: [{ name: "Rice 5kg", barcode: "2000001", cost: "5", price: "8", stock: "10", category: "Pantry" }],
  });
  const id = create.body.results[0].id;

  const update = await imp("products", {
    mode: "upsert",
    dry_run: false,
    rows: [{ name: "Rice 5kg", barcode: "2000001", price: "8.5", stock: "15" }], // no category/cost sent
  });
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.equal(update.body.updated, 1);

  const product = app.db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  assert.equal(product.price, 8.5, "present field should update");
  assert.equal(product.category, "Pantry", "absent field should be left alone");
  assert.equal(product.cost, 5, "absent field should be left alone");
  assert.equal(product.stock, 15);

  const adjustments = app.db.prepare("SELECT * FROM stock_adjustments WHERE product_id = ? ORDER BY id").all(id);
  assert.equal(adjustments.length, 2, "opening stock + stock count adjustment");
  const countAdj = adjustments[1];
  assert.equal(countAdj.qty_before, 10);
  assert.equal(countAdj.qty_after, 15);
  assert.equal(countAdj.reason, "Import: stock count");
});

test("products: a row whose barcodes span two different existing products -> BARCODE_TAKEN", async () => {
  // A plain barcode match (row's barcode = an existing product's barcode) is a legitimate update,
  // not a conflict. The real conflict is a row that pulls in barcodes belonging to two DIFFERENT
  // existing products at once — there's no single record it could sensibly update.
  await imp("products", { mode: "upsert", dry_run: false, rows: [{ name: "Sugar 2kg", barcode: "6000001", price: "2" }] });
  await imp("products", { mode: "upsert", dry_run: false, rows: [{ name: "Salt 1kg", barcode: "6000002", price: "1" }] });

  const res = await imp("products", {
    mode: "upsert",
    dry_run: true,
    rows: [{ name: "Confused Product", barcode: "6000001", barcodes: "6000001,6000002", price: "5" }],
  });
  assert.equal(res.body.errors.length, 1, JSON.stringify(res.body));
  assert.equal(res.body.errors[0].code, "BARCODE_TAKEN");
});

test("products: duplicate barcode inside the file -> DUPLICATE_IN_FILE on the later row", async () => {
  const res = await imp("products", {
    mode: "upsert",
    dry_run: true,
    rows: [
      { name: "Item A", barcode: "4000001", price: "1" },
      { name: "Item B", barcode: "4000001", price: "2" },
    ],
  });
  assert.equal(res.body.errors.length, 1);
  assert.equal(res.body.errors[0].row, 2);
  assert.equal(res.body.errors[0].code, "DUPLICATE_IN_FILE");
});

test("products: create_only + existing match -> skip with EXISTS warning", async () => {
  await imp("products", { mode: "upsert", dry_run: false, rows: [{ name: "Tahini 450g", barcode: "5000001", price: "4.4" }] });

  const res = await imp("products", {
    mode: "create_only",
    dry_run: true,
    rows: [{ name: "Tahini 450g", barcode: "5000001", price: "9.99" }],
  });
  assert.equal(res.body.skipped, 1);
  assert.equal(res.body.created, 0);
  assert.equal(res.body.errors.length, 0);
  assert.equal(res.body.warnings[0].code, "EXISTS");
  assert.equal(res.body.results[0].action, "skip");
});

test("products: number formats — thousands/decimal commas and currency symbols", async () => {
  const res = await imp("products", {
    mode: "upsert",
    dry_run: true,
    rows: [
      { name: "P1", price: "1,234.50" },
      { name: "P2", price: "12,5" },
      { name: "P3", price: "$ 3.00" },
      { name: "P4", price: "LL 90,000" },
    ],
  });
  assert.equal(res.body.errors.length, 0, JSON.stringify(res.body.errors));
  // dry run doesn't expose parsed values directly, so run for real and check the DB.
  const real = await imp("products", {
    mode: "upsert",
    dry_run: false,
    rows: [
      { name: "NumFmt A", price: "1,234.50" },
      { name: "NumFmt B", price: "12,5" },
      { name: "NumFmt C", price: "$ 3.00" },
      { name: "NumFmt D", price: "LL 90,000" },
    ],
  });
  assert.equal(real.status, 200, JSON.stringify(real.body));
  const get = (name: string) => app.db.prepare("SELECT price FROM products WHERE name = ?").get(name) as any;
  assert.equal(get("NumFmt A").price, 1234.5);
  assert.equal(get("NumFmt B").price, 12.5);
  assert.equal(get("NumFmt C").price, 3);
  assert.equal(get("NumFmt D").price, 90000);
});

test("products: yes/no aliases for track_inventory", async () => {
  const res = await imp("products", {
    mode: "upsert",
    dry_run: false,
    rows: [
      { name: "TrackA", price: "1", track_inventory: "no" },
      { name: "TrackB", price: "1", track_inventory: "لا" },
      { name: "TrackC", price: "1", track_inventory: "non" },
      { name: "TrackD", price: "1", track_inventory: "نعم" },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const get = (name: string) => app.db.prepare("SELECT track_inventory FROM products WHERE name = ?").get(name) as any;
  assert.equal(get("TrackA").track_inventory, 0);
  assert.equal(get("TrackB").track_inventory, 0);
  assert.equal(get("TrackC").track_inventory, 0);
  assert.equal(get("TrackD").track_inventory, 1);
});

test("dry run writes nothing", async () => {
  const before = (app.db.prepare("SELECT COUNT(*) c FROM products").get() as any).c;
  const res = await imp("products", { mode: "upsert", dry_run: true, rows: [{ name: "Ghost Product", price: "1" }] });
  assert.equal(res.body.created, 1);
  const after = (app.db.prepare("SELECT COUNT(*) c FROM products").get() as any).c;
  assert.equal(after, before, "dry run must not write anything");
  const ghost = app.db.prepare("SELECT * FROM products WHERE name = ?").get("Ghost Product");
  assert.equal(ghost, undefined);
});

test("real run with one bad row writes nothing and returns 422", async () => {
  const before = (app.db.prepare("SELECT COUNT(*) c FROM products").get() as any).c;
  const res = await imp("products", {
    mode: "upsert",
    dry_run: false,
    rows: [
      { name: "GoodOne", price: "5" },
      { name: "", price: "5" }, // missing name -> error
    ],
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.errors.length, 1);
  const after = (app.db.prepare("SELECT COUNT(*) c FROM products").get() as any).c;
  assert.equal(after, before, "an all-or-nothing failure must not write the good row either");
  assert.equal(app.db.prepare("SELECT * FROM products WHERE name = ?").get("GoodOne"), undefined);
});

test("a large payload (3000 products) succeeds", async () => {
  const rows = Array.from({ length: 3000 }, (_, i) => ({
    name: `Bulk Product ${i}`,
    barcode: `9${String(i).padStart(9, "0")}`,
    price: (1 + (i % 50)).toFixed(2),
    cost: (0.5 + (i % 50)).toFixed(2),
    category: "Bulk",
    stock: String(i % 10),
  }));
  const res = await imp("products", { mode: "upsert", dry_run: false, rows });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 500));
  assert.equal(res.body.created, 3000);
  const count = (app.db.prepare("SELECT COUNT(*) c FROM products WHERE category = 'Bulk'").get() as any).c;
  assert.equal(count, 3000);
});

// --------------------------------------------------------------------------------------
// Customers / Suppliers
// --------------------------------------------------------------------------------------

test("customers: opening balance becomes a negative (owes) balance, with a price level alias", async () => {
  const res = await imp("customers", {
    mode: "upsert",
    dry_run: false,
    rows: [{ name: "Mini Market Al Amal", phone: "70111222", opening_balance: "150", price_level: "جملة" }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const id = res.body.results[0].id;
  const st = app.db.prepare("SELECT * FROM stakeholders WHERE id = ?").get(id);
  assert.equal(st.balance, -150, "owes 150 -> negative balance");
  assert.equal(st.balance_baseline, -150);
  assert.equal(st.price_level, "wholesale");
});

test("suppliers: opening balance (we owe them) is negative too, by convention", async () => {
  const res = await imp("suppliers", {
    mode: "upsert",
    dry_run: false,
    rows: [{ name: "Dairy Farms Co.", phone: "01444555", opening_balance: "500" }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const id = res.body.results[0].id;
  const st = app.db.prepare("SELECT * FROM stakeholders WHERE id = ?").get(id);
  assert.equal(st.type, "supplier");
  assert.equal(st.balance, -500);
});

test("customers: upsert matched by name+phone", async () => {
  const create = await imp("customers", {
    mode: "upsert",
    dry_run: false,
    rows: [{ name: "Nadim Haddad", phone: "71999888", address: "Achrafieh" }],
  });
  const id = create.body.results[0].id;

  const update = await imp("customers", {
    mode: "upsert",
    dry_run: false,
    rows: [{ name: "Nadim Haddad", phone: "71999888", address: "Furn El Chebbak" }],
  });
  assert.equal(update.body.updated, 1);
  assert.equal(update.body.created, 0);
  assert.equal(update.body.results[0].id, id);
  const st = app.db.prepare("SELECT * FROM stakeholders WHERE id = ?").get(id);
  assert.equal(st.address, "Furn El Chebbak");
});

test("customers: opening_balance on an existing party WITH transaction history -> HAS_HISTORY error", async () => {
  const create = await imp("customers", {
    mode: "upsert",
    dry_run: false,
    rows: [{ name: "History Customer", phone: "70000999" }],
  });
  const id = create.body.results[0].id;
  app.db.prepare(
    "INSERT INTO transactions (tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, status) VALUES (?, ?, NULL, 'sale', 20, 'USD', 1, 'completed')"
  ).run(tenantId, id);

  const res = await imp("customers", {
    mode: "upsert",
    dry_run: true,
    rows: [{ name: "History Customer", phone: "70000999", opening_balance: "30" }],
  });
  assert.equal(res.body.errors.length, 1);
  assert.equal(res.body.errors[0].code, "HAS_HISTORY");
});

test("customers: 'Walk-in Customer' can never be matched or modified -> RESERVED_NAME", async () => {
  const res = await imp("customers", {
    mode: "upsert",
    dry_run: true,
    rows: [{ name: "Walk-in Customer", opening_balance: "10" }],
  });
  assert.equal(res.body.errors.length, 1);
  assert.equal(res.body.errors[0].code, "RESERVED_NAME");
});

test("customers: create_only skips an existing match with EXISTS warning", async () => {
  await imp("customers", { mode: "upsert", dry_run: false, rows: [{ name: "Repeat Customer" }] });
  const res = await imp("customers", { mode: "create_only", dry_run: true, rows: [{ name: "Repeat Customer" }] });
  assert.equal(res.body.skipped, 1);
  assert.equal(res.body.warnings[0].code, "EXISTS");
});

test("customers: duplicate name in file -> DUPLICATE_IN_FILE on the later row", async () => {
  const res = await imp("customers", {
    mode: "upsert",
    dry_run: true,
    rows: [{ name: "Dup Customer" }, { name: "Dup Customer" }],
  });
  assert.equal(res.body.errors.length, 1);
  assert.equal(res.body.errors[0].row, 2);
  assert.equal(res.body.errors[0].code, "DUPLICATE_IN_FILE");
});

test("customers: bad email format is a warning, not an error", async () => {
  const res = await imp("customers", {
    mode: "upsert",
    dry_run: true,
    rows: [{ name: "Email Customer", email: "not-an-email" }],
  });
  assert.equal(res.body.errors.length, 0);
  assert.equal(res.body.warnings.length, 1);
  assert.equal(res.body.warnings[0].code, "EMAIL_FORMAT");
});

test("products: a stock-count sheet (barcode + stock only) updates stock and keeps the product's extra barcodes", async () => {
  const create = await imp("products", { mode: "upsert", dry_run: false, rows: [
    { name: "Count Me", barcode: "SC-1", barcodes: "SC-2|SC-3", price: "5", cost: "3", stock: "10" },
  ] });
  assert.equal(create.status, 200, JSON.stringify(create.body));
  const id = create.body.results[0].id;

  const count = await imp("products", { mode: "upsert", dry_run: false, rows: [{ barcode: "SC-1", stock: "7" }] });
  assert.equal(count.status, 200, JSON.stringify(count.body));
  assert.equal(count.body.updated, 1);
  const p = app.db.prepare("SELECT name, price, stock FROM products WHERE id = ?").get(id) as any;
  assert.deepEqual([p.name, p.price, p.stock], ["Count Me", 5, 7], "name/price untouched, stock counted");
  const extras = (app.db.prepare("SELECT barcode FROM product_barcodes WHERE product_id = ? ORDER BY barcode").all(id) as any[]).map((r) => r.barcode);
  assert.deepEqual(extras, ["SC-2", "SC-3"], "extra barcodes must survive a row that only carries the primary barcode");
  const adj = app.db.prepare("SELECT qty_before, qty_after, unit_cost FROM stock_adjustments WHERE product_id = ? ORDER BY id DESC LIMIT 1").get(id) as any;
  assert.deepEqual([adj.qty_before, adj.qty_after, adj.unit_cost], [10, 7, 3]);
});

test("products: a new product still needs a name and a price", async () => {
  const res = await imp("products", { mode: "upsert", dry_run: true, rows: [{ barcode: "NEW-NO-NAME", price: "2" }, { name: "No Price" }] });
  assert.deepEqual(res.body.errors.map((e: any) => [e.row, e.code, e.field]), [[1, "MISSING_REQUIRED", "name"], [2, "MISSING_REQUIRED", "price"]]);
});
