// v1.7.8 "lighter sync" (Supabase free-plan egress cut ~10x). Covers: the hot/cold pull schedule,
// constant-request child-table pulls (+ chunked fallback), keyset paging, the server-time
// (synced_at) pull cursor and its updated_at fallback, local edits never being overwritten by a pull,
// and the stakeholder push churn. The Supabase client is an in-memory fake that records every request.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let sync: typeof import("../server/sync.js");
let session: typeof import("../server/session.js");
let tenant: number;
const GID = "aaaaaaaa-0000-4000-8000-000000000001";

type Req = { table: string; op: "select" | "upsert"; select?: string; filters: Array<[string, string, any]> };
let requests: Req[] = [];
let cloud: Record<string, any[]> = {};
let embedError: any = null;
let cloudHasSyncedAt = true;
let afterSelect: ((req: Req) => void) | null = null;

const ms = (v: any) => Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(String(v)) ? String(v) : String(v) + "Z");
// The cloud's synced_at: explicit on the fixture row, else the row's updated_at (as the DB trigger would).
const sat = (r: any) => r.synced_at ?? new Date(ms(r.updated_at)).toISOString();

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
        select(cols: string) { req.select = cols; return q; },
        gt(c: string, v: any) { req.filters.push(["gt", c, v]); return q; },
        gte(c: string, v: any) { req.filters.push(["gte", c, v]); return q; },
        or(expr: string) { req.filters.push(["or", "", expr]); return q; },
        eq(c: string, v: any) { req.filters.push(["eq", c, v]); return q; },
        in(c: string, v: any) { req.filters.push(["in", c, v]); return q; },
        order(c: string) { orderCols.push(c); return q; },
        limit(n: number) { limit = n; return q; },
        upsert() { req.op = "upsert"; return q; },
        update() { return q; },
        not() { return q; },
        is() { return q; },
        then(resolve: any, reject: any) {
          requests.push(req);
          const done = (v: any) => Promise.resolve(v).then(resolve, reject);
          if (req.op === "upsert") return done({ error: null });
          const usesSyncedAt = orderCols.includes("synced_at") || req.filters.some(([, c, v]) => c === "synced_at" || /synced_at/.test(String(v)));
          if (usesSyncedAt && !cloudHasSyncedAt) return done({ data: null, error: { code: "42703", message: 'column "synced_at" does not exist' } });
          const embed = /!inner/.test(req.select || "");
          if (embed && embedError) return done({ data: null, error: embedError });
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
              if (c.includes(".")) rows = rows.filter((r) => r.__tenant === v); // embedded parent's tenant
              else rows = rows.filter((r) => r[c] === v);
            }
          }
          rows.sort((a, b) => ms(val(a)) - ms(val(b)) || String(a.global_id).localeCompare(String(b.global_id)));
          rows = rows.slice(0, limit).map((r) => {
            const o: any = { ...r };
            delete o.__tenant;
            if (cloudHasSyncedAt) o.synced_at = sat(r); else delete o.synced_at;
            if (embed) o[(req.select!.match(/,\s*(\w+)!inner/) || [])[1]] = { tenant_id: r.__tenant };
            return o;
          });
          const out = done({ data: rows, error: null });
          afterSelect?.(req);
          return out;
        },
      };
      return q;
    },
  };
}

const selects = (table?: string) => requests.filter((r) => r.op === "select" && (!table || r.table === table));
const upserts = (table: string) => requests.filter((r) => r.op === "upsert" && r.table === table);
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const pad = (i: number) => `2099-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000000`;
const iso = (s: string) => new Date(s).toISOString(); // millisecond-exact ISO stamp
const client = () => (session.getActiveSession() as any).client;
const product = (gid: string, name: string, updated: string, extra: any = {}) => ({
  global_id: gid, tenant_id: GID, barcode: `B-${gid.slice(-6)}`, name, price: 1, stock: 1, category: "x", updated_at: updated, ...extra,
});
const localProduct = (gid: string) => app.db.prepare("SELECT * FROM products WHERE global_id = ?").get(gid) as any;

