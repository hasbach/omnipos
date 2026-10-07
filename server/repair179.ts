// One-time repair for the 1.7.8 "resurrected rows" incident (v1.7.9).
//
// 1.7.8 re-downloaded every cloud row once. The cloud still held rows that had been SETTLED locally
// (day settlement archives transactions/items/payments/cash_flow, deletes cashier_shifts, and should
// delete them in the cloud - that delete had failed). The archived copies carried different global_ids,
// so the pull re-inserted them into the LIVE tables: duplicated invoices, double-counted balances (the
// settled effect is already banked in stakeholders.balance_baseline) and a wrong cash drawer. It also
// pulled in duplicates of seeded rows made by a test login on another PC (Admin / USD / Walk-in).
//
// This runs ONCE at startup (guarded by _migrations), after the DB migrations and before the sync
// engine starts. Conservative by design: every match is exact (see below), all local work for all
// tenants happens in ONE db.transaction together with the migration marker (so a failure rolls
// everything back and the repair is retried on the next start), and a VACUUM INTO backup is taken
// first whenever there is anything to repair. Rows that do not match are never touched.
import fs from "fs";
import path from "path";
import { db, dbDir } from "./db.js";
import { addTombstones, ensureTombstoneTable } from "./sync.js";
import { recomputeAllBalances } from "./balance.js";

export const REPAIR_179_NAME = "repair_1_7_9_resurrected_rows";
const EPS = "0.000001";

export interface TenantRepairReport {
  tenant_id: number;
  removed_transactions: number;
  removed_cash_flow: number;
  removed_shifts: number;
  merged_users: number;
  merged_currencies: number;
  merged_walk_ins: number;
  balance_changes: { stakeholder_id: number; name: string; before: number; after: number }[];
}

