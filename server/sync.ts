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

// ---- Sync schedule --------------------------------------------------------------------------
// Supabase Free plan egress is 5 GB/month, so the schedule is deliberately lazy:
//  - PUSH is checked every SYNC_INTERVAL_MS. That is a cheap LOCAL query per table; the network is
//    touched only when unsynced rows exist (pushToCloud `continue`s on an empty result).
//  - PULL "hot" tables (data other registers change all day) every HOT_PULL_INTERVAL_MS.
//  - PULL "cold" tables (setup data that rarely changes) every COLD_PULL_INTERVAL_MS.
//  - Initial/forced pulls (login, reconnect, forceInitialSync) always pull everything immediately.
export const SYNC_INTERVAL_MS = 10_000;
export const HOT_PULL_INTERVAL_MS = 60_000;
export const COLD_PULL_INTERVAL_MS = 5 * 60_000;
// PostgREST returns at most 1000 rows per request; pulls page with .range() until a short page.
export const PULL_PAGE_SIZE = 1000;

// Cloud request counters (observability only; exposed by GET /api/sync/status).
const requestCounts = { pull: 0, push: 0, since: new Date().toISOString() };
export function getRequestCounts() { return { ...requestCounts }; }
export function resetRequestCounts() { requestCounts.pull = 0; requestCounts.push = 0; requestCounts.since = new Date().toISOString(); }

// Observability only (GET /api/sync/status) — never consulted by push/pull decisions.
let lastPushAt: number | null = null;
let lastPullAt: number | null = null;
let lastSyncErrorAt = 0;
export function getSyncTimes() {
  return {
    lastPushAt: lastPushAt ? new Date(lastPushAt).toISOString() : null,
    lastPullAt: lastPullAt ? new Date(lastPullAt).toISOString() : null,
    // Offline when the most recent failure is newer than the most recent success.
    recentError: lastSyncErrorAt > Math.max(lastPushAt || 0, lastPullAt || 0) && Date.now() - lastSyncErrorAt < 120000,
  };
}

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
// Each learned column is forgotten after CLOUD_COLUMN_REPROBE_MS (and on restart) so applying the cloud
// migration is picked up without a restart: the next push includes the column again.
const CLOUD_COLUMN_REPROBE_MS = 30 * 60 * 1000;
const cloudMissingColumns: Record<string, Map<string, number>> = {}; // table -> column -> forget-at (ms)
function activeMissingColumns(tableName: string): Set<string> | null {
  const m = cloudMissingColumns[tableName];
  if (!m) return null;
  const now = Date.now();
  for (const [col, until] of m) if (until <= now) m.delete(col);
  return m.size ? new Set(m.keys()) : null;
}
/** Test hook: forget what we learned about the cloud's missing columns. */
export function resetCloudColumnProbe() { for (const k of Object.keys(cloudMissingColumns)) delete cloudMissingColumns[k]; }
/** Column named by a PostgREST PGRST204 ("Could not find the 'x' column of ...") or Postgres 42703 error. */
export function parseMissingColumn(error: any): string | undefined {
  if (!error) return undefined;
  if (error.code === 'PGRST204') return /'([^']+)' column/.exec(error.message || '')?.[1];
  if (error.code === '42703') return /column "([^"]+)"/.exec(error.message || '')?.[1] ?? /'([^']+)' column/.exec(error.message || '')?.[1];
  return undefined;
}

export async function upsertToCloud(client: SupabaseClient, tableName: string, payload: any) {
  const rows: any[] = Array.isArray(payload) ? payload : [payload];
  for (let attempt = 0; attempt < 5; attempt++) {
    const missing = activeMissingColumns(tableName);
    if (missing) for (const r of rows) for (const col of missing) delete r[col];
    requestCounts.push++;
    const { error } = await client.from(tableName).upsert(Array.isArray(payload) ? rows : rows[0], { onConflict: 'global_id' });
    const col = parseMissingColumn(error);
    if (!col || missing?.has(col)) return { error };
    console.warn(`⚠️ [SYNC] Cloud ${tableName} has no '${col}' column — pushing without it until the cloud schema is migrated.`);
    (cloudMissingColumns[tableName] ||= new Map()).set(col, Date.now() + CLOUD_COLUMN_REPROBE_MS);
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
  lastSyncErrorAt = Date.now();
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
    requestCounts.push++;
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
// Columns that exist only in the local database and must never be pushed.
//  - stakeholders.balance_baseline (see server/balance.ts)
const LOCAL_ONLY_COLUMNS: Record<string, string[]> = {
  stakeholders: ['balance_baseline'],
};
// Columns pushed only once the cloud has them (supabase/migrations/2026-10-06_local_rates.sql). They
// are always included in the payload; if the cloud rejects one as unknown, upsertToCloud learns that,
// strips it and retries. The first successful push that INCLUDED a column persists a flag in
// `_migrations` and re-marks the rows holding a value as unsynced, so values set before the cloud
// migration get pushed once.
export const OPTIONAL_CLOUD_COLUMNS: Record<string, string[]> = {
  stakeholders: ['local_rate'],
  transactions: ['local_rate', 'local_currency'],
};
const cloudColFlag = (table: string, col: string) => `cloud_col_ok:${table}.${col}`;
function noteCloudColumnsAccepted(tableName: string, payload: any[]) {
  if (!payload.length) return;
  for (const col of OPTIONAL_CLOUD_COLUMNS[tableName] || []) {
    if (!(col in payload[0])) continue; // was stripped: the cloud doesn't have it (yet)
    const name = cloudColFlag(tableName, col);
    if (db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get(name)) continue;
    db.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO _migrations (name) VALUES (?)").run(name);
      db.prepare(`UPDATE ${tableName} SET last_synced_at = NULL WHERE ${col} IS NOT NULL`).run();
    })();
    console.log(`[SYNC] Cloud ${tableName}.${col} is available - re-pushing rows that hold a value.`);
  }
}
/** Row -> cloud upsert payload (before FK translation): drops local-only columns, id -> local_id. */
export function toCloudRecord(tableName: string, record: any) {
  const { id, last_synced_at, ...rest } = record;
  const mapped: any = { ...rest };
  for (const col of LOCAL_ONLY_COLUMNS[tableName] || []) delete mapped[col];
  if (id !== undefined) mapped.local_id = id;
  return mapped;
}

