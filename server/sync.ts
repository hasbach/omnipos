import { db } from './db.js';
import { getActiveSession } from './session.js';
import { recomputeAllBalances } from './balance.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// Offline-first sync, scoped to the ONE tenant currently logged in (see server/session.ts).
// All cloud access goes through that tenant's authenticated Supabase client, so Row Level
// Security scopes every read/write to their own rows — no service-role key ships in the app.

// Foreign Key mapping: TableName -> { ColumnName: ReferencedTable }
const fkMap: Record<string, Record<string, string>> = {
  products: { tenant_id: 'tenants' },
  product_barcodes: { product_id: 'products' },
  product_units: { tenant_id: 'tenants', product_id: 'products' },
  stakeholders: { tenant_id: 'tenants' },
  users: { tenant_id: 'tenants' },
  transactions: { tenant_id: 'tenants', stakeholder_id: 'stakeholders', user_id: 'users' },
  // uom_id / original_item_id are local ids too: they travel as global UUIDs so another register
  // resolves them to ITS rows (an unresolvable original line falls back to per-product allocation).
  transaction_items: { transaction_id: 'transactions', product_id: 'products', uom_id: 'product_units', original_item_id: 'transaction_items' },
  payments: { transaction_id: 'transactions' },
  currencies: { tenant_id: 'tenants' },
  settings: { tenant_id: 'tenants' },
  cash_flow: { tenant_id: 'tenants', user_id: 'users' },
  daily_reports: { tenant_id: 'tenants', user_id: 'users' },
  cashier_shifts: { tenant_id: 'tenants', user_id: 'users' },
  settlement_corrections: { tenant_id: 'tenants', report_id: 'daily_reports', user_id: 'users' },
  cash_flow_categories: { tenant_id: 'tenants' },
};

function getGlobalId(tableName: string, localId: number) {
  if (!localId) return null;
  try {
    const row = db.prepare(`SELECT global_id FROM ${tableName} WHERE id = ?`).get(localId) as any;
    return row?.global_id || null;
  } catch (e) { return null; }
}

function getLocalId(tableName: string, globalId: string) {
  if (!globalId) return null;
  try {
    const row = db.prepare(`SELECT id FROM ${tableName} WHERE global_id = ?`).get(globalId) as any;
    return row?.id || null;
  } catch (e) { return null; }
}

const SYNC_INTERVAL_MS = 10000; // 10 seconds

// Tenant data reset support (server/tenantReset.ts). While a reset runs, NO push or pull may touch
// the cloud or the local tables: an in-flight pull would re-insert rows the reset just deleted, and
// an in-flight push would upsert rows back into the cloud right after they were purged.
// `pauseSync()` raises the flag and waits for any cycle already in flight to drain (the loops below
// check the flag between tables, so the wait is short); `resumeSync()` lowers it.
let syncPaused = false;
const inFlight = new Set<Promise<unknown>>();
function track<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  const done = () => { inFlight.delete(p); };
  p.then(done, done);
  return p;
}
export function isSyncPaused(): boolean { return syncPaused; }
export async function pauseSync(): Promise<void> {
  syncPaused = true;
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}
export function resumeSync(): void { syncPaused = false; }

// Local columns the cloud table doesn't have yet (e.g. a new column like stakeholders.address
// before its Supabase migration has been run). PostgREST rejects the WHOLE upsert with PGRST204
// for one unknown column, so rather than blocking all sync for that table we learn the column
// here, strip it from the payload, and retry. Reset on restart, so it's re-probed after migrating.
const cloudMissingColumns: Record<string, Set<string>> = {};

async function upsertToCloud(client: SupabaseClient, tableName: string, payload: any) {
  const rows: any[] = Array.isArray(payload) ? payload : [payload];
  for (let attempt = 0; attempt < 5; attempt++) {
    const missing = cloudMissingColumns[tableName];
    if (missing) for (const r of rows) for (const col of missing) delete r[col];
    const { error } = await client.from(tableName).upsert(Array.isArray(payload) ? rows : rows[0], { onConflict: 'global_id' });
    const col = error?.code === 'PGRST204' ? /'([^']+)' column/.exec(error.message || '')?.[1] : undefined;
    if (!col || missing?.has(col)) return { error };
    console.warn(`⚠️ [SYNC] Cloud ${tableName} has no '${col}' column — pushing without it until the cloud schema is migrated.`);
    (cloudMissingColumns[tableName] ||= new Set()).add(col);
  }
  return { error: { message: `Too many unknown columns for ${tableName}` } };
}