function seedLocalTransactions(count: number): string[] {
  const ids: string[] = [];
  const ins = app.db.prepare("INSERT INTO transactions (tenant_id, total_amount, currency, exchange_rate, global_id) VALUES (?, 1, 'USD', 1, ?)");
  app.db.transaction(() => { for (let i = 0; i < count; i++) { const g = uuid(); ins.run(tenant, g); ids.push(g); } })();
  return ids;
}

before(async () => {
  app = await createTestApp();
  sync = await import("../server/sync.js");
  session = await import("../server/session.js");
  tenant = seedTenant(app.db, "Lighter Co", "lighter@example.com");
  app.db.prepare("UPDATE tenants SET global_id = ? WHERE id = ?").run(GID, tenant);
  session.__setClientFactory(makeFake as any);
  await session.setActiveSession(tenant, GID, "lighter@example.com", { access_token: "a", refresh_token: "r" });
});
after(async () => { session.__setClientFactory(); await app.close(); });
beforeEach(() => {
  requests = []; cloud = {}; embedError = null; cloudHasSyncedAt = true; afterSelect = null;
  sync.resetEmbedProbe(); sync.resetPullSchedule(); sync.resetRequestCounts(); sync.resetSyncedAtProbe();
  sync.clearSyncCursors(); sync.__setPullPageSize();
});

test("idle cycles follow the schedule: hot every 60 s, cold every 5 min, push stays local", async () => {
  const T0 = 1_000_000_000_000;
  await sync.runSyncCycleAt(T0); // first cycle pulls everything and pushes the seed rows once
  assert.equal(selects().length, sync.HOT_PULL_TABLES.length + sync.COLD_PULL_TABLES.length);
  requests = [];

  const perTable: Record<string, number> = {};
  // 10 simulated minutes of 10 s ticks (T0+10 s .. T0+600 s)
  for (let s = 10; s <= 600; s += 10) await sync.runSyncCycleAt(T0 + s * 1000);
  for (const r of selects()) perTable[r.table] = (perTable[r.table] || 0) + 1;

  for (const t of sync.HOT_PULL_TABLES) assert.equal(perTable[t], 10, `${t}: hot pulls at 60..600 s`);
  for (const t of sync.COLD_PULL_TABLES) assert.equal(perTable[t], 2, `${t}: cold pulls at 300 s and 600 s`);
  assert.equal(requests.filter((r) => r.op === "upsert").length, 0, "nothing pending => no push requests");
  const c = sync.getRequestCounts();
  assert.equal(c.pull, selects().length + sync.HOT_PULL_TABLES.length + sync.COLD_PULL_TABLES.length);
  assert.ok(c.since);
});

test("child tables are pulled with ONE request however many parents exist", async () => {
  const txIds = seedLocalTransactions(250);
  cloud.transaction_items = [];
  cloud.payments = [{ global_id: uuid(), transaction_id: txIds[7], amount: 5, method: "cash", currency: "USD", exchange_rate: 1, updated_at: pad(1), __tenant: GID }];
  await sync.pullFromCloud(client(), tenant, GID, ["transaction_items", "payments"]);
  assert.equal(selects("transaction_items").length, 1);
  assert.equal(selects("payments").length, 1);
  assert.match(selects("payments")[0].select!, /transactions!inner\(tenant_id\)/);
  assert.ok(selects("payments")[0].filters.some(([op, c, v]) => op === "eq" && c === "transactions.tenant_id" && v === GID));
  const got = app.db.prepare("SELECT * FROM payments WHERE amount = 5").all() as any[];
  assert.equal(got.length, 1, "pulled row stored");
  assert.ok(!("transactions" in got[0]), "embedded parent object is never written");
});

test("a rejected embed falls back to chunked pulls (and is remembered)", async () => {
  const txIds = seedLocalTransactions(250);
  const total = (app.db.prepare("SELECT COUNT(*) c FROM transactions WHERE tenant_id = ? AND global_id IS NOT NULL").get(tenant) as any).c;
  const chunks = Math.ceil(total / 100);
  embedError = { code: "PGRST200", message: "Could not find a relationship" };
  cloud.payments = [{ global_id: uuid(), transaction_id: txIds[3], amount: 9, method: "cash", currency: "USD", exchange_rate: 1, updated_at: pad(2), __tenant: GID }];

  await sync.pullFromCloud(client(), tenant, GID, ["payments"]);
  assert.equal(selects("payments").length, 1 + chunks, "1 failed embed + one request per chunk of 100");
  assert.equal(app.db.prepare("SELECT COUNT(*) c FROM payments WHERE amount = 9").get().c, 1);

  requests = [];
  await sync.pullFromCloud(client(), tenant, GID, ["payments"]);
  assert.equal(selects("payments").length, chunks, "no second embed attempt this session");
});

