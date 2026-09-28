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

const app = express();
app.use(express.json());
app.use(session({ secret: "preview", resave: false, saveUninitialized: true }));
app.use((req: any, _res, next) => { req.session.tenantId = tenantId; req.session.tenantName = "Beirut Wholesale Market"; next(); });
const authenticate = (req: any, res: any, next: any) => (req.session.tenantId ? next() : res.status(401).json({ error: "Unauthorized" }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
setupRoutes(app, wss, () => {}, authenticate);

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

const vite = await createVite({ root, server: { middlewareMode: true, hmr: { port: PORT + 1 } }, appType: "spa" });
app.use(vite.middlewares);
console.log(`Preview ready on http://localhost:${PORT} (data in ${tmpDir})`);
