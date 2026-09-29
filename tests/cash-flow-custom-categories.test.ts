// Admin-defined cash-flow categories: create / rename / hide / re-direct, validation on cash in/out and
// on the admin edit, per-tenant isolation, analytics grouping by the custom key, and permissions
// (anyone who can use the register may READ them; defining them needs settings.manage).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let otherTenant: number;

const cat = (t: number, method: string, url: string, body?: any) => app.api(method, url, { tenantId: t, body });
const create = (name: string, direction: string, t = tenantId) => cat(t, "POST", "/api/cash-flow/categories", { name, direction });
const add = (body: any, t = tenantId) => cat(t, "POST", "/api/cash-flow", { currency: "USD", exchange_rate: 1, ...body });

let keyIn = "", keyOut = "", keyBoth = "", idIn = 0, idOut = 0, idBoth = 0;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "CF Custom Cat Co", "cf-custom-cat@example.com");
  otherTenant = seedTenant(app.db, "CF Custom Cat Other", "cf-custom-cat-other@example.com");
});
after(async () => { await app.close(); });

test("create custom categories for in / out / both; GET lists built-ins and custom", async () => {
  const a = await create("  Tips  ", "in");
  const b = await create("Rent", "out");
  const c = await create("Misc float", "both");
  for (const r of [a, b, c]) { assert.equal(r.status, 200); assert.match(r.body.key, /^c_[0-9a-f]{12}$/); }
  ({ id: idIn, key: keyIn } = a.body); ({ id: idOut, key: keyOut } = b.body); ({ id: idBoth, key: keyBoth } = c.body);

  const list = (await cat(tenantId, "GET", "/api/cash-flow/categories")).body;
  assert.equal(list.builtin.length, 8);
  assert.deepEqual(list.builtin.find((x: any) => x.key === "top_up"), { key: "top_up", direction: "in" });
  assert.deepEqual(list.builtin.find((x: any) => x.key === "other"), { key: "other", direction: "both" });
  assert.deepEqual(list.custom.map((x: any) => [x.name, x.direction, x.active]), [["Tips", "in", true], ["Rent", "out", true], ["Misc float", "both", true]]);
  assert.deepEqual(list.custom.map((x: any) => x.sort_order), [1, 2, 3]);
  // Another tenant sees none of them.
  assert.deepEqual((await cat(otherTenant, "GET", "/api/cash-flow/categories")).body.custom, []);
});

test("name and direction validation, case-insensitive uniqueness", async () => {
  const empty = await create("   ", "in");
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, "CASHFLOW_CATEGORY_NAME_INVALID");
  assert.equal(empty.body.field, "name");
  assert.equal((await create("x".repeat(41), "in")).body.code, "CASHFLOW_CATEGORY_NAME_INVALID");
  assert.equal((await create("x".repeat(40), "in")).status, 200);

  const dup = await create("rent", "in");
  assert.equal(dup.status, 400);
  assert.equal(dup.body.code, "CASHFLOW_CATEGORY_NAME_TAKEN");
  assert.equal(dup.body.field, "name");

  const noDir = await create("Fresh", "sideways");
  assert.equal(noDir.body.code, "CASHFLOW_CATEGORY_DIRECTION_INVALID");
  assert.equal(noDir.body.field, "direction");
  assert.equal((await cat(tenantId, "POST", "/api/cash-flow/categories", { name: "NoDir" })).body.code, "CASHFLOW_CATEGORY_DIRECTION_INVALID");

  // The same name is fine in another tenant.
  assert.equal((await create("Rent", "out", otherTenant)).status, 200);
  // Renaming onto an existing name is refused; keeping your own name is fine.
  assert.equal((await cat(tenantId, "PUT", `/api/cash-flow/categories/${idOut}`, { name: "TIPS" })).body.code, "CASHFLOW_CATEGORY_NAME_TAKEN");
  assert.equal((await cat(tenantId, "PUT", `/api/cash-flow/categories/${idOut}`, { name: "RENT" })).status, 200);
  assert.equal((await cat(tenantId, "PUT", `/api/cash-flow/categories/99999`, { name: "Zzz" })).status, 404);
});