test("pulls page past the 1000-row PostgREST cap (keyset)", async () => {
  const [tx] = seedLocalTransactions(1);
  cloud.payments = Array.from({ length: 2500 }, (_, i) => ({
    global_id: uuid(), transaction_id: tx, amount: 1000 + i, method: "cash", currency: "USD", exchange_rate: 1, updated_at: pad(i), __tenant: GID,
  }));
  await sync.pullFromCloud(client(), tenant, GID, ["payments"]);
  assert.equal(selects("payments").length, 3, "1000 + 1000 + 500");
  assert.equal(app.db.prepare("SELECT COUNT(*) c FROM payments WHERE amount >= 1000").get().c, 2500);

  requests = [];
  cloud.products = Array.from({ length: 1200 }, (_, i) => product(uuid(), `P${i}`, pad(i), { barcode: `PG-${i}` }));
  await sync.pullFromCloud(client(), tenant, GID, ["products"]);
  assert.equal(selects("products").length, 2);
  assert.equal(app.db.prepare("SELECT COUNT(*) c FROM products WHERE barcode LIKE 'PG-%'").get().c, 1200);
});

test("stakeholder churn: pull + post-pull recompute is not pushable; a real edit is", async () => {
  const c = client();
  const sg = uuid();
  // Another register's copy, with a balance that disagrees with what this register derives (0).
  cloud.stakeholders = [{ global_id: sg, tenant_id: GID, name: "Remote Customer", type: "customer", balance: 50, updated_at: "2026-01-02T03:04:05.123456" }];
  await sync.pushToCloud(c, tenant); // settle everything seeded so far
  requests = [];

  await sync.pullFromCloud(c, tenant, GID, ["stakeholders"]);
  sync.recomputeBalancesAfterPull(tenant);
  const row = app.db.prepare("SELECT * FROM stakeholders WHERE global_id = ?").get(sg) as any;
  assert.equal(row.balance, 0, "balance is the locally derived value, not the cloud's");
  assert.equal(row.updated_at, "2026-01-02 03:04:05.123456", "updated_at untouched by the recompute");
  assert.deepEqual(sync.countPendingPush(tenant).stakeholders ?? 0, 0, "row is not pending");
  await sync.pushToCloud(c, tenant);
  assert.equal(upserts("stakeholders").length, 0, "no stakeholder POST after a pull");

  // Re-pulling the identical cloud row (overlap re-read) changes nothing either.
  await sync.pullFromCloud(c, tenant, GID, ["stakeholders"]);
  sync.recomputeBalancesAfterPull(tenant);
  await sync.pushToCloud(c, tenant);
  assert.equal(upserts("stakeholders").length, 0);

  // A genuine local edit still goes up.
  app.db.prepare("UPDATE stakeholders SET name = 'Renamed' WHERE global_id = ?").run(sg);
  assert.equal(sync.countPendingPush(tenant).stakeholders, 1);
  await sync.pushToCloud(c, tenant);
  assert.equal(upserts("stakeholders").length, 1);
  assert.equal(sync.countPendingPush(tenant).stakeholders ?? 0, 0);
});

test("a recompute right after a real local change still pushes that stakeholder", async () => {
  const id = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Local New', 'customer')").run(tenant).lastInsertRowid);
  app.db.prepare("UPDATE stakeholders SET balance_baseline = 7 WHERE id = ?").run(id);
  sync.recomputeBalancesAfterPull(tenant); // row was already pending: must stay pending
  requests = [];
  await sync.pushToCloud(client(), tenant);
  assert.equal(upserts("stakeholders").length, 1);
});

