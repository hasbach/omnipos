// Arabic as printer-native text (for printers with a built-in Arabic code page, e.g. Xprinter
// XP-80C). The printer neither joins letters nor lays text out right to left, so the app must
// send presentation forms in visual order. Expected values below are worked out by hand.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import iconv from "iconv-lite";
import { shape, toVisual, encodeArabicLine } from "../server/printing/arabic.js";
import { buildReceiptBuffer, buildArabicTestBuffer } from "../server/printing/receipt.js";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

const cps = (s: string) => [...s].map(c => c.codePointAt(0)!.toString(16).toUpperCase());
const RASTER = Buffer.from([0x1d, 0x76, 0x30]);

test("letters take their joined forms", () => {
  // م (initial) ح (medial) م (medial) د (final — dal never joins forward)
  assert.deepEqual(cps(shape("محمد")), ["FEE3", "FEA4", "FEE4", "FEAA"]);
  // right-joining letters never connect forward, so every letter of "دار" stands alone
  assert.deepEqual(cps(shape("دار")), ["FEA9", "FE8D", "FEAD"]);
});

test("lam + alef become one ligature, in the right form", () => {
  assert.deepEqual(cps(shape("لا")), ["FEFB"]);                       // isolated
  assert.deepEqual(cps(shape("سلام")), ["FEB3", "FEFC", "FEE1"]);     // final after س; م isolated
});

test("an Arabic line is reversed into visual order, numbers kept left-to-right", () => {
  const v = toVisual("شارع 12");
  // RTL line: the number sits on the left of the word, still reading 1-2
  assert.equal(v, "12 عراش");
});

test("Arabic inside an English line: only the Arabic run is reversed", () => {
  assert.equal(toVisual("Address: 12 شارع"), "Address: 12 عراش");
  assert.equal(toVisual("Customer: علي"), "Customer: يلع");
});

test("punctuation after an Arabic word stays on its left (the reading end)", () => {
  assert.equal(toVisual("بيروت، شارع"), "عراش ،توريب");
});

test("text CP864 can't hold is rejected so the line can fall back to an image", () => {
  assert.equal(encodeArabicLine("پیتزا", "cp864"), null); // Persian letters aren't in CP864
  assert.ok(encodeArabicLine("شارع الحمرا", "cp864"));
  assert.ok(encodeArabicLine("شارع الحمرا", "cp1256"));
});

test("CP864 output decodes back to the joined, visually-ordered glyphs", () => {
  const bytes = encodeArabicLine("محمد", "cp864")!;
  // visual order = reversed logical: د(final) م(medial) ح(medial) م(initial). CP864 has one
  // glyph for final+isolated and one for initial+medial for these letters, so those stand in.
  assert.deepEqual(cps(iconv.decode(bytes, "cp864")), ["FEA9", "FEE3", "FEA3", "FEE3"]);
});

function receiptWith(arabic: any, name = "محمد علي") {
  return buildReceiptBuffer({
    storeName: "Acme",
    arabic,
    transaction: { id: 1, stakeholder_name: name, stakeholder_address: "بيروت، شارع الحمرا",
      items: [{ name: "شاحن سريع", price: 12.5, quantity: 2 }], total_amount: 25 },
  });
}

test("with a code page set, Arabic goes out as printer text, not images", () => {
  const buf = receiptWith({ codepage: 22, encoding: "cp864" });
  assert.ok(!buf.includes(RASTER), "no raster images expected in text mode");
  assert.ok(buf.includes(Buffer.from([0x1b, 0x74, 22])), "switches to the chosen code page");
  assert.ok(buf.includes(Buffer.from([0x1b, 0x74, 0])), "switches back for Latin text");
  assert.ok(buf.includes(encodeArabicLine("شاحن سريع", "cp864")!), "item name sent as CP864 text");
});

test("without a code page (the default), Arabic still prints as images", () => {
  assert.ok(receiptWith(null).includes(RASTER));
});

test("a line the code page can't hold falls back to an image; the rest stays text", () => {
  const buf = receiptWith({ codepage: 22, encoding: "cp864" }, "پرویز");
  assert.ok(buf.includes(RASTER), "the Persian name should be an image");
  assert.ok(buf.includes(encodeArabicLine("شاحن سريع", "cp864")!), "other Arabic lines stay text");
});

test("the Arabic test page prints one labelled line per code page and encoding", () => {
  const text = buildArabicTestBuffer({ codepages: [22, 50] }).toString("latin1");
  for (const label of [" 22 864 : ", " 22 1256: ", " 50 864 : ", " 50 1256: "]) {
    assert.ok(text.includes(label), `missing line "${label}"`);
  }
});

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Printer Co", "printer-arabic@example.com");
});
after(async () => { await app.close(); });

test("a printer's Arabic code page is saved, and blank means images", async () => {
  const add = await app.api("POST", "/api/printers", {
    tenantId,
    body: { name: "XP-80C", type: "receipt", connection: "network", address: "127.0.0.1", paper_width: 80, arabic_codepage: "22", arabic_encoding: "cp864" },
  });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const id = Number(add.body.id);
  const get = async () => ((await app.api("GET", "/api/printers", { tenantId })).body as any[]).find(p => p.id === id);
  assert.equal((await get()).arabic_codepage, 22);

  await app.api("PUT", `/api/printers/${id}`, {
    tenantId,
    body: { name: "XP-80C", type: "receipt", connection: "network", address: "127.0.0.1", paper_width: 80, enabled: 1, arabic_codepage: "", arabic_encoding: "cp864" },
  });
  assert.equal((await get()).arabic_codepage, null);
});
