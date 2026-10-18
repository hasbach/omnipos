// Vercel entry point: every non-asset request lands here (storefront/vercel.json) and is handed to the
// platform-independent handler in src/http.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig } from '../src/config.js';
import { SupabaseRpcSource } from '../src/data.js';
import { handle } from '../src/http.js';
import { ASSET_VERSION } from '../src/assets.js';

const config = loadConfig();
const data = new SupabaseRpcSource(config.supabaseUrl, config.supabaseAnonKey);

export default async function storefront(req: IncomingMessage, res: ServerResponse) {
  const out = await handle({ host: String(req.headers['x-forwarded-host'] || req.headers.host || ''), url: req.url || '/' }, { config, data, assetVersion: ASSET_VERSION });
  res.statusCode = out.status;
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.end(typeof out.body === 'string' ? out.body : Buffer.from(out.body));
}
