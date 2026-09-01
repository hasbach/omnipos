// Regression test for Bug 4 from the audit: printing a receipt should reach the configured
// printer directly — no Windows print dialog. There's no dialog to assert the absence of in a
// headless test (a dialog is an OS/GUI concept), so this proves the thing that actually matters:
// with a printer configured, POST /api/print/receipt completes as a single server-side call that
// sends real ESC/POS bytes straight to the printer's connection — a self-contained request/response
// with no window, no browser print API, and nothing for a dialog to interrupt.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let productId: number;
let fakePrinter: net.Server;
let printerPort: number;
let receivedChunks: Buffer[] = [];

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Printer Test Co", "printer-test@example.com");
  productId = seedProduct(app.db, tenantId, { barcode: "PRN-1", name: "Receipt Paper", price: 15 });

  // A real TCP listener standing in for a network (Ethernet/WiFi) receipt printer's RAW/JetDirect
  // port — server/printing/transport.ts writes raw bytes to exactly this kind of socket.
  fakePrinter = net.createServer((socket) => {
    socket.on("data", (chunk) => receivedChunks.push(chunk));
  });
  await new Promise<void>((resolve) => fakePrinter.listen(0, "127.0.0.1", resolve));
  printerPort = (fakePrinter.address() as any).port;

  app.db.prepare(
    `INSERT INTO printers (tenant_id, name, type, connection, address, paper_width, is_default, enabled)
     VALUES (?, 'Front Counter', 'receipt', 'network', ?, 80, 1, 1)`
  ).run(tenantId, `127.0.0.1:${printerPort}`);
});

after(async () => {
  fakePrinter.close();
  await app.close();
});

test("printing a receipt with a printer configured sends real bytes directly, in one call", async () => {
  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "sale",
      items: [{ id: productId, quantity: 1 }],
      currency: "USD",
      exchange_rate: 1,
      payments: [{ amount: 15, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));

  const printResult = await app.api("POST", "/api/print/receipt", {
    tenantId,
    body: { transactionId: sale.body.id },
  });
  assert.equal(printResult.status, 200, JSON.stringify(printResult.body));
  assert.equal(printResult.body.success, true);

  // Give the TCP write a moment to land (it's already sent by the time the HTTP response came
  // back, since sendToPrinter is awaited before responding — this just lets the event loop flush).
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(receivedChunks.length > 0, "the printer never received any bytes");
  const received = Buffer.concat(receivedChunks).toString("latin1");
  assert.ok(received.includes("Receipt Paper"), "the printed receipt did not contain the sold item");
});
