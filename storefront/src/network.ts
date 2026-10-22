// The visitor's network for the order abuse limits (specs/003-retail-ordering research R12). Only a daily-rotating
// hash leaves the storefront: the cloud never sees an address, and the raw address is never logged.
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

// Checked in order. The edge appends the real client to X-Forwarded-For, so only its LAST hop is trusted (earlier
// entries can be typed by the client). Which one Render provides is confirmed once in production (quickstart-s2 §1.5).
const SOURCES = ['cf-connecting-ip', 'true-client-ip', 'x-forwarded-for'] as const;

let sourceLogged = false;

export function visitorNetwork(
  headers: IncomingHttpHeaders, socketAddress: string | undefined, key: string, now = new Date(),
): { hash: string; source: string } {
  let source = 'socket';
  let address = socketAddress || '';
  for (const name of SOURCES) {
    const raw = headers[name];
    const value = (Array.isArray(raw) ? raw[raw.length - 1] : raw)?.trim();
    if (!value) continue;
    address = name === 'x-forwarded-for' ? value.split(',').at(-1)!.trim() : value;
    source = name;
    break;
  }
  if (!sourceLogged) { console.log(`network source: ${source}`); sourceLogged = true; }
  const day = now.toISOString().slice(0, 10);
  return { hash: createHash('sha256').update(`${day}|${address}|${key}`).digest('hex'), source };
}
