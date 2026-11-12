// Production entry (Coolify on the Contabo VPS, see storefront/README.md): `npm start` in storefront/.
// PORT is set by the host (10000 by default); the Cloudflare edge cache in front honours the Cache-Control headers set by src/http.ts.
import { loadConfig } from './src/config.js';
import { SupabaseRpcSource } from './src/data.js';
import { createStorefrontServer } from './src/node-server.js';

const config = loadConfig();
const data = new SupabaseRpcSource(config.supabaseUrl, config.supabaseAnonKey);
const PORT = Number(process.env.PORT || 10000);

const server = createStorefrontServer({ config, data });
server.keepAliveTimeout = 65_000; // longer than the edge proxy's idle timeout, so it never reuses a closed socket
server.listen(PORT, '0.0.0.0', () => console.log(`Storefront on :${PORT} for *.${config.storefrontDomain}`));

process.on('SIGTERM', () => server.close(() => process.exit(0)));
