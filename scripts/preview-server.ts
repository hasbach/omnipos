// Dev-only UI preview server: the real server/routes.ts + the Vite dev frontend, against a
// throwaway SQLite database seeded with realistic demo data. Auth is bypassed by a middleware
// that pins every request to the demo tenant, so no Supabase call (and no credential) is ever
// involved and the real pos.db is never touched. Not part of any build.
//
//   npm rebuild better-sqlite3   (Node ABI — restore with `npm run rebuild` afterwards)
//   npx tsx scripts/preview-server.ts   → http://localhost:3100
import express from "express";
import session from "express-session";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import { WebSocketServer } from "ws";
import { createServer as createVite } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PREVIEW_PORT || 3100);
// Online store: public addresses and photo thumbnails point at this server instead of the real storefront
// domain / Supabase bucket (read by server/commerce.ts).
process.env.STOREFRONT_PATH_BASE = `http://localhost:${PORT}/s/`;
process.env.STOREFRONT_IMAGE_BASE = `http://localhost:${PORT}/img/`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnipos-preview-"));
process.chdir(tmpDir);
const { db } = await import("../server/db.js");
const { setupRoutes } = await import("../server/routes.js");
process.chdir(root);

// ---- seed ----------------------------------------------------------------------------------
const tenantId = Number(db.prepare("INSERT INTO tenants (name, email, password) VALUES (?, ?, ?)")
  .run("Beirut Wholesale Market", "preview@omnipos.test", bcrypt.hashSync(Math.random().toString(36), 4)).lastInsertRowid);
db.prepare("UPDATE tenants SET local_license_type = 'lifetime', online_license_type = 'lifetime', local_license_expiry = '2099-12-31', online_license_expiry = '2099-12-31' WHERE id = ?").run(tenantId);
db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, 'Admin', 'admin', '0000')").run(tenantId);
db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, 'Rami', 'staff', '1111')").run(tenantId);
db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, 'Lina', 'cashier', '2222')").run(tenantId);
db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, 'USD', '$', 1, 1)").run(tenantId);
db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, 'LBP', 'LL', 89500, 0)").run(tenantId);
db.prepare("INSERT OR REPLACE INTO settings (tenant_id, key, value) VALUES (?, 'store_name', 'Beirut Wholesale Market')").run(tenantId);

const cats: Record<string, [string, number, number][]> = {
  Dairy: [["Whole Milk 1L", 1.1, 1.5], ["Labneh 500g", 2.2, 3.25], ["Halloumi 250g", 3.1, 4.5], ["Yogurt 1kg", 1.6, 2.4]],
  Bakery: [["Arabic Bread", 0.55, 0.9], ["Croissant 6pk", 2.4, 3.9], ["Kaak", 0.4, 0.75]],
  Pantry: [["Rice 5kg", 5.2, 7.5], ["Olive Oil 1L", 6.4, 9.9], ["Lentils 1kg", 1.3, 2.1], ["Sugar 2kg", 1.7, 2.6], ["Tahini 450g", 2.9, 4.4]],
  Beverages: [["Water 6x1.5L", 1.4, 2.2], ["Cola 2.25L", 1.2, 1.9], ["Orange Juice 1L", 1.5, 2.5], ["Coffee 500g", 7.8, 12]],
  Cleaning: [["Detergent 3kg", 5.5, 8.4], ["Dish Soap 1L", 1.1, 1.9], ["Bleach 2L", 0.9, 1.6]],
};
const insP = db.prepare(`INSERT INTO products (tenant_id, barcode, name, price, price_lbp, cost, stock, reorder_point, category, unit,
  price_wholesale, price_super_wholesale, package_price, units_per_package) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pcs', ?, ?, ?, ?)`);
