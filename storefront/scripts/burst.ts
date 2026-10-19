// Burst test for a deployed storefront (spec 002 SC-001 / SC-002; quickstart §4). Dev tool, not deployed.
//   npx tsx storefront/scripts/burst.ts https://abc-market.myomnipos.com / /?c=Dairy /p/<listing-id> --requests=2000 --concurrency=20
// Reports status codes, p50 / p95 latency and the CDN cache mix from Render's edge cache (cf-cache-status header):
// every response not served from the edge (MISS, EXPIRED, BYPASS, DYNAMIC, none) is a call to Supabase, so (MISS / requests) is the storefront's share of database reads (target < 5%).

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:\/\//.test(a));
const paths = args.filter((a) => a.startsWith('/'));
const opt = (name: string, def: number) => Number(args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def);
const total = opt('requests', 500);
const concurrency = opt('concurrency', 10);

if (!base || paths.length === 0) {
  console.error('Usage: npx tsx storefront/scripts/burst.ts <base url> <path> [<path>...] [--requests=500] [--concurrency=10]');
  process.exit(2);
}

const latencies: number[] = [];
const statuses = new Map<number, number>();
const cache = new Map<string, number>();
let next = 0;

async function worker() {
  while (next < total) {
    const i = next++;
    const url = base!.replace(/\/$/, '') + paths[i % paths.length];
    const t0 = performance.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'omnipos-burst/1' } });
      await res.arrayBuffer();
      latencies.push(performance.now() - t0);
      statuses.set(res.status, (statuses.get(res.status) || 0) + 1);
      const c = res.headers.get('cf-cache-status') || 'none';
      cache.set(c, (cache.get(c) || 0) + 1);
    } catch {
      statuses.set(0, (statuses.get(0) || 0) + 1);
    }
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const seconds = (performance.now() - started) / 1000;
latencies.sort((a, b) => a - b);
const pct = (p: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] : 0);
const misses = ['MISS', 'EXPIRED', 'BYPASS', 'DYNAMIC', 'none'].reduce((n, k) => n + (cache.get(k) || 0), 0);

console.log(`${total} requests over ${paths.length} URL(s) in ${seconds.toFixed(1)} s (${(total / seconds).toFixed(0)} req/s)`);
console.log('status:', Object.fromEntries(statuses));
console.log(`latency: p50 ${pct(50).toFixed(0)} ms, p95 ${pct(95).toFixed(0)} ms`);
console.log('cache:', Object.fromEntries(cache), `→ upstream share ≈ ${((misses / total) * 100).toFixed(1)}% (target < 5%)`);