test("a pull never overwrites (or marks synced) a row with a pending local edit", async () => {
  const c = client();
  await sync.pushToCloud(c, tenant);
  // (a) edited after the last push
  const g1 = uuid();
  app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, stock, category, global_id) VALUES (?, 'DIRTY-1', 'Local v1', 1, 1, 'x', ?)").run(tenant, g1);
  await sync.pushToCloud(c, tenant);
  // (timestamps have 1 s resolution: pretend the last push was an hour ago so the edit is unambiguously newer)
  app.db.prepare("UPDATE products SET last_synced_at = datetime('now', '-1 hour') WHERE global_id = ?").run(g1);
  app.db.prepare("UPDATE products SET name = 'Local edit' WHERE global_id = ?").run(g1);
  // (b) never pushed at all (last_synced_at NULL), e.g. created offline
  const g2 = uuid();
  app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, stock, category, global_id, last_synced_at) VALUES (?, 'DIRTY-2', 'Offline new', 1, 1, 'x', ?, NULL)").run(tenant, g2);

  const future = new Date(Date.now() + 60_000).toISOString();
  cloud.products = [
    product(g1, "Cloud version 1", future, { barcode: "DIRTY-1" }),
    product(g2, "Cloud version 2", future, { barcode: "DIRTY-2" }),
  ];
  // a pull right after login (before any push) is exactly forceInitialSync
  await sync.forceInitialSync();
  const a = localProduct(g1), b = localProduct(g2);
  assert.equal(a.name, "Local edit");
  assert.equal(b.name, "Offline new");
  assert.equal(b.last_synced_at, null, "not marked synced");
  assert.ok(sync.countPendingPush(tenant).products >= 1, "still pending, so the push sends ours");
  requests = [];
  await sync.pushToCloud(c, tenant);
  assert.equal(upserts("products").length, 1, "our versions go up");
  assert.equal(sync.countPendingPush(tenant).products ?? 0, 0);
});

test("a late backlog (old updated_at, new synced_at) is pulled; the updated_at clock is irrelevant", async () => {
  const gA = uuid(), gB = uuid();
  cloud.products = [product(gA, "A", "2026-10-01T10:00:00.000Z", { synced_at: "2026-10-01T10:00:01.000Z" })];
  await sync.pullFromCloud(client(), tenant, GID, ["products"]);
  assert.equal(localProduct(gA).name, "A");

  // Another register comes back online and pushes a backlog stamped a month ago; the cloud
  // stamps it with ITS clock, which is after our cursor.
  cloud.products.push(product(gB, "Backlog", "2026-09-01T09:00:00.000Z", { synced_at: "2026-10-05T12:00:00.000Z" }));
  await sync.pullFromCloud(client(), tenant, GID, ["products"]);
  assert.equal(localProduct(gB)?.name, "Backlog");
  assert.ok(selects("products").some((r) => r.filters.some(([, c]) => c === "synced_at")), "cursor is on synced_at");
});

test("rows sharing one timestamp are all pulled across page boundaries", async () => {
  sync.__setPullPageSize(2);
  const ids = Array.from({ length: 5 }, () => uuid());
  cloud.products = ids.map((g, i) => product(g, `Same-${i}`, "2026-10-01T10:00:00.000Z", { synced_at: "2026-10-01T10:00:00.000Z", barcode: `EQ-${i}` }));
  await sync.pullFromCloud(client(), tenant, GID, ["products"]);
  assert.equal(app.db.prepare("SELECT COUNT(*) c FROM products WHERE barcode LIKE 'EQ-%'").get().c, 5);
  assert.equal(selects("products").length, 3, "2 + 2 + 1");
});

