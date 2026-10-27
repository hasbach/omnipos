// Cloud SQL for online orders (003 Slice 2), run on PGlite against stub Supabase tables:
// supabase/migrations 2026-10-18 → 2026-10-19 → 2026-10-19b → 2026-10-21 → 2026-10-23_retail_ordering_s2.sql, each twice.
// Guards what no desktop test can reach: the gateway key, server-side re-pricing (SC-004), idempotency (SC-008),
// abuse limits (SC-009), the state machine and first-action-wins (SC-006), expiry, the public view's privacy,
// tenant isolation, grants, and that order functions never touch money tables (FR-038).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = ["2026-10-18_commerce_store_foundation.sql", "2026-10-19_storefront.sql", "2026-10-19b_storefront_storage.sql",
  "2026-10-21_retail_ordering_s1.sql", "2026-10-23_retail_ordering_s2.sql"]
  .map((f) => fs.readFileSync(path.join(root, "supabase", "migrations", f), "utf8"));
const CHECKS = fs.readFileSync(path.join(root, "supabase", "checks", "2026-10-23_retail_ordering_s2_checks.sql"), "utf8");

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const SA = "cccccccc-0000-4000-8000-000000000003"; // A, retail, online orders
const SW = "dddddddd-0000-4000-8000-000000000004"; // A, retail, WhatsApp mode
const SB = "eeeeeeee-0000-4000-8000-000000000005"; // B, retail, online orders
const P1 = "10000000-0000-4000-8000-000000000001"; // Cola 1.50, stock 10
const P2 = "10000000-0000-4000-8000-000000000002"; // Tea 2.00, stock 0
const P3 = "10000000-0000-4000-8000-000000000003"; // Rice per kg 1.20
const P4 = "10000000-0000-4000-8000-000000000004"; // Water, pack only, own LBP price
const U1 = "30000000-0000-4000-8000-000000000001"; // Cola pack of 6, 8.00
const U4 = "30000000-0000-4000-8000-000000000004"; // Water pack of 6, 3.00 / 250 000 LBP
const L1 = "20000000-0000-4000-8000-000000000001";
const L2 = "20000000-0000-4000-8000-000000000002";
const L3 = "20000000-0000-4000-8000-000000000003";
const L4 = "20000000-0000-4000-8000-000000000004";
const LB = "20000000-0000-4000-8000-000000000005"; // B's listing of its own product
const PB = "10000000-0000-4000-8000-000000000005";
const KEY = "k".repeat(43);
const NET = "a".repeat(64);
const ONLINE = JSON.stringify({ ordering_mode: "online", pickup_enabled: 1, delivery_enabled: 1, order_expiry_hours: 12 });

