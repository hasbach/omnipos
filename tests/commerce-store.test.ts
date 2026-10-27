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

test("order expiry defaults for new and legacy stores and validates integer bounds", async () => {
  const s = setup();
  const store = await newStore(s.as);
  assert.equal(store.settings.order_expiry_hours, 24);
  const legacyId = Number(app.db.prepare(
    "INSERT INTO stores (tenant_id, name, settings) VALUES (?, 'Legacy', ?)"
  ).run(s.tenantId, JSON.stringify({ ordering_mode: 'off' })).lastInsertRowid);
  const listed = await app.api("GET", "/api/commerce/stores", s.as);
  assert.equal(listed.body.find((row: any) => row.id === legacyId).settings.order_expiry_hours, 24);

  for (const hours of [1, 72]) {
    const r = await app.api("PUT", `/api/commerce/stores/${store.id}`, {
      ...s.as, body: { settings: { order_expiry_hours: hours } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.settings.order_expiry_hours, hours);
  }
  for (const hours of [0, 73, 1.5, '12', null]) {
    for (const method of ['POST', 'PUT']) {
      const r = await app.api(method, method === 'POST' ? '/api/commerce/stores' : `/api/commerce/stores/${store.id}`, {
        ...s.as, body: { name: 'Shop', settings: { order_expiry_hours: hours } },
      });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.code, 'STORE_ORDER_EXPIRY_INVALID');
      assert.equal(r.body.field, 'settings.order_expiry_hours');
    }
  }
});

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
  assert.deepEqual(store.settings, {
    show_exact_stock: 0, hide_out_of_stock: 0, show_local_price: 1, category_order: [],
    // 003 ordering settings: off by default.
    order_expiry_hours: 24,
    ordering_mode: "off", pickup_enabled: 1, pickup_note: "", delivery_enabled: 0, delivery_note: "", min_order_usd: null,
  });
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
  await bad({ contact_whatsapp: "12345" }, "STORE_WHATSAPP_INVALID", "contact_whatsapp");
  await bad({ default_language: "de" }, "STORE_LANGUAGE_INVALID", "default_language");
  await bad({ settings: { unknown_key: 1 } }, "STORE_SETTINGS_INVALID", "settings.unknown_key");
  await bad({ settings: { show_exact_stock: "yes" } }, "STORE_SETTINGS_INVALID", "settings.show_exact_stock");
  await bad({ settings: { category_order: "Drinks" } }, "STORE_SETTINGS_INVALID", "settings.category_order");

  const ok = await newStore(s.as, {
    name: "Shop", description: "d".repeat(1000), contact_phone: "+961 1 234 567", contact_whatsapp: "071 315 744", primary_color: "#1A2B3C",
    contact_email: "shop@example.com", default_language: "ar", settings: { show_exact_stock: true, category_order: [" Drinks "] },
  });
  assert.equal(ok.contact_whatsapp, "+96171315744", "local numbers are saved as Lebanese international");
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
  assert.equal(ok.body.public_url, "https://abc-market.myomnipos.com/");
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

test("reserved addresses: the back office, the storefront and the cloud claim use the same list", async () => {
  const fs = await import("fs");
  const path = await import("path");
  const sql = fs.readFileSync(path.join(process.cwd(), "supabase", "migrations", "2026-10-19_storefront.sql"), "utf8");
  const m = sql.match(/v_slug = ANY \(ARRAY\[([^\]]+)\]\)/);
  assert.ok(m, "reserved array found in claim_store_slug");
  const cloud = m![1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")).sort();
  assert.deepEqual(cloud, [...commerce.RESERVED_SLUGS].sort());
  const s = setup();
  const store = await newStore(s.as);
  for (const slug of ["mail", "cdn", "dashboard", "demo"]) {
    const r = await app.api("POST", `/api/commerce/stores/${store.id}/slug`, { ...s.as, body: { slug } });
    assert.equal(r.body.code, "STORE_SLUG_RESERVED", slug);
  }
});

test("wholesale stores can't be opened to the public; hybrid stores can", async () => {
  const s = setup();
  commerce.__setSlugClaimer(okClaimer);
  const ws = await newStore(s.as, { name: "Meat Wholesale", mode: "wholesale" });
  await app.api("POST", `/api/commerce/stores/${ws.id}/slug`, { ...s.as, body: { slug: `meat-${n}` } });
  const refused = await app.api("POST", `/api/commerce/stores/${ws.id}/status`, { ...s.as, body: { status: "active" } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "STORE_MODE_NOT_PUBLIC");
  assert.equal(refused.body.field, "mode");
  assert.equal((app.db.prepare("SELECT status FROM stores WHERE id = ?").get(ws.id) as any).status, "draft");

  const t = setup();
  const hy = await newStore(t.as, { name: "Hybrid", mode: "hybrid" });
  await app.api("POST", `/api/commerce/stores/${hy.id}/slug`, { ...t.as, body: { slug: `hybrid-${n}` } });
  assert.equal((await app.api("POST", `/api/commerce/stores/${hy.id}/status`, { ...t.as, body: { status: "active" } })).body.status, "active");
});

test("status explains why a store is not public: commerce off, license, draft, paused, wholesale", async () => {
  const s = setup();
  commerce.__setSlugClaimer(okClaimer);
  const store = await newStore(s.as);
  const reason = async () => (await app.api("GET", "/api/commerce/status", s.as)).body.store;

  let st = await reason();
  assert.equal(st.publicly_visible, false);
  assert.equal(st.not_public_reason, "license", "seeded tenants have no online license");
  app.db.prepare("UPDATE tenants SET online_license_type = 'lifetime' WHERE id = ?").run(s.tenantId);
  assert.equal((await reason()).not_public_reason, "draft");

  await app.api("POST", `/api/commerce/stores/${store.id}/slug`, { ...s.as, body: { slug: `reason-${n}` } });
  await app.api("POST", `/api/commerce/stores/${store.id}/status`, { ...s.as, body: { status: "active" } });
  st = await reason();
  assert.equal(st.publicly_visible, true);
  assert.equal(st.not_public_reason, null);

  // Switching an open store to wholesale keeps it "active" but takes it off the public storefront.
  await app.api("PUT", `/api/commerce/stores/${store.id}`, { ...s.as, body: { mode: "wholesale" } });
  st = await reason();
  assert.equal(st.status, "active");
  assert.equal(st.publicly_visible, false);
  assert.equal(st.not_public_reason, "wholesale");
  await app.api("PUT", `/api/commerce/stores/${store.id}`, { ...s.as, body: { mode: "retail" } });

  await app.api("POST", `/api/commerce/stores/${store.id}/status`, { ...s.as, body: { status: "paused" } });
  assert.equal((await reason()).not_public_reason, "paused");
  app.db.prepare("UPDATE settings SET value = '0' WHERE tenant_id = ? AND key = 'commerce_enabled'").run(s.tenantId);
  assert.equal((await reason()).not_public_reason, "commerce_off");
});

// ---- 003 Slice 1: ordering settings (specs/003-retail-ordering/contracts/backoffice-api.md) -------------

test("003 ordering settings: defaults keep ordering off; stores created before 003 get the defaults too", async () => {
  const s = setup();
  const store = await newStore(s.as);
  assert.deepEqual(
    [store.settings.ordering_mode, store.settings.pickup_enabled, store.settings.pickup_note, store.settings.delivery_enabled, store.settings.delivery_note, store.settings.min_order_usd],
    ["off", 1, "", 0, "", null],
  );
  // A store row written before 003 (settings without the new keys).
  app.db.prepare("UPDATE stores SET settings = ? WHERE id = ?").run(JSON.stringify({ show_exact_stock: 1 }), store.id);
  const listed = (await app.api("GET", "/api/commerce/stores", s.as)).body.find((x: any) => x.id === store.id);
  assert.equal(listed.settings.ordering_mode, "off");
  assert.equal(listed.settings.show_exact_stock, 1);
});

test("003 ordering settings: WhatsApp mode needs a WhatsApp number and a way to receive the goods", async () => {
  const s = setup();
  const store = await newStore(s.as);
  const put = (body: any) => app.api("PUT", `/api/commerce/stores/${store.id}`, { ...s.as, body });

  let r = await put({ settings: { ordering_mode: "whatsapp" } });
  assert.equal(r.status, 400);
  assert.deepEqual([r.body.code, r.body.field], ["STORE_ORDERING_NEEDS_WHATSAPP", "contact_whatsapp"]);

  r = await put({ contact_whatsapp: "71 315 744", settings: { ordering_mode: "whatsapp", pickup_enabled: false, delivery_enabled: false } });
  assert.deepEqual([r.body.code, r.body.field], ["STORE_ORDERING_NEEDS_FULFILMENT", "settings.pickup_enabled"]);

  r = await put({
    contact_whatsapp: "71 315 744",
    settings: { ordering_mode: "whatsapp", pickup_note: "  Back door after 4 pm ", delivery_enabled: true, delivery_note: "Hamra only", min_order_usd: 10.5 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(
    [r.body.settings.ordering_mode, r.body.settings.pickup_enabled, r.body.settings.pickup_note, r.body.settings.delivery_enabled, r.body.settings.delivery_note, r.body.settings.min_order_usd],
    ["whatsapp", 1, "Back door after 4 pm", 1, "Hamra only", 10.5],
  );

  // Clearing or breaking the number while WhatsApp ordering is on is refused; nothing saved.
  for (const wa of ["", "12345"]) {
    const bad = await put({ contact_whatsapp: wa });
    assert.equal(bad.status, 400, wa);
  }
  assert.equal((await put({ contact_whatsapp: "" })).body.code, "STORE_ORDERING_NEEDS_WHATSAPP");
  const still = (await app.api("GET", "/api/commerce/stores", s.as)).body.find((x: any) => x.id === store.id);
  assert.equal(still.contact_whatsapp, "+96171315744");
  // Turning ordering off first makes the number optional again.
  assert.equal((await put({ settings: { ordering_mode: "off" } })).status, 200);
  assert.equal((await put({ contact_whatsapp: "" })).status, 200);
});

test("003 ordering settings: online orders; field rules for notes and the minimum", async () => {
  const s = setup();
  const store = await newStore(s.as, { name: "Shop", contact_whatsapp: "70 123 456" });
  const put = (settings: any) => app.api("PUT", `/api/commerce/stores/${store.id}`, { ...s.as, body: { settings } });
  const bad = async (settings: any, code: string, field: string) => {
    const r = await put(settings);
    assert.equal(r.status, 400, JSON.stringify(settings));
    assert.deepEqual([r.body.code, r.body.field], [code, field], JSON.stringify(settings));
  };
  assert.equal((await put({ ordering_mode: "online" })).status, 200);
  assert.equal((await app.api("PUT", `/api/commerce/stores/${store.id}`, { ...s.as, body: { contact_whatsapp: "" } })).status, 200);
  await bad({ pickup_enabled: false, delivery_enabled: false }, "STORE_ORDERING_NEEDS_FULFILMENT", "settings.pickup_enabled");
  await bad({ ordering_mode: "shop" }, "STORE_SETTINGS_INVALID", "settings.ordering_mode");
  await bad({ pickup_enabled: "yes" }, "STORE_SETTINGS_INVALID", "settings.pickup_enabled");
  await bad({ pickup_note: "x".repeat(201) }, "STORE_SETTINGS_INVALID", "settings.pickup_note");
  await bad({ delivery_note: 5 }, "STORE_SETTINGS_INVALID", "settings.delivery_note");
  await bad({ min_order_usd: -1 }, "STORE_SETTINGS_INVALID", "settings.min_order_usd");
  await bad({ min_order_usd: 100001 }, "STORE_SETTINGS_INVALID", "settings.min_order_usd");
  await bad({ min_order_usd: 1.234 }, "STORE_SETTINGS_INVALID", "settings.min_order_usd");
  await bad({ min_order_usd: "ten" }, "STORE_SETTINGS_INVALID", "settings.min_order_usd");
  assert.equal((await put({ min_order_usd: 0 })).body.settings.min_order_usd, null, "0 means no minimum");
  assert.equal((await put({ min_order_usd: null })).body.settings.min_order_usd, null);
  assert.equal((await put({ min_order_usd: 25 })).body.settings.min_order_usd, 25);
});

test("003 ordering settings: another tenant can't change them", async () => {
  const a = setup();
  const b = setup();
  const store = await newStore(a.as, { name: "Shop", contact_whatsapp: "70 123 456" });
  const r = await app.api("PUT", `/api/commerce/stores/${store.id}`, { ...b.as, body: { settings: { ordering_mode: "whatsapp" } } });
  assert.equal(r.status, 404);
  const mine = (await app.api("GET", "/api/commerce/stores", a.as)).body.find((x: any) => x.id === store.id);
  assert.equal(mine.settings.ordering_mode, "off");
});
