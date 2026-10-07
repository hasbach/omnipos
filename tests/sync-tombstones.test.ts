// v1.7.9: a day settlement (or invoice delete) whose CLOUD delete fails must not come back on the next
// pull. Settlement keeps each row's global_id in the archive and tombstones the live rows locally;
// pulls skip tombstoned rows (and children of deleted/unknown parents) and the sync engine retries the
// cloud delete. The Supabase client is an in-memory fake (see tests/sync-lighter.test.ts) with delete().
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let sync: typeof import("../server/sync.js");
let session: typeof import("../server/session.js");
let tenant: number;
let productId: number;
let productGid: string;
const GID = "bbbbbbbb-0000-4000-8000-000000000001";

type Req = { table: string; op: "select" | "upsert" | "delete"; filters: Array<[string, string, any]> };
let requests: Req[] = [];
let cloud: Record<string, any[]> = {};
let deleteError: any = null;
let selectErrors: Record<string, any> = {};

const ms = (v: any) => Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(String(v)) ? String(v) : String(v) + "Z");

function makeFake() {
  return {
    auth: {
      setSession: async (t: any) => ({ data: { session: { ...t } }, error: null }),
      refreshSession: async () => ({ data: { session: null }, error: { message: "no" } }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from(table: string) {
      const req: Req = { table, op: "select", filters: [] };
      const orderCols: string[] = [];
      let limit = Infinity;
      const q: any = {
        select() { return q; },
        gt(c: string, v: any) { req.filters.push(["gt", c, v]); return q; },
        gte(c: string, v: any) { req.filters.push(["gte", c, v]); return q; },
        or(expr: string) { req.filters.push(["or", "", expr]); return q; },
        eq(c: string, v: any) { req.filters.push(["eq", c, v]); return q; },
        in(c: string, v: any) { req.filters.push(["in", c, v]); return q; },
        order(c: string) { orderCols.push(c); return q; },
        limit(n: number) { limit = n; return q; },
        upsert() { req.op = "upsert"; return q; },
        delete() { req.op = "delete"; return q; },
        update() { return q; },
        not() { return q; },
        is() { return q; },
        then(resolve: any, reject: any) {
          requests.push(req);
          const done = (v: any) => Promise.resolve(v).then(resolve, reject);
          if (req.op === "upsert") return done({ error: null });
          if (req.op === "delete") {
            if (deleteError) return done({ error: deleteError });
            cloud[table] = (cloud[table] || []).filter((r) => !req.filters.every(([op, c, v]) => (op === "in" ? v.includes(r[c]) : r[c] === v)));
            return done({ error: null });
          }
          if (selectErrors[table]) return done({ data: null, error: selectErrors[table] });
          const sat = (r: any) => new Date(ms(r.updated_at)).toISOString();
          const col = orderCols[0] === "synced_at" ? "synced_at" : "updated_at";
          const val = (r: any) => (col === "synced_at" ? sat(r) : r.updated_at);
          let rows = [...(cloud[table] || [])];
          for (const [op, c, v] of req.filters) {
            if (op === "gt") rows = rows.filter((r) => ms(val(r)) > ms(v));
            else if (op === "gte") rows = rows.filter((r) => ms(val(r)) >= ms(v));
            else if (op === "in") rows = rows.filter((r) => v.includes(r[c]));
            else if (op === "or") {
              const m = /^(\w+)\.gt\.(.+?),and\(\1\.eq\.(.+?),global_id\.gt\.(.+)\)$/.exec(v)!;
              rows = rows.filter((r) => ms(val(r)) > ms(m[2]) || (ms(val(r)) === ms(m[3]) && String(r.global_id) > m[4]));
            } else if (op === "eq") {
              if (c.includes(".")) rows = rows.filter((r) => r.__tenant === v);
              else rows = rows.filter((r) => r[c] === v);
            }
          }
          rows.sort((a, b) => ms(val(a)) - ms(val(b)) || String(a.global_id).localeCompare(String(b.global_id)));
          rows = rows.slice(0, limit).map((r) => {
            const o: any = { ...r };
            delete o.__tenant;
            o.synced_at = sat(r);
            if (/!inner/.test(String((req as any).select || ""))) o.transactions = { tenant_id: r.__tenant };
            return o;
          });
          return done({ data: rows, error: null });
        },
      };
      return q;
    },
  };
}

let n = 0;
const uuid = () => `11111111-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const client = () => (session.getActiveSession() as any).client;
const deletes = (table?: string) => requests.filter((r) => r.op === "delete" && (!table || r.table === table));
const count = (sql: string, ...args: any[]) => (app.db.prepare(sql).get(...args) as any).c as number;
const unpurged = () => count("SELECT COUNT(*) c FROM sync_tombstones WHERE tenant_id = ? AND cloud_purged_at IS NULL", tenant);
const STAMP = "2026-10-01T10:00:00.000";

/** A cloud transaction + one item + one payment, all stamped as another register would have pushed them. */
function cloudSale() {
  const t = uuid(), i = uuid(), p = uuid();
  cloud.transactions.push({ global_id: t, tenant_id: GID, type: "sale", total_amount: 7, currency: "USD", exchange_rate: 1, updated_at: STAMP });
  cloud.transaction_items.push({ global_id: i, transaction_id: t, product_id: productGid, quantity: 1, unit_price: 7, updated_at: STAMP, __tenant: GID });
  cloud.payments.push({ global_id: p, transaction_id: t, amount: 7, method: "cash", currency: "USD", exchange_rate: 1, updated_at: STAMP, __tenant: GID });
  return { t, i, p };
}
const SALE_TABLES = ["transactions", "transaction_items", "payments"];
const localTx = (g: string) => count("SELECT COUNT(*) c FROM transactions WHERE global_id = ?", g);

before(async () => {
  app = await createTestApp();
  sync = await import("../server/sync.js");
  session = await import("../server/session.js");
  tenant = seedTenant(app.db, "Tombstone Co", "tombstone@example.com");
  app.db.prepare("UPDATE tenants SET global_id = ? WHERE id = ?").run(GID, tenant);
  productId = seedProduct(app.db, tenant, { barcode: "TS-1", name: "Widget", price: 7 });
  productGid = (app.db.prepare("SELECT global_id FROM products WHERE id = ?").get(productId) as any).global_id;
  session.__setClientFactory(makeFake as any);
  await session.setActiveSession(tenant, GID, "tombstone@example.com", { access_token: "a", refresh_token: "r" });
});
after(async () => { session.__setClientFactory(); await app.close(); });
beforeEach(() => {
  requests = []; cloud = { transactions: [], transaction_items: [], payments: [], cash_flow: [], cashier_shifts: [] }; deleteError = null; selectErrors = {};
  sync.resetEmbedProbe(); sync.resetPullSchedule(); sync.resetRequestCounts(); sync.resetSyncedAtProbe();
  sync.clearSyncCursors(); sync.__setPullPageSize();
  sync.ensureTombstoneTable(); app.db.prepare("DELETE FROM sync_tombstones").run();
});

test("a tombstoned cloud transaction (+ item + payment) is not re-inserted by a pull", async () => {
  const dead = cloudSale(), live = cloudSale();
  sync.addTombstones(tenant, [
    { table: "transactions", globalId: dead.t },
    { table: "transaction_items", globalId: dead.i, parentGlobalId: dead.t },
    { table: "payments", globalId: dead.p, parentGlobalId: dead.t },
    { table: "payments", globalId: "" }, // empty ids are ignored
  ]);
  assert.equal(sync.isTombstoned("transactions", dead.t), true);
  assert.equal(sync.isTombstoned("transactions", live.t), false);

  await sync.pullFromCloud(client(), tenant, GID, SALE_TABLES);
  assert.equal(localTx(dead.t), 0, "tombstoned transaction skipped");
  assert.equal(count("SELECT COUNT(*) c FROM transaction_items WHERE global_id = ?", dead.i), 0);
  assert.equal(count("SELECT COUNT(*) c FROM payments WHERE global_id = ?", dead.p), 0);
  assert.equal(localTx(live.t), 1, "an untouched sale still syncs");
  assert.equal(count("SELECT COUNT(*) c FROM payments WHERE global_id = ?", live.p), 1);
});

test("children of a tombstoned or unknown parent transaction are skipped", async () => {
  const tombParent = cloudSale();
  sync.addTombstones(tenant, [{ table: "transactions", globalId: tombParent.t }]); // only the parent is tombstoned
  const orphanPayment = uuid(), orphanItem = uuid(), unknownParent = uuid();
  cloud.payments.push({ global_id: orphanPayment, transaction_id: unknownParent, amount: 3, method: "cash", currency: "USD", exchange_rate: 1, updated_at: STAMP, __tenant: GID });
  cloud.transaction_items.push({ global_id: orphanItem, transaction_id: unknownParent, product_id: productGid, quantity: 1, unit_price: 3, updated_at: STAMP, __tenant: GID });

  await sync.pullFromCloud(client(), tenant, GID, SALE_TABLES);
  assert.equal(count("SELECT COUNT(*) c FROM payments WHERE global_id IN (?, ?)", orphanPayment, tombParent.p), 0);
  assert.equal(count("SELECT COUNT(*) c FROM transaction_items WHERE global_id IN (?, ?)", orphanItem, tombParent.i), 0);
  assert.equal(count("SELECT COUNT(*) c FROM payments WHERE transaction_id IS NULL"), 0, "no child is stored without a parent");
});

test("settlement whose cloud purge fails: tombstones + archive keep global_ids, the next cycle deletes from the cloud, pulls never resurrect", async () => {
  for (const t of ["payments", "transaction_items", "transactions"]) app.db.prepare(`DELETE FROM ${t}`).run(); // rows pulled by the tests above
  const sale = cloudSale();
  // The same sale as this register holds it (already synced).
  app.db.prepare("INSERT INTO transactions (tenant_id, type, total_amount, currency, exchange_rate, global_id, last_synced_at) VALUES (?, 'sale', 7, 'USD', 1, ?, CURRENT_TIMESTAMP)").run(tenant, sale.t);
  const txId = (app.db.prepare("SELECT id FROM transactions WHERE global_id = ?").get(sale.t) as any).id;
  app.db.prepare("INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price, global_id, last_synced_at) VALUES (?, ?, 1, 7, ?, CURRENT_TIMESTAMP)").run(txId, productId, sale.i);
  app.db.prepare("INSERT INTO payments (transaction_id, amount, method, currency, exchange_rate, global_id, last_synced_at) VALUES (?, 7, 'cash', 'USD', 1, ?, CURRENT_TIMESTAMP)").run(txId, sale.p);

  deleteError = { message: "offline" };
  const settle = await app.api("POST", "/api/tenant/settlement", { tenantId: tenant, body: {} });
  assert.equal(settle.status, 207, JSON.stringify(settle.body));
  assert.equal(settle.body.cloudPurged, false);

  // archive kept the original global_ids; the live rows are gone and tombstoned (not yet purged from the cloud)
  assert.equal(count("SELECT COUNT(*) c FROM archived_transactions WHERE global_id = ?", sale.t), 1);
  assert.equal(count("SELECT COUNT(*) c FROM archived_transaction_items WHERE global_id = ?", sale.i), 1);
  assert.equal(count("SELECT COUNT(*) c FROM archived_payments WHERE global_id = ?", sale.p), 1);
  assert.equal(localTx(sale.t), 0);
  assert.equal(unpurged(), 3);
  assert.equal(cloud.transactions.length, 1, "cloud still holds the sale");

  // a pull right now (offline retry still failing) does not bring it back
  await sync.pullFromCloud(client(), tenant, GID, SALE_TABLES);
  assert.equal(localTx(sale.t), 0);

  // connection is back: the next cycle deletes the tombstoned rows (children first) and marks them purged
  deleteError = null; requests = []; sync.clearSyncCursors();
  await sync.runSyncCycleAt(2_000_000_000_000);
  assert.deepEqual(deletes().map((r) => r.table).filter((t) => SALE_TABLES.includes(t)), ["payments", "transaction_items", "transactions"]);
  assert.ok(deletes("payments")[0].filters.some(([op, c, v]) => op === "in" && c === "global_id" && v.includes(sale.p)));
  assert.equal(cloud.transactions.length + cloud.transaction_items.length + cloud.payments.length, 0, "cloud rows deleted");
  assert.equal(unpurged(), 0);
  assert.equal(count("SELECT COUNT(*) c FROM sync_tombstones WHERE tenant_id = ?", tenant), 3, "tombstones stay as the pull guard");

  // nothing pending => no further delete requests
  requests = [];
  await sync.runSyncCycleAt(2_000_000_000_000 + 10_000);
  assert.equal(deletes().length, 0);

  // even if a stale copy reappears in the cloud, the pull skips it
  cloud.transactions.push({ global_id: sale.t, tenant_id: GID, type: "sale", total_amount: 7, currency: "USD", exchange_rate: 1, updated_at: STAMP });
  await sync.pullFromCloud(client(), tenant, GID, SALE_TABLES);
  assert.equal(localTx(sale.t), 0);
});

test("a settlement whose cloud purge succeeds: the next cycle confirms the delete by global_id", async () => {
  const g = uuid();
  app.db.prepare("INSERT INTO transactions (tenant_id, type, total_amount, currency, exchange_rate, global_id) VALUES (?, 'sale', 1, 'USD', 1, ?)").run(tenant, g);
  cloud.transactions.push({ global_id: g, tenant_id: GID, type: "sale", total_amount: 1, currency: "USD", exchange_rate: 1, updated_at: STAMP });
  const settle = await app.api("POST", "/api/tenant/settlement", { tenantId: tenant, body: {} });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));
  assert.equal(sync.isTombstoned("transactions", g), true);
  assert.equal(cloud.transactions.length, 0);
  // Left unpurged on purpose (a row pushed between the purge and the local archive would survive);
  // the next cycle re-deletes by global_id and marks them purged.
  assert.ok(unpurged() > 0);
  await sync.runSyncCycleAt(2_000_000_000_000 + 1_000_000);
  assert.equal(unpurged(), 0);
});

// ---- Deferred children (a skipped child must never be passed by the synced_at cursor) ----------
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
const cursorOf = (table: string) => app.db.prepare("SELECT synced_at, global_id FROM sync_cursor WHERE tenant_id = ? AND table_name = ?").get(tenant, table) as any;
const selects = (table: string) => requests.filter((r) => r.op === "select" && r.table === table);
const cloudChild = (kind: "transaction_items" | "payments", parent: string, stamp: string) => {
  const g = uuid();
  cloud[kind].push(kind === "payments"
    ? { global_id: g, transaction_id: parent, amount: 4, method: "cash", currency: "USD", exchange_rate: 1, updated_at: stamp, __tenant: GID }
    : { global_id: g, transaction_id: parent, product_id: productGid, quantity: 1, unit_price: 4, updated_at: stamp, __tenant: GID });
  return g;
};
const rowCount = (table: string, g: string) => count(`SELECT COUNT(*) c FROM ${table} WHERE global_id = ?`, g);

test("a failed transactions pull skips transaction_items/payments for that call; the next call pulls all", async () => {
  const t = uuid();
  cloud.transactions.push({ global_id: t, tenant_id: GID, type: "sale", total_amount: 4, currency: "USD", exchange_rate: 1, updated_at: iso(60_000) });
  const item = cloudChild("transaction_items", t, iso(60_000));
  const pay = cloudChild("payments", t, iso(60_000));

  selectErrors.transactions = { code: "XX000", message: "boom" };
  await sync.pullFromCloud(client(), tenant, GID, SALE_TABLES);
  assert.equal(selects("transaction_items").length, 0, "items not requested");
  assert.equal(selects("payments").length, 0, "payments not requested");
  assert.equal(cursorOf("transaction_items"), undefined);
  assert.equal(localTx(t), 0);

  selectErrors = {};
  await sync.pullFromCloud(client(), tenant, GID, SALE_TABLES);
  assert.equal(localTx(t), 1);
  assert.equal(rowCount("transaction_items", item), 1);
  assert.equal(rowCount("payments", pay), 1);
});

test("a child that arrives before its parent is deferred (cursor not moved past it) and applied once the parent shows up", async () => {
  const good = uuid(), late = uuid();
  cloud.transactions.push({ global_id: good, tenant_id: GID, type: "sale", total_amount: 4, currency: "USD", exchange_rate: 1, updated_at: iso(600_000) });
  const goodItem = cloudChild("transaction_items", good, iso(600_000));
  const lateItem = cloudChild("transaction_items", late, iso(60_000)); // parent not in the cloud yet
  const laterItem = cloudChild("transaction_items", good, iso(30_000)); // same page, after the deferred row: applied, but the cursor stays before the deferred row

  await sync.pullFromCloud(client(), tenant, GID, SALE_TABLES);
  assert.equal(rowCount("transaction_items", goodItem), 1);
  assert.equal(rowCount("transaction_items", lateItem), 0, "deferred, not stored");
  assert.equal(rowCount("transaction_items", laterItem), 1, "rows with a known parent are still applied");
  assert.equal(cursorOf("transaction_items").global_id, goodItem, "cursor stops just before the deferred row");

  cloud.transactions.push({ global_id: late, tenant_id: GID, type: "sale", total_amount: 4, currency: "USD", exchange_rate: 1, updated_at: iso(1_000) });
  await sync.pullFromCloud(client(), tenant, GID, SALE_TABLES);
  assert.equal(localTx(late), 1);
  assert.equal(rowCount("transaction_items", lateItem), 1, "applied after its parent arrived");
  assert.equal(rowCount("transaction_items", laterItem), 1);
});

test("an orphan child older than 24h is dropped and the cursor moves on", async () => {
  const gone = uuid();
  const orphan = cloudChild("payments", gone, iso(2 * 24 * 3600_000));
  const t = uuid();
  cloud.transactions.push({ global_id: t, tenant_id: GID, type: "sale", total_amount: 4, currency: "USD", exchange_rate: 1, updated_at: iso(60_000) });
  const after = cloudChild("payments", t, iso(30_000));

  await sync.pullFromCloud(client(), tenant, GID, SALE_TABLES);
  assert.equal(rowCount("payments", orphan), 0, "orphan dropped");
  assert.equal(rowCount("payments", after), 1, "paging continued past the dropped orphan");
  assert.equal(cursorOf("payments").global_id, after);
});
