// Cloud SQL for the online store, run on PGlite (real Postgres in WASM) against stub Supabase tables:
// supabase/migrations/2026-10-18_commerce_store_foundation.sql + 2026-10-19_storefront.sql.
// Guards the privacy rules that no desktop test can reach: the public gates (incl. Wholesale never public),
// preview tokens, the single-listing RPC, the reserved addresses, function privileges and storage policies.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = ["2026-10-18_commerce_store_foundation.sql", "2026-10-19_storefront.sql"]
  .map((f) => fs.readFileSync(path.join(root, "supabase", "migrations", f), "utf8"));

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const SA = "cccccccc-0000-4000-8000-000000000003"; // A, retail, active
const SH = "dddddddd-0000-4000-8000-000000000004"; // A, hybrid, active
const SW = "eeeeeeee-0000-4000-8000-000000000005"; // A, wholesale, active
const SD = "ffffffff-0000-4000-8000-000000000006"; // A, retail, draft
const SB = "99999999-0000-4000-8000-000000000007"; // B, retail, active
const P1 = "10000000-0000-4000-8000-000000000001";
const P2 = "10000000-0000-4000-8000-000000000002";
const L1 = "20000000-0000-4000-8000-000000000001"; // SA, published
const L2 = "20000000-0000-4000-8000-000000000002"; // SA, unpublished
const LW = "20000000-0000-4000-8000-000000000003"; // SW, published
const LD = "20000000-0000-4000-8000-000000000004"; // SD, published

let db: PGlite;

