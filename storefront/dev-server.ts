// Local storefront: the production handler on Node http, serving public/ too.
//   npx tsx storefront/dev-server.ts                  → cloud data (public catalog RPCs, read-only)
//   npx tsx storefront/dev-server.ts --source=fixture → in-memory demo store "beirut-market"
// Open http://localhost:3200/s/<address> (path form; subdomains need a real domain).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './src/config.js';
import { SupabaseRpcSource, type DataSource } from './src/data.js';
import { FixtureSource } from './src/fixture.js';
import { handle } from './src/http.js';
import { ASSET_VERSION } from './src/assets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.STOREFRONT_PORT || 3200);
const useFixture = process.argv.includes('--source=fixture');
const config = loadConfig();
const data: DataSource = useFixture ? new FixtureSource() : new SupabaseRpcSource(config.supabaseUrl, config.supabaseAnonKey);
const TYPES: Record<string, string> = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  try {
    const pathname = (req.url || '/').split('?')[0];
    const asset = ['/storefront.css', '/storefront.js', '/placeholder.svg'].includes(pathname) ? path.join(here, 'public', pathname) : null;
    if (asset) {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(asset)], 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(asset));
      return;
    }
    const out = await handle({ host: String(req.headers.host || ''), url: req.url || '/' }, { config, data, assetVersion: ASSET_VERSION });
    res.writeHead(out.status, out.headers);
    res.end(typeof out.body === 'string' ? out.body : Buffer.from(out.body));
  } catch (e: any) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(String(e?.stack || e));
  }
}).listen(PORT, () => {
  console.log(`Storefront dev server on http://localhost:${PORT}/s/${useFixture ? 'beirut-market' : '<address>'} (${useFixture ? 'fixture' : 'cloud'} data)`);
});