test("cash in / out accept a matching custom category and reject wrong direction, inactive and foreign ones", async () => {
  assert.equal((await add({ type: "in", amount: 10, category: keyIn, reason: "tip 1" })).status, 200);
  assert.equal((await add({ type: "out", amount: 20, category: keyOut, reason: "rent 1" })).status, 200);
  assert.equal((await add({ type: "in", amount: 5, category: keyBoth, reason: "both in" })).status, 200);
  assert.equal((await add({ type: "out", amount: 6, category: keyBoth, reason: "both out" })).status, 200);

  const mismatch = await add({ type: "out", amount: 5, category: keyIn, reason: "x" });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.code, "CASHFLOW_CATEGORY_TYPE_MISMATCH");
  assert.equal((await add({ type: "in", amount: 5, category: keyOut, reason: "x" })).body.code, "CASHFLOW_CATEGORY_TYPE_MISMATCH");

  // Another tenant's key is simply unknown.
  const foreign = (await cat(otherTenant, "GET", "/api/cash-flow/categories")).body.custom[0].key;
  const cross = await add({ type: "out", amount: 5, category: foreign, reason: "x" });
  assert.equal(cross.status, 400);
  assert.equal(cross.body.code, "CASHFLOW_CATEGORY_INVALID");
  assert.equal((await add({ type: "out", amount: 5, category: "c_doesnotexist", reason: "x" })).body.code, "CASHFLOW_CATEGORY_INVALID");

  // Hidden (inactive) categories are refused for new movements.
  const hide = await cat(tenantId, "PUT", `/api/cash-flow/categories/${idBoth}`, { active: false });
  assert.equal(hide.status, 200);
  const inactive = await add({ type: "in", amount: 5, category: keyBoth, reason: "x" });
  assert.equal(inactive.status, 400);
  assert.equal(inactive.body.code, "CASHFLOW_CATEGORY_INVALID");
  const listed = (await cat(tenantId, "GET", "/api/cash-flow/categories")).body.custom.find((x: any) => x.key === keyBoth);
  assert.equal(listed.active, false, "inactive ones are still listed, flagged");
});

test("admin edit: a row may keep its now-hidden category, but cannot move to one", async () => {
  const row = app.db.prepare("SELECT id FROM cash_flow WHERE tenant_id = ? AND reason = 'both in'").get(tenantId) as any;
  // Keeps the hidden category while the amount changes.
  const keep = await cat(tenantId, "PUT", `/api/cash-flow/${row.id}`, { amount: 7, edit_reason: "typo" });
  assert.equal(keep.status, 200);
  assert.equal((app.db.prepare("SELECT category FROM cash_flow WHERE id = ?").get(row.id) as any).category, keyBoth);
  // Switching TO a valid custom category works; switching back to the hidden one does not.
  assert.equal((await cat(tenantId, "PUT", `/api/cash-flow/${row.id}`, { category: keyIn, edit_reason: "recategorise" })).status, 200);
  const back = await cat(tenantId, "PUT", `/api/cash-flow/${row.id}`, { category: keyBoth, edit_reason: "undo" });
  assert.equal(back.body.code, "CASHFLOW_CATEGORY_INVALID");
  // Changing the movement type against the category's direction is a mismatch.
  const flip = await cat(tenantId, "PUT", `/api/cash-flow/${row.id}`, { type: "out", edit_reason: "flip" });
  assert.equal(flip.body.code, "CASHFLOW_CATEGORY_TYPE_MISMATCH");
});

