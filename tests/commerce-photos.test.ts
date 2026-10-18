// Online-store photos, logo/cover and owner preview (specs/002-tenant-online-store, US5,
// contracts/backoffice-api.md). The cloud (Supabase Storage + preview-token RPC) is a fake that can be
// switched between ok / offline / failed.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let commerce: typeof import("../server/commerce.js");
let n = 0;

type Mode = "ok" | "offline" | "failed";
const cloud = { mode: "ok" as Mode, objects: new Map<string, number>(), removed: [] as string[], token: "tok_preview_1" };

before(async () => {
  app = await createTestApp();
  commerce = await import("../server/commerce.js");
  commerce.__setSlugClaimer(async () => ({ ok: true, code: "ok" }));
  const res = <T,>(value: T) => (cloud.mode === "ok" ? { ok: true as const, value } : { ok: false as const, reason: cloud.mode as "offline" | "failed" });
  commerce.__setCommerceCloud({
    upload: async (_t, path, bytes) => { const r = res(null); if (r.ok) cloud.objects.set(path, bytes.length); return r; },
    remove: async (_t, paths) => { const r = res(null); if (r.ok) for (const p of paths) { cloud.objects.delete(p); cloud.removed.push(p); } return r; },
    previewToken: async () => res(cloud.token),
  });
});
beforeEach(() => { cloud.mode = "ok"; cloud.removed = []; });
after(async () => { commerce.__setSlugClaimer(); commerce.__setCommerceCloud(); await app.close(); });

/** A tiny but valid-looking WebP file (RIFF....WEBP header) of `size` bytes. */
function webp(size = 2048): Uint8Array {
  const b = Buffer.alloc(size, 7);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(size - 8, 4);
  b.write("WEBPVP8 ", 8, "ascii");
  return new Uint8Array(b);
}

async function setup() {
  n++;
  const tenantId = seedTenant(app.db, `Photo Shop ${n}`, `photo${n}-${Date.now()}@example.com`);
  const admin = (app.db.prepare("SELECT id FROM users WHERE tenant_id = ? AND role = 'admin'").get(tenantId) as any).id as number;
  const cashier = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, 'Cara', 'cashier', '5555')").run(tenantId).lastInsertRowid);
  app.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'commerce_enabled', '1')").run(tenantId);
  const as = { tenantId, userId: admin };
  const store = (await app.api("POST", "/api/commerce/stores", { ...as, body: { name: "Shop" } })).body;
  const productId = Number(app.db.prepare("INSERT INTO products (tenant_id, name, price, stock) VALUES (?, 'Cola', 1.5, 10)").run(tenantId).lastInsertRowid);
  const tenantGid = (app.db.prepare("SELECT global_id FROM tenants WHERE id = ?").get(tenantId) as any).global_id as string;
  const photosUrl = `/api/commerce/stores/${store.id}/listings/${productId}/photos`;
  const upload = (data = webp(), who: any = as) => app.api("POST", photosUrl, { ...who, raw: { type: "image/webp", data } });
  return { tenantId, admin, cashier, as, store, productId, tenantGid, photosUrl, upload };
}

test("upload: creates the listing (unpublished) if missing and stores the photo under the business's own folder", async () => {
  const s = await setup();
  const r = await s.upload();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.published, false);
  assert.equal(r.body.images.length, 1);
  const listingGid = r.body.global_id;
  assert.match(r.body.images[0], new RegExp(`^${s.tenantGid}/l/${listingGid}/[A-Za-z0-9_-]{22}\\.webp$`));
  assert.ok(cloud.objects.has(r.body.images[0]));
  const log = app.db.prepare("SELECT details FROM user_logs WHERE tenant_id = ? AND action = 'listing_photo_add'").get(s.tenantId) as any;
  assert.ok(log);
});

test("up to 4 photos; the 5th is refused and not uploaded", async () => {
  const s = await setup();
  for (let i = 0; i < 4; i++) assert.equal((await s.upload()).status, 200);
  const before = cloud.objects.size;
  const fifth = await s.upload();
  assert.equal(fifth.status, 400);
  assert.equal(fifth.body.code, "LISTING_IMAGES_INVALID");
  assert.equal(fifth.body.field, "images");
  assert.equal(cloud.objects.size, before);
});

test("only WebP up to 2 MB is accepted", async () => {
  const s = await setup();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  for (const [label, r] of [
    ["png bytes", await s.upload(new Uint8Array(png))],
    ["too big", await s.upload(webp(2 * 1024 * 1024 + 100))],
    ["empty", await s.upload(new Uint8Array(0))],
    ["json body", await app.api("POST", s.photosUrl, { ...s.as, body: { images: ["x"] } })],
  ] as const) {
    assert.equal(r.status, 400, label);
    assert.equal(r.body.code, "LISTING_IMAGES_INVALID", label);
  }
});

test("offline: upload refused with STORE_PHOTO_NEEDS_ONLINE and nothing is created; a failed upload leaves no listing behind", async () => {
  const s = await setup();
  cloud.mode = "offline";
  const r = await s.upload();
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "STORE_PHOTO_NEEDS_ONLINE");
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM store_listings WHERE product_id = ? AND deleted_at IS NULL").get(s.productId) as any).c, 0);
  cloud.mode = "failed";
  const f = await s.upload();
  assert.equal(f.status, 502);
  assert.equal(f.body.code, "STORE_PHOTO_UPLOAD_FAILED");
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM store_listings WHERE product_id = ? AND deleted_at IS NULL").get(s.productId) as any).c, 0);
});