// A table the cloud doesn't have yet (its Supabase migration hasn't been run, e.g. product_units):
// PostgREST answers PGRST205 / Postgres 42P01 / a 404. Skip that table with ONE warning instead of
// failing (or spamming) every sync cycle. Reset on restart, so it's re-probed after migrating.
const cloudMissingTables = new Set<string>();
function isMissingCloudTable(error: any): boolean {
  if (!error) return false;
  return error.code === 'PGRST205' || error.code === '42P01' || error.status === 404 || error.statusCode === 404;
}
function noteMissingCloudTable(tableName: string) {
  if (cloudMissingTables.has(tableName)) return;
  cloudMissingTables.add(tableName);
  console.warn(`⚠️ [SYNC] Cloud has no '${tableName}' table yet — skipping it until the cloud schema is migrated.`);
}

// A table whose push keeps failing (rows the cloud rejects every time) is retried with exponential
// backoff instead of every cycle, so one bad row can't hammer the cloud with a request per row every
// 10 seconds. Cleared by the first fully successful push; reset on restart.
const MAX_PUSH_BACKOFF_MS = 10 * 60 * 1000;
const pushBackoff: Record<string, { failures: number; until: number }> = {};
function notePushFailure(tableName: string) {
  const failures = (pushBackoff[tableName]?.failures || 0) + 1;
  const delay = Math.min(SYNC_INTERVAL_MS * 2 ** failures, MAX_PUSH_BACKOFF_MS);
  pushBackoff[tableName] = { failures, until: Date.now() + delay };
  console.warn(`⏳ [SYNC] ${tableName}: push failed ${failures}x — next attempt in ${Math.round(delay / 1000)}s`);
}

// Extra barcodes are soft-deleted (server/barcodes.ts), but rows written by older versions were hard-
// deleted locally and stayed live in the cloud. Before pushing live barcodes, mark any OTHER live cloud
// row with the same barcode as deleted (RLS limits this to the tenant's own rows), so the cloud keeps
// one live row per barcode. Soft delete only: the old rows remain in the cloud and can be restored.
async function retireCloudBarcodeDuplicates(client: SupabaseClient, rows: any[]) {
  const live = rows.filter((r) => !r.deleted_at && r.barcode && r.global_id);
  const CHUNK = 100;
  for (let i = 0; i < live.length; i += CHUNK) {
    const chunk = live.slice(i, i + CHUNK);
    const now = new Date().toISOString();
    const { error } = await client.from('product_barcodes')
      .update({ deleted_at: now, updated_at: now })
      .in('barcode', chunk.map((r) => r.barcode))
      .not('global_id', 'in', `(${chunk.map((r) => r.global_id).join(',')})`)
      .is('deleted_at', null);
    if (error) console.warn('⚠️ [SYNC] Could not retire duplicate cloud barcodes:', JSON.stringify(error));
  }
}

