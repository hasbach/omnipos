// Statement on the receipt printer: ESC/POS buffer (Arabic via raster image or code page) and the
// print route sending it to the configured printer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let productId: number;
let cust: number;
let fakePrinter: net.Server;
let received: Buffer[] = [];
const RASTER = Buffer.from([0x1d, 0x76, 0x30, 0x00]);

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Print Stmt Co", "print-stmt@example.com");
  productId = seedProduct(app.db, tenantId, { barcode: "PS-1", name: "Paper Roll", price: 25, stock: 500 });
  cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "محمد الحسن", type: "customer", address: "بيروت" } })).body.id;
  const r = await app.api("POST", "/api/transactions", { tenantId, body: { type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  fakePrinter = net.createServer((s) => s.on("data", (c) => received.push(c)));
  await new Promise<void>((resolve) => fakePrinter.listen(0, "127.0.0.1", resolve));
});
after(async () => { fakePrinter.close(); await app.close(); });

const docFor = async (mode: "open" | "activity", language: "en" | "fr" = "en") => {
  const { buildStatementDocument } = await import("../server/statementDocument.js");
  return buildStatementDocument(tenantId, cust, mode === "open" ? { mode } : { mode, from: "2000-01-01", to: "2100-01-01" },
    { name: "Acme", address: "", phone: "", language })!;
};

test("ESC/POS open statement: Latin text plain, Arabic name as an image, total printed", async () => {
  const { buildStatementBuffer } = await import("../server/printing/statement.js");
  for (const width of [80, 58]) {
    const buf = buildStatementBuffer({ doc: await docFor("open"), paperWidth: width });
    const text = buf.toString("latin1");
    assert.ok(text.includes("Paper Roll"), `item line at ${width}mm`);
    assert.ok(text.includes("Total due"), `total line at ${width}mm`);
    assert.ok(text.includes("$25.00"));
    assert.ok(buf.indexOf(RASTER) !== -1, "Arabic customer name rendered as a raster image");
  }
});

test("ESC/POS with an Arabic code page prints the name as text, not images", async () => {
  const { buildStatementBuffer } = await import("../server/printing/statement.js");
  const buf = buildStatementBuffer({ doc: await docFor("open"), paperWidth: 80, arabic: { codepage: 22, encoding: "cp864" } as any });
  assert.equal(buf.indexOf(RASTER), -1);
});

test("ESC/POS activity statement prints opening and closing balances", async () => {
  const { buildStatementBuffer } = await import("../server/printing/statement.js");
  const text = buildStatementBuffer({ doc: await docFor("activity"), paperWidth: 80 }).toString("latin1");
  assert.ok(text.includes("Opening balance"));
  assert.ok(text.includes("Closing balance"));
});

test("POST /api/print/statement: 404 without a printer, then sends bytes to the configured printer", async () => {
  const none = await app.api("POST", "/api/print/statement", { tenantId, body: { stakeholderId: cust, mode: "open" } });
  assert.equal(none.status, 404);
  assert.equal(none.body.code, "no_receipt_printer");

  app.db.prepare(`INSERT INTO printers (tenant_id, name, type, connection, address, paper_width, is_default, enabled)
    VALUES (?, 'Counter', 'receipt', 'network', ?, 80, 1, 1)`).run(tenantId, `127.0.0.1:${(fakePrinter.address() as any).port}`);

  const bad = await app.api("POST", "/api/print/statement", { tenantId, body: { stakeholderId: cust, mode: "activity" } });
  assert.equal(bad.status, 400);

  received = [];
  const ok = await app.api("POST", "/api/print/statement", { tenantId, body: { stakeholderId: cust, mode: "open" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(Buffer.concat(received).toString("latin1").includes("Paper Roll"));
});

// The receipt's text bytes with raster image data cut out (bitmap bytes can look like control codes).
function textOnly(buf: Buffer) {
  const RASTER_HDR = Buffer.from([0x1d, 0x76, 0x30, 0x00]);
  let out = "", from = 0;
  for (let i = buf.indexOf(RASTER_HDR); i !== -1; i = buf.indexOf(RASTER_HDR, from)) {
    out += buf.subarray(from, i).toString("latin1");
    from = i + 8 + (buf[i + 4] | (buf[i + 5] << 8)) * (buf[i + 6] | (buf[i + 7] << 8));
  }
  return out + buf.subarray(from).toString("latin1");
}

test("French activity statement stays latin1-safe: no em dash / curly apostrophe control bytes", async () => {
  const { buildStatementBuffer } = await import("../server/printing/statement.js");
  const text = textOnly(buildStatementBuffer({ doc: await docFor("activity", "fr"), paperWidth: 80 }));
  for (const bad of [0x14, 0x19, 0x13]) assert.ok(!text.includes(String.fromCharCode(bad)), `control byte 0x${bad.toString(16)}`);
  assert.ok(text.includes("Solde d'ouverture"));
});

test("latinSafe: control bytes and line breaks never reach the printer; look-alikes mapped; Arabic kept", async () => {
  const { latinSafe } = await import("../server/printing/statement.js");
  assert.equal(latinSafe("a\nb\r\nc"), "a b c");
  assert.equal(latinSafe("a\tb"), "a b");
  assert.equal(latinSafe("x\x1b@y\x1dVz"), "x?@y?Vz");
  assert.equal(latinSafe("\x00\x7f\x9b"), "???");
  assert.equal(latinSafe("a \u2014 b"), "a - b");
  assert.equal(latinSafe("l\u2019eau"), "l'eau");
  assert.equal(latinSafe("caf\u00e9"), "caf\u00e9");
  assert.equal(latinSafe("\u4e2d"), "?");
  assert.equal(latinSafe("a   b"), "a   b", "padding spaces are kept for column layout");
  const ar = "\u0645\u062d\u0645\u062f \u0627\u0644\u062d\u0633\u0646";
  assert.equal(latinSafe(ar), ar);
  assert.equal(latinSafe(ar.replace(" ", "\n")), ar);
  assert.equal(latinSafe(ar + "\x1b"), ar + "?");
});

test("a partially refunded order shows a Returned line in ESC/POS and HTML", async () => {
  const c = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Returner", type: "customer" } })).body.id;
  const s = await app.api("POST", "/api/transactions", { tenantId, body: { type: "sale", stakeholder_id: c, items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1, payments: [] } });
  const rf = await app.api("POST", "/api/transactions", { tenantId, body: { type: "refund", original_transaction_id: s.body.id, stakeholder_id: c, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] } });
  assert.equal(rf.status, 200, JSON.stringify(rf.body));
  const { buildStatementDocument } = await import("../server/statementDocument.js");
  const { buildStatementBuffer } = await import("../server/printing/statement.js");
  const { renderStatementHtml } = await import("../server/statementHtml.js");
  const doc = buildStatementDocument(tenantId, c, { mode: "open" }, { name: "Acme", address: "", phone: "", language: "en" })!;
  assert.equal(doc.open!.orders[0].returned, 25);
  const text = buildStatementBuffer({ doc, paperWidth: 80 }).toString("latin1");
  assert.ok(/Returned\s+\$25\.00/.test(text), "ESC/POS Returned line");
  assert.ok(!/Paid\s+\$/.test(text), "refund credit is not printed as paid");
  for (const f of ["a4", "receipt"] as const) assert.ok(/Returned<\/td><td class="end"><span class="n" dir="ltr">\$25\.00/.test(renderStatementHtml(doc, f)), f);
});