test("reorder works offline; removing needs the cloud and deletes the object; only current photos accepted", async () => {
  const s = await setup();
  const paths: string[] = [];
  for (let i = 0; i < 3; i++) paths.push((await s.upload()).body.images.at(-1));
  cloud.mode = "offline";
  const reordered = await app.api("PUT", s.photosUrl, { ...s.as, body: { images: [paths[2], paths[0], paths[1]] } });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.deepEqual(reordered.body.images, [paths[2], paths[0], paths[1]]);

  const offlineRemove = await app.api("PUT", s.photosUrl, { ...s.as, body: { images: [paths[2]] } });
  assert.equal(offlineRemove.status, 503);
  assert.equal(offlineRemove.body.code, "STORE_PHOTO_NEEDS_ONLINE");

  cloud.mode = "ok";
  const removed = await app.api("PUT", s.photosUrl, { ...s.as, body: { images: [paths[2]] } });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.images, [paths[2]]);
  assert.deepEqual(cloud.removed.sort(), [paths[0], paths[1]].sort());

  for (const bad of [[paths[2], paths[2]], ["someone-else/l/x/y.webp"], "not-an-array"]) {
    const r = await app.api("PUT", s.photosUrl, { ...s.as, body: { images: bad } });
    assert.equal(r.body.code, "LISTING_IMAGES_INVALID", JSON.stringify(bad));
  }
});

test("the generic listing PUT no longer accepts images", async () => {
  const s = await setup();
  const r = await app.api("PUT", `/api/commerce/stores/${s.store.id}/listings/${s.productId}`, { ...s.as, body: { images: ["a.webp"] } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "LISTING_FIELD_INVALID");
  assert.equal(r.body.field, "images");
});

test("permissions and isolation: cashiers can't change photos; another business gets STORE_NOT_FOUND", async () => {
  const s = await setup();
  assert.equal((await s.upload(webp(), { tenantId: s.tenantId, userId: s.cashier })).status, 403);
  assert.equal((await app.api("PUT", s.photosUrl, { tenantId: s.tenantId, userId: s.cashier, body: { images: [] } })).status, 403);
  const other = await setup();
  const r = await app.api("POST", s.photosUrl, { ...other.as, raw: { type: "image/webp", data: webp() } });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "STORE_NOT_FOUND");
});

test("logo and cover: upload, replace (old object deleted), remove", async () => {
  const s = await setup();
  const url = (kind: string) => `/api/commerce/stores/${s.store.id}/branding/${kind}`;
  const first = await app.api("POST", url("logo"), { ...s.as, raw: { type: "image/webp", data: webp() } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.match(first.body.logo_path, new RegExp(`^${s.tenantGid}/s/${s.store.global_id}/logo-[A-Za-z0-9_-]{22}\\.webp$`));
  const second = await app.api("POST", url("logo"), { ...s.as, raw: { type: "image/webp", data: webp() } });
  assert.notEqual(second.body.logo_path, first.body.logo_path);
  assert.ok(cloud.removed.includes(first.body.logo_path), "old logo deleted");
  const cover = await app.api("POST", url("cover"), { ...s.as, raw: { type: "image/webp", data: webp() } });
  assert.match(cover.body.cover_path, /\/cover-[A-Za-z0-9_-]{22}\.webp$/);
  const cleared = await app.api("DELETE", url("logo"), s.as);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.logo_path, null);
  assert.ok(cloud.removed.includes(second.body.logo_path));
  assert.equal((await app.api("POST", url("banner"), { ...s.as, raw: { type: "image/webp", data: webp() } })).status, 404);
  assert.equal((await app.api("POST", url("logo"), { tenantId: s.tenantId, userId: s.cashier, raw: { type: "image/webp", data: webp() } })).status, 403);
});

test("preview link: needs an address and the cloud; returns the public address with a preview token", async () => {
  const s = await setup();
  const url = `/api/commerce/stores/${s.store.id}/preview`;
  const noSlug = await app.api("POST", url, s.as);
  assert.equal(noSlug.body.code, "STORE_NOT_READY");
  await app.api("POST", `/api/commerce/stores/${s.store.id}/slug`, { ...s.as, body: { slug: `photo-shop-${n}` } });
  cloud.mode = "offline";
  const offline = await app.api("POST", url, s.as);
  assert.equal(offline.status, 503);
  assert.equal(offline.body.code, "STORE_PREVIEW_NEEDS_ONLINE");
  cloud.mode = "ok";
  const ok = await app.api("POST", url, s.as);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.url, `https://photo-shop-${n}.omnipos.shop/?preview=tok_preview_1`);
});

test("status: public address in host form, storefront origin and where back-office thumbnails load from", async () => {
  const s = await setup();
  await app.api("POST", `/api/commerce/stores/${s.store.id}/slug`, { ...s.as, body: { slug: `addr-${n}` } });
  const st = (await app.api("GET", "/api/commerce/status", s.as)).body;
  assert.equal(st.storefront_origin, "https://omnipos.shop");
  assert.equal(st.store.public_url, `https://addr-${n}.omnipos.shop/`);
  assert.match(st.image_base, /\/storage\/v1\/object\/public\/store-images\/$/);
  const stores = (await app.api("GET", "/api/commerce/stores", s.as)).body;
  assert.equal(stores[0].public_url, `https://addr-${n}.omnipos.shop/`);
});