async function asRole(role: "anon" | "authenticated", uid: string | null, q: string, params: any[] = []) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub', '${uid ?? ""}', false)`);
  try { return (await db.query(q, params)).rows as any[]; }
  finally { await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false)"); }
}
const anon = (q: string, params: any[] = []) => asRole("anon", null, q, params);
const user = (uid: string, q: string, params: any[] = []) => asRole("authenticated", uid, q, params);
const canExec = async (role: string, fn: string) =>
  (await db.query(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE') AS ok`)).rows[0] as any;

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
    CREATE TABLE public.tenants (global_id uuid PRIMARY KEY, name text, online_license_type text, online_license_expiry timestamp, deleted_at timestamp);
    CREATE TABLE public.products (global_id uuid PRIMARY KEY, tenant_id uuid, barcode text, name text NOT NULL, price numeric NOT NULL,
      price_lbp numeric, cost numeric, stock numeric DEFAULT 0, reorder_point numeric DEFAULT 0, track_inventory int DEFAULT 1,
      category text, unit text DEFAULT 'pcs', active int DEFAULT 1, deleted_at timestamp);
    CREATE TABLE public.product_units (global_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, product_id uuid,
      name text, factor numeric, price numeric, price_lbp numeric, sort_order int DEFAULT 0, deleted_at timestamp);
    CREATE TABLE public.settings (tenant_id uuid, key text, value text, deleted_at timestamp);
    CREATE TABLE public.currencies (tenant_id uuid, local_id int, code text, symbol text, rate numeric, deleted_at timestamp);
    -- Supabase storage, reduced to what the policies use.
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
    CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
      SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    GRANT USAGE ON SCHEMA storage TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION storage.foldername(text) TO anon, authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "read all" ON storage.objects FOR SELECT USING (true);
  `);
  for (const sql of MIGRATIONS) await db.exec(sql);
  for (const sql of MIGRATIONS) await db.exec(sql); // re-runnable
  await db.exec(`
    INSERT INTO tenants VALUES ('${A}', 'Shop A', 'lifetime', NULL, NULL), ('${B}', 'Shop B', 'lifetime', NULL, NULL);
    INSERT INTO settings VALUES ('${A}', 'commerce_enabled', '1', NULL), ('${B}', 'commerce_enabled', '1', NULL);
    INSERT INTO stores (global_id, tenant_id, name, slug, mode, status) VALUES
      ('${SA}', '${A}', 'Retail', 'retail-shop', 'retail', 'active'),
      ('${SH}', '${A}', 'Hybrid', 'hybrid-shop', 'hybrid', 'active'),
      ('${SW}', '${A}', 'Wholesale', 'wholesale-shop', 'wholesale', 'active'),
      ('${SD}', '${A}', 'Draft', 'draft-shop', 'retail', 'draft'),
      ('${SB}', '${B}', 'B Shop', 'b-shop', 'retail', 'active');
    INSERT INTO products (global_id, tenant_id, barcode, name, price, cost, stock) VALUES
      ('${P1}', '${A}', 'P1', 'Cola', 1.5, 0.8, 10), ('${P2}', '${A}', 'P2', 'Tea', 2, 1, 10);
    INSERT INTO store_listings (global_id, tenant_id, store_id, product_id, published) VALUES
      ('${L1}', '${A}', '${SA}', '${P1}', 1), ('${L2}', '${A}', '${SA}', '${P2}', 0),
      ('${LW}', '${A}', '${SW}', '${P1}', 1), ('${LD}', '${A}', '${SD}', '${P1}', 1);
  `);
});
after(async () => { await db.close(); });

test("gate: retail and hybrid stores are public, wholesale and draft are not", async () => {
  for (const slug of ["retail-shop", "hybrid-shop", "b-shop"]) {
    assert.equal((await anon("SELECT * FROM store_public_get($1)", [slug])).length, 1, slug);
  }
  for (const slug of ["wholesale-shop", "draft-shop", "missing-shop"]) {
    assert.equal((await anon("SELECT * FROM store_public_get($1)", [slug])).length, 0, slug);
    assert.equal((await anon("SELECT * FROM store_public_listings($1)", [slug])).length, 0, slug);
  }
  assert.equal((await anon("SELECT * FROM store_public_listing('wholesale-shop', $1)", [LW])).length, 0);
  const g = (await anon("SELECT * FROM store_public_get('retail-shop')"))[0];
  assert.equal(g.is_preview, false);
});

test("store_public_listing: one visible product; nothing for unpublished, other store or unknown ids", async () => {
  const r = await anon("SELECT * FROM store_public_listing('retail-shop', $1)", [L1]);
  assert.equal(r.length, 1);
  assert.equal(r[0].title, "Cola");
  assert.equal(Number(r[0].price), 1.5);
  assert.equal(r[0].stock, null, "exact stock hidden by default");
  for (const k of ["cost", "barcode", "product_id", "tenant_id", "total_count"]) assert.ok(!(k in r[0]), k);
  assert.equal((await anon("SELECT * FROM store_public_listing('retail-shop', $1)", [L2])).length, 0, "unpublished");
  assert.equal((await anon("SELECT * FROM store_public_listing('b-shop', $1)", [L1])).length, 0, "other store");
  assert.equal((await anon("SELECT * FROM store_public_listing('retail-shop', $1)", ["30000000-0000-4000-8000-000000000000"])).length, 0);
});

test("preview tokens: owner-only creation; a valid token shows draft and wholesale stores; expired or foreign tokens don't", async () => {
  assert.equal((await user(B, "SELECT * FROM create_store_preview_token($1)", [SD])).length, 0, "non-owner gets nothing");
  const [{ token, expires_at }] = await user(A, "SELECT * FROM create_store_preview_token($1)", [SD]);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(new Date(expires_at).getTime() - Date.now() > 25 * 60 * 1000);

  const g = await anon("SELECT * FROM store_public_get('draft-shop', $1)", [token]);
  assert.equal(g.length, 1);
  assert.equal(g[0].is_preview, true);
  assert.equal((await anon("SELECT * FROM store_public_listing('draft-shop', $1, $2)", [LD, token])).length, 1);
  assert.equal((await anon("SELECT * FROM store_public_get('wholesale-shop', $1)", [token])).length, 0, "token is per store");

  const [{ token: wt }] = await user(A, "SELECT * FROM create_store_preview_token($1)", [SW]);
  assert.equal((await anon("SELECT * FROM store_public_listings('wholesale-shop', NULL, NULL, 48, 0, $1)", [wt])).length, 1);

  await db.query("UPDATE store_preview_tokens SET expires_at = now() - interval '1 minute' WHERE token = $1", [token]);
  assert.equal((await anon("SELECT * FROM store_public_get('draft-shop', $1)", [token])).length, 0, "expired");
  // The token table itself is closed to the API roles.
  await assert.rejects(anon("SELECT * FROM store_preview_tokens"));
});

test("a preview still needs commerce on", async () => {
  const [{ token }] = await user(A, "SELECT * FROM create_store_preview_token($1)", [SD]);
  await db.exec(`UPDATE settings SET value = '0' WHERE tenant_id = '${A}'`);
  try {
    assert.equal((await anon("SELECT * FROM store_public_get('draft-shop', $1)", [token])).length, 0);
    assert.equal((await anon("SELECT * FROM store_public_get('retail-shop')")).length, 0);
  } finally {
    await db.exec(`UPDATE settings SET value = '1' WHERE tenant_id = '${A}'`);
  }
});

test("claim_store_slug refuses every reserved address (storefront/src/reserved.ts)", async () => {
  const { RESERVED_SLUGS } = await import("../storefront/src/reserved.js");
  for (const slug of RESERVED_SLUGS) {
    const [r] = await user(A, "SELECT * FROM claim_store_slug($1, $2)", [SA, slug]);
    assert.equal(r.code, "reserved", slug);
  }
  const [ok] = await user(A, "SELECT * FROM claim_store_slug($1, $2)", [SA, "retail-shop-2"]);
  assert.equal(ok.ok, true);
  await db.exec(`UPDATE stores SET slug = 'retail-shop' WHERE global_id = '${SA}'`);
});

test("privileges: anon may call only the three public functions", async () => {
  const pub = ["public.store_public_get(text, text)", "public.store_public_listings(text, text, text, integer, integer, text)", "public.store_public_listing(text, uuid, text)"];
  for (const f of pub) assert.equal((await canExec("anon", f)).ok, true, f);
  for (const f of ["public.claim_store_slug(uuid, text)", "public.create_store_preview_token(uuid)"]) {
    assert.equal((await canExec("anon", f)).ok, false, f);
    assert.equal((await canExec("authenticated", f)).ok, true, f);
  }
  for (const f of ["public._store_public_store(text, text)", "public._store_public_is_preview(uuid, text)", "public._store_public_rows(uuid, boolean)", "public._store_public_settings(text)"]) {
    assert.equal((await canExec("anon", f)).ok, false, f);
    assert.equal((await canExec("authenticated", f)).ok, false, f);
  }
  const old = await db.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('store_public_get','store_public_listings','_store_public_store') AND pronargs IN (1, 5)");
  assert.equal((old.rows[0] as any).n, 0, "old 001 signatures are dropped");
});

test("storage: bucket settings; a business writes only inside its own folder", async () => {
  const b = (await db.query("SELECT * FROM storage.buckets WHERE id = 'store-images'")).rows[0] as any;
  assert.equal(b.public, true);
  assert.equal(Number(b.file_size_limit), 2097152);
  assert.deepEqual(b.allowed_mime_types, ["image/webp"]);

  const own = `${A}/l/${L1}/abcdefghijklmnopqrstuv.webp`;
  await user(A, "INSERT INTO storage.objects (bucket_id, name) VALUES ('store-images', $1)", [own]);
  await assert.rejects(
    user(A, "INSERT INTO storage.objects (bucket_id, name) VALUES ('store-images', $1)", [`${B}/l/${L1}/x.webp`]),
    /row-level security/,
  );
  await assert.rejects(anon("INSERT INTO storage.objects (bucket_id, name) VALUES ('store-images', $1)", [own]));
  // B cannot delete A's object (row invisible to the delete policy => 0 rows).
  const count = async () => ((await db.query("SELECT count(*)::int AS n FROM storage.objects WHERE name = $1", [own])).rows[0] as any).n;
  await user(B, "DELETE FROM storage.objects WHERE name = $1", [own]);
  assert.equal(await count(), 1);
  await user(A, "DELETE FROM storage.objects WHERE name = $1", [own]);
  assert.equal(await count(), 0);
});

test("supabase/checks/2026-10-19_storefront_checks.sql runs and every check shows its expected result", async () => {
  const sql = fs.readFileSync(path.join(root, "supabase", "checks", "2026-10-19_storefront_checks.sql"), "utf8");
  const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 7);
  const r = [] as any[][];
  for (const s of statements) r.push((await db.query(s)).rows as any[]);
  const fns = Object.fromEntries(r[0].map((x) => [x.function_name, x]));
  for (const f of Object.values(fns) as any[]) assert.equal(f.exists, true, f.function_name);
  for (const f of ["store_public_get(text, text)", "store_public_listings(text, text, text, integer, integer, text)", "store_public_listing(text, uuid, text)"]) {
    assert.equal(fns[`public.${f}`].anon, true, f);
  }
  for (const f of ["claim_store_slug(uuid, text)", "create_store_preview_token(uuid)"]) {
    assert.equal(fns[`public.${f}`].anon, false, f);
    assert.equal(fns[`public.${f}`].authenticated, true, f);
  }
  for (const f of Object.keys(fns).filter((k) => k.includes("._store_public_"))) {
    assert.equal(fns[f].anon, false, f);
    assert.equal(fns[f].authenticated, false, f);
  }
  assert.equal(Number(r[1][0].old_signatures), 0);
  assert.equal(r[2][0].wholesale_gate_present, true);
  assert.equal(r[3].length, 0, "allow-list");
  assert.deepEqual({ ...r[4][0], policies: Number(r[4][0].policies) }, { rls_enabled: true, policies: 0 });
  assert.equal(r[5][0].public, true);
  assert.equal(r[6].length, 3);
  for (const p of r[6]) assert.deepEqual(p.roles, ["authenticated"]);
});