// Quantities that are REAL locally (kg/g products, fractional unit factors) pick up floating-point
// noise from stock arithmetic (1.8000000000000016, -6.1e-30). Round them before pushing so the cloud
// stores clean values. Only these columns: money columns keep full precision (LBP conversions).
const QUANTITY_COLUMNS: Record<string, string[]> = {
  products: ['stock', 'reorder_point', 'units_per_package'],
};
export function cleanQuantity(v: any) {
  if (typeof v !== 'number' || !Number.isFinite(v) || Number.isInteger(v)) return v;
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

// The tenants row is authoritative in the cloud (created at registration, license edited by the
// super-admin) — the desktop only ever PULLS it, never pushes, so it can't stomp a freshly
// activated license with a stale local copy.
const PUSH_TABLES = [
  'products', 'product_barcodes', 'product_units', 'stakeholders', 'users',
  'transactions', 'transaction_items', 'payments',
  'currencies', 'settings', 'cash_flow_categories', 'cash_flow', 'daily_reports', 'cashier_shifts', 'settlement_corrections',
];

const PULL_TABLES = [
  'tenants',
  'products', 'product_barcodes', 'product_units', 'stakeholders', 'users',
  'transactions', 'transaction_items', 'payments',
  'currencies', 'settings', 'cash_flow_categories', 'cash_flow', 'daily_reports', 'cashier_shifts', 'settlement_corrections',
];

// Should the active tenant sync at all? Seed/super-admin accounts have no cloud business data.
function syncableTenant(email: string): boolean {
  return !['hasbach', 'demo@example.com', 'admin@example.com'].includes(email);
}

/**
 * Pushes the active tenant's local changes to Supabase (records where updated_at > last_synced_at).
 */
async function pushToCloud(client: SupabaseClient, localId: number) {
  for (const tableName of PUSH_TABLES) {
    if (syncPaused) return;
    if (cloudMissingTables.has(tableName)) continue;
    if (Date.now() < (pushBackoff[tableName]?.until || 0)) continue;
    try {
      let queryStr = `SELECT * FROM ${tableName} WHERE (last_synced_at IS NULL OR updated_at > last_synced_at)`;
      if (Object.keys(fkMap[tableName] || {}).includes('tenant_id')) {
        queryStr += ` AND tenant_id = ${localId}`;
      } else if (tableName === 'product_barcodes') {
        queryStr += ` AND product_id IN (SELECT id FROM products WHERE tenant_id = ${localId})`;
      } else if (tableName === 'transaction_items' || tableName === 'payments') {
        queryStr += ` AND transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ${localId})`;
      }
      const unsyncedRecords = db.prepare(queryStr).all() as any[];
      if (unsyncedRecords.length === 0) continue;

      // Map local integer 'id' -> 'local_id', strip 'last_synced_at', translate FK ids -> UUIDs.
      // `balance_baseline` is a local-only column (see server/balance.ts) — never push it to the
      // cloud, whose stakeholders table doesn't have it (pushing an unknown column errors).
      const payload = unsyncedRecords.map(record => {
        const { id, last_synced_at, balance_baseline, ...rest } = record;
        const mapped: any = { ...rest };
        if (id !== undefined) mapped.local_id = id;
        for (const col of QUANTITY_COLUMNS[tableName] || []) if (col in mapped) mapped[col] = cleanQuantity(mapped[col]);
        if (fkMap[tableName]) {
          for (const [col, refTable] of Object.entries(fkMap[tableName])) {
            if (mapped[col]) mapped[col] = getGlobalId(refTable, mapped[col]);
          }
        }
        return mapped;
      });

      const markSynced = db.prepare(`UPDATE ${tableName} SET last_synced_at = CURRENT_TIMESTAMP WHERE global_id = ?`);

      if (tableName === 'product_barcodes') await retireCloudBarcodeDuplicates(client, payload);

      const { error } = await upsertToCloud(client, tableName, payload);
      if (isMissingCloudTable(error)) { noteMissingCloudTable(tableName); continue; }
      if (!error) {
        const tx = db.transaction((records: any[]) => {
          for (const record of records) markSynced.run(record.global_id);
        });
        tx(unsyncedRecords);
        delete pushBackoff[tableName];
      } else {
        // A whole-batch upsert fails if EVEN ONE row is bad (e.g. an FK the cloud rejects),
        // which would otherwise block every other row indefinitely. Fall back to per-row so the
        // good rows still sync and the offending row is isolated (and named) in the log.
        console.error(`❌ [SYNC] Batch push failed for ${tableName}, retrying row-by-row:`, JSON.stringify(error));
        let pushed = 0;
        for (let i = 0; i < payload.length; i++) {
          const { error: rowErr } = await upsertToCloud(client, tableName, payload[i]);
          if (rowErr) {
            console.error(`❌ [SYNC] Skipping ${tableName} global_id=${unsyncedRecords[i].global_id}:`, JSON.stringify(rowErr));
          } else {
            markSynced.run(unsyncedRecords[i].global_id);
            pushed++;
          }
        }
        console.log(`↻ [SYNC] ${tableName}: pushed ${pushed}/${payload.length} rows individually`);
        if (pushed < payload.length) notePushFailure(tableName); else delete pushBackoff[tableName];
      }
    } catch (err) {
      console.error(`❌ [SYNC] Error pushing ${tableName}:`, err);
      notePushFailure(tableName);
    }
  }
}

/**
 * Pulls the active tenant's newer cloud rows into local SQLite.
 */
async function pullFromCloud(client: SupabaseClient, localId: number, globalId: string) {
  async function fetchChunked(tableName: string, columnName: string, ids: string[], lastUpdate: string) {
    const CHUNK_SIZE = 100;
    let allResults: any[] = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const { data, error } = await client.from(tableName).select('*').gt('updated_at', lastUpdate).in(columnName, chunk);
      if (error) return { data: null, error };
      if (data) allResults = allResults.concat(data);
    }
    return { data: allResults, error: null };
  }

  for (const tableName of PULL_TABLES) {
    if (syncPaused) return;
    if (cloudMissingTables.has(tableName)) continue;
    try {
      // Latest updated_at we already hold locally for this tenant (our pull cursor).
      let lastUpdateQuery = `SELECT MAX(updated_at) as last_update FROM ${tableName}`;
      let queryParams: any[] = [];
      if (tableName === 'tenants') {
        lastUpdateQuery += ` WHERE id = ?`;
        queryParams = [localId];
      } else if (Object.keys(fkMap[tableName] || {}).includes('tenant_id')) {
        lastUpdateQuery += ` WHERE tenant_id = ?`;
        queryParams = [localId];
      } else if (tableName === 'product_barcodes') {
        lastUpdateQuery += ` WHERE product_id IN (SELECT id FROM products WHERE tenant_id = ?)`;
        queryParams = [localId];
      } else if (tableName === 'transaction_items' || tableName === 'payments') {
        lastUpdateQuery += ` WHERE transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ?)`;
        queryParams = [localId];
      }
      const result = db.prepare(lastUpdateQuery).get(...queryParams) as any;
      const lastUpdate = result?.last_update || '1970-01-01T00:00:00.000Z';

      let data: any[] | null = null;
      let error: any = null;

      if (tableName === 'tenants') {
        const res = await client.from(tableName).select('*').gt('updated_at', lastUpdate).eq('global_id', globalId);
        data = res.data; error = res.error;
      } else if (Object.keys(fkMap[tableName] || {}).includes('tenant_id')) {
        const res = await client.from(tableName).select('*').gt('updated_at', lastUpdate).eq('tenant_id', globalId);
        data = res.data; error = res.error;
      } else if (tableName === 'product_barcodes') {
        const products = db.prepare(`SELECT global_id FROM products WHERE tenant_id = ? AND global_id IS NOT NULL`).all(localId) as any[];
        const productIds = products.map(p => p.global_id);
        if (productIds.length === 0) continue;
        const res = await fetchChunked(tableName, 'product_id', productIds, lastUpdate);
        data = res.data; error = res.error;
      } else if (tableName === 'transaction_items' || tableName === 'payments') {
        const transactions = db.prepare(`SELECT global_id FROM transactions WHERE tenant_id = ? AND global_id IS NOT NULL`).all(localId) as any[];
        const txIds = transactions.map(t => t.global_id);
        if (txIds.length === 0) continue;
        const res = await fetchChunked(tableName, 'transaction_id', txIds, lastUpdate);
        data = res.data; error = res.error;
      }

      if (isMissingCloudTable(error)) { noteMissingCloudTable(tableName); continue; }
      if (error) {
        console.error(`❌ [SYNC] Failed to pull ${tableName}:`, JSON.stringify(error));
        continue;
      }
      if (!data || data.length === 0) continue;

      // Strip cloud 'local_id'/'id', normalize timestamps, translate FK UUIDs -> local ids.
      const mappedData = data.map(record => {
        const { local_id, id, ...rest } = record;
        const mapped: any = { ...rest };
        if (mapped.updated_at) mapped.updated_at = mapped.updated_at.replace('T', ' ').replace('Z', '');
        if (mapped.created_at) mapped.created_at = mapped.created_at.replace('T', ' ').replace('Z', '');
        if (mapped.deleted_at) mapped.deleted_at = mapped.deleted_at.replace('T', ' ').replace('Z', '');
        if (fkMap[tableName]) {
          for (const [col, refTable] of Object.entries(fkMap[tableName])) {
            if (mapped[col]) mapped[col] = getLocalId(refTable, mapped[col]);
          }
        }
        return mapped;
      });

      const columns = Object.keys(mappedData[0]);
      const updateSet = columns.map(col => `${col} = ?`).join(', ');
      const insertCols = columns.join(', ');
      const insertVals = columns.map(() => '?').join(', ');

      const checkStmt = db.prepare(`SELECT 1 FROM ${tableName} WHERE global_id = ?`);
      const updateStmt = db.prepare(`UPDATE ${tableName} SET ${updateSet} WHERE global_id = ?`);
      const insertStmt = db.prepare(`INSERT INTO ${tableName} (${insertCols}) VALUES (${insertVals})`);
      const barcodeHolder = tableName === 'product_barcodes'
        ? db.prepare(`SELECT id, deleted_at FROM product_barcodes WHERE barcode = ?`) : null;
      const purgeBarcode = tableName === 'product_barcodes'
        ? db.prepare(`DELETE FROM product_barcodes WHERE id = ?`) : null;

      const tx = db.transaction((records: any[]) => {
        for (const record of records) {
          const exists = checkStmt.get(record.global_id);
          if (!exists && barcodeHolder) {
            // product_barcodes.barcode is UNIQUE locally: a cloud row we don't have must not collide
            // with a local row (which would fail the whole pull of this table every cycle).
            if (record.deleted_at) continue; // a removal we never held — nothing to store
            const holder = barcodeHolder.get(record.barcode) as any;
            if (holder && !holder.deleted_at) continue; // live here already; our push wins
            if (holder) purgeBarcode!.run(holder.id);
          }
          const values = columns.map(col => record[col] ?? null);
          if (exists) updateStmt.run(...values, record.global_id);
          else insertStmt.run(...values);
        }
      });
      tx(mappedData);
    } catch (err) {
      console.error(`❌ [SYNC] Error pulling ${tableName}:`, err);
    }
  }
}