const productIds: number[] = [];
let bc = 6221000000001;
for (const [cat, items] of Object.entries(cats)) {
  for (const [name, cost, price] of items) {
    const r = Math.round;
    const id = Number(insP.run(tenantId, String(bc++), name, price, r(price * 89500 / 5000) * 5000, cost,
      Math.floor(Math.random() * 120), 12, cat, +(price * 0.9).toFixed(2), +(price * 0.82).toFixed(2),
      +(price * 12 * 0.93).toFixed(2), 12).lastInsertRowid);
    productIds.push(id);
  }
}
db.prepare("UPDATE products SET stock = 3 WHERE id = ?").run(productIds[2]);
db.prepare("UPDATE products SET stock = 0 WHERE id = ?").run(productIds[9]);

const insS = db.prepare("INSERT INTO stakeholders (tenant_id, name, type, phone, address, price_level, credit_limit) VALUES (?, ?, ?, ?, ?, ?, ?)");
const walkIn = Number(insS.run(tenantId, "Walk-in Customer", "customer", null, null, "retail", null).lastInsertRowid);
const customers = [
  Number(insS.run(tenantId, "Mini Market Al Amal", "customer", "70 111 222", "Hamra, Beirut", "wholesale", 1500).lastInsertRowid),
  Number(insS.run(tenantId, "Supermarché Le Cèdre", "customer", "03 555 111", "Jounieh", "super_wholesale", 5000).lastInsertRowid),
  Number(insS.run(tenantId, "Nadim Haddad", "customer", "71 999 888", "Achrafieh", "retail", 300).lastInsertRowid),
];
const suppliers = [
  Number(insS.run(tenantId, "Dairy Farms Co.", "supplier", "01 444 555", "Bekaa", "retail", null).lastInsertRowid),
  Number(insS.run(tenantId, "Levant Foods Import", "supplier", "01 777 666", "Port of Beirut", "retail", null).lastInsertRowid),
]

// Online orders (003 Slice 2): a store in online mode with orders in every state, written straight into the
// local mirror tables (in production they arrive from the cloud by sync).
const tenantGid = (db.prepare("SELECT global_id FROM tenants WHERE id = ?").get(tenantId) as any).global_id as string;
const onlineStoreId = Number(db.prepare(`INSERT INTO stores (tenant_id, name, slug, mode, status, settings) VALUES (?, ?, ?, 'retail', 'active', ?)`)
  .run(tenantId, "Beirut Market", "beirut-market", JSON.stringify({ ordering_mode: "online", pickup_enabled: 1, pickup_note: "Back door after 4 pm",
    delivery_enabled: 1, delivery_note: "Hamra and Ras Beirut only", order_expiry_hours: 24 })).lastInsertRowid);
