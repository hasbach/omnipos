// Commerce foundation, Slice A — US5 stores (specs/001-commerce-domain-foundation,
// contracts/backoffice-api.md): CRUD, field rules, the cloud slug claim, status transitions, audit.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
// Imported AFTER createTestApp so server/db.js is the test database, not the repo's pos.db.
let commerce: typeof import("../server/commerce.js");
let n = 0;

before(async () => {
  app = await createTestApp();
  commerce = await import("../server/commerce.js");
});
afterEach(() => commerce.__setSlugClaimer());
after(async () => { await app.close(); });

function setup(enabled = true) {
  n++;
  const tenantId = seedTenant(app.db, `Store Shop ${n}`, `store${n}-${Date.now()}@example.com`);
  const admin = (app.db.prepare("SELECT id FROM users WHERE tenant_id = ? AND role = 'admin'").get(tenantId) as any).id as number;
  if (enabled) app.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'commerce_enabled', '1')").run(tenantId);
  const as = { tenantId, userId: admin };
  return { tenantId, admin, as };
}

const okClaimer = async () => ({ ok: true, code: "ok" });

async function newStore(as: any, body: any = { name: "ABC Market" }) {
  const r = await app.api("POST", "/api/commerce/stores", { ...as, body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

test("create: draft, no slug, default settings; listed; audited", async () => {
  const s = setup();
  const store = await newStore(s.as, { name: "  ABC Market  ", mode: "wholesale" });
  assert.equal(store.name, "ABC Market");
  assert.equal(store.status, "draft");
  assert.equal(store.slug, null);
  assert.equal(store.public_url, null);
  assert.equal(store.mode, "wholesale");
  assert.deepEqual(store.settings, { show_exact_stock: 0, hide_out_of_stock: 0, show_local_price: 1, category_order: [] });
  assert.equal(store.tenant_id, undefined, "local tenant id is not exposed");
  assert.ok(store.global_id);

  const list = await app.api("GET", "/api/commerce/stores", s.as);
  assert.deepEqual(list.body.map((x: any) => x.id), [store.id]);
  const status = await app.api("GET", "/api/commerce/status", s.as);
  assert.equal(status.body.store.id, store.id);

  const log = app.db.prepare("SELECT details FROM user_logs WHERE tenant_id = ? AND action = 'store_create'").get(s.tenantId) as any;
  assert.equal(JSON.parse(log.details).after.name, "ABC Market");
});

test("writes need commerce on (COMMERCE_OFF), reads still work", async () => {
  const s = setup(false);
  const r = await app.api("POST", "/api/commerce/stores", { ...s.as, body: { name: "X" } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "COMMERCE_OFF");
  assert.equal((await app.api("GET", "/api/commerce/stores", s.as)).status, 200);
});

test("field rules: name, mode, lengths, colour, email, language, settings", async () => {
  const s = setup();
  const bad = async (body: any, code: string, field: string) => {
    const r = await app.api("POST", "/api/commerce/stores", { ...s.as, body: { name: "Shop", ...body } });
    assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, code, JSON.stringify(body));
    assert.equal(r.body.field, field, JSON.stringify(body));
  };
  await bad({ name: "   " }, "STORE_NAME_INVALID", "name");
  await bad({ name: "x".repeat(81) }, "STORE_NAME_INVALID", "name");
  await bad({ mode: "b2b" }, "STORE_MODE_INVALID", "mode");
  await bad({ description: "d".repeat(1001) }, "STORE_FIELD_TOO_LONG", "description");
  await bad({ contact_phone: "1".repeat(31) }, "STORE_FIELD_TOO_LONG", "contact_phone");
  await bad({ contact_whatsapp: "1".repeat(31) }, "STORE_FIELD_TOO_LONG", "contact_whatsapp");
  await bad({ address: "a".repeat(301) }, "STORE_FIELD_TOO_LONG", "address");
  await bad({ primary_color: "red" }, "STORE_COLOR_INVALID", "primary_color");
  await bad({ contact_email: "not-an-email" }, "STORE_EMAIL_INVALID", "contact_email");
  await bad({ default_language: "de" }, "STORE_LANGUAGE_INVALID", "default_language");
  await bad({ settings: { unknown_key: 1 } }, "STORE_SETTINGS_INVALID", "settings.unknown_key");
  await bad({ settings: { show_exact_stock: "yes" } }, "STORE_SETTINGS_INVALID", "settings.show_exact_stock");
  await bad({ settings: { category_order: "Drinks" } }, "STORE_SETTINGS_INVALID", "settings.category_order");

  const ok = await newStore(s.as, {
    name: "Shop", description: "d".repeat(1000), contact_phone: "+961 1 234 567", primary_color: "#1A2B3C",
    contact_email: "shop@example.com", default_language: "ar", settings: { show_exact_stock: true, category_order: [" Drinks "] },
  });
  assert.equal(ok.primary_color, "#1a2b3c");
  assert.equal(ok.default_language, "ar");
  assert.equal(ok.settings.show_exact_stock, 1);
  assert.deepEqual(ok.settings.category_order, ["Drinks"]);
});

test("update: partial, settings merge, slug/status ignored, audited with only the changed fields", async () => {
  const s = setup();
  const store = await newStore(s.as, { name: "Shop", settings: { hide_out_of_stock: 1 } });
  const r = await app.api("PUT", `/api/commerce/stores/${store.id}`, {
    ...s.as, body: { description: "Fresh fruit", settings: { show_exact_stock: 1 }, slug: "sneaky", status: "active" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.name, "Shop");
  assert.equal(r.body.description, "Fresh fruit");
  assert.equal(r.body.slug, null);
  assert.equal(r.body.status, "draft");
  assert.equal(r.body.settings.hide_out_of_stock, 1, "earlier setting kept");
  assert.equal(r.body.settings.show_exact_stock, 1);
  const log = app.db.prepare("SELECT details FROM user_logs WHERE tenant_id = ? AND action = 'store_update'").get(s.tenantId) as any;
  const d = JSON.parse(log.details);
  assert.equal(d.after.description, "Fresh fruit");
  assert.equal(d.after.name, undefined, "unchanged fields are not logged");
});

test("slug: format and reserved checked locally before any cloud call", async () => {
  const s = setup();
  const store = await newStore(s.as);
  let calls = 0;
  commerce.__setSlugClaimer(async () => { calls++; return { ok: true, code: "ok" }; });
  for (const slug of ["ab", "x".repeat(41), "-abc", "abc-", "ab--cd", "ab_cd", "café"]) {
    const r = await app.api("POST", `/api/commerce/stores/${store.id}/slug`, { ...s.as, body: { slug } });
    assert.equal(r.body.code, "STORE_SLUG_INVALID", slug);
    assert.equal(r.body.field, "slug");
  }
  const reserved = await app.api("POST", `/api/commerce/stores/${store.id}/slug`, { ...s.as, body: { slug: "Admin" } });
  assert.equal(reserved.body.code, "STORE_SLUG_RESERVED");
  assert.equal(calls, 0);
});

test("slug: offline => STORE_SLUG_NEEDS_ONLINE and nothing saved; taken => STORE_SLUG_TAKEN; ok => saved lowercase + audited", async () => {
  const s = setup();
  const store = await newStore(s.as);
  // Default claimer, no cloud session in tests: offline.
  const offline = await app.api("POST", `/api/commerce/stores/${store.id}/slug`, { ...s.as, body: { slug: "abc-market" } });
  assert.equal(offline.status, 503);
  assert.equal(offline.body.code, "STORE_SLUG_NEEDS_ONLINE");
  assert.equal((app.db.prepare("SELECT slug FROM stores WHERE id = ?").get(store.id) as any).slug, null);

  commerce.__setSlugClaimer(async () => ({ ok: false, code: "taken" }));
  const taken = await app.api("POST", `/api/commerce/stores/${store.id}/slug`, { ...s.as, body: { slug: "abc-market" } });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.code, "STORE_SLUG_TAKEN");

  let seen: any = null;
  commerce.__setSlugClaimer(async (tenantId, gid, slug) => { seen = { tenantId, gid, slug }; return { ok: true, code: "ok" }; });
  const ok = await app.api("POST", `/api/commerce/stores/${store.id}/slug`, { ...s.as, body: { slug: " ABC-Market " } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.slug, "abc-market");
  assert.equal(ok.body.public_url, "/s/abc-market");
  assert.deepEqual(seen, { tenantId: s.tenantId, gid: store.global_id, slug: "abc-market" });
  const log = app.db.prepare("SELECT details FROM user_logs WHERE tenant_id = ? AND action = 'store_slug_change'").get(s.tenantId) as any;
  assert.deepEqual(JSON.parse(log.details).after, { slug: "abc-market" });
});

test("status: active needs a slug; draft -> active <-> paused; paused -> draft refused", async () => {
  const s = setup();
  const store = await newStore(s.as);
  const status = (v: string) => app.api("POST", `/api/commerce/stores/${store.id}/status`, { ...s.as, body: { status: v } });

  const notReady = await status("active");
  assert.equal(notReady.status, 409);
  assert.equal(notReady.body.code, "STORE_NOT_READY");
  assert.equal((await status("paused")).body.code, "STORE_BAD_TRANSITION");

  commerce.__setSlugClaimer(okClaimer);
  await app.api("POST", `/api/commerce/stores/${store.id}/slug`, { ...s.as, body: { slug: `shop-${n}` } });
  assert.equal((await status("active")).body.status, "active");
  assert.equal((await status("paused")).body.status, "paused");
  assert.equal((await status("draft")).body.code, "STORE_BAD_TRANSITION");
  assert.equal((await status("active")).body.status, "active");
  const logs = app.db.prepare("SELECT COUNT(*) c FROM user_logs WHERE tenant_id = ? AND action = 'store_status_change'").get(s.tenantId) as any;
  assert.equal(logs.c, 3);
});

test("delete: soft-deletes the store and its listings; gone from list and status", async () => {
  const s = setup();
  const store = await newStore(s.as);
  const pid = Number(app.db.prepare("INSERT INTO products (tenant_id, name, price, stock) VALUES (?, 'Tea', 2, 5)").run(s.tenantId).lastInsertRowid);
  await app.api("PUT", `/api/commerce/stores/${store.id}/listings/${pid}`, { ...s.as, body: { published: true } });
  const del = await app.api("DELETE", `/api/commerce/stores/${store.id}`, s.as);
  assert.equal(del.status, 200);
  assert.ok((app.db.prepare("SELECT deleted_at FROM stores WHERE id = ?").get(store.id) as any).deleted_at);
  assert.ok((app.db.prepare("SELECT deleted_at FROM store_listings WHERE store_id = ?").get(store.id) as any).deleted_at);
  assert.deepEqual((await app.api("GET", "/api/commerce/stores", s.as)).body, []);
  assert.equal((await app.api("GET", "/api/commerce/status", s.as)).body.store, null);
  assert.equal((await app.api("PUT", `/api/commerce/stores/${store.id}`, { ...s.as, body: { name: "Y" } })).body.code, "STORE_NOT_FOUND");
});

test("permissions: a cashier cannot create stores; every store route has a rule", async () => {
  const s = setup();
  const cashier = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, 'Cara', 'cashier', '5555')").run(s.tenantId).lastInsertRowid);
  const r = await app.api("POST", "/api/commerce/stores", { tenantId: s.tenantId, userId: cashier, body: { name: "X" } });
  assert.equal(r.status, 403);
  const { findRule } = await import("../server/permissions.js");
  const routes: [string, string, string][] = [
    ["GET", "/api/commerce/stores", "store.view"],
    ["POST", "/api/commerce/stores", "store.manage"],
    ["PUT", "/api/commerce/stores/1", "store.manage"],
    ["POST", "/api/commerce/stores/1/slug", "store.manage"],
    ["POST", "/api/commerce/stores/1/status", "store.manage"],
    ["DELETE", "/api/commerce/stores/1", "store.manage"],
    ["GET", "/api/commerce/stores/1/listings", "store.view"],
    ["GET", "/api/commerce/products/1/listings", "store.view"],
    ["PUT", "/api/commerce/stores/1/listings/2", "store.publish"],
    ["POST", "/api/commerce/stores/1/listings/bulk", "store.publish"],
    ["DELETE", "/api/commerce/stores/1/listings/2", "store.publish"],
  ];
  for (const [m, u, need] of routes) assert.equal(findRule(m, u)?.need, need, `${m} ${u}`);
});
