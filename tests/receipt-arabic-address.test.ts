// The customer's address is printed on the thermal receipt, and Arabic text (address, names,
// store name) prints correctly. Before, every line went out as `latin1` bytes, so each Arabic
// character became a literal "?" on paper. Arabic lines are now rendered to a GS v 0 raster
// image; Latin-only lines stay plain text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReceiptBuffer } from "../server/printing/receipt.js";

const RASTER = Buffer.from([0x1d, 0x76, 0x30, 0x00]);

function receipt(tx: Record<string, any>, paperWidth = 80) {
  return buildReceiptBuffer({
    storeName: "Acme",
    paperWidth,
    transaction: { id: 1, items: [{ name: "USB Cable", price: 3, quantity: 1 }], total_amount: 3, ...tx },
  });
}

// Every GS v 0 image in the buffer: its width in bytes and height in dots.
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

// The receipt's text bytes with image data cut out (bitmap bytes can contain 0x3F by chance).
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

test("a Latin customer address is printed as plain receipt text", () => {
  const buf = receipt({ stakeholder_name: "Rami", stakeholder_address: "Hamra St, Beirut" });
  const text = buf.toString("latin1");
  assert.ok(text.includes("Customer: Rami"));
  assert.ok(text.includes("Address: Hamra St, Beirut"), "the address line is missing from the receipt");
  assert.equal(rasterImages(buf).length, 0, "Latin-only receipts should not need any images");
});

test("no address line when the customer has no address", () => {
  const text = receipt({ stakeholder_name: "Rami" }).toString("latin1");
  assert.ok(!text.includes("Address:"));
});

test("an Arabic address is rendered as a raster image, never as '?' bytes", () => {
  const address = "بيروت، شارع الحمرا، بناية النور";
  const buf = receipt({ stakeholder_name: "Rami", stakeholder_address: address });
  assert.ok(!textOnly(buf).includes("?"), "Arabic characters were mangled into '?'");
  const images = rasterImages(buf);
  assert.equal(images.length, 1, "expected exactly the address line as an image");
  assert.equal(images[0].widthBytes * 8, 576, "80mm paper is 576 dots wide");
  assert.ok(images[0].height > 0);
});

test("a long Arabic address wraps onto several lines within 58mm paper", () => {
  const address = "بيروت، شارع الحمرا، بناية النور، الطابق الثالث، قرب صيدلية المدينة";
  const images = rasterImages(receipt({ stakeholder_address: address }, 58));
  assert.equal(images.length, 1);
  assert.equal(images[0].widthBytes * 8, 384, "58mm paper is 384 dots wide");
  assert.ok(images[0].height >= 64, "a long address should wrap to more than one line");
});

test("Arabic customer, store and item names also print as images, not '?'", () => {
  const buf = buildReceiptBuffer({
    storeName: "متجر سلوم",
    receiptFooter: "شكراً لزيارتكم",
    transaction: {
      id: 1,
      stakeholder_name: "محمد علي",
      items: [{ name: "شاحن سريع", price: 12.5, quantity: 2 }],
      total_amount: 25,
    },
  });
  assert.ok(!textOnly(buf).includes("?"));
  assert.equal(rasterImages(buf).length, 4, "store name, customer, item and footer should each be an image");
});