const onlineStoreGid = (db.prepare("SELECT global_id FROM stores WHERE id = ?").get(onlineStoreId) as any).global_id as string;
{
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();
  const insO = db.prepare(`INSERT INTO orders (global_id, tenant_id, store_id, number, state, reason, cancelled_by, customer_name, customer_phone,
    fulfilment, address, note, local_currency, local_rate, total_usd, total_local, confirmed_total_usd, confirmed_total_local, submitted_at, expires_at,
    confirmed_at, ready_at, closed_at) VALUES (@gid, ${tenantId}, ${onlineStoreId}, @number, @state, @reason, @by, @name, @phone, @fulfilment, @address, @note,
    'LBP', 89500, @total, @totalLocal, @confirmed, @confirmedLocal, @at, @expires, @confirmedAt, @readyAt, @closedAt)`);
  const insL = db.prepare(`INSERT INTO order_lines (global_id, tenant_id, order_id, line_no, product_id, product_name, unit_key, unit_name, unit_factor,
    ordered_qty, confirmed_qty, shortfall_reason, unit_price_usd, unit_price_local, line_total_usd, line_total_local)
    VALUES (?, ${tenantId}, ?, ?, ?, ?, 'base', 'pcs', 1, ?, ?, ?, ?, ?, ?, ?)`);
  const insE = db.prepare(`INSERT INTO order_events (global_id, tenant_id, order_id, at, kind, from_state, to_state, actor_kind, actor_name, terminal, reason)
    VALUES (?, ${tenantId}, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const product = (i: number) => db.prepare("SELECT id, name, price, price_lbp FROM products WHERE id = ?").get(productIds[i]) as any;
  const seedOrder = (o: any, lines: [number, number, number | null, string | null][]) => {
    const gid = crypto.randomUUID();
    let total = 0, totalLocal = 0, confirmed = 0, confirmedLocal = 0;
    const rows = lines.map(([i, qty, conf, reason]) => {
      const p = product(i);
      total += Math.round(p.price * qty * 100) / 100; totalLocal += p.price_lbp * qty;
      if (conf != null) { confirmed += Math.round(p.price * conf * 100) / 100; confirmedLocal += p.price_lbp * conf; }
      return { p, qty, conf, reason };
    });
    const id = Number(insO.run({ gid, by: null, reason: null, address: null, note: null, confirmedAt: null, readyAt: null, closedAt: null, ...o,
      total, totalLocal, confirmed: o.state === 'submitted' || o.state === 'expired' ? null : confirmed,
      confirmedLocal: o.state === 'submitted' || o.state === 'expired' ? null : confirmedLocal }).lastInsertRowid);
    rows.forEach((r, n) => insL.run(crypto.randomUUID(), id, n + 1, r.p.id, r.p.name, r.qty, r.conf, r.reason, r.p.price, r.p.price_lbp,
      Math.round(r.p.price * r.qty * 100) / 100, r.p.price_lbp * r.qty));
    insE.run(crypto.randomUUID(), id, o.at, 'submitted', null, 'submitted', 'customer', null, null, null);
    if (o.confirmedAt) insE.run(crypto.randomUUID(), id, o.confirmedAt, 'confirmed', 'submitted', 'confirmed', 'user', 'Admin', 'POS1', null);
  };
  seedOrder({ number: 1001, state: 'submitted', name: "Nadim Haddad", phone: "+96171999888", fulfilment: 'pickup', note: "Ring the bell twice",
    at: minutesAgo(4), expires: minutesAgo(-1436) }, [[2, 6, null, null], [11, 2, null, null]]);
  seedOrder({ number: 1002, state: 'submitted', name: "رانيا حداد", phone: "+9613123456", fulfilment: 'delivery', address: "Hamra, Bliss Street, 3rd floor",
    at: minutesAgo(20), expires: minutesAgo(-1420) }, [[0, 3, null, null], [5, 1, null, null], [14, 2, null, null]]);
  seedOrder({ number: 1003, state: 'confirmed', name: "Karim Saad", phone: "+96170123456", fulfilment: 'pickup', at: minutesAgo(90), expires: minutesAgo(1350),
    confirmedAt: minutesAgo(80) }, [[2, 6, 3, 'out_of_stock'], [7, 1, 1, null]]);
  seedOrder({ number: 1004, state: 'ready', name: "Maya Khoury", phone: "+96176543210", fulfilment: 'pickup', at: minutesAgo(200), expires: minutesAgo(1240),
    confirmedAt: minutesAgo(190), readyAt: minutesAgo(150) }, [[3, 4, 4, null]]);
  seedOrder({ number: 1005, state: 'submitted', name: "Late Customer", phone: "+96171000111", fulfilment: 'pickup', at: minutesAgo(1600),
    expires: minutesAgo(160) }, [[1, 1, null, null]]);
  seedOrder({ number: 1006, state: 'rejected', name: "Sami Aoun", phone: "+96178111222", fulfilment: 'delivery', address: "Jounieh", reason: "We don't deliver to Jounieh",
    at: minutesAgo(3000), expires: minutesAgo(1560), closedAt: minutesAgo(2990) }, [[4, 2, null, null]]);
}

const app = express();
// See server.ts: the import wizard needs a bigger body limit than the global default, mounted
// route-scoped and before the global parser (which no-ops once req._body is already set).
app.use('/api/import', express.json({ limit: '25mb' }));
app.use('/api/commerce', express.raw({ type: 'image/webp', limit: '3mb' }));
app.use(express.json());
app.use(session({ secret: "preview", resave: false, saveUninitialized: true }));
app.use((req: any, _res, next) => { req.session.tenantId = tenantId; req.session.tenantName = "Beirut Wholesale Market"; next(); });
const authenticate = (req: any, res: any, next: any) => (req.session.tenantId ? next() : res.status(401).json({ error: "Unauthorized" }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const { installPermissions } = await import("../server/permissions.js");
installPermissions(app, authenticate, () => {});
setupRoutes(app, wss, () => {}, authenticate);

// Online store: there is no cloud here, so claim store web addresses against this throwaway DB instead
// of the cloud claim_store_slug RPC (same "one live store per address" rule), and the store can be opened.
const { __setSlugClaimer } = await import("../server/commerce.js");
__setSlugClaimer(async (_tenantId, storeGlobalId, slug) => {
  const clash = db.prepare("SELECT 1 FROM stores WHERE lower(slug) = ? AND deleted_at IS NULL AND global_id <> ?").get(slug, storeGlobalId);
  return clash ? { ok: false, code: "taken" } : { ok: true, code: "ok" };
});

// Online orders: a fake cloud session whose order functions update the local mirror the way the cloud
// would (state machine only, no limits), so the Online orders page is "online" and its actions work here.
{
  const { makeFakeSupabase } = await import("../tests/helpers/fakeSupabase.js");
  const session = await import("../server/session.js");
  const fake = makeFakeSupabase();
  const cloudRows = (gid: string) => {
    const o = db.prepare("SELECT * FROM orders WHERE global_id = ?").get(gid) as any;
    const { id, last_synced_at, ...order } = o;
    const lines = (db.prepare("SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_no").all(id) as any[])
      .map(({ id: _id, last_synced_at: _s, ...l }) => ({ ...l, tenant_id: tenantGid, order_id: gid }));
    return { order: { ...order, tenant_id: tenantGid, store_id: onlineStoreGid }, lines };
  };
  const act = (to: string, from: string[], extra: (o: any, args: any) => void = () => {}) => (args: any) => {
    const o = db.prepare("SELECT * FROM orders WHERE global_id = ?").get(args.p_order) as any;
    if (!o) return { ok: false, code: 'not_found' };
    if (o.state !== args.p_expected_state) return { ok: false, code: 'handled', ...cloudRows(o.global_id) };
    if (!from.includes(o.state)) return { ok: false, code: 'invalid_transition', ...cloudRows(o.global_id) };
    extra(o, args);
    const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
    db.prepare("UPDATE orders SET state = ?, reason = coalesce(?, reason), cancelled_by = ?, updated_at = ? WHERE id = ?")
      .run(to, args.p_reason ?? null, to === 'cancelled' ? 'shop' : o.cancelled_by, stamp, o.id);
    return { ok: true, code: 'ok', ...cloudRows(o.global_id) };
  };
  fake.onRpc('order_accept', act('confirmed', ['submitted'], (o, args) => {
    for (const l of db.prepare("SELECT * FROM order_lines WHERE order_id = ?").all(o.id) as any[]) {
      const given = (args.p_lines || []).find((g: any) => g.line_no === l.line_no);
      db.prepare("UPDATE order_lines SET confirmed_qty = ?, shortfall_reason = ? WHERE id = ?")
        .run(given ? given.confirmed_qty : l.ordered_qty, given?.reason ?? null, l.id);
    }
  }));
  fake.onRpc('order_reject', act('rejected', ['submitted']));
  fake.onRpc('order_ready', act('ready', ['confirmed']));
  fake.onRpc('order_cancel_by_shop', act('cancelled', ['confirmed', 'ready']));
  // Completion from a POS sale: first sale id wins, the same id again is ok (idempotent), undo only for that id.
  fake.onRpc('order_complete', (args: any) => {
    const o = db.prepare("SELECT * FROM orders WHERE global_id = ?").get(args.p_order) as any;
    if (!o) return { ok: false, code: 'not_found' };
    if (o.state === 'completed' && o.sale_global_id === args.p_sale_global_id) return { ok: true, code: 'ok', ...cloudRows(o.global_id) };
    if (!['confirmed', 'ready'].includes(o.state)) return { ok: false, code: 'handled', ...cloudRows(o.global_id) };
    const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
    db.prepare("UPDATE orders SET state = 'completed', sale_global_id = ?, closed_at = ?, updated_at = ? WHERE id = ?")
      .run(args.p_sale_global_id, stamp, stamp, o.id);
    return { ok: true, code: 'ok', ...cloudRows(o.global_id) };
  });
  fake.onRpc('order_complete_undo', (args: any) => {
    const o = db.prepare("SELECT * FROM orders WHERE global_id = ?").get(args.p_order) as any;
    if (!o || o.state !== 'completed' || o.sale_global_id !== args.p_sale_global_id) return { ok: false, code: 'handled' };
    const back = o.ready_at ? 'ready' : 'confirmed';
    const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
    db.prepare("UPDATE orders SET state = ?, sale_global_id = NULL, closed_at = NULL, updated_at = ? WHERE id = ?").run(back, stamp, o.id);
    return { ok: true, code: 'ok', ...cloudRows(o.global_id) };
  });
  session.__setClientFactory(() => fake as any);
  await session.setActiveSession(tenantId, tenantGid, "preview@omnipos.test", { access_token: "preview", refresh_token: "preview" });
}

// Transactions through the REAL API so every total/stock/balance/cost rule applies, then backdated.
await new Promise<void>((r) => server.listen(PORT, r));
const call = async (method: string, url: string, body?: any) => {
  const res = await fetch(`http://localhost:${PORT}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
};
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
for (const sup of suppliers) {
  const items = productIds.slice(0, 10).map((id) => ({ id, quantity: 24 + Math.floor(Math.random() * 48), price: +(((db.prepare("SELECT cost FROM products WHERE id=?").get(id) as any).cost) * (0.95 + Math.random() * 0.1)).toFixed(2) }));
  const tx = await call("POST", "/api/transactions", { stakeholder_id: sup, type: "purchase", items, currency: "USD", exchange_rate: 1, reference: `INV-${1000 + sup}`, payments: [{ amount: 150, method: "cash", currency: "USD", exchange_rate: 1 }] });
  db.prepare("UPDATE transactions SET created_at = datetime('now', ?) WHERE id = ?").run(`-${40 + sup} days`, tx.id);
}
for (let day = 45; day >= 0; day--) {
  const n = 2 + Math.floor(Math.random() * 6);
  for (let k = 0; k < n; k++) {
    const cust = Math.random() < 0.55 ? walkIn : pick(customers);
    const items = Array.from({ length: 1 + Math.floor(Math.random() * 4) }, () => ({ id: pick(productIds), quantity: 1 + Math.floor(Math.random() * (cust === walkIn ? 3 : 20)) }));
    const uniq = Object.values(Object.fromEntries(items.map((i) => [i.id, i])));
    const credit = cust !== walkIn && Math.random() < 0.4;
    const payments = credit ? [] : [Math.random() < 0.3
      ? { amount: 5000000, method: "cash", currency: "LBP", exchange_rate: 89500 }
      : { amount: 400, method: Math.random() < 0.2 ? "card" : "cash", currency: "USD", exchange_rate: 1 }];
    const tx = await call("POST", "/api/transactions", { stakeholder_id: cust, type: "sale", items: uniq, currency: "USD", exchange_rate: 1, payments,
      discount: Math.random() < 0.15 ? { type: "percentage", value: 5 } : undefined });
    if (!tx.id) continue;
    // Cap cash payment at the invoice total so demo payments look real.
    const t = db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(tx.id) as any;
    db.prepare("UPDATE payments SET amount = MIN(amount, ? * exchange_rate) WHERE transaction_id = ?").run(t.total_amount, tx.id);
    const at = `-${day} days`;
    db.prepare("UPDATE transactions SET created_at = datetime('now', ?, ?) WHERE id = ?").run(at, `-${Math.floor(Math.random() * 8)} hours`, tx.id);
    db.prepare("UPDATE payments SET created_at = (SELECT created_at FROM transactions WHERE id = ?) WHERE transaction_id = ?").run(tx.id, tx.id);
  }
  if (day === 10) await call("POST", "/api/tenant/settlement");
}
const { recomputeAllBalances } = await import("../server/balance.js");
recomputeAllBalances(tenantId);
await call("POST", "/api/cash-flow", { type: "out", amount: 45, currency: "USD", exchange_rate: 1, reason: "Generator fuel" });

// Storefront (feature 002) on the demo data: http://localhost:3100/s/<store address>. Same handler as production,
// fed from the local database instead of the cloud public catalog (scripts/preview-storefront.ts).
{
  const { handle } = await import("../storefront/src/http.js");
  const { loadConfig } = await import("../storefront/src/config.js");
  const { ASSET_VERSION } = await import("../storefront/src/assets.js");
  const { LocalDbSource } = await import("./preview-storefront.js");
  const sfConfig = loadConfig();
  // No cloud here: photos go to a local folder, preview tokens live in memory (30 minutes, like the cloud).
  const { __setCommerceCloud } = await import("../server/commerce.js");
  const crypto = await import("crypto");
  const imgDir = path.join(tmpDir, "store-images");
  const previewTokens = new Map<string, { store: string; until: number }>();
  __setCommerceCloud({
    upload: async (_t, p, bytes) => { fs.mkdirSync(path.dirname(path.join(imgDir, p)), { recursive: true }); fs.writeFileSync(path.join(imgDir, p), bytes); return { ok: true, value: null }; },
    remove: async (_t, paths) => { for (const p of paths) fs.rmSync(path.join(imgDir, p), { force: true }); return { ok: true, value: null }; },
    previewToken: async (_t, store) => { const token = crypto.randomBytes(32).toString("base64url"); previewTokens.set(token, { store, until: Date.now() + 30 * 60 * 1000 }); return { ok: true, value: token }; },
  });
  const sfData = new LocalDbSource(db, tenantId, (store, token) => { const p = previewTokens.get(token); return !!p && p.store === store && p.until > Date.now(); });
  const { IMG_PATH } = await import("../storefront/src/img.js");
  const assets: Record<string, string> = { "/storefront.css": "text/css; charset=utf-8", "/storefront.js": "text/javascript; charset=utf-8", "/placeholder.svg": "image/svg+xml", "/cart.js": "text/javascript; charset=utf-8", "/checkout.js": "text/javascript; charset=utf-8", "/order.js": "text/javascript; charset=utf-8" };
  app.use(async (req: any, res: any, next: any) => {
    if (assets[req.path]) {
      res.type(assets[req.path]).set("Cache-Control", "no-cache").send(fs.readFileSync(path.join(root, "storefront", "public", req.path.slice(1))));
      return;
    }
    if (req.path.startsWith("/img/")) {
      const p = decodeURIComponent(req.path.slice(5));
      const file = path.join(imgDir, p);
      if (!IMG_PATH.test(p) || !fs.existsSync(file)) { res.status(404).send("Not found"); return; }
      res.type("image/webp").set("Cache-Control", "no-cache").send(fs.readFileSync(file));
      return;
    }
    if (!req.path.startsWith("/s/")) return next();
    try {
      const out = await handle({ host: String(req.headers.host || ""), url: req.originalUrl }, { config: sfConfig, data: sfData, assetVersion: ASSET_VERSION });
      res.status(out.status).set(out.headers).send(typeof out.body === "string" ? out.body : Buffer.from(out.body));
    } catch (e) { next(e); }
  });
}

const vite = await createVite({ root, server: { middlewareMode: true, hmr: { port: PORT + 1 } }, appType: "spa" });
app.use(vite.middlewares);
console.log(`Preview ready on http://localhost:${PORT} (data in ${tmpDir})`);