let db: PGlite;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function asRole(role: "anon" | "authenticated", uid: string | null, q: string, params: any[] = []) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub', '${uid ?? ""}', false)`);
  try { return (await db.query(q, params)).rows as any[]; }
  finally { await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false)"); }
}
const anon = (q: string, params: any[] = []) => asRole("anon", null, q, params);
const user = (uid: string, q: string, params: any[] = []) => asRole("authenticated", uid, q, params);
const one = async (q: string, params: any[] = []) => ((await db.query(q, params)).rows as any[])[0];
const canExec = async (role: string, fn: string) =>
  ((await db.query(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE') AS ok`)).rows[0] as any).ok;

let seq = 0;
const statusKey = () => `s${String(++seq).padStart(31, "0")}`;
const attempt = () => `att-${++seq}-0000`;

type Line = { listing: string; unit: string; qty: number; price?: number };
async function quote(slug: string, lines: Line[], key = KEY) {
  return (await anon("SELECT order_quote($1, $2, $3::jsonb) AS r", [key, slug, JSON.stringify(lines)]))[0].r;
}
async function submit(opts: Partial<{ slug: string; key: string; attempt: string; status: string; network: string; customer: any;
  lines: Line[]; total: number | null; trap: string }> = {}) {
  const lines = opts.lines ?? [{ listing: L1, unit: "base", qty: 2, price: 1.5 }];
  const q = await quote(opts.slug ?? "shop-a", lines);
  const total = opts.total === undefined ? Number(q.quote?.total_usd ?? 0) : opts.total;
  const r = (await anon("SELECT order_submit($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9) AS r", [
    opts.key ?? KEY, opts.slug ?? "shop-a", opts.attempt ?? attempt(), opts.status ?? statusKey(), opts.network ?? NET,
    JSON.stringify(opts.customer ?? { name: "Rania Haddad", phone: "71 315 744", fulfilment: "pickup", note: "ring twice" }),
    JSON.stringify(lines), total, opts.trap ?? "",
  ]))[0].r;
  return r;
}
async function orderOf(number: string) {
  return one("SELECT * FROM orders WHERE number = $1 AND store_id = $2", [Number(number.slice(2)), SA]);
}
const actor = JSON.stringify({ name: "Lina", terminal: "POS1" });

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    CREATE TABLE public.tenants (global_id uuid PRIMARY KEY, name text, online_license_type text, online_license_expiry timestamp, deleted_at timestamp);
    CREATE TABLE public.products (global_id uuid PRIMARY KEY, tenant_id uuid, barcode text, name text NOT NULL, price numeric NOT NULL,
      price_lbp numeric, cost numeric, stock numeric DEFAULT 0, reorder_point numeric DEFAULT 0, track_inventory int DEFAULT 1,
      category text, unit text DEFAULT 'pcs', active int DEFAULT 1, deleted_at timestamp);
    CREATE TABLE public.product_units (global_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, product_id uuid,
      name text, factor numeric, price numeric, price_lbp numeric, sort_order int DEFAULT 0, deleted_at timestamp);
    CREATE TABLE public.settings (tenant_id uuid, key text, value text, deleted_at timestamp);
    CREATE TABLE public.currencies (tenant_id uuid, local_id int, code text, symbol text, rate numeric, deleted_at timestamp);
    CREATE TABLE public.transactions (global_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, total_amount numeric);
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
    CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
      SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    GRANT USAGE ON SCHEMA storage TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION storage.foldername(text) TO anon, authenticated;
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  `);
  for (const sql of MIGRATIONS) { await db.exec(sql); await db.exec(sql); }
  await db.exec(`
    INSERT INTO tenants VALUES ('${A}', 'Shop A', 'lifetime', NULL, NULL), ('${B}', 'Shop B', 'lifetime', NULL, NULL);
    INSERT INTO settings VALUES ('${A}', 'commerce_enabled', '1', NULL), ('${B}', 'commerce_enabled', '1', NULL);
    INSERT INTO currencies VALUES ('${A}', 1, 'USD', '$', 1, NULL), ('${A}', 2, 'LBP', 'LL', 89500, NULL);
    INSERT INTO stores (global_id, tenant_id, name, slug, mode, status, settings) VALUES
      ('${SA}', '${A}', 'Shop A', 'shop-a', 'retail', 'active', '${ONLINE}'),
      ('${SW}', '${A}', 'WhatsApp A', 'wa-a', 'retail', 'active', '{"ordering_mode":"whatsapp","pickup_enabled":1}'),
      ('${SB}', '${B}', 'Shop B', 'shop-b', 'retail', 'active', '${ONLINE}');
    INSERT INTO products (global_id, tenant_id, name, price, price_lbp, stock, unit) VALUES
      ('${P1}', '${A}', 'Cola', 1.5, NULL, 10, 'pcs'), ('${P2}', '${A}', 'Tea', 2, NULL, 0, 'pcs'),
      ('${P3}', '${A}', 'Rice', 1.2, NULL, 50, 'kg'), ('${P4}', '${A}', 'Water', 0.6, NULL, 100, 'bottle'),
      ('${PB}', '${B}', 'B Bread', 1, NULL, 10, 'pcs');
    INSERT INTO product_units (global_id, tenant_id, product_id, name, factor, price, price_lbp) VALUES
      ('${U1}', '${A}', '${P1}', 'Pack of 6', 6, 8, NULL), ('${U4}', '${A}', '${P4}', 'Pack of 6', 6, 3, 250000);
    INSERT INTO store_listings (global_id, tenant_id, store_id, product_id, published, orderable_unit_ids, min_quantity) VALUES
      ('${L1}', '${A}', '${SA}', '${P1}', 1, NULL, NULL), ('${L2}', '${A}', '${SA}', '${P2}', 1, NULL, NULL),
      ('${L3}', '${A}', '${SA}', '${P3}', 1, NULL, NULL), ('${L4}', '${A}', '${SA}', '${P4}', 1, '["${U4}"]', 12),
      ('${LB}', '${B}', '${SB}', '${PB}', 1, NULL, NULL);
    INSERT INTO storefront_gateway_keys (key_hash, label) VALUES ('${sha(KEY)}', 'test');
    INSERT INTO transactions (tenant_id, total_amount) VALUES ('${A}', 10);
  `);
});
after(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec("DELETE FROM order_events; DELETE FROM order_lines; DELETE FROM orders; DELETE FROM order_counters; DELETE FROM order_blocked_phones;");
});

test("gateway: without the storefront's key every public function refuses and writes nothing", async () => {
  for (const key of ["", "x".repeat(43), "short"]) {
    assert.equal((await quote("shop-a", [{ listing: L1, unit: "base", qty: 1 }], key)).code, "gateway");
    assert.equal((await submit({ key })).code, "gateway");
    assert.equal((await anon("SELECT order_status($1, $2) AS r", [key, statusKey()]))[0].r.code, "gateway");
    assert.equal((await anon("SELECT order_cancel($1, $2) AS r", [key, statusKey()]))[0].r.code, "gateway");
  }
  await db.exec(`UPDATE storefront_gateway_keys SET revoked_at = now()`);
  try { assert.equal((await submit()).code, "gateway", "revoked key"); }
  finally { await db.exec(`UPDATE storefront_gateway_keys SET revoked_at = NULL`); }
  assert.equal(Number((await one("SELECT count(*) AS n FROM orders")).n), 0);
});

test("quote: catalog prices, local amounts with cart.js rounding, problems per line", async () => {
  const r = await quote("shop-a", [
    { listing: L1, unit: "base", qty: 2, price: 1.5 },
    { listing: L1, unit: U1, qty: 1, price: 7 },              // price changed since added
    { listing: L4, unit: U4, qty: 2 },                         // own LBP price, 12 bottles = minimum
    { listing: L2, unit: "base", qty: 1 },                     // out of stock
    { listing: L3, unit: "base", qty: 1.25 },                  // kg: decimals allowed
    { listing: L4, unit: "base", qty: 1 },                     // restricted to the pack
    { listing: "not-a-uuid", unit: "base", qty: 1 },
  ]);
  assert.equal(r.ok, true);
  const q = r.quote;
  const byLine = (n: number) => q.lines.find((l: any) => l.line === n);
  assert.equal(Number(byLine(1).line_total_usd), 3);
  assert.equal(Number(byLine(1).unit_price_local), 134250);         // round(1.5 × 89500)
  assert.equal(Number(byLine(2).unit_price_usd), 8);
  assert.equal(Number(byLine(3).unit_price_local), 250000);         // the unit's own price_lbp
  assert.equal(byLine(4).problem, "out_of_stock");
  assert.equal(Number(byLine(5).line_total_usd), 1.5);              // 1.2 × 1.25
  assert.equal(byLine(6).problem, "unit_not_orderable");
  assert.equal(byLine(7).problem, "listing_unavailable");
  assert.equal(Number(q.total_usd), 3 + 8 + 6 + 1.5);
  assert.equal(Number(q.total_local), 268500 + 716000 + 500000 + 134250);
  assert.deepEqual(q.local, { code: "LBP", rate: 89500 });
  const codes = q.problems.map((p: any) => `${p.line ?? "-"}:${p.code}`).sort();
  assert.deepEqual(codes, ["2:price_changed", "4:out_of_stock", "6:unit_not_orderable", "7:listing_unavailable"]);

  const bad = await quote("shop-a", [{ listing: L1, unit: "base", qty: 1.5 }, { listing: L4, unit: U4, qty: 1 }]);
  assert.deepEqual(bad.quote.problems.map((p: any) => p.code).sort(), ["below_listing_minimum", "invalid_quantity"]);
  assert.equal((await quote("wa-a", [{ listing: L1, unit: "base", qty: 1 }])).code, "store_unavailable", "WhatsApp-mode store");
  assert.equal((await quote("shop-a", Array.from({ length: 51 }, () => ({ listing: L1, unit: "base", qty: 1 })))).quote.problems[0].code, "too_many_lines");
});

test("submit: prices come from the catalog — an altered browser price or total creates nothing (SC-004)", async () => {
  const changed = await submit({ lines: [{ listing: L1, unit: "base", qty: 2, price: 0.5 }] });
  assert.equal(changed.code, "changed");
  assert.equal(Number(changed.quote.total_usd), 3);
  const lowTotal = await submit({ total: 1 });
  assert.equal(lowTotal.code, "changed");
  assert.equal(Number((await one("SELECT count(*) AS n FROM orders")).n), 0);

  const ok = await submit({ lines: [{ listing: L1, unit: "base", qty: 2, price: 1.5 }, { listing: L1, unit: U1, qty: 1, price: 8 }] });
  assert.equal(ok.code, "created");
  assert.equal(ok.number, "W-1001");
  const o = await orderOf(ok.number);
  assert.equal(Number(o.total_usd), 11);
  assert.equal(Number(o.total_local), 268500 + 716000);
  assert.equal(o.customer_phone, "+96171315744");
  assert.equal(o.state, "submitted");
  assert.equal(o.local_currency, "LBP");
  const hours = (new Date(o.expires_at).getTime() - new Date(o.submitted_at).getTime()) / 3600_000;
  assert.equal(Math.round(hours), 12, "store expiry setting");
  const lines = (await db.query("SELECT * FROM order_lines WHERE order_id = $1 ORDER BY line_no", [o.global_id])).rows as any[];
  assert.deepEqual(lines.map((l) => [l.unit_key, Number(l.ordered_qty), Number(l.unit_price_usd), Number(l.unit_factor)]),
    [["base", 2, 1.5, 1], [U1, 1, 8, 6]]);
  assert.equal((await submit()).number, "W-1002", "numbers per store");
  assert.equal((await submit({ slug: "shop-b", lines: [{ listing: LB, unit: "base", qty: 1 }] })).number, "W-1001", "other store starts at 1001");
  const ev = await one("SELECT * FROM order_events WHERE order_id = $1", [o.global_id]);
  assert.equal(ev.kind, "submitted");
  assert.equal(ev.actor_kind, "customer");
});

test("submit: the same attempt returns the same order; a foreign status key is refused (SC-008)", async () => {
  const att = attempt(); const key = statusKey();
  const first = await submit({ attempt: att, status: key });
  const again = await submit({ attempt: att, status: key });
  assert.equal(first.code, "created");
  assert.equal(again.code, "existing");
  assert.equal(again.number, first.number);
  assert.equal((await submit({ attempt: att, status: statusKey() })).code, "refused");
  assert.equal(Number((await one("SELECT count(*) AS n FROM orders")).n), 1);
  const st = (await anon("SELECT order_status($1, $2) AS r", [KEY, key]))[0].r;
  assert.equal(st.order.number, first.number, "the browser's key opens the status page");
  assert.equal((await one("SELECT status_key_hash FROM orders")).status_key_hash, sha(key), "only the hash is stored");
});

test("submit: field validation, bot trap, blocked phone", async () => {
  const field = async (customer: any) => (await submit({ customer })).field;
  assert.equal(await field({ name: "", phone: "71315744", fulfilment: "pickup" }), "name");
  assert.equal(await field({ name: "x".repeat(81), phone: "71315744", fulfilment: "pickup" }), "name");
  assert.equal(await field({ name: "Ali", phone: "123", fulfilment: "pickup" }), "phone");
  assert.equal(await field({ name: "Ali", phone: "71315744", fulfilment: "drone" }), "fulfilment");
  assert.equal(await field({ name: "Ali", phone: "71315744", fulfilment: "delivery" }), "address");
  assert.equal(await field({ name: "Ali", phone: "71315744", fulfilment: "pickup", note: "n".repeat(301) }), "note");
  assert.equal((await submit({ status: "short" })).field, "status_key");
  assert.equal((await submit({ network: "not hex" })).field, "network");
  assert.equal((await submit({ trap: "http://spam" })).code, "refused");
  await user(A, "SELECT order_block_phone($1, '03 123 456', 'prank')", [SA]);
  assert.equal((await submit({ customer: { name: "X", phone: "+9613123456", fulfilment: "pickup" } })).code, "refused");
  assert.equal(Number((await one("SELECT count(*) AS n FROM orders")).n), 0);
  const d = await submit({ customer: { name: "Ali", phone: "00961 70 123 456", fulfilment: "delivery", address: "Gemmayzeh" } });
  assert.equal(d.code, "created");
  assert.equal((await orderOf(d.number)).customer_phone, "+96170123456");
});

test("limits: 3 New and 5 per hour per phone, 10 per network per store; a normal customer is never refused (SC-009)", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await submit()).code, "created");
  assert.equal((await submit()).code, "phone_limit", "4th order while 3 are New");
  await db.exec("UPDATE orders SET state = 'confirmed'");
  assert.equal((await submit()).code, "created");
  assert.equal((await submit()).code, "created");
  await db.exec("UPDATE orders SET state = 'confirmed'");
  assert.equal((await submit()).code, "phone_limit", "6th in the hour");
  await db.exec("UPDATE orders SET submitted_at = now() - interval '2 hours'");
  assert.equal((await submit()).code, "created", "next hour");

  await db.exec("DELETE FROM order_events; DELETE FROM order_lines; DELETE FROM orders;");
  for (let i = 0; i < 10; i++) {
    assert.equal((await submit({ customer: { name: "N", phone: `7031${String(i).padStart(4, "0")}`, fulfilment: "pickup" } })).code, "created");
  }
  assert.equal((await submit({ customer: { name: "N", phone: "70319999", fulfilment: "pickup" } })).code, "network_limit");
  assert.equal((await submit({ network: "b".repeat(64), customer: { name: "N", phone: "70319999", fulfilment: "pickup" } })).code, "created",
    "another network is unaffected");
});

test("accept: per-line confirmation with reasons; refusals; first action wins (SC-006)", async () => {
  const o = await orderOf((await submit({ lines: [{ listing: L1, unit: "base", qty: 6, price: 1.5 }, { listing: L1, unit: U1, qty: 2, price: 8 }] })).number);
  const accept = (uid: string, expected: string, lines: any[]) =>
    user(uid, "SELECT order_accept($1, $2, $3::jsonb, $4::jsonb) AS r", [o.global_id, expected, JSON.stringify(lines), actor]).then((r) => r[0].r);

  assert.equal((await accept(B, "submitted", [])).code, "not_found", "other tenant");
  assert.equal((await accept(A, "confirmed", [])).code, "handled", "stale expected state");
  assert.equal((await accept(A, "submitted", [{ line_no: 1, confirmed_qty: 7 }])).code, "confirm_exceeds");
  const nr = await accept(A, "submitted", [{ line_no: 1, confirmed_qty: 4 }]);
  assert.equal(nr.code, "reason_required");
  assert.equal(nr.line_no, 1);
  assert.equal((await accept(A, "submitted", [{ line_no: 1, confirmed_qty: 0, reason: "out_of_stock" }, { line_no: 2, confirmed_qty: 0, reason: "other" }])).code, "all_zero");
  assert.equal((await one("SELECT state FROM orders WHERE global_id = $1", [o.global_id])).state, "submitted", "refusals change nothing");

  const ok = await accept(A, "submitted", [{ line_no: 1, confirmed_qty: 4, reason: "out_of_stock" }]);
  assert.equal(ok.code, "ok");
  assert.equal(ok.order.state, "confirmed");
  assert.equal(Number(ok.order.confirmed_total_usd), 4 * 1.5 + 2 * 8);
  assert.equal(Number(ok.order.confirmed_total_local), 4 * 134250 + 2 * 716000);
  for (const secret of ["network_hash", "idempotency_key", "status_key_hash"]) assert.ok(!(secret in ok.order), secret);
  assert.deepEqual(ok.lines.map((l: any) => [Number(l.confirmed_qty), l.shortfall_reason]), [[4, "out_of_stock"], [2, null]]);
  const second = await accept(A, "submitted", []);
  assert.equal(second.code, "handled", "the second user is told it was handled");
  assert.equal(second.order.state, "confirmed");
  const kinds = (await db.query("SELECT kind, actor_name, terminal, detail FROM order_events WHERE order_id = $1 ORDER BY at", [o.global_id])).rows as any[];
  assert.deepEqual(kinds.map((k) => k.kind), ["submitted", "confirmed", "adjusted"]);
  assert.equal(kinds[1].actor_name, "Lina");
  assert.equal(kinds[1].terminal, "POS1");
  assert.deepEqual(kinds[2].detail, [{ line_no: 1, ordered: 6, confirmed: 4, reason: "out_of_stock" }]);
});

test("lifecycle: ready → complete once per sale → undo; reject / cancel need reasons; customer cancels only New", async () => {
  const o = await orderOf((await submit()).number);
  const call = (q: string, ...p: any[]) => user(A, `SELECT ${q} AS r`, p).then((r) => r[0].r);
  assert.equal((await call("order_ready($1, 'submitted', $2::jsonb)", o.global_id, actor)).code, "invalid_transition");
  assert.equal((await call("order_complete($1, $2, 3, $3::jsonb)", o.global_id, "50000000-0000-4000-8000-000000000001", actor)).code, "invalid_transition");
  await call("order_accept($1, 'submitted', '[]'::jsonb, $2::jsonb)", o.global_id, actor);
  assert.equal((await call("order_ready($1, 'confirmed', $2::jsonb)", o.global_id, actor)).order.state, "ready");
  const S1 = "50000000-0000-4000-8000-000000000001", S2 = "50000000-0000-4000-8000-000000000002";
  const done = await call("order_complete($1, $2, 2.999, $3::jsonb)", o.global_id, S1, actor);
  assert.equal(done.code, "ok");
  assert.equal(done.order.state, "completed");
  assert.equal(Number(done.order.sale_total_usd), 3);
  assert.equal((await call("order_complete($1, $2, 3, $3::jsonb)", o.global_id, S1, actor)).code, "ok", "same sale again is a no-op");
  assert.equal((await call("order_complete($1, $2, 3, $3::jsonb)", o.global_id, S2, actor)).code, "handled", "a second sale is refused");
  assert.equal((await call("order_complete_undo($1, $2, $3::jsonb)", o.global_id, S2, actor)).code, "handled", "undo needs the same sale");
  const undone = await call("order_complete_undo($1, $2, $3::jsonb)", o.global_id, S1, actor);
  assert.equal(undone.order.state, "ready");
  assert.equal(undone.order.sale_global_id, null);
  assert.equal((await call("order_cancel_by_shop($1, 'ready', '  ', $2::jsonb)", o.global_id, actor)).code, "reason_required");
  const c = await call("order_cancel_by_shop($1, 'ready', 'Customer never came', $2::jsonb)", o.global_id, actor);
  assert.equal(c.order.state, "cancelled");
  assert.equal(c.order.cancelled_by, "shop");

  const key = statusKey();
  const o2 = await orderOf((await submit({ status: key })).number);
  assert.equal((await call("order_reject($1, 'submitted', '', $2::jsonb)", o2.global_id, actor)).code, "reason_required");
  const rej = await call("order_reject($1, 'submitted', 'Closed today', $2::jsonb)", o2.global_id, actor);
  assert.equal(rej.order.state, "rejected");
  const pub = (await anon("SELECT order_status($1, $2) AS r", [KEY, key]))[0].r.order;
  assert.equal(pub.state, "rejected");
  assert.equal(pub.reason, "Closed today");
  assert.equal((await anon("SELECT order_cancel($1, $2) AS r", [KEY, key]))[0].r.code, "not_cancellable");

  const key3 = statusKey();
  await submit({ status: key3 });
  const cc = (await anon("SELECT order_cancel($1, $2) AS r", [KEY, key3]))[0].r;
  assert.equal(cc.code, "cancelled");
  assert.equal(cc.order.state, "cancelled");
  assert.equal(cc.order.cancelled_by, "customer");
});

test("expiry: overdue New orders expire via the sweep and on any read; actions on them return 'expired'", async () => {
  const key = statusKey();
  const o = await orderOf((await submit({ status: key })).number);
  await db.exec(`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE global_id = '${o.global_id}'`);
  assert.equal((await anon("SELECT order_status($1, $2) AS r", [KEY, key]))[0].r.order.state, "expired", "status read");
  const o2 = await orderOf((await submit()).number);
  await db.exec(`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE global_id = '${o2.global_id}'`);
  assert.deepEqual((await user(A, "SELECT orders_sweep() AS r"))[0].r, { ok: true, code: "ok", expired: 1 });
  assert.equal((await user(A, "SELECT order_accept($1, 'submitted', '[]'::jsonb, $2::jsonb) AS r", [o2.global_id, actor]))[0].r.code, "expired");
  const ev = await one("SELECT * FROM order_events WHERE order_id = $1 AND kind = 'expired'", [o2.global_id]);
  assert.equal(ev.actor_kind, "system");
  assert.equal((await anon("SELECT orders_sweep() AS r").catch((e) => e)).message !== undefined, true, "anon can't sweep");
});

test("privacy: the public view shows first name only — no phone, note, network or keys (FR-042/FR-043)", async () => {
  const key = statusKey();
  const r = await submit({ status: key, customer: { name: "Rania Haddad", phone: "71315744", fulfilment: "delivery", address: "Achrafieh", note: "secret note" } });
  const pub = (await anon("SELECT order_status($1, $2) AS r", [KEY, key]))[0].r.order;
  assert.equal(pub.first_name, "Rania");
  assert.equal(pub.address, "Achrafieh");
  const text = JSON.stringify([r, pub]);
  for (const leak of ["Haddad", "71315744", "secret note", NET, sha(key)]) assert.ok(!text.includes(leak), leak);
  assert.equal(pub.store.slug, "shop-a");
  assert.equal((await anon("SELECT order_status($1, $2) AS r", [KEY, statusKey()]))[0].r.code, "not_found");
});

test("isolation and privileges: RLS read-only for owners, nothing for anon, exact function grants", async () => {
  await submit();
  await submit({ slug: "shop-b", lines: [{ listing: LB, unit: "base", qty: 1 }] });
  assert.equal((await user(A, "SELECT count(*)::int AS n FROM orders"))[0].n, 1, "A sees only its order");
  assert.equal((await user(B, "SELECT count(*)::int AS n FROM order_lines"))[0].n, 1);
  await assert.rejects(anon("SELECT * FROM orders"), /permission denied/);
  await assert.rejects(user(A, "UPDATE orders SET state = 'completed'"), /permission denied/);
  await assert.rejects(user(A, "INSERT INTO order_events (tenant_id, order_id, kind, actor_kind) SELECT tenant_id, global_id, 'ready', 'user' FROM orders"), /permission denied/);
  for (const t of ["order_counters", "order_blocked_phones", "storefront_gateway_keys"]) {
    await assert.rejects(user(A, `SELECT * FROM ${t}`), /permission denied/, t);
  }
  assert.deepEqual((await user(B, "SELECT order_blocked_phones($1) AS r", [SA]))[0].r.code, "not_owner");

  const pub = ["order_quote(text, text, jsonb)", "order_submit(text, text, text, text, text, jsonb, jsonb, numeric, text)",
    "order_status(text, text)", "order_cancel(text, text)"];
  const owner = ["order_accept(uuid, text, jsonb, jsonb)", "order_reject(uuid, text, text, jsonb)", "order_ready(uuid, text, jsonb)",
    "order_cancel_by_shop(uuid, text, text, jsonb)", "order_complete(uuid, uuid, numeric, jsonb)", "order_complete_undo(uuid, uuid, jsonb)",
    "orders_sweep()", "order_blocked_phones(uuid)", "order_block_phone(uuid, text, text)", "order_unblock_phone(uuid, text)"];
  const internal = ["_gateway_ok(text)", "_order_phone(text)", "_order_quote(uuid, jsonb)", "_orders_expire(uuid)", "_order_lock(uuid)",
    "_order_sha256(text)", "_order_measured(text)", "_order_lines_json(uuid)"];
  for (const f of pub) { assert.equal(await canExec("anon", f), true, f); assert.equal(await canExec("authenticated", f), true, f); }
  for (const f of owner) { assert.equal(await canExec("anon", f), false, f); assert.equal(await canExec("authenticated", f), true, f); }
  for (const f of internal) { assert.equal(await canExec("anon", f), false, f); assert.equal(await canExec("authenticated", f), false, f); }
});

test("blocked phones: owner add (normalised), list, remove", async () => {
  assert.equal((await user(A, "SELECT order_block_phone($1, 'abc', NULL) AS r", [SA]))[0].r.code, "invalid");
  assert.equal((await user(A, "SELECT order_block_phone($1, '71 315 744', 'prank') AS r", [SA]))[0].r.phone, "+96171315744");
  const list = (await user(A, "SELECT order_blocked_phones($1) AS r", [SA]))[0].r.rows;
  assert.deepEqual(list.map((r: any) => [r.phone, r.note]), [["+96171315744", "prank"]]);
  await user(A, "SELECT order_unblock_phone($1, '+96171315744')", [SA]);
  assert.equal((await user(A, "SELECT order_blocked_phones($1) AS r", [SA]))[0].r.rows.length, 0);
});

test("order functions never touch money or stock tables (FR-038)", async () => {
  const before = await one("SELECT (SELECT count(*) FROM transactions) AS t, (SELECT sum(stock) FROM products) AS s");
  const o = await orderOf((await submit()).number);
  const call = (q: string, ...p: any[]) => user(A, `SELECT ${q} AS r`, p);
  await call("order_accept($1, 'submitted', '[]'::jsonb, $2::jsonb)", o.global_id, actor);
  await call("order_ready($1, 'confirmed', $2::jsonb)", o.global_id, actor);
  await call("order_complete($1, '50000000-0000-4000-8000-000000000009', 3, $2::jsonb)", o.global_id, actor);
  const after = await one("SELECT (SELECT count(*) FROM transactions) AS t, (SELECT sum(stock) FROM products) AS s");
  assert.deepEqual(after, before);
  assert.ok(await one("SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'order_global_id'"));
});

test("checks file: every query runs read-only and reports the expected result", async () => {
  for (const q of CHECKS.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) {
    const rows = (await db.query(q)).rows as any[];
    for (const row of rows) {
      if ("ok" in row) assert.equal(row.ok, true, `${q}\n${JSON.stringify(row)}`);
    }
  }
});