export interface RepairReport {
  applied: boolean; // false when nothing needed repairing (migration just marked done)
  backup: string | null;
  report_path: string | null;
  tenants: TenantRepairReport[];
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

function tableColumns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${q(table)})`).all() as any[]).map((c) => c.name);
}

function allTables(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as any[]).map((r) => r.name);
}

/** ORDER BY for "earliest created_at, then lowest id" - tolerant of a table without created_at. */
function earliestOrder(table: string): string {
  return tableColumns(table).includes("created_at")
    ? "COALESCE(datetime(created_at), '9999-12-31') ASC, id ASC"
    : "id ASC";
}

// ---- Detection (read-only) -------------------------------------------------------------------

// Live transactions that are copies of an archived (settled) one: same tenant/type/terminal/sequence
// (NULL-safe), same second, same total.
function findResurrectedTransactions(tenantId: number): any[] {
  return db.prepare(`
    SELECT t.id, t.global_id FROM transactions t
    WHERE t.tenant_id = ?
      AND EXISTS (
        SELECT 1 FROM archived_transactions a
        WHERE a.tenant_id = t.tenant_id
          AND a.type IS t.type
          AND a.terminal_id IS t.terminal_id
          AND a.terminal_sequence IS t.terminal_sequence
          AND a.stakeholder_id IS t.stakeholder_id
          AND datetime(a.created_at) = datetime(t.created_at)
          AND ABS(a.total_amount - t.total_amount) < ${EPS}
      )
    ORDER BY t.id
  `).all(tenantId) as any[];
}

function findResurrectedCashFlow(tenantId: number): any[] {
  return db.prepare(`
    SELECT c.id, c.global_id FROM cash_flow c
    WHERE c.tenant_id = ?
      AND EXISTS (
        SELECT 1 FROM archived_cash_flow a
        WHERE a.tenant_id = c.tenant_id
          AND a.type IS c.type
          AND a.currency IS c.currency
          AND ABS(a.amount - c.amount) < ${EPS}
          AND datetime(a.created_at) = datetime(c.created_at)
          AND COALESCE(a.reason, '') = COALESCE(c.reason, '')
          AND a.user_id IS c.user_id
          AND COALESCE(a.category, '') = COALESCE(c.category, '')
          AND COALESCE(a.counterparty, '') = COALESCE(c.counterparty, '')
      )
    ORDER BY c.id
  `).all(tenantId) as any[];
}

// Settlement deletes ALL of the tenant's shifts, so a shift created at/before the latest daily report
// cannot be genuine. Only applies when the tenant has at least one daily report.
function findResurrectedShifts(tenantId: number): any[] {
  const last = db.prepare("SELECT MAX(datetime(created_at)) AS d FROM daily_reports WHERE tenant_id = ?").get(tenantId) as any;
  if (!last?.d) return [];
  return db.prepare(
    "SELECT id, global_id FROM cashier_shifts WHERE tenant_id = ? AND datetime(created_at) <= datetime(?) ORDER BY id"
  ).all(tenantId, last.d) as any[];
}

interface DupGroup { keep: any; dups: any[] }

function groupDuplicates(rows: any[], keyOf: (r: any) => string): DupGroup[] {
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => ({ keep: g[0], dups: g.slice(1) })); // rows arrive pre-ordered
}

function findDuplicateAdmins(tenantId: number): DupGroup[] {
  const rows = db.prepare(
    `SELECT * FROM users WHERE tenant_id = ? AND name = 'Admin' AND role = 'admin' AND deleted_at IS NULL ORDER BY ${earliestOrder("users")}`
  ).all(tenantId) as any[];
  return groupDuplicates(rows, () => "admin");
}

function findDuplicateCurrencies(tenantId: number): DupGroup[] {
  const rows = db.prepare(
    `SELECT * FROM currencies WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY ${earliestOrder("currencies")}`
  ).all(tenantId) as any[];
  return groupDuplicates(rows, (r) => String(r.code ?? "").toLowerCase());
}

function findDuplicateWalkIns(tenantId: number): DupGroup[] {
  const rows = db.prepare(
    `SELECT * FROM stakeholders WHERE tenant_id = ? AND name = 'Walk-in Customer' AND deleted_at IS NULL ORDER BY ${earliestOrder("stakeholders")}`
  ).all(tenantId) as any[];
  return groupDuplicates(rows, () => "walkin");
}

function needsRepair(tenantId: number): boolean {
  return findResurrectedTransactions(tenantId).length > 0
    || findResurrectedCashFlow(tenantId).length > 0
    || findResurrectedShifts(tenantId).length > 0
    || findDuplicateAdmins(tenantId).length > 0
    || findDuplicateCurrencies(tenantId).length > 0
    || findDuplicateWalkIns(tenantId).length > 0;
}

// ---- Repair ----------------------------------------------------------------------------------

function repointColumn(column: "user_id" | "stakeholder_id", tenantId: number, from: number, to: number) {
  for (const table of allTables()) {
    const cols = tableColumns(table);
    if (!cols.includes(column)) continue;
    // Local ids are only unique per database, not per tenant: never touch a table we can't scope to
    // this tenant (none exist today; a future one is skipped rather than risk another tenant's rows).
    if (!cols.includes("tenant_id")) { console.warn(`[REPAIR 1.7.9] ${table}.${column} has no tenant_id - not re-pointed`); continue; }
    db.prepare(`UPDATE ${q(table)} SET ${column} = ? WHERE ${column} = ? AND tenant_id = ?`).run(to, from, tenantId);
  }
}

function repairTenant(tenantId: number): TenantRepairReport {
  const rep: TenantRepairReport = {
    tenant_id: tenantId, removed_transactions: 0, removed_cash_flow: 0, removed_shifts: 0,
    merged_users: 0, merged_currencies: 0, merged_walk_ins: 0, balance_changes: [],
  };
  const balancesBefore = new Map<number, { name: string; balance: number }>();
  for (const s of db.prepare("SELECT id, name, balance FROM stakeholders WHERE tenant_id = ?").all(tenantId) as any[]) {
    balancesBefore.set(s.id, { name: s.name, balance: s.balance || 0 });
  }

  // 1. Resurrected transactions (+ their items and payments). Stock is NOT touched: the original sale
  // already moved it, and a pull inserts rows directly without ever adjusting products.stock.
  for (const t of findResurrectedTransactions(tenantId)) {
    const items = db.prepare("SELECT id, global_id FROM transaction_items WHERE transaction_id = ?").all(t.id) as any[];
    const pays = db.prepare("SELECT id, global_id FROM payments WHERE transaction_id = ?").all(t.id) as any[];
    addTombstones(tenantId, [
      ...pays.map((p) => ({ table: "payments", globalId: p.global_id, parentGlobalId: t.global_id })),
      ...items.map((i) => ({ table: "transaction_items", globalId: i.global_id, parentGlobalId: t.global_id })),
      { table: "transactions", globalId: t.global_id },
    ]);
    db.prepare("DELETE FROM payments WHERE transaction_id = ?").run(t.id);
    db.prepare("DELETE FROM transaction_items WHERE transaction_id = ?").run(t.id);
    db.prepare("DELETE FROM transactions WHERE id = ? AND tenant_id = ?").run(t.id, tenantId);
    rep.removed_transactions++;
  }

  // 2. Resurrected cash_flow
  for (const c of findResurrectedCashFlow(tenantId)) {
    addTombstones(tenantId, [{ table: "cash_flow", globalId: c.global_id }]);
    db.prepare("DELETE FROM cash_flow WHERE id = ? AND tenant_id = ?").run(c.id, tenantId);
    rep.removed_cash_flow++;
  }

  // 3. Resurrected cashier shifts
  for (const s of findResurrectedShifts(tenantId)) {
    addTombstones(tenantId, [{ table: "cashier_shifts", globalId: s.global_id }]);
    db.prepare("DELETE FROM cashier_shifts WHERE id = ? AND tenant_id = ?").run(s.id, tenantId);
    rep.removed_shifts++;
  }

  // 4a. Duplicate 'Admin' users
  for (const g of findDuplicateAdmins(tenantId)) {
    for (const d of g.dups) {
      repointColumn("user_id", tenantId, d.id, g.keep.id);
      db.prepare("UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?").run(d.id, tenantId);
      rep.merged_users++;
    }
  }

  // 4b. Duplicate currencies (same code, case-insensitive)
  for (const g of findDuplicateCurrencies(tenantId)) {
    const hadDefault = [g.keep, ...g.dups].some((c) => c.is_default === 1);
    for (const d of g.dups) {
      db.prepare("UPDATE currencies SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?").run(d.id, tenantId);
      rep.merged_currencies++;
    }
    const liveDefault = db.prepare("SELECT 1 FROM currencies WHERE tenant_id = ? AND is_default = 1 AND deleted_at IS NULL").get(tenantId);
    if (hadDefault && !liveDefault) {
      db.prepare("UPDATE currencies SET is_default = 1 WHERE id = ? AND tenant_id = ?").run(g.keep.id, tenantId);
    }
  }

  // 4c. Duplicate 'Walk-in Customer' stakeholders
  for (const g of findDuplicateWalkIns(tenantId)) {
    for (const d of g.dups) {
      repointColumn("stakeholder_id", tenantId, d.id, g.keep.id);
      db.prepare("UPDATE stakeholders SET balance_baseline = IFNULL(balance_baseline, 0) + ? WHERE id = ? AND tenant_id = ?")
        .run(d.balance_baseline || 0, g.keep.id, tenantId);
      // The duplicate's baseline now lives on the kept row - zero it so it can't be counted twice.
      db.prepare("UPDATE stakeholders SET balance_baseline = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?").run(d.id, tenantId);
      rep.merged_walk_ins++;
    }
  }

  // 5. Balances are derived: recompute from baseline + the (now de-duplicated) live transactions.
  recomputeAllBalances(tenantId, { source: "repair_1_7_9", note: "Removed re-downloaded settled rows (1.7.9)" });
  for (const s of db.prepare("SELECT id, name, balance FROM stakeholders WHERE tenant_id = ?").all(tenantId) as any[]) {
    const before = balancesBefore.get(s.id);
    if (before && Math.abs(before.balance - (s.balance || 0)) > 0.0000001) {
      rep.balance_changes.push({ stakeholder_id: s.id, name: s.name, before: before.balance, after: s.balance || 0 });
    }
  }
  return rep;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Run the repair once. Returns null when it already ran; otherwise a report (applied=false when there
 * was nothing to fix). THROWS on failure without marking the migration done - callers must catch.
 */
export function runRepair179(opts: { backupDir?: string } = {}): RepairReport | null {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  if (db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get(REPAIR_179_NAME)) return null;
  ensureTombstoneTable(); // DDL up-front: keep it out of the repair transaction

  const tenantIds = (db.prepare("SELECT id FROM tenants ORDER BY id").all() as any[]).map((r) => r.id as number);
  const toRepair = tenantIds.filter(needsRepair);

  if (toRepair.length === 0) {
    db.prepare("INSERT OR IGNORE INTO _migrations (name) VALUES (?)").run(REPAIR_179_NAME);
    return { applied: false, backup: null, report_path: null, tenants: [] };
  }

  // 0. Backup first - if it fails, abort (nothing changed, migration not marked).
  const dir = opts.backupDir ?? dbDir;
  fs.mkdirSync(dir, { recursive: true });
  const ts = timestamp();
  const backup = path.join(dir, `backup-before-1.7.9-repair-${ts}.db`);
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  if (!fs.existsSync(backup) || fs.statSync(backup).size === 0) throw new Error(`repair 1.7.9: backup was not created at ${backup}`);

  // 1-6. Everything in one transaction, migration marker included: all or nothing.
  const tenants: TenantRepairReport[] = db.transaction(() => {
    const out = toRepair.map(repairTenant);
    db.prepare("INSERT OR IGNORE INTO _migrations (name) VALUES (?)").run(REPAIR_179_NAME);
    return out;
  })();

  const report: RepairReport = { applied: true, backup, report_path: path.join(dir, `repair-1.7.9-report-${ts}.json`), tenants };
  try {
    fs.writeFileSync(report.report_path!, JSON.stringify(report, null, 2));
  } catch (e) {
    console.error("repair 1.7.9: could not write the report file:", e); // the repair itself is committed
    report.report_path = null;
  }
  console.log("repair 1.7.9: done", JSON.stringify(report));
  return report;
}