test("direction change is blocked while opposite-type movements use the category", async () => {
  // keyOut has an 'out' row. Narrowing to 'in' conflicts; widening to 'both' is fine; then back to 'out'.
  const blocked = await cat(tenantId, "PUT", `/api/cash-flow/categories/${idOut}`, { direction: "in" });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.code, "CASHFLOW_CATEGORY_DIRECTION_IN_USE");
  assert.equal(blocked.body.field, "direction");
  assert.equal((await cat(tenantId, "PUT", `/api/cash-flow/categories/${idOut}`, { direction: "both" })).status, 200);
  assert.equal((await cat(tenantId, "PUT", `/api/cash-flow/categories/${idOut}`, { direction: "out" })).status, 200);

  // Archived (settled) rows count too.
  app.db.prepare("INSERT INTO archived_cash_flow (tenant_id, type, amount, currency, exchange_rate, category, reason) VALUES (?, 'in', 3, 'USD', 1, ?, 'old settled')").run(tenantId, keyOut);
  // An 'in' row under an 'out' category can only exist as history; narrowing keyBoth-like categories is what matters:
  const created = await create("Archived use", "both");
  app.db.prepare("INSERT INTO archived_cash_flow (tenant_id, type, amount, currency, exchange_rate, category, reason) VALUES (?, 'out', 3, 'USD', 1, ?, 'settled out')").run(tenantId, created.body.key);
  const archBlocked = await cat(tenantId, "PUT", `/api/cash-flow/categories/${created.body.id}`, { direction: "in" });
  assert.equal(archBlocked.body.code, "CASHFLOW_CATEGORY_DIRECTION_IN_USE");
  assert.equal((await cat(tenantId, "PUT", `/api/cash-flow/categories/${created.body.id}`, { direction: "out" })).status, 200);
  app.db.prepare("DELETE FROM archived_cash_flow WHERE tenant_id = ? AND reason IN ('old settled', 'settled out')").run(tenantId);
});

test("analytics groups by the custom key and can filter / search by it", async () => {
  const a = (await app.api("GET", "/api/cash-flow/analytics", { tenantId })).body;
  const tips = a.by_category.find((c: any) => c.category === keyIn && c.type === "in");
  assert.ok(tips, "custom key appears in by_category");
  assert.equal(tips.total, 17, "10 tip + the 7 row recategorised in the edit test");
  assert.equal(a.by_category.find((c: any) => c.category === keyOut).total, 20);
  assert.ok(a.rows.some((r: any) => r.category === keyIn));

  const filtered = (await app.api("GET", `/api/cash-flow/analytics?category=${keyOut}`, { tenantId })).body;
  assert.equal(filtered.totals.out, 20);
  assert.equal(filtered.totals.in, 0);

  // Free-text search matches the category NAME, not only the key.
  const bySearch = (await app.api("GET", "/api/cash-flow/analytics?q=rent", { tenantId })).body;
  assert.ok(bySearch.rows.length > 0 && bySearch.rows.every((r: any) => r.category === keyOut || /rent/i.test(r.reason || "")));
  // Renaming keeps the key, so history keeps grouping.
  assert.equal((await cat(tenantId, "PUT", `/api/cash-flow/categories/${idIn}`, { name: "Gratuities" })).status, 200);
  const after = (await app.api("GET", "/api/cash-flow/analytics", { tenantId })).body;
  assert.equal(after.by_category.find((c: any) => c.category === keyIn).total, 17);
});

test("permissions: readers without settings.manage can GET but not POST / PUT", async () => {
  const admin = (app.db.prepare("SELECT id FROM users WHERE tenant_id = ? AND role = 'admin'").get(tenantId) as any).id as number;
  const mk = (name: string, role: string) =>
    Number(app.db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, ?, ?, ?)").run(tenantId, name, role, String(Math.floor(1000 + Math.random() * 8999))).lastInsertRowid);
  const manager = mk("Mia", "manager");
  const accountant = mk("Adam", "accountant");
  const cashier = mk("Cara", "cashier");

  for (const userId of [manager, accountant]) {
    const g = await app.api("GET", "/api/cash-flow/categories", { tenantId, userId });
    assert.equal(g.status, 200, "GET is open to register users");
    assert.ok(g.body.custom.length > 0);
    const p = await app.api("POST", "/api/cash-flow/categories", { tenantId, userId, body: { name: "Nope", direction: "in" } });
    assert.equal(p.status, 403);
    assert.equal(p.body.code, "PERMISSION_DENIED");
    assert.equal(p.body.permission, "settings.manage");
    assert.equal((await app.api("PUT", `/api/cash-flow/categories/${idIn}`, { tenantId, userId, body: { active: false } })).status, 403);
  }
  // A cashier holds no cash-flow permission by default, so not even the read.
  assert.equal((await app.api("GET", "/api/cash-flow/categories", { tenantId, userId: cashier })).status, 403);
  // The admin PIN user may manage.
  const ok = await app.api("POST", "/api/cash-flow/categories", { tenantId, userId: admin, body: { name: "Admin made", direction: "out" } });
  assert.equal(ok.status, 200);
});
