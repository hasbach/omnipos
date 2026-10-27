#!/usr/bin/env node
// Prints a new storefront order-gateway key and its SHA-256 (specs/003-retail-ordering, research R12).
// The key goes ONLY into the Render env var ORDER_GATEWAY_KEY; the cloud stores only the hash
// (INSERT INTO storefront_gateway_keys (key_hash, label) VALUES ('<sha256>', 'render-YYYY-MM')), so the
// secret never appears in the SQL editor history. Writes nothing to disk, reads no env vars, no network.
import { randomBytes, createHash } from "crypto";

const key = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(key, "utf8").digest("hex");

console.log(`key:    ${key}`);
console.log(`sha256: ${hash}`);
console.log("Paste the key into Render ORDER_GATEWAY_KEY; insert only the hash into storefront_gateway_keys.");
