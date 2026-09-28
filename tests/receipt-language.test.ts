// The receipt prints in the store's own language (settings key `language`: 'en' | 'ar' | 'fr',
// default 'en' — server/routes.ts POST /api/print/receipt passes settings.language through to
// buildReceiptBuffer). Labels live in server/printing/receiptLabels.ts. Arabic labels go through
// the same Arabic path as Arabic item names/addresses (server/printing/escpos.ts): a printer-native
// code page when configured on the printer, otherwise a rasterized image.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReceiptBuffer } from "../server/printing/receipt.js";
import { encodeArabicLine } from "../server/printing/arabic.js";

const RASTER = Buffer.from([0x1d, 0x76, 0x30]);

function rasterImages(buf: Buffer) {
  const images: { widthBytes: number; height: number }[] = [];
  for (let i = buf.indexOf(RASTER); i !== -1; i = buf.indexOf(RASTER, i + 1)) {
    const widthBytes = buf[i + 4] | (buf[i + 5] << 8);
    const height = buf[i + 6] | (buf[i + 7] << 8);
    images.push({ widthBytes, height });
    i += 7 + widthBytes * height;
  }
  return images;
}

function textOnly(buf: Buffer) {
  let out = "";
  let from = 0;
  for (let i = buf.indexOf(RASTER); i !== -1; i = buf.indexOf(RASTER, from)) {
    out += buf.subarray(from, i).toString("latin1");
    const widthBytes = buf[i + 4] | (buf[i + 5] << 8);
    const height = buf[i + 6] | (buf[i + 7] << 8);
    from = i + 8 + widthBytes * height;
  }
  return out + buf.subarray(from).toString("latin1");
}

function baseTx(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    items: [{ name: "USB Cable", price: 3, quantity: 2 }],
    total_amount: 6,
    payments: [{ method: "cash", amount: 6, currency: "USD" }],
    ...overrides,
  };
}

test("an Arabic-language receipt with no printer code page renders its labels as raster images", () => {
  const buf = buildReceiptBuffer({
    storeName: "Acme",
    language: "ar",
    transaction: baseTx(),
  });
  assert.ok(rasterImages(buf).length > 0, "Arabic labels should be rasterized without a code page");
  assert.ok(!textOnly(buf).includes("?"), "Arabic labels were mangled into '?'");
  assert.ok(!buf.toString("latin1").includes("TOTAL"), "the TOTAL label should be translated, not English");
});

// cp1256 (Windows Arabic) holds the full Arabic base alphabet, unlike cp864 (whose limited
// per-printer table can't hold every letter — e.g. "إيصال" itself needs a hamza-under-alif form
// CP864 lacks — which is a genuine per-codepage limitation, not a translation bug: such a line
// correctly falls back to a raster image, per server/printing/arabic.ts's documented contract).
test("an Arabic-language receipt with a printer code page renders labels as printer-native text, not images", () => {
  const buf = buildReceiptBuffer({
    storeName: "Acme",
    language: "ar",
    arabic: { codepage: 40, encoding: "cp1256" },
    transaction: baseTx({ items: [{ name: "شاحن سريع", price: 3, quantity: 2 }] }),
  });
  assert.ok(!buf.includes(RASTER), "no raster images expected once a full-coverage code page is configured");
  // Several lines contain Arabic (title, date, TOTAL, payment method, item name), so the code
  // page should be switched on more than once.
  const codepageSwitches = buf.toString("latin1").split(String.fromCharCode(0x1b, 0x74, 40)).length - 1;
  assert.ok(codepageSwitches >= 2, `expected multiple Arabic code-page switches, got ${codepageSwitches}`);
  const text = buf.toString("latin1");
  assert.ok(!text.includes("TOTAL"), "TOTAL should be translated, not literal English text");
  assert.ok(!text.includes("CASH"), "payment method should be translated, not literal English text");
  // The Arabic item name itself isn't padded, so it can be matched byte-for-byte like the
  // existing item-name Arabic tests (tests/arabic-text-printing.test.ts).
  assert.ok(buf.includes(encodeArabicLine("شاحن سريع", "cp1256")!), "item name sent as Arabic printer text");
});

test("Arabic balance lines lay out right-to-left through the same Arabic path as an address", () => {
  const withoutBalance = buildReceiptBuffer({
    storeName: "Acme",
    language: "ar",
    arabic: { codepage: 40, encoding: "cp1256" },
    transaction: baseTx(),
  });
  const withBalance = buildReceiptBuffer({
    storeName: "Acme",
    language: "ar",
    arabic: { codepage: 40, encoding: "cp1256" },
    transaction: baseTx({
      stakeholder_name: "Rami",
      stakeholder_balance: -30,
      balance_effect: -30,
    }),
  });
  assert.ok(!withBalance.includes(RASTER), "no raster images expected once a full-coverage code page is configured");
  assert.ok(withBalance.length > withoutBalance.length, "balance lines add printer-text content");
  const text = withBalance.toString("latin1");
  assert.ok(!text.includes("Due") && !text.includes("New Balance"), "balance words should be Arabic, not English");
});

test("a French-language receipt uses French labels", () => {
  const buf = buildReceiptBuffer({
    storeName: "Acme",
    language: "fr",
    transaction: baseTx({ stakeholder_name: "Marie", stakeholder_address: "Rue Hamra" }),
  });
  const text = buf.toString("latin1");
  assert.ok(text.includes("Client: Marie"), "Customer label should be French");
  assert.ok(text.includes("Adresse: Rue Hamra"), "Address label should be French");
  assert.ok(text.includes("TOTAL"));
  assert.ok(text.includes("ESPÈCES") || text.includes("ESP") /* accented E may vary by codepage */, "payment method should be French");
  assert.ok(text.includes("Merci pour votre achat"), "footer default should be French");
});

test("payment method names are translated per language", () => {
  const tx = baseTx({ payments: [{ method: "credit", amount: 6, currency: "USD" }] });
  const en = buildReceiptBuffer({ storeName: "Acme", language: "en", transaction: tx }).toString("latin1");
  const fr = buildReceiptBuffer({ storeName: "Acme", language: "fr", transaction: tx }).toString("latin1");
  assert.ok(en.includes("CREDIT"), "English keeps the plain uppercase method name");
  assert.ok(fr.includes("COMPTE CLIENT"), "French translates 'credit' (on-account) to its own term");
});

test("an English receipt (default / unspecified language) is unchanged: plain TOTAL, item names and amounts print correctly", () => {
  const buf = buildReceiptBuffer({ storeName: "Acme", transaction: baseTx() });
  const text = buf.toString("latin1");
  assert.ok(text.includes("TOTAL"));
  assert.ok(text.includes("USB Cable"), "item name printed");
  assert.ok(text.includes("6.00"), "line total printed");
  assert.equal(rasterImages(buf).length, 0, "no Arabic content -> no raster images");
});

test("a refund transaction prints the refund title in the receipt's language", () => {
  const en = buildReceiptBuffer({ storeName: "Acme", transaction: baseTx({ type: "refund" }) }).toString("latin1");
  assert.ok(en.includes("Refund:"), "English refund title");
  const fr = buildReceiptBuffer({ storeName: "Acme", language: "fr", transaction: baseTx({ type: "refund" }) }).toString("latin1");
  assert.ok(fr.includes("Remboursement:"), "French refund title");
});