test("keyset paging misses nothing when rows arrive between pages", async () => {
  sync.__setPullPageSize(2);
  const mk = (i: number, name: string) => product(uuid(), name, `2026-10-01T10:00:0${i}.000Z`, { synced_at: `2026-10-01T10:00:0${i}.000Z`, barcode: `KS-${name}` });
  cloud.products = [mk(1, "s1"), mk(2, "s2"), mk(3, "s3"), mk(4, "s4"), mk(5, "s5"), mk(6, "s6")];
  let fired = false;
  afterSelect = () => {
    if (fired) return;
    fired = true; // after page 1 was served: a late commit sorts BEFORE page 1's last row, another AFTER the end
    cloud.products.push(product(uuid(), "skew", "2026-10-01T10:00:01.500Z", { synced_at: "2026-10-01T10:00:01.500Z", barcode: "KS-skew" }));
    cloud.products.push(product(uuid(), "s7", "2026-10-01T10:00:07.000Z", { synced_at: "2026-10-01T10:00:07.000Z", barcode: "KS-s7" }));
  };
  await sync.pullFromCloud(client(), tenant, GID, ["products"]);
  const names = () => (app.db.prepare("SELECT barcode FROM products WHERE barcode LIKE 'KS-%'").all() as any[]).map((r) => r.barcode).sort();
  assert.deepEqual(names(), ["KS-s1", "KS-s2", "KS-s3", "KS-s4", "KS-s5", "KS-s6", "KS-s7"], "nothing skipped or duplicated mid-run; the late tail row arrives");
  // The commit-order skew row sits just behind the cursor: the overlap window on the next pull gets it.
  await sync.pullFromCloud(client(), tenant, GID, ["products"]);
  assert.deepEqual(names(), ["KS-s1", "KS-s2", "KS-s3", "KS-s4", "KS-s5", "KS-s6", "KS-s7", "KS-skew"]);
});

test("first synced_at use re-downloads from the epoch, skipping identical rows and healing missed ones", async () => {
  const gKnown = uuid(), gMissed = uuid();
  // Held locally, identical updated_at, clean (as if pulled earlier) - the local stock differs from the cloud
  // copy so we can tell an (unwanted) rewrite from a skip.
  app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, stock, category, global_id, updated_at, last_synced_at) VALUES (?, 'HEAL-1', 'Known', 1, 111, 'x', ?, '2026-10-05 10:00:00', '2026-10-05 10:00:00')").run(tenant, gKnown);
  cloud.products = [
    product(gKnown, "Known", "2026-10-05T10:00:00", { barcode: "HEAL-1", stock: 999 }),
    // an offline register's backlog older than our local MAX(updated_at): the old cursor never reached it
    product(gMissed, "Missed", "2026-10-01T10:00:00", { barcode: "HEAL-2" }),
  ];
  await sync.pullFromCloud(client(), tenant, GID, ["products"]);
  assert.equal(localProduct(gMissed)?.name, "Missed", "healed");
  assert.equal(localProduct(gKnown).stock, 111, "identical row skipped, not rewritten");
  const first = selects("products")[0];
  assert.ok(first.filters.some(([op, c, v]) => op === "gte" && c === "synced_at" && ms(v) === 0), "starts at the epoch");
});

test("without a cloud synced_at column the pull falls back to updated_at (overlapped, equal stamps included)", async () => {
  // earlier tests left far-future (2099) rows behind; the fallback cursor is the newest clean local row
  app.db.prepare("DELETE FROM products WHERE updated_at >= '2090'").run();
  cloudHasSyncedAt = false;
  sync.__setPullPageSize(2);
  const stamp = "2026-10-02T08:00:00.000";
  const ids = Array.from({ length: 5 }, () => uuid());
  cloud.products = ids.map((g, i) => product(g, `Fb-${i}`, stamp, { barcode: `FB-${i}` }));
  await sync.pullFromCloud(client(), tenant, GID, ["products"]);
  assert.equal(app.db.prepare("SELECT COUNT(*) c FROM products WHERE barcode LIKE 'FB-%'").get().c, 5, "equal updated_at rows all pulled");
  const reqs = selects("products");
  assert.ok(reqs.some((r) => r.filters.some(([, c]) => c === "updated_at")), "uses updated_at");
  assert.ok(reqs.some((r) => r.filters.some(([op, c]) => op === "gte" && c === "updated_at")), "gte, not gt");

  // remembered: the next pull does not probe synced_at again, and a re-read is a harmless no-op
  requests = [];
  await sync.pullFromCloud(client(), tenant, GID, ["products"]);
  assert.ok(selects("products").every((r) => !r.filters.some(([, c, v]) => c === "synced_at" || /synced_at/.test(String(v)))));
  // a late-arriving row inside the overlap window (older than our newest, e.g. slow commit) is still picked up
  cloud.products.push(product(uuid(), "Late", "2026-10-02T07:59:30.000", { barcode: "FB-late" }));
  await sync.pullFromCloud(client(), tenant, GID, ["products"]);
  assert.equal(app.db.prepare("SELECT COUNT(*) c FROM products WHERE barcode = 'FB-late'").get().c, 1);
});
