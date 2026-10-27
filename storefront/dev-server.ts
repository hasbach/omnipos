// Local storefront: the production Node server (src/node-server.ts) with no-cache assets.
//   npx tsx storefront/dev-server.ts                  → cloud data (public catalog RPCs, read-only)
//   npx tsx storefront/dev-server.ts --source=fixture → in-memory demo store "beirut-market"
//   add --ordering                                    → the demo store takes WhatsApp orders (003)
// Open http://localhost:3200/s/<address> (path form; subdomains need a real domain).
import { loadConfig } from './src/config.js';
import { SupabaseRpcSource, type DataSource } from './src/data.js';
import { FixtureSource, FixtureOrderGateway, demoFixture } from './src/fixture.js';
import { createStorefrontServer } from './src/node-server.js';

const PORT = Number(process.env.STOREFRONT_PORT || 3200);
const useFixture = process.argv.includes('--source=fixture');
const config = loadConfig();
const ordering = process.argv.includes('--ordering=online') ? 'online' : process.argv.includes('--ordering');
if (useFixture && ordering === 'online') config.orderGatewayKey = 'fixture-only';
const data: DataSource = useFixture ? new FixtureSource(demoFixture(60, { ordering })) : new SupabaseRpcSource(config.supabaseUrl, config.supabaseAnonKey);

createStorefrontServer({ config, data, gateway: useFixture ? new FixtureOrderGateway(data as FixtureSource) : undefined, assetCache: 'no-cache' }).listen(PORT, () => {
  console.log(`Storefront dev server on http://localhost:${PORT}/s/${useFixture ? 'beirut-market' : '<address>'} (${useFixture ? 'fixture' : 'cloud'} data)`);
});
