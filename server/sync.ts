import { db } from './db.js';
import { supabase } from './supabase.js';

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

// Configuration
const SYNC_INTERVAL_MS = 10000; // 10 seconds

/**
 * Pushes local changes to Supabase.
 * Finds all records where updated_at > last_synced_at.
 */
async function pushToCloud() {
  console.log('🔄 [SYNC] Starting push to cloud...');
  
  // List of tables we want to sync (order matters for foreign keys)
  const syncTables = [
    'tenants', 
    'products', 
    'product_barcodes', 
    'stakeholders', 
    'users', 
    'transactions', 
    'transaction_items', 
    'payments', 
    'currencies', 
    'settings', 
    'cash_flow', 
    'daily_reports', 
    'cashier_shifts'
  ];

  for (const tableName of syncTables) {
    try {
      // Find unsynced local records
      // Filter out super admin ('hasbach') from being pushed
      let unsyncedRecords = [];
      if (tableName === 'tenants') {
        unsyncedRecords = db.prepare(`
          SELECT * FROM tenants 
          WHERE email != 'hasbach' AND email != 'demo@example.com' AND (last_synced_at IS NULL OR updated_at > last_synced_at)
        `).all() as any[];
      } else {
        // For other tables, make sure we only push if the tenant isn't hasbach or demo
        // Since we don't have a direct email join easily, we'll fetch valid local tenant IDs first.
        const validTenants = db.prepare(`SELECT id FROM tenants WHERE email != 'hasbach' AND email != 'demo@example.com'`).all() as any[];
        const validIds = validTenants.map(t => t.id);
        
        if (validIds.length === 0) continue; // No valid tenants to push for
        
        let queryStr = `SELECT * FROM ${tableName} WHERE (last_synced_at IS NULL OR updated_at > last_synced_at)`;
        if (Object.keys(fkMap[tableName] || {}).includes('tenant_id')) {
           queryStr += ` AND tenant_id IN (${validIds.join(',')})`;
        } else if (tableName === 'product_barcodes') {
           queryStr += ` AND product_id IN (SELECT id FROM products WHERE tenant_id IN (${validIds.join(',')}))`;
        } else if (tableName === 'transaction_items' || tableName === 'payments') {
           queryStr += ` AND transaction_id IN (SELECT id FROM transactions WHERE tenant_id IN (${validIds.join(',')}))`;
        }
        unsyncedRecords = db.prepare(queryStr).all() as any[];
      }

      if (unsyncedRecords.length === 0) continue;

      console.log(`[SYNC] Found ${unsyncedRecords.length} unsynced records in ${tableName}`);

      // Map local 'id' to 'local_id', strip 'last_synced_at', and translate FKs
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

      // Push to Supabase
      const { data, error } = await supabase
        .from(tableName)
        .upsert(payload, { onConflict: 'global_id' });

      if (error) {
        console.error(`❌ [SYNC] Failed to push to ${tableName}:`, JSON.stringify(error));
        continue;
      }

      // Mark as synced locally
      const markSynced = db.prepare(`UPDATE ${tableName} SET last_synced_at = CURRENT_TIMESTAMP WHERE global_id = ?`);
      const transaction = db.transaction((records: any[]) => {
        for (const record of records) {
          markSynced.run(record.global_id);
        }
      });
      transaction(unsyncedRecords);

      console.log(`✅ [SYNC] Successfully pushed ${tableName}`);
    } catch (err) {
      console.error(`❌ [SYNC] Error processing ${tableName}:`, err);
    }
  }
}

/**
 * Pulls cloud changes to local SQLite.
 */
