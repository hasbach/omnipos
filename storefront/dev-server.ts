// Local storefront: the production Node server (src/node-server.ts) with no-cache assets.
//   npx tsx storefront/dev-server.ts                  → cloud data (public catalog RPCs, read-only)
//   npx tsx storefront/dev-server.ts --source=fixture → in-memory demo store "beirut-market"
// Open http://localhost:3200/s/<address> (path form; subdomains need a real domain).
import { loadConfig } from './src/config.js';
import { SupabaseRpcSource, type DataSource } from './src/data.js';
import { FixtureSource } from './src/fixture.js';
import { createStorefrontServer } from './src/node-server.js';

const PORT = Number(process.env.STOREFRONT_PORT || 3200);
const useFixture = process.argv.includes('--source=fixture');
const config = loadConfig();
const data: DataSource = useFixture ? new FixtureSource() : new SupabaseRpcSource(config.supabaseUrl, config.supabaseAnonKey);

createStorefrontServer({ config, data, assetCache: 'no-cache' }).listen(PORT, () => {
  console.log(`Storefront dev server on http://localhost:${PORT}/s/${useFixture ? 'beirut-market' : '<address>'} (${useFixture ? 'fixture' : 'cloud'} data)`);
});