// Cloud columns this database doesn't have (a newer cloud schema) are dropped on pull instead of
// failing the whole INSERT/UPDATE. PRAGMA results are cached per table for the process lifetime.
const localColumnCache = new Map<string, Set<string>>();
export function localColumns(tableName: string): Set<string> {
  let cols = localColumnCache.get(tableName);
  if (!cols) {
    cols = new Set((db.prepare(`PRAGMA table_info(${tableName})`).all() as any[]).map(c => c.name));
    localColumnCache.set(tableName, cols);
  }
  return cols;
}
export function dropUnknownLocalColumns(tableName: string, record: any) {
  const cols = localColumns(tableName);
  const out: any = {};
  for (const k of Object.keys(record)) if (cols.has(k)) out[k] = record[k];
  return out;
}

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

export const HOT_PULL_TABLES = [
  'products', 'product_barcodes', 'product_units', 'stakeholders', 'users',
  'transactions', 'transaction_items', 'payments', 'cash_flow',
];
export const COLD_PULL_TABLES = [
  'tenants', 'currencies', 'settings', 'cash_flow_categories',
  'daily_reports', 'cashier_shifts', 'settlement_corrections',
];
// Pull order: parents before children (FK translation needs the parent row locally).
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
export async function pushToCloud(client: SupabaseClient, localId: number) {
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
      // Local-only columns (see LOCAL_ONLY_COLUMNS) are never pushed — the cloud tables don't have
      // them and pushing an unknown column errors.
      const payload = unsyncedRecords.map(record => {
        const mapped: any = toCloudRecord(tableName, record);
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
        noteCloudColumnsAccepted(tableName, payload);
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

/** How many local rows are still waiting to be pushed, per table (read-only). */
export function countPendingPush(localId: number): Record<string, number> {
  const out: Record<string, number> = {};
  const id = Number(localId);
  for (const tableName of PUSH_TABLES) {
    try {
      let q = `SELECT COUNT(*) AS c FROM ${tableName} WHERE (last_synced_at IS NULL OR updated_at > last_synced_at)`;
      if (Object.keys(fkMap[tableName] || {}).includes('tenant_id')) q += ` AND tenant_id = ${id}`;
      else if (tableName === 'product_barcodes') q += ` AND product_id IN (SELECT id FROM products WHERE tenant_id = ${id})`;
      else if (tableName === 'transaction_items' || tableName === 'payments') q += ` AND transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ${id})`;
      const c = (db.prepare(q).get() as any)?.c || 0;
      if (c > 0) out[tableName] = c;
    } catch { /* table without these columns */ }
  }
  return out;
}

/**
 * Pulls the active tenant's newer cloud rows into local SQLite.
 */
// Child tables without their own tenant_id: pulled with ONE request through an inner join on the
// parent (constant request count however much history exists). If the cloud rejects the embed we
// fall back to the old per-chunk `.in(parent ids)` path, log once, and remember it for the session.
const EMBED_PARENT: Record<string, { parent: string; fk: string }> = {
  transaction_items: { parent: 'transactions', fk: 'transaction_id' },
  payments: { parent: 'transactions', fk: 'transaction_id' },
  product_barcodes: { parent: 'products', fk: 'product_id' },
};
const embedUnsupported = new Set<string>();
/** Test hook: forget which child tables fell back to the chunked pull. */
export function resetEmbedProbe() { embedUnsupported.clear(); }

// ---- Pull cursors ---------------------------------------------------------------------------
// Cloud `updated_at` is whatever clock the PUSHING register had, so a cursor based on it can skip
// rows: this register's own later edit moves MAX(updated_at) past a row another register pushed
// with an earlier stamp; an offline register that reconnects pushes a backlog with OLD stamps no
// other cursor will ever reach. So, once the cloud has `synced_at` (server time, set by a trigger -
// supabase/migrations/2026-10-07_synced_at.sql) pulls use a per-table (synced_at, global_id) cursor
// kept in the local-only table `sync_cursor`, with keyset paging and a safety overlap for
// commit-order skew. Without that column they fall back to an overlapped `updated_at` cursor.
export const CURSOR_OVERLAP_MS = 2 * 60 * 1000;
let pullPageSize = PULL_PAGE_SIZE;
/** Test hook: shrink the page size so paging is exercised without thousands of rows. */
export function __setPullPageSize(n?: number) { pullPageSize = n || PULL_PAGE_SIZE; }

let cursorTableReady = false;
function ensureCursorTable() {
  if (cursorTableReady) return;
  db.exec(`CREATE TABLE IF NOT EXISTS sync_cursor (
    tenant_id INTEGER NOT NULL,
    table_name TEXT NOT NULL,
    synced_at TEXT,
    global_id TEXT,
    PRIMARY KEY (tenant_id, table_name)
  )`);
  cursorTableReady = true;
}
type Cursor = { synced_at: string; global_id: string };
function getCursor(tenantId: number, table: string): Cursor | null {
  ensureCursorTable();
  const r = db.prepare('SELECT synced_at, global_id FROM sync_cursor WHERE tenant_id = ? AND table_name = ?').get(tenantId, table) as any;
  return r && r.synced_at ? { synced_at: r.synced_at, global_id: r.global_id || '' } : null;
}
function cursorAfter(a: Cursor, b: Cursor | null): boolean {
  if (!b) return true;
  const ta = Date.parse(a.synced_at), tb = Date.parse(b.synced_at);
  return ta !== tb ? ta > tb : a.global_id > b.global_id;
}
function setCursor(tenantId: number, table: string, c: Cursor) {
  ensureCursorTable();
  if (!cursorAfter(c, getCursor(tenantId, table))) return; // monotonic: the overlap re-reads older rows
  db.prepare(`INSERT INTO sync_cursor (tenant_id, table_name, synced_at, global_id) VALUES (?, ?, ?, ?)
              ON CONFLICT(tenant_id, table_name) DO UPDATE SET synced_at = excluded.synced_at, global_id = excluded.global_id`)
    .run(tenantId, table, c.synced_at, c.global_id);
}
/** Forget the pull cursors (a tenant data reset wipes the local rows, so everything must be re-pulled). */
export function clearSyncCursors(tenantId?: number) {
  ensureCursorTable();
  if (tenantId === undefined) db.prepare('DELETE FROM sync_cursor').run();
  else db.prepare('DELETE FROM sync_cursor WHERE tenant_id = ?').run(tenantId);
}

// ---- Tombstones -----------------------------------------------------------------------------
// Local-only record of live rows that were deleted on purpose here (End-of-Day settlement archives
// them under the SAME global_id; an invoice delete/edit removes them). If the cloud delete could not
// be done at the time (offline / dead session) the cloud still holds the rows, and a later pull would
// re-insert them. A tombstone (a) makes the pull skip that global_id and (b) remembers that the cloud
// copy still has to be deleted (cloud_purged_at IS NULL) - retried by purgeTombstonedFromCloud.
// Created lazily, after db.ts ran its sync-metadata loop; never pushed or pulled.
const TOMBSTONE_CHUNK = 100;
let tombstoneTableReady = false;
let isTombstonedStmt: any = null;
export function ensureTombstoneTable() {
  if (tombstoneTableReady) return;
  db.exec(`CREATE TABLE IF NOT EXISTS sync_tombstones (
    table_name TEXT NOT NULL,
    global_id TEXT NOT NULL,
    tenant_id INTEGER NOT NULL,
    parent_global_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    cloud_purged_at DATETIME,
    PRIMARY KEY (table_name, global_id)
  )`);
  tombstoneTableReady = true;
}
export type TombstoneRow = { table: string; globalId: string | null | undefined; parentGlobalId?: string | null };
export function addTombstones(tenantId: number, rows: TombstoneRow[]) {
  ensureTombstoneTable();
  const ins = db.prepare('INSERT OR IGNORE INTO sync_tombstones (table_name, global_id, tenant_id, parent_global_id) VALUES (?, ?, ?, ?)');
  for (const r of rows) if (r.globalId) ins.run(r.table, r.globalId, tenantId, r.parentGlobalId || null);
}
export function isTombstoned(table: string, globalId: string): boolean {
  if (!globalId) return false;
  ensureTombstoneTable();
  isTombstonedStmt ||= db.prepare('SELECT 1 FROM sync_tombstones WHERE table_name = ? AND global_id = ?');
  return !!isTombstonedStmt.get(table, globalId);
}
/** The cloud copies of these rows are gone: stop retrying them (the tombstone itself stays, so a stale pull can't resurrect them). */
export function markTombstonesPurged(rows: { table: string; globalId: string | null | undefined }[]) {
  ensureTombstoneTable();
  const upd = db.prepare('UPDATE sync_tombstones SET cloud_purged_at = CURRENT_TIMESTAMP WHERE table_name = ? AND global_id = ? AND cloud_purged_at IS NULL');
  db.transaction(() => { for (const r of rows) if (r.globalId) upd.run(r.table, r.globalId); })();
}
/** Forget a tenant's tombstones (a tenant data reset wipes local AND cloud data). */
export function clearTombstones(tenantId: number) {
  ensureTombstoneTable();
  db.prepare('DELETE FROM sync_tombstones WHERE tenant_id = ?').run(tenantId);
}
function pendingTombstoneCount(tenantId: number): number {
  ensureTombstoneTable();
  return (db.prepare('SELECT COUNT(*) AS c FROM sync_tombstones WHERE tenant_id = ? AND cloud_purged_at IS NULL').get(tenantId) as any).c;
}

// Retry the cloud delete of tombstoned rows (children first). A delete of a row the cloud no longer
// has is a no-op, so this is safe to repeat. Costs nothing (a local COUNT) when nothing is pending.
const TOMBSTONE_PURGE_ORDER = ['payments', 'transaction_items', 'transactions', 'cash_flow', 'cashier_shifts'];
export async function purgeTombstonedFromCloud(client: SupabaseClient, tenantId: number) {
  if (pendingTombstoneCount(tenantId) === 0) return;
  for (const table of TOMBSTONE_PURGE_ORDER) {
    const ids = (db.prepare('SELECT global_id FROM sync_tombstones WHERE tenant_id = ? AND table_name = ? AND cloud_purged_at IS NULL').all(tenantId, table) as any[]).map(r => r.global_id);
    for (let i = 0; i < ids.length; i += TOMBSTONE_CHUNK) {
      if (syncPaused) return;
      const chunk = ids.slice(i, i + TOMBSTONE_CHUNK);
      try {
        requestCounts.push++;
        const { error } = await client.from(table).delete().in('global_id', chunk);
        if (error) throw error;
        markTombstonesPurged(chunk.map(g => ({ table, globalId: g })));
      } catch (err: any) {
        lastSyncErrorAt = Date.now();
        console.warn(`⏳ [SYNC] Could not delete tombstoned ${table} rows from the cloud yet (will retry):`, err?.message || JSON.stringify(err));
        return;
      }
    }
  }
}

// Tables whose cloud copy has no synced_at yet -> forget-at (ms). Re-probed after
// CLOUD_COLUMN_REPROBE_MS and on restart, so applying the migration is picked up without a restart.
const noSyncedAt = new Map<string, number>();
export function resetSyncedAtProbe() { noSyncedAt.clear(); }
function syncedAtAvailable(table: string): boolean {
  const until = noSyncedAt.get(table);
  if (until === undefined) return true;
  if (until <= Date.now()) { noSyncedAt.delete(table); return true; }
  return false;
}
function isMissingSyncedAt(error: any): boolean {
  if (!error) return false;
  const msg = String(error.message || '');
  return /synced_at/.test(msg) && (error.code === '42703' || error.code === 'PGRST204' || /does not exist|could not find/i.test(msg));
}
function shiftIso(ts: string, deltaMs: number): string {
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(ts);
  const d = new Date(ts.replace(' ', 'T') + (hasTz ? '' : 'Z'));
  return new Date(d.getTime() + deltaMs).toISOString();
}
const EPOCH = '1970-01-01T00:00:00.000Z';
/** A child whose parent transaction is unknown stays deferred this long; older orphans are dropped. */
const ORPHAN_DEFER_MS = 24 * 60 * 60 * 1000;

export async function pullFromCloud(client: SupabaseClient, localId: number, globalId: string, tables: readonly string[] = PULL_TABLES) {
  // KEYSET paging on (col, global_id): page 1 is `col >= start`, later pages `col > last OR (col = last
  // AND global_id > lastId)`, so rows inserted or changed between pages can neither be skipped nor
  // duplicated, and any number of rows sharing one timestamp are all returned. `onPage` stores the page.
  async function pageThrough(col: 'synced_at' | 'updated_at', start: string, makeQuery: () => any, onPage: (rows: any[]) => boolean | void) {
    let after: { v: string; g: string } | null = null;
    for (;;) {
      let q = makeQuery().order(col, { ascending: true }).order('global_id', { ascending: true }).limit(pullPageSize);
      q = after ? q.or(`${col}.gt.${after.v},and(${col}.eq.${after.v},global_id.gt.${after.g})`) : q.gte(col, start);
      requestCounts.pull++;
      const { data, error } = await q;
      if (error) return { error };
      const rows: any[] = data || [];
      if (rows.length && col === 'synced_at' && rows[0].synced_at === undefined) {
        return { error: { code: '42703', message: 'column synced_at does not exist' } };
      }
      if (rows.length && onPage(rows) === true) return { error: null }; // page handler asked to stop (deferred child)
      if (rows.length < pullPageSize) return { error: null };
      const last = rows[rows.length - 1];
      after = { v: last[col], g: last.global_id };
    }
  }

  // Strip cloud 'local_id'/'id'/'synced_at'/embedded parent, normalize timestamps, translate FK
  // UUIDs -> local ids, then insert/update. Rows we must not touch are skipped (see below).
  // Returns the earliest DEFERRED child row (parent transaction unknown here, not tombstoned, and
  // the cloud row is recent): the caller must not advance its cursor past it, so a later pull retries.
  function applyRows(tableName: string, rawData: any[], embedParent?: string): { synced_at: string; global_id: string } | null {
    // Never resurrect a row deleted here on purpose (see "Tombstones"), nor a child of a deleted
    // parent. A child whose parent is merely unknown is deferred (or dropped once older than
    // ORPHAN_DEFER_MS). Checked on the cloud's UUIDs, i.e. BEFORE the FK translation below.
    const isChild = tableName === 'transaction_items' || tableName === 'payments';
    let deferred: { synced_at: string; global_id: string } | null = null;
    let droppedOrphans = 0;
    const data = rawData.filter(record => {
      if (isTombstoned(tableName, record.global_id)) return false;
      if (!isChild) return true;
      if (isTombstoned('transactions', record.transaction_id)) return false;
      if (getLocalId('transactions', record.transaction_id)) return true;
      const ts = record.synced_at ? Date.parse(record.synced_at) : NaN;
      if (Number.isFinite(ts) && ts > Date.now() - ORPHAN_DEFER_MS) {
        if (!deferred) deferred = { synced_at: record.synced_at, global_id: record.global_id };
      } else droppedOrphans++;
      return false;
    });
    if (droppedOrphans) console.warn(`⚠️ [SYNC] Dropped ${droppedOrphans} ${tableName} row(s) older than 24h whose parent transaction never arrived.`);
    if (data.length === 0) return deferred;
    const mappedData = data.map(record => {
      const { local_id, id, synced_at, ...rest } = record;
      if (embedParent) delete rest[embedParent];
      const mapped: any = { ...rest };
      if (mapped.updated_at) mapped.updated_at = mapped.updated_at.replace('T', ' ').replace('Z', '');
      if (mapped.created_at) mapped.created_at = mapped.created_at.replace('T', ' ').replace('Z', '');
      if (mapped.deleted_at) mapped.deleted_at = mapped.deleted_at.replace('T', ' ').replace('Z', '');
      if (fkMap[tableName]) {
        for (const [col, refTable] of Object.entries(fkMap[tableName])) {
          if (mapped[col]) mapped[col] = getLocalId(refTable, mapped[col]);
        }
      }
      const clean = dropUnknownLocalColumns(tableName, mapped);
      // A row we just pulled IS the cloud's copy: mark it synced (last_synced_at = its updated_at) in
      // the same write, so it is never pushed straight back. Must be part of the same statement: a
      // separate UPDATE would fire the updated_at trigger and bump the row. Capped at "now" so a cloud
      // stamp from a register whose clock runs ahead can't swallow a later local edit.
      if (clean.updated_at && localColumns(tableName).has('last_synced_at')) {
        const nowStamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
        clean.last_synced_at = String(clean.updated_at) < nowStamp ? clean.updated_at : nowStamp;
      }
      return clean;
    });

    const columns = Object.keys(mappedData[0]);
    // Stakeholder balances are DERIVED locally (server/balance.ts): the cloud copy only seeds a
    // brand-new row, never overwrites one we have (registers with different baselines would fight).
    const updateColumns = tableName === 'stakeholders' ? columns.filter(c => c !== 'balance') : columns;
    const updateSet = updateColumns.map(col => `${col} = ?`).join(', ');
    const insertCols = columns.join(', ');
    const insertVals = columns.map(() => '?').join(', ');

    const checkStmt = db.prepare(`SELECT updated_at, last_synced_at FROM ${tableName} WHERE global_id = ?`);
    const updateStmt = db.prepare(`UPDATE ${tableName} SET ${updateSet} WHERE global_id = ?`);
    const insertStmt = db.prepare(`INSERT INTO ${tableName} (${insertCols}) VALUES (${insertVals})`);
    const restoreStmt = columns.includes('updated_at') && columns.includes('last_synced_at')
      ? db.prepare(`UPDATE ${tableName} SET updated_at = ?, last_synced_at = ? WHERE global_id = ?`) : null;
    const barcodeHolder = tableName === 'product_barcodes'
      ? db.prepare(`SELECT id, deleted_at FROM product_barcodes WHERE barcode = ?`) : null;
    const purgeBarcode = tableName === 'product_barcodes'
      ? db.prepare(`DELETE FROM product_barcodes WHERE id = ?`) : null;

    // Deleted-here-on-purpose parties are SOFT deleted (deleted_at): a deleted row we never held is
    // not worth inserting. Currencies are unique per code: a second live copy with another global_id
    // (e.g. a USD seeded by a second device) must not be inserted next to ours.
    const skipUnknownDeleted = tableName === 'currencies' || tableName === 'users' || tableName === 'stakeholders';
    const liveCurrencyByCode = tableName === 'currencies'
      ? db.prepare(`SELECT 1 FROM currencies WHERE tenant_id = ? AND UPPER(code) = UPPER(?) AND deleted_at IS NULL`) : null;

    const tx = db.transaction((records: any[]) => {
      for (const record of records) {
        const exists = checkStmt.get(record.global_id) as any;
        if (!exists && skipUnknownDeleted && record.deleted_at) continue;
        if (!exists && liveCurrencyByCode && !record.deleted_at && liveCurrencyByCode.get(record.tenant_id, record.code)) continue;
        if (!exists && barcodeHolder) {
          // product_barcodes.barcode is UNIQUE locally: a cloud row we don't have must not collide
          // with a local row (which would fail the whole pull of this table every cycle).
          if (record.deleted_at) continue; // a removal we never held - nothing to store
          const holder = barcodeHolder.get(record.barcode) as any;
          if (holder && !holder.deleted_at) continue; // live here already; our push wins
          if (holder) purgeBarcode!.run(holder.id);
        }
        if (exists) {
          // Same version already held (overlap / re-fetch): nothing to do, and an UPDATE that leaves
          // updated_at unchanged would make the trigger bump it and re-push the row.
          if (exists.updated_at && record.updated_at && String(exists.updated_at) === String(record.updated_at)) continue;
          // A row with a pending local edit (never pushed, or edited since the last push) is NEVER
          // overwritten: the push will send ours. (The tenants row is cloud-authoritative, never pushed.)
          if (tableName !== 'tenants' && (exists.last_synced_at == null || String(exists.updated_at) > String(exists.last_synced_at))) continue;
          updateStmt.run(...updateColumns.map(col => record[col] ?? null), record.global_id);
        } else {
          insertStmt.run(...columns.map(col => record[col] ?? null));
          // The AFTER INSERT trigger re-writes updated_at, which fires the updated_at trigger and
          // stamps the row with "now" (it would look like a local edit and be pushed back). Restore
          // the cloud's values (they differ from the stamped ones, so no trigger fires).
          if (record.updated_at && restoreStmt) restoreStmt.run(record.updated_at, record.last_synced_at ?? record.updated_at, record.global_id);
        }
      }
    });
    tx(mappedData);
    return deferred;
  }

  // Latest updated_at we hold for this tenant in a row that is NOT waiting to be pushed - the
  // fallback cursor. Pending local edits and unfetched rows never move it, minus an overlap.
  function fallbackStart(tableName: string): string {
    let scope = '';
    if (tableName === 'tenants') scope = `id = ${Number(localId)}`;
    else if (Object.keys(fkMap[tableName] || {}).includes('tenant_id')) scope = `tenant_id = ${Number(localId)}`;
    else if (tableName === 'product_barcodes') scope = `product_id IN (SELECT id FROM products WHERE tenant_id = ${Number(localId)})`;
    else scope = `transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ${Number(localId)})`;
    const cleanOnly = tableName === 'tenants' ? '' : ' AND last_synced_at IS NOT NULL AND updated_at <= last_synced_at';
    const r = db.prepare(`SELECT MAX(updated_at) AS m FROM ${tableName} WHERE ${scope}${cleanOnly}`).get() as any;
    return r?.m ? shiftIso(r.m, -CURSOR_OVERLAP_MS) : EPOCH;
  }

  // If the parent `transactions` pull of this call failed, the children are not pulled at all: their
  // cursors stay put and the next cycle retries (a skipped orphan must never be passed by a cursor).
  let transactionsPullFailed = false;
  for (const tableName of PULL_TABLES) {
    if (!tables.includes(tableName)) continue;
    if (syncPaused) return;
    if (cloudMissingTables.has(tableName)) continue;
    if (transactionsPullFailed && (tableName === 'transaction_items' || tableName === 'payments')) continue;
    try {
      const embed = EMBED_PARENT[tableName]; // set for child tables without their own tenant_id
      const hasTenantCol = Object.keys(fkMap[tableName] || {}).includes('tenant_id');
      const select = embed && !embedUnsupported.has(tableName) ? `*, ${embed.parent}!inner(tenant_id)` : '*';
      const baseQuery = () => {
        const q = client.from(tableName).select(select);
        if (tableName === 'tenants') return q.eq('global_id', globalId);
        if (hasTenantCol) return q.eq('tenant_id', globalId);
        return q.eq(`${embed.parent}.tenant_id`, globalId);
      };
      const embedParent = select === '*' ? undefined : embed?.parent;

      let res: { error: any } = { error: null };
      const chunkedOnly = !!embed && embedUnsupported.has(tableName); // the join was rejected earlier
      const bySyncedAt = () => {
        const cur = getCursor(localId, tableName);
        return pageThrough('synced_at', cur ? shiftIso(cur.synced_at, -CURSOR_OVERLAP_MS) : EPOCH, baseQuery, (rows) => {
          const deferred = applyRows(tableName, rows, embedParent);
          // Keyset order is (synced_at, global_id): with a deferred child, advance only to the row just
          // before it (not at all if it is first) and stop paging. Re-reading the applied rows is harmless.
          const upTo = deferred ? rows.findIndex(r => r.global_id === deferred!.global_id) - 1 : rows.length - 1;
          const last = rows[upTo];
          if (last && last.synced_at) setCursor(localId, tableName, { synced_at: last.synced_at, global_id: last.global_id });
          return !!deferred;
        });
      };
      const byUpdatedAt = (query: () => any) =>
        pageThrough('updated_at', fallbackStart(tableName), query, (rows) => { applyRows(tableName, rows, embedParent); });

      if (chunkedOnly) {
        // handled below
      } else if (syncedAtAvailable(tableName)) {
        res = await bySyncedAt();
        if (isMissingSyncedAt(res.error)) {
          noSyncedAt.set(tableName, Date.now() + CLOUD_COLUMN_REPROBE_MS);
          console.warn(`⚠️ [SYNC] Cloud ${tableName} has no synced_at column yet - pulling by updated_at until the cloud schema is migrated.`);
          res = await byUpdatedAt(baseQuery);
        }
      } else {
        res = await byUpdatedAt(baseQuery);
      }

      // The embed itself rejected (PGRST200/201 relationship missing/ambiguous, 42xxx): fall back to
      // per-chunk `.in(parent ids)` pulls, by updated_at, remembered for the session.
      if (embed && embedParent && res.error && !isMissingCloudTable(res.error) && /^(PGRST|42)/.test(String(res.error.code || ''))) {
        embedUnsupported.add(tableName);
        console.warn(`⚠️ [SYNC] Cloud rejected the ${tableName} -> ${embed.parent} join (${res.error.code || res.error.message}); falling back to chunked pulls for ${tableName}.`);
        res = { error: null };
      }
      if (embed && embedUnsupported.has(tableName) && !res.error) {
        const parents = db.prepare(`SELECT global_id FROM ${embed.parent} WHERE tenant_id = ? AND global_id IS NOT NULL`).all(localId) as any[];
        const ids = parents.map(p => p.global_id);
        for (let i = 0; i < ids.length && !res.error; i += 100) {
          const chunk = ids.slice(i, i + 100);
          res = await pageThrough('updated_at', fallbackStart(tableName), () => client.from(tableName).select('*').in(embed.fk, chunk),
            (rows) => { applyRows(tableName, rows); });
        }
      }

      if (isMissingCloudTable(res.error)) { noteMissingCloudTable(tableName); continue; }
      if (res.error) {
        if (tableName === 'transactions') transactionsPullFailed = true;
        console.error(`❌ [SYNC] Failed to pull ${tableName}:`, JSON.stringify(res.error));
      }
    } catch (err) {
      if (tableName === 'transactions') transactionsPullFailed = true;
      lastSyncErrorAt = Date.now();
      console.error(`❌ [SYNC] Error pulling ${tableName}:`, err);
    }
  }
}

// A pull may have changed transactions/payments without going through the local write paths, so
// balances are re-derived from the freshly-synced data (see server/balance.ts) - but QUIETLY.
// The derived balance is a pure local function of (balance_baseline + transactions), so a recompute
// that merely brings a row in line with the data just pulled is not an edit and must not make the
// row pushable. Without this the recompute bumped updated_at (trigger), the row was pushed, the
// other register pulled it, recomputed against ITS baseline, bumped, pushed ... forever
// (the 73 POST /rest/v1/stakeholders in ~70 minutes). Rows that were already pending a push (a real
// local edit) are left alone, so genuine edits still go up.
export function recomputeBalancesAfterPull(localId: number): void {
  const clean = db.prepare(
    `SELECT id, updated_at FROM stakeholders
     WHERE tenant_id = ? AND last_synced_at IS NOT NULL AND updated_at <= last_synced_at`
  ).all(localId) as { id: number; updated_at: string }[];
  recomputeAllBalances(localId, { source: 'sync' });
  // Put updated_at back to what it was for rows that were clean: the value differs from the
  // trigger's fresh CURRENT_TIMESTAMP, so this UPDATE does not fire the bump trigger again.
  const restore = db.prepare(
    `UPDATE stakeholders SET updated_at = ? WHERE id = ? AND tenant_id = ? AND updated_at <> ?`
  );
  db.transaction(() => { for (const r of clean) restore.run(r.updated_at, r.id, localId, r.updated_at); })();
}

// ---- Scheduler ------------------------------------------------------------------------------
// Pull bookkeeping for the active tenant. A different tenant (or a reset) means "never pulled", so
// the first cycle pulls everything immediately.
let scheduleTenant: string | null = null;
let lastHotPullAt = 0;
let lastColdPullAt = 0;

/** Which tables are due for a pull at `now` (injectable clock for tests). Advances the schedule. */
export function duePullTables(now: number, sessionKey: string): string[] {
  if (scheduleTenant !== sessionKey) { scheduleTenant = sessionKey; lastHotPullAt = 0; lastColdPullAt = 0; }
  const hot = now - lastHotPullAt >= HOT_PULL_INTERVAL_MS;
  const cold = now - lastColdPullAt >= COLD_PULL_INTERVAL_MS;
  if (hot) lastHotPullAt = now;
  if (cold) lastColdPullAt = now;
  if (!hot && !cold) return [];
  return PULL_TABLES.filter(t => (hot && HOT_PULL_TABLES.includes(t)) || (cold && COLD_PULL_TABLES.includes(t)));
}
/** Test hook: forget the pull schedule. */
export function resetPullSchedule() { scheduleTenant = null; lastHotPullAt = 0; lastColdPullAt = 0; }

/**
 * One sync cycle for the currently logged-in tenant. No-op if nobody is logged in
 * (no active cloud session) or the active account is a seed/super-admin account.
 * Push is checked every cycle (local query; network only when rows are pending); pulls follow the
 * hot/cold schedule above.
 */
// The interval fires every 10s whether or not the previous cycle finished; when the cloud is slow,
// overlapping cycles would push the same rows again and again. Only one cycle runs at a time.
let cycleInFlight: Promise<void> | null = null;
function runSyncCycle(now: number = Date.now()): Promise<void> {
  if (syncPaused) return Promise.resolve();
  if (cycleInFlight) return cycleInFlight;
  cycleInFlight = track(runSyncCycleInner(now)).finally(() => { cycleInFlight = null; });
  return cycleInFlight;
}
/** Test seam: run one scheduled cycle at a simulated time. */
export function runSyncCycleAt(now: number): Promise<void> { return runSyncCycle(now); }
async function runSyncCycleInner(now: number) {
  const session = getActiveSession();
  if (!session || !session.globalId || !syncableTenant(session.email)) return;
  await purgeTombstonedFromCloud(session.client, session.localId);
  await pushToCloud(session.client, session.localId);
  if (!syncPaused) lastPushAt = Date.now();
  const due = duePullTables(now, `${session.localId}:${session.globalId}`);
  if (due.length === 0) return;
  await pullFromCloud(session.client, session.localId, session.globalId, due);
  if (!syncPaused) lastPullAt = Date.now();
  recomputeBalancesAfterPull(session.localId);
}

/**
 * Forces an immediate pull of EVERYTHING for the active tenant (used right after login/reconnect).
 */
export function forceInitialSync(): Promise<void> {
  if (syncPaused) return Promise.resolve();
  return track(forceInitialSyncInner());
}
async function forceInitialSyncInner() {
  const session = getActiveSession();
  if (!session || !session.globalId || !syncableTenant(session.email)) return;
  console.log('[SYNC] Forcing initial pull for tenant...');
  await purgeTombstonedFromCloud(session.client, session.localId);
  await pullFromCloud(session.client, session.localId, session.globalId);
  // Count it as both schedules having just run, so the next cycle doesn't pull everything again.
  scheduleTenant = `${session.localId}:${session.globalId}`;
  lastHotPullAt = lastColdPullAt = Date.now();
  recomputeBalancesAfterPull(session.localId);
  console.log('[SYNC] Initial pull complete.');
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

// Call after a local write to push it within ~2 s instead of waiting for the next 10 s check.
// Push-only (never pulls), debounced, and free of network traffic when nothing is pending.
const NOTIFY_DEBOUNCE_MS = 2000;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
export function notifyLocalChange(): void {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    if (cycleInFlight) return; // the running cycle's push (or the next tick) picks it up
    forcePushToCloud().catch(() => {});
  }, NOTIFY_DEBOUNCE_MS);
  (notifyTimer as any).unref?.();
}

/**
 * Starts the continuous synchronization loop.
 */
export function startSyncEngine() {
  console.log('Starting Offline-First Sync Engine...');
  setInterval(async () => {
    try {
      await runSyncCycle();
    } catch (err) {
      console.error('[SYNC] Critical engine error:', err);
    }
  }, SYNC_INTERVAL_MS);
}
