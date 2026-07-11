import { db } from './db.js';
import { getActiveSession } from './session.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// Offline-first sync, scoped to the ONE tenant currently logged in (see server/session.ts).
// All cloud access goes through that tenant's authenticated Supabase client, so Row Level
// Security scopes every read/write to their own rows — no service-role key ships in the app.

// Foreign Key mapping: TableName -> { ColumnName: ReferencedTable }
const fkMap: Record<string, Record<string, string>> = {
  products: { tenant_id: 'tenants' },
  product_barcodes: { product_id: 'products' },
  stakeholders: { tenant_id: 'tenants' },
  users: { tenant_id: 'tenants' },
  transactions: { tenant_id: 'tenants', stakeholder_id: 'stakeholders', user_id: 'users' },
  transaction_items: { transaction_id: 'transactions', product_id: 'products' },
  payments: { transaction_id: 'transactions' },
  currencies: { tenant_id: 'tenants' },
  settings: { tenant_id: 'tenants' },
  cash_flow: { tenant_id: 'tenants', user_id: 'users' },
  daily_reports: { tenant_id: 'tenants', user_id: 'users' },
  cashier_shifts: { tenant_id: 'tenants', user_id: 'users' },
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

// The tenants row is authoritative in the cloud (created at registration, license edited by the
// super-admin) — the desktop only ever PULLS it, never pushes, so it can't stomp a freshly
// activated license with a stale local copy.
const PUSH_TABLES = [
  'products', 'product_barcodes', 'stakeholders', 'users',
  'transactions', 'transaction_items', 'payments',
  'currencies', 'settings', 'cash_flow', 'daily_reports', 'cashier_shifts',
];

const PULL_TABLES = [
  'tenants',
  'products', 'product_barcodes', 'stakeholders', 'users',
  'transactions', 'transaction_items', 'payments',
  'currencies', 'settings', 'cash_flow', 'daily_reports', 'cashier_shifts',
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
      const payload = unsyncedRecords.map(record => {
        const { id, last_synced_at, ...rest } = record;
        const mapped: any = { ...rest };
        if (id !== undefined) mapped.local_id = id;
        if (fkMap[tableName]) {
          for (const [col, refTable] of Object.entries(fkMap[tableName])) {
            if (mapped[col]) mapped[col] = getGlobalId(refTable, mapped[col]);
          }
        }
        return mapped;
      });

      const { error } = await client.from(tableName).upsert(payload, { onConflict: 'global_id' });
      if (error) {
        console.error(`❌ [SYNC] Failed to push ${tableName}:`, JSON.stringify(error));
        continue;
      }

      const markSynced = db.prepare(`UPDATE ${tableName} SET last_synced_at = CURRENT_TIMESTAMP WHERE global_id = ?`);
      const tx = db.transaction((records: any[]) => {
        for (const record of records) markSynced.run(record.global_id);
      });
      tx(unsyncedRecords);
    } catch (err) {
      console.error(`❌ [SYNC] Error pushing ${tableName}:`, err);
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

      const tx = db.transaction((records: any[]) => {
        for (const record of records) {
          const exists = checkStmt.get(record.global_id);
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
async function runSyncCycle() {
  const session = getActiveSession();
  if (!session || !session.globalId || !syncableTenant(session.email)) return;
  await pushToCloud(session.client, session.localId);
  await pullFromCloud(session.client, session.localId, session.globalId);
}

/**
 * Forces an immediate pull for the active tenant (used right after login to populate local data).
 */
export async function forceInitialSync() {
  const session = getActiveSession();
  if (!session || !session.globalId || !syncableTenant(session.email)) return;
  console.log('⚡ [SYNC] Forcing initial pull for tenant...');
  await pullFromCloud(session.client, session.localId, session.globalId);
  console.log('⚡ [SYNC] Initial pull complete.');
}

export async function forcePushToCloud() {
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