/**
 * One full sync cycle for the currently logged-in tenant. No-op if nobody is logged in
 * (no active cloud session) or the active account is a seed/super-admin account.
 */
// The interval fires every 10s whether or not the previous cycle finished; when the cloud is slow,
// overlapping cycles would push the same rows again and again. Only one cycle runs at a time.
let cycleInFlight: Promise<void> | null = null;
function runSyncCycle(): Promise<void> {
  if (syncPaused) return Promise.resolve();
  if (cycleInFlight) return cycleInFlight;
  cycleInFlight = track(runSyncCycleInner()).finally(() => { cycleInFlight = null; });
  return cycleInFlight;
}
async function runSyncCycleInner() {
  const session = getActiveSession();
  if (!session || !session.globalId || !syncableTenant(session.email)) return;
  await pushToCloud(session.client, session.localId);
  await pullFromCloud(session.client, session.localId, session.globalId);
  // A pull may have changed transactions/payments without going through the local write paths,
  // so re-derive balances from the freshly-synced data (see server/balance.ts).
  recomputeAllBalances(session.localId, { source: 'sync' });
}

/**
 * Forces an immediate pull for the active tenant (used right after login to populate local data).
 */
export function forceInitialSync(): Promise<void> {
  if (syncPaused) return Promise.resolve();
  return track(forceInitialSyncInner());
}
async function forceInitialSyncInner() {
  const session = getActiveSession();
  if (!session || !session.globalId || !syncableTenant(session.email)) return;
  console.log('⚡ [SYNC] Forcing initial pull for tenant...');
  await pullFromCloud(session.client, session.localId, session.globalId);
  recomputeAllBalances(session.localId, { source: 'sync' });
  console.log('⚡ [SYNC] Initial pull complete.');
}

export function forcePushToCloud(): Promise<void> {
  if (syncPaused) return Promise.resolve();
  return track(forcePushToCloudInner());
}
async function forcePushToCloudInner() {
  const session = getActiveSession();
  if (!session || !session.globalId || !syncableTenant(session.email)) return;
  await pushToCloud(session.client, session.localId);
}

/**
 * Starts the continuous synchronization loop.
 */
export function startSyncEngine() {
  console.log('🚀 Starting Offline-First Sync Engine...');
  setInterval(async () => {
    try {
      await runSyncCycle();
    } catch (err) {
      console.error('❌ [SYNC] Critical engine error:', err);
    }
  }, SYNC_INTERVAL_MS);
}
