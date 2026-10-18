// Store web addresses that no business may claim (spec 002 FR-004): names OmniPOS needs on the storefront
// domain. The single source for the storefront router AND the back office (server/commerce.ts imports it);
// the cloud claim_store_slug() carries the same list — tests/commerce-store.test.ts checks they match.
// Dependency-free on purpose: the storefront is deployed from this folder alone.
export const RESERVED_SLUGS: readonly string[] = [
  'www', 'api', 'app', 'admin', 'mail', 'email', 'smtp', 'ftp', 'monitor', 'status', 'help', 'support', 'docs',
  'blog', 'shop', 'store', 'stores', 'cdn', 'static', 'assets', 'media', 'img', 'images', 'login', 'signup',
  'account', 'dashboard', 'omnipos', 'test', 'demo',
];