async function pullFromCloud() {
  console.log('🔄 [SYNC] Starting pull from cloud...');

  // Helper function to chunk large arrays for Supabase .in() queries
  async function fetchChunked(tableName: string, columnName: string, ids: string[], lastUpdate: string) {
    const CHUNK_SIZE = 100;
    let allResults: any[] = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const { data, error } = await supabase.from(tableName).select('*').gt('updated_at', lastUpdate).in(columnName, chunk);
      if (error) return { data: null, error };
      if (data) allResults = allResults.concat(data);
    }
    return { data: allResults, error: null };
  }
  
  const syncTables = [
    'tenants', 
    'products', 
    'product_barcodes', 
    'stakeholders', 
    'users', 
    'transactions', 
    'transaction_items', 
    'payments', 
    'currencies', 
    'settings', 
    'cash_flow', 
    'daily_reports', 
    'cashier_shifts'
  ];

  for (const tableName of syncTables) {
    try {
      // Get local tenant IDs (excluding super admin 'hasbach' and default seed data)
      const localTenants = db.prepare(`SELECT id, global_id FROM tenants WHERE email != 'hasbach' AND email != 'admin@example.com' AND global_id IS NOT NULL`).all() as any[];

      if (localTenants.length === 0) continue; // No valid tenants to pull for

      let allData: any[] = [];

      for (const tenant of localTenants) {
        // Find the latest updated_at we have locally for THIS tenant
        let lastUpdateQuery = `SELECT MAX(updated_at) as last_update FROM ${tableName}`;
        let queryParams: any[] = [];
        
        if (tableName === 'tenants') {
          lastUpdateQuery += ` WHERE id = ?`;
          queryParams = [tenant.id];
        } else if (Object.keys(fkMap[tableName] || {}).includes('tenant_id')) {
          lastUpdateQuery += ` WHERE tenant_id = ?`;
          queryParams = [tenant.id];
        } else if (tableName === 'product_barcodes') {
          lastUpdateQuery += ` WHERE product_id IN (SELECT id FROM products WHERE tenant_id = ?)`;
          queryParams = [tenant.id];
        } else if (tableName === 'transaction_items' || tableName === 'payments') {
          lastUpdateQuery += ` WHERE transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ?)`;
          queryParams = [tenant.id];
        }

        const result = db.prepare(lastUpdateQuery).get(...queryParams) as any;
        const lastUpdate = result?.last_update || '1970-01-01T00:00:00.000Z';

        let data: any[] | null = null;
        let error: any = null;

        if (tableName === 'tenants') {
          const res = await supabase.from(tableName).select('*').gt('updated_at', lastUpdate).eq('global_id', tenant.global_id);
          data = res.data; error = res.error;
        } else if (Object.keys(fkMap[tableName] || {}).includes('tenant_id')) {
          const res = await supabase.from(tableName).select('*').gt('updated_at', lastUpdate).eq('tenant_id', tenant.global_id);
          data = res.data; error = res.error;
        } else if (tableName === 'product_barcodes') {
          const products = db.prepare(`SELECT global_id FROM products WHERE tenant_id = ? AND global_id IS NOT NULL`).all(tenant.id) as any[];
          const productIds = products.map(p => p.global_id);
          if (productIds.length > 0) {
              const res = await fetchChunked(tableName, 'product_id', productIds, lastUpdate);
              data = res.data; error = res.error;
          } else {
              continue; // No products, so no barcodes to pull for this tenant
          }
        } else if (tableName === 'transaction_items' || tableName === 'payments') {
          const transactions = db.prepare(`SELECT global_id FROM transactions WHERE tenant_id = ? AND global_id IS NOT NULL`).all(tenant.id) as any[];
          const txIds = transactions.map(t => t.global_id);
          if (txIds.length > 0) {
              const res = await fetchChunked(tableName, 'transaction_id', txIds, lastUpdate);
              data = res.data; error = res.error;
          } else {
              continue;
          }
        }

        if (error) {
          console.error(`❌ [SYNC] Failed to pull ${tableName} for tenant ${tenant.id}:`, JSON.stringify(error));
          continue;
        }

        if (data && data.length > 0) {
          allData = allData.concat(data);
        }
      }

      const data = allData;

      if (!data || data.length === 0) continue;

      console.log(`[SYNC] Pulled ${data.length} new records for ${tableName}`);

      // Strip 'local_id' and 'id' before upserting locally and translate FKs back to local integers
      const mappedData = data.map(record => {
        const { local_id, id, ...rest } = record;
        const mapped: any = { ...rest };

        // Normalize ISO timestamps to SQLite format
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

      // Upsert into local SQLite (Handling without UNIQUE constraint on global_id)
      const columns = Object.keys(mappedData[0]);
      
      const updateSet = columns.map(col => `${col} = ?`).join(', ');
      const insertCols = columns.join(', ');
      const insertVals = columns.map(() => '?').join(', ');

      const checkStmt = db.prepare(`SELECT 1 FROM ${tableName} WHERE global_id = ?`);
      const updateStmt = db.prepare(`UPDATE ${tableName} SET ${updateSet} WHERE global_id = ?`);
      const insertStmt = db.prepare(`INSERT INTO ${tableName} (${insertCols}) VALUES (${insertVals})`);

      const transaction = db.transaction((records: any[]) => {
        for (const record of records) {
          const exists = checkStmt.get(record.global_id);
          const values = columns.map(col => record[col] ?? null);
          if (exists) {
            updateStmt.run(...values, record.global_id);
          } else {
            insertStmt.run(...values);
          }
        }
      });
      transaction(mappedData);

      console.log(`✅ [SYNC] Successfully pulled ${tableName}`);
    } catch (err) {
      console.error(`❌ [SYNC] Error pulling ${tableName}:`, err);
    }
  }
}

/**
 * Forces an immediate synchronous pull from the cloud.
 * Useful after a fresh login to populate the local DB before UI loads.
 */
export async function forceInitialSync() {
  console.log('⚡ [SYNC] Forcing initial sync...');
  await pullFromCloud();
  console.log('⚡ [SYNC] Initial sync complete.');
}

export async function forcePushToCloud() {
  console.log('⚡ [SYNC] Forcing immediate push to cloud...');
  await pushToCloud();
}

/**
 * Starts the continuous synchronization loop.
 */
export function startSyncEngine() {
  console.log('🚀 Starting Offline-First Sync Engine...');
  
  setInterval(async () => {
    try {
      await pushToCloud();
      await pullFromCloud();
    } catch (err) {
      console.error('❌ [SYNC] Critical engine error:', err);
    }
  }, SYNC_INTERVAL_MS);
}
