import fs from "fs";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";

// Database Setup
export let dbPath = "pos.db";
export let sessionsDir = ".";
if (process.env.NODE_ENV === 'production' || process.env.ELECTRON_RUN_AS_NODE) {
  const dataDir = process.env.APPDATA || (process.platform === 'darwin' ? path.join(process.env.HOME || '', 'Library', 'Application Support') : path.join(process.env.HOME || '', '.config'));
  const appDataDir = path.join(dataDir, 'OmniPOS');
  dbPath = path.join(appDataDir, 'pos.db');
  sessionsDir = appDataDir;
}

// Absolute folder holding the database, resolved once at import time (dbPath may be relative to the
// cwd of that moment). Backups (e.g. the pre-reset backup) live in a subfolder next to it.
export const dbDir = path.dirname(path.resolve(dbPath));

console.log(`Initializing database at: ${dbPath}`);

export let db: any;
try {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  console.log("Database connected successfully");
} catch (err: any) {
  console.error(`Database initialization error: ${err.message}`);
  process.exit(1);
}

// Initialize Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    local_license_type TEXT CHECK(local_license_type IN ('year', 'lifetime')) DEFAULT 'year',
    local_license_expiry DATETIME,
    online_license_type TEXT CHECK(online_license_type IN ('monthly', 'lifetime')) DEFAULT 'monthly',
    online_license_expiry DATETIME,
    or_license_type TEXT CHECK(or_license_type IN ('none', 'monthly', 'year', 'lifetime')) DEFAULT 'none',
    or_license_expiry DATETIME,
    current_version TEXT DEFAULT '2.5.0',
    available_version TEXT DEFAULT '2.5.0',
    scheduled_update_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    barcode TEXT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    price_lbp REAL,
    package_price REAL,
    package_price_lbp REAL,
    cost REAL,
    cost_lbp REAL,
    units_per_package INTEGER DEFAULT 1,
    stock INTEGER DEFAULT 0,
    reorder_point INTEGER DEFAULT 0,
    track_inventory INTEGER DEFAULT 1,
    category TEXT,
    currency TEXT DEFAULT 'USD',
    unit TEXT DEFAULT 'pcs',
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS product_barcodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    barcode TEXT UNIQUE NOT NULL,
    FOREIGN KEY(product_id) REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS stakeholders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT CHECK(type IN ('customer', 'supplier')) NOT NULL,
    email TEXT,
    phone TEXT,
    address TEXT,
    balance REAL DEFAULT 0,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    pin TEXT DEFAULT '0000',
    role TEXT DEFAULT 'staff',
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    stakeholder_id INTEGER,
    user_id INTEGER,
    type TEXT CHECK(type IN ('sale', 'purchase', 'refund')) DEFAULT 'sale',
    total_amount REAL NOT NULL,
    currency TEXT NOT NULL,
    exchange_rate REAL NOT NULL,
    discount_type TEXT,
    discount_value REAL,
    tax_type TEXT,
    tax_value REAL,
    status TEXT DEFAULT 'pending',
    terminal_id TEXT,
    terminal_sequence INTEGER,
    idempotency_key TEXT,
    original_transaction_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(stakeholder_id) REFERENCES stakeholders(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS transaction_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity REAL NOT NULL,
    unit_price REAL NOT NULL,
    discount_type TEXT,
    discount_value REAL,
    tax_type TEXT,
    tax_value REAL,
    FOREIGN KEY(transaction_id) REFERENCES transactions(id),
    FOREIGN KEY(product_id) REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL,
    currency TEXT NOT NULL,
    exchange_rate REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(transaction_id) REFERENCES transactions(id)
  );

  CREATE TABLE IF NOT EXISTS archived_transactions (
    id INTEGER PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    stakeholder_id INTEGER,
    user_id INTEGER,
    type TEXT,
    total_amount REAL NOT NULL,
    currency TEXT NOT NULL,
    exchange_rate REAL NOT NULL,
    discount_type TEXT,
    discount_value REAL,
    tax_type TEXT,
    tax_value REAL,
    status TEXT,
    terminal_id TEXT,
    terminal_sequence INTEGER,
    original_transaction_id INTEGER,
    created_at DATETIME,
    archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS archived_transaction_items (
    id INTEGER PRIMARY KEY,
    transaction_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity REAL NOT NULL,
    unit_price REAL NOT NULL,
    discount_type TEXT,
    discount_value REAL,
    tax_type TEXT,
    tax_value REAL
  );

  CREATE TABLE IF NOT EXISTS archived_payments (
    id INTEGER PRIMARY KEY,
    transaction_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL,
    currency TEXT NOT NULL,
    exchange_rate REAL NOT NULL,
    created_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS currencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    symbol TEXT NOT NULL,
    rate REAL NOT NULL,
    is_default INTEGER DEFAULT 0,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS user_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    action TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    tenant_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY(tenant_id, key),
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS cash_flow (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    type TEXT CHECK(type IN ('in', 'out')) NOT NULL,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'USD',
    exchange_rate REAL DEFAULT 1,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  -- End-of-day settlement used to just DELETE FROM cash_flow with no history kept anywhere,
  -- unlike transactions (which move to archived_transactions first). Settlement now archives here
  -- before deleting — see /api/tenant/settlement in server/routes.ts. Local-only, not synced to
  -- the cloud (same convention as archived_transactions/archived_payments in sync.ts).
  CREATE TABLE IF NOT EXISTS archived_cash_flow (
    id INTEGER PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    type TEXT,
    amount REAL NOT NULL,
    currency TEXT,
    exchange_rate REAL,
    reason TEXT,
    created_at DATETIME,
    archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS daily_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    date TEXT NOT NULL,
    opening_balance REAL DEFAULT 0,
    total_sales REAL DEFAULT 0,
    total_purchases REAL DEFAULT 0,
    total_cash_in REAL DEFAULT 0,
    total_cash_out REAL DEFAULT 0,
    closing_balance REAL DEFAULT 0,
    actual_balance REAL DEFAULT 0,
    difference REAL DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS yearly_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    year INTEGER NOT NULL,
    total_sales REAL DEFAULT 0,
    total_purchases REAL DEFAULT 0,
    total_profit REAL DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS cashier_shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    opening_balance REAL DEFAULT 0,
    cash_sales REAL DEFAULT 0,
    cash_refunds REAL DEFAULT 0,
    cash_purchases REAL DEFAULT 0,
    cash_in REAL DEFAULT 0,
    cash_out REAL DEFAULT 0,
    expected_cash REAL DEFAULT 0,
    actual_cash REAL DEFAULT 0,
    difference REAL DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS printers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT CHECK(type IN ('receipt', 'kitchen', 'bar')) NOT NULL DEFAULT 'receipt',
    connection TEXT CHECK(connection IN ('usb', 'network', 'bluetooth')) NOT NULL DEFAULT 'usb',
    address TEXT NOT NULL DEFAULT '',
    paper_width INTEGER NOT NULL DEFAULT 80,
    is_default INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );
`);

// Migration: Add tenant_id and bulk pricing columns to existing tables if not present
const columns = db.prepare("PRAGMA table_info(products)").all() as any[];
if (!columns.some((c: any) => c.name === 'tenant_id')) {
  console.log("Migrating to Multi-Tenant...");
  
  // Create a default tenant
  // This seed tenant's password is only ever checked by the OFFLINE local-bcrypt login fallback
  // (see establishLogin in server/routes.ts) — a real customer's tenant comes from the cloud
  // registration flow instead. A fixed fallback like 'admin123' would be a standing, publicly
  // known credential in every install (the packaged app ships with no .env at all, so this
  // fallback is what every real install actually uses unless DEFAULT_ADMIN_PASSWORD is set).
  // Generating a random one instead only matters once — it's hashed and stored in `tenants.password`
  // right below, so nothing needs to remember or persist the plaintext afterward.
  const hashedDefaultPassword = bcrypt.hashSync(process.env.DEFAULT_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url'), 10);
  const result = db.prepare("INSERT INTO tenants (name, email, password) VALUES (?, ?, ?)").run('Default Business', 'admin@example.com', hashedDefaultPassword);
  const defaultTenantId = result.lastInsertRowid;

  try {
    db.exec(`ALTER TABLE products ADD COLUMN tenant_id INTEGER DEFAULT ${defaultTenantId}`);
    db.exec(`ALTER TABLE stakeholders ADD COLUMN tenant_id INTEGER DEFAULT ${defaultTenantId}`);
    db.exec(`ALTER TABLE users ADD COLUMN tenant_id INTEGER DEFAULT ${defaultTenantId}`);
    db.exec(`ALTER TABLE transactions ADD COLUMN tenant_id INTEGER DEFAULT ${defaultTenantId}`);
    db.exec(`ALTER TABLE currencies ADD COLUMN tenant_id INTEGER DEFAULT ${defaultTenantId}`);
    // Settings is a bit different due to composite PK
    db.exec(`CREATE TABLE settings_new (tenant_id INTEGER, key TEXT, value TEXT, PRIMARY KEY(tenant_id, key))`);
    db.exec(`INSERT INTO settings_new (tenant_id, key, value) SELECT ${defaultTenantId}, key, value FROM settings`);
    db.exec(`DROP TABLE settings`);
    db.exec(`ALTER TABLE settings_new RENAME TO settings`);
  } catch (e) {
    console.error("Migration error:", e);
  }
}

// Add bulk pricing columns if they don't exist
if (!columns.some((c: any) => c.name === 'package_price')) {
  console.log("Adding bulk pricing columns...");
  try {
    db.exec(`ALTER TABLE products ADD COLUMN package_price REAL`);
    db.exec(`ALTER TABLE products ADD COLUMN units_per_package INTEGER DEFAULT 1`);
  } catch (e) {
    console.error("Bulk pricing migration error:", e);
  }
}

// Migration: Add license columns to tenants table if not present
const tenantCols = db.prepare("PRAGMA table_info(tenants)").all() as any[];
if (!tenantCols.some((c: any) => c.name === 'local_license_type')) {
  try {
    db.exec(`ALTER TABLE tenants ADD COLUMN local_license_type TEXT CHECK(local_license_type IN ('year', 'lifetime')) DEFAULT 'year'`);
    db.exec(`ALTER TABLE tenants ADD COLUMN local_license_expiry DATETIME`);
    db.exec(`ALTER TABLE tenants ADD COLUMN online_license_type TEXT CHECK(online_license_type IN ('monthly', 'lifetime')) DEFAULT 'monthly'`);
    db.exec(`ALTER TABLE tenants ADD COLUMN online_license_expiry DATETIME`);
  } catch (e) {
    console.error("Migration error (tenants license):", e);
  }
}
if (!tenantCols.some((c: any) => c.name === 'or_license_type')) {
  try {
    db.exec(`ALTER TABLE tenants ADD COLUMN or_license_type TEXT CHECK(or_license_type IN ('none', 'monthly', 'year', 'lifetime')) DEFAULT 'none'`);
    db.exec(`ALTER TABLE tenants ADD COLUMN or_license_expiry DATETIME`);
  } catch (e) {
    console.error("Migration error (tenants or_license):", e);
  }
}

// Add reorder_point column if it doesn't exist
if (!columns.some((c: any) => c.name === 'reorder_point')) {
  console.log("Adding reorder_point column...");
  try {
    db.exec(`ALTER TABLE products ADD COLUMN reorder_point INTEGER DEFAULT 0`);
  } catch (e) {
    console.error("Reorder point migration error:", e);
  }
}

// Graceful schema migrations for terminal sequences and new columns
try { db.exec("ALTER TABLE transactions ADD COLUMN terminal_id TEXT;"); } catch {}
try { db.exec("ALTER TABLE transactions ADD COLUMN terminal_sequence INTEGER;"); } catch {}
try { db.exec("ALTER TABLE archived_transactions ADD COLUMN terminal_id TEXT;"); } catch {}
try { db.exec("ALTER TABLE archived_transactions ADD COLUMN terminal_sequence INTEGER;"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN pin TEXT DEFAULT '0000';"); } catch {}
try { db.exec("ALTER TABLE products ADD COLUMN track_inventory INTEGER DEFAULT 1;"); } catch {}
// 1 = active, 0 = disabled (can't be sold; hidden from the POS; purchases/history keep working).
try { db.exec("ALTER TABLE products ADD COLUMN active INTEGER DEFAULT 1;"); } catch {}
try { db.exec("ALTER TABLE transactions ADD COLUMN idempotency_key TEXT;"); } catch {}
// A refund needs to point back at the sale it's refunding — without it there's no way to verify
// a refund's price/quantity against what was actually sold (see POST /api/transactions).
try { db.exec("ALTER TABLE transactions ADD COLUMN original_transaction_id INTEGER;"); } catch {}
try { db.exec("ALTER TABLE archived_transactions ADD COLUMN original_transaction_id INTEGER;"); } catch {}
try { db.exec("ALTER TABLE stakeholders ADD COLUMN address TEXT;"); } catch {}
// Per-printer Arabic mode: NULL codepage = print Arabic as images (works on any printer).
try { db.exec("ALTER TABLE printers ADD COLUMN arabic_codepage INTEGER;"); } catch {}
try { db.exec("ALTER TABLE printers ADD COLUMN arabic_encoding TEXT DEFAULT 'cp864';"); } catch {}

// 1.2.0 — price tiers, costing snapshots, invoice editing, stock adjustments.
// Tier prices (retail = `price`; wholesale = جملة; super wholesale = جملة الجملة). NULL/0 = not set.
for (const col of ['price_wholesale', 'price_wholesale_lbp', 'price_super_wholesale', 'price_super_wholesale_lbp', 'min_price']) {
  try { db.exec(`ALTER TABLE products ADD COLUMN ${col} REAL;`); } catch {}
}
try { db.exec("ALTER TABLE stakeholders ADD COLUMN price_level TEXT DEFAULT 'retail';"); } catch {}
try { db.exec("ALTER TABLE stakeholders ADD COLUMN credit_limit REAL;"); } catch {}
// A party's own local-currency exchange rate (units per USD); NULL = use the global currencies rate.
try { db.exec("ALTER TABLE stakeholders ADD COLUMN local_rate REAL;"); } catch {}
// Loyalty: a standing discount (percent off the whole sale) the POS applies when this customer is picked. NULL/0 = none.
try { db.exec("ALTER TABLE stakeholders ADD COLUMN discount_percent REAL;"); } catch {}
// Every column added to a live transactional table must also exist on its archived twin and be
// copied by /api/tenant/settlement — settlement moves rows between them.
for (const t of ['transactions', 'archived_transactions']) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN order_global_id TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN price_level TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN notes TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN reference TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN edited_at DATETIME;`); } catch {}
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN edit_count INTEGER DEFAULT 0;`); } catch {}
  // The tenant's local-currency rate (units per USD) and code at the moment of sale. Server-set,
  // never edited afterwards, local-only for now (see the push strip in server/sync.ts).
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN local_rate REAL;`); } catch {}
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN local_currency TEXT;`); } catch {}
}
// USD cost of one unit at the time the line was recorded — the basis of COGS / gross profit.
try { db.exec("ALTER TABLE transaction_items ADD COLUMN unit_cost REAL;"); } catch {}
try { db.exec("ALTER TABLE archived_transaction_items ADD COLUMN unit_cost REAL;"); } catch {}

// Units of measure (packs/cartons with their own barcodes and prices). Quantity/unit_price/unit_cost
// on transaction_items stay in BASE PIECES / per piece; these columns are a line-level snapshot of the
// unit sold (uom_qty is in that unit) and, for refunds, the sale line being refunded.
// product_units is created before the sync-metadata block below so it gets global_id/updated_at/
// deleted_at + triggers like every other synced table (rows are soft-deleted).
db.exec(`
  CREATE TABLE IF NOT EXISTS product_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    factor REAL NOT NULL,
    barcode TEXT,
    price REAL NOT NULL,
    price_lbp REAL,
    price_wholesale REAL,
    price_wholesale_lbp REAL,
    price_super_wholesale REAL,
    price_super_wholesale_lbp REAL,
    sort_order INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_product_units_tenant_product ON product_units(tenant_id, product_id);
  CREATE INDEX IF NOT EXISTS idx_product_units_tenant_barcode ON product_units(tenant_id, barcode);
`);
// Same rule as unit_cost above: live column => archived twin => copied by settlement.
for (const t of ['transaction_items', 'archived_transaction_items']) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN uom_id INTEGER;`); } catch {}
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN uom_name TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN uom_factor REAL;`); } catch {}
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN uom_qty REAL;`); } catch {}
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN original_item_id INTEGER;`); } catch {}
}

// Local-only audit/inventory tables (not in the sync PUSH/PULL lists).
db.exec(`
  CREATE TABLE IF NOT EXISTS transaction_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    transaction_id INTEGER NOT NULL,
    archived INTEGER DEFAULT 0,
    user_id INTEGER,
    reason TEXT,
    before_json TEXT,
    after_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS stock_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    user_id INTEGER,
    qty_before REAL,
    qty_after REAL,
    delta REAL,
    reason TEXT,
    unit_cost REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_tx_tenant_created ON transactions(tenant_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_atx_tenant_created ON archived_transactions(tenant_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ti_tx ON transaction_items(transaction_id);
  CREATE INDEX IF NOT EXISTS idx_ati_tx ON archived_transaction_items(transaction_id);
  CREATE INDEX IF NOT EXISTS idx_pay_tx ON payments(transaction_id);
  CREATE INDEX IF NOT EXISTS idx_apay_tx ON archived_payments(transaction_id);
  CREATE INDEX IF NOT EXISTS idx_tx_stakeholder ON transactions(stakeholder_id);
  CREATE INDEX IF NOT EXISTS idx_atx_stakeholder ON archived_transactions(stakeholder_id);
`);

// Settlement detail (docs/plans/2026-09-29-settlement-detail.md): a daily_report becomes the full
// record of one End-of-Day close (snapshot + counted cash per currency), the archived rows point
// back at the settlement that moved them, and admin corrections are appended (never edited in place).
for (const col of [
  "settled_at DATETIME", "period_start DATETIME", "total_refunds REAL DEFAULT 0", "counted_json TEXT",
  "snapshot_json TEXT", "corrected_actual_balance REAL", "adjustments_total REAL DEFAULT 0",
]) {
  try { db.exec(`ALTER TABLE daily_reports ADD COLUMN ${col};`); } catch {}
}
try { db.exec("ALTER TABLE archived_transactions ADD COLUMN settlement_id INTEGER;"); } catch {}
try { db.exec("ALTER TABLE archived_cash_flow ADD COLUMN settlement_id INTEGER;"); } catch {}

// Cash-flow categories + counterparty (who lent / who was paid), on the live AND archived tables so a
// settled day keeps them. `category` is one of server/cashFlow.ts CASH_FLOW_CATEGORIES; NULL reads as 'other'.
for (const t of ["cash_flow", "archived_cash_flow"]) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN category TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN counterparty TEXT;`); } catch {}
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN stakeholder_id INTEGER;`); } catch {}
}
// One-time backfill by reason prefix (the automatic rows). Only rows with NO category are touched, so
// re-running at every start is a no-op once done. Manual rows stay NULL (= 'other').
export function backfillCashFlowCategories() {
  for (const t of ["cash_flow", "archived_cash_flow"]) {
    db.exec(`
      UPDATE ${t} SET category = 'customer_collection'
       WHERE category IS NULL AND type = 'in'
         AND (reason LIKE 'Balance collection from %' OR reason LIKE 'Payment on invoice #%');
      UPDATE ${t} SET category = 'supplier_payment'
       WHERE category IS NULL AND type = 'out'
         AND (reason LIKE 'Payment to supplier %' OR reason LIKE 'Payment on invoice #%');
    `);
  }
}
backfillCashFlowCategories();
// Local-only audit trail for admin edits of cash-flow rows (live or archived), like transaction_edits:
// NOT in the sync lists and deliberately absent from the Supabase migration.
db.exec(`
  CREATE TABLE IF NOT EXISTS cash_flow_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    cash_flow_id INTEGER NOT NULL,
    archived INTEGER DEFAULT 0,
    user_id INTEGER,
    edit_reason TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_cfe_row ON cash_flow_edits(tenant_id, cash_flow_id);
`);
// Admin-defined cash-flow categories (Settings -> Cash flow categories). `key` is the stable slug
// stored in cash_flow.category (built-ins keep their fixed keys and are NOT rows here); rename or hide
// a category and old rows keep resolving through the key. Synced (created before the sync-metadata
// block so it gets global_id/updated_at/deleted_at + triggers); hiding = active 0, never deleted.
db.exec(`
  CREATE TABLE IF NOT EXISTS cash_flow_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('in', 'out', 'both')),
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cfc_tenant_key ON cash_flow_categories(tenant_id, key);
`);
// Cash accounts (Cash Drawer + Savings / Safe / Reserve funds). Created before the sync-metadata
// block so it gets global_id/updated_at/deleted_at + triggers.
db.exec(`
  CREATE TABLE IF NOT EXISTS cash_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'savings' CHECK(kind IN ('drawer', 'savings', 'bank')),
    is_default INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );
  CREATE INDEX IF NOT EXISTS idx_ca_tenant ON cash_accounts(tenant_id);
`);
for (const t of ["cash_flow", "archived_cash_flow"]) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN account_id INTEGER;`); } catch {}
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN transfer_id TEXT;`); } catch {}
}
for (const t of ["payments", "archived_payments"]) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN account_id INTEGER;`); } catch {}
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_atx_settlement ON archived_transactions(settlement_id);
  CREATE INDEX IF NOT EXISTS idx_acf_settlement ON archived_cash_flow(settlement_id);
  CREATE TABLE IF NOT EXISTS settlement_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    report_id INTEGER NOT NULL,
    user_id INTEGER,
    kind TEXT CHECK(kind IN ('counted', 'adjustment')) NOT NULL,
    currency TEXT,
    old_value REAL,
    new_value REAL,
    amount_usd REAL,
    reason TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(report_id) REFERENCES daily_reports(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_scorr_report ON settlement_corrections(report_id);
`);

// Commerce (specs/001-commerce-domain-foundation, Slice A): a tenant's online store and the products
// it publishes. Created before the sync-metadata block below so both get global_id/updated_at/
// deleted_at + triggers and sync like products. A listing references a product and never copies its
// price, stock or units. Empty until an admin turns commerce on; nothing is created automatically.
db.exec(`
  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    slug TEXT,
    mode TEXT NOT NULL DEFAULT 'retail',
    status TEXT NOT NULL DEFAULT 'draft',
    description TEXT,
    logo_path TEXT,
    cover_path TEXT,
    primary_color TEXT,
    contact_phone TEXT,
    contact_whatsapp TEXT,
    contact_email TEXT,
    address TEXT,
    default_language TEXT DEFAULT 'en',
    settings TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );
  CREATE INDEX IF NOT EXISTS idx_stores_tenant ON stores(tenant_id);
  CREATE TABLE IF NOT EXISTS store_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    store_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    published INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    description TEXT,
    images TEXT DEFAULT '[]',
    store_category TEXT,
    sort_order INTEGER DEFAULT 0,
    min_quantity REAL,
    orderable_unit_ids TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- No FK on store_id / product_id (same as product_units): products are hard-deleted locally and a
    -- pull may bring a listing before its parent. A listing whose product is gone is just unavailable.
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );
  CREATE INDEX IF NOT EXISTS idx_store_listings_tenant ON store_listings(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_store_listings_product ON store_listings(product_id);
`);

// No foreign-key constraints: cloud mirror rows may arrive in any order.
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    tenant_id INTEGER,
    store_id INTEGER,
    number INTEGER,
    state TEXT,
    cancelled_by TEXT,
    reason TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    fulfilment TEXT,
    address TEXT,
    note TEXT,
    local_currency TEXT,
    local_rate REAL,
    total_usd REAL,
    total_local REAL,
    confirmed_total_usd REAL,
    confirmed_total_local REAL,
    sale_global_id TEXT,
    sale_total_usd REAL,
    submitted_at DATETIME,
    expires_at DATETIME,
    confirmed_at DATETIME,
    ready_at DATETIME,
    closed_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS order_lines (
    id INTEGER PRIMARY KEY,
    tenant_id INTEGER,
    order_id INTEGER,
    line_no INTEGER,
    listing_id TEXT,
    product_id INTEGER,
    product_name TEXT,
    unit_key TEXT,
    unit_name TEXT,
    unit_factor REAL,
    ordered_qty REAL,
    confirmed_qty REAL,
    shortfall_reason TEXT,
    unit_price_usd REAL,
    unit_price_local REAL,
    line_total_usd REAL,
    line_total_local REAL
  );
  CREATE TABLE IF NOT EXISTS order_events (
    id INTEGER PRIMARY KEY,
    tenant_id INTEGER,
    order_id INTEGER,
    at DATETIME,
    kind TEXT,
    from_state TEXT,
    to_state TEXT,
    actor_kind TEXT,
    actor_name TEXT,
    terminal TEXT,
    reason TEXT,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_tenant_state ON orders(tenant_id, state);
  CREATE INDEX IF NOT EXISTS idx_orders_store ON orders(store_id);
  CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);
  CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_order ON transactions(order_global_id) WHERE order_global_id IS NOT NULL;
`);

// OmniPulse OR (Paid Add-On Module): Operations Research tables (Owner Draw, PO Cash-Lock,
// 5-Minute ABC Cycle Count, Virtual Cash Buckets, Fixed Obligations, Nightly Pipeline).
// Created before the sync-metadata block below so synced tables receive global_id/updated_at/
// deleted_at + triggers automatically. All monetary columns are stored in USD base.
db.exec(`
  CREATE TABLE IF NOT EXISTS or_tenant_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL UNIQUE,
    business_type TEXT NOT NULL DEFAULT 'RETAIL' CHECK(business_type IN ('RETAIL', 'RESTAURANT', 'SERVICE', 'HYBRID')),
    survival_mode TEXT NOT NULL DEFAULT 'RECOVERY' CHECK(survival_mode IN ('CRISIS', 'RECOVERY', 'GROWTH')),
    enable_owner_draw INTEGER NOT NULL DEFAULT 1,
    enable_po_cash_lock INTEGER NOT NULL DEFAULT 1,
    enable_cycle_count INTEGER NOT NULL DEFAULT 1,
    enable_recipe_deduction INTEGER NOT NULL DEFAULT 0,
    min_drawer_float REAL NOT NULL DEFAULT 30.0,
    cycle_count_daily_limit INTEGER NOT NULL DEFAULT 8,
    variance_alert_pct REAL NOT NULL DEFAULT 5.0,
    owner_stakeholder_id INTEGER,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS or_draw_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    survival_mode TEXT NOT NULL CHECK(survival_mode IN ('CRISIS', 'RECOVERY', 'GROWTH')),
    max_daily_cash REAL NOT NULL DEFAULT 0,
    max_daily_goods_cost REAL NOT NULL DEFAULT 0,
    max_monthly_total REAL NOT NULL DEFAULT 0,
    require_override_reason INTEGER NOT NULL DEFAULT 1,
    UNIQUE(tenant_id, survival_mode),
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS or_fixed_obligations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'opex',
    amount_usd REAL NOT NULL,
    frequency TEXT NOT NULL DEFAULT 'monthly' CHECK(frequency IN ('daily', 'weekly', 'monthly', 'yearly')),
    due_day INTEGER DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );
  CREATE INDEX IF NOT EXISTS idx_or_obligations_tenant ON or_fixed_obligations(tenant_id, active);

  CREATE TABLE IF NOT EXISTS or_cash_buckets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    target_amount REAL NOT NULL DEFAULT 0,
    current_balance REAL NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 1,
    UNIQUE(tenant_id, code),
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS or_cash_bucket_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    bucket_id INTEGER NOT NULL,
    tx_type TEXT NOT NULL,
    amount REAL NOT NULL,
    reference_type TEXT,
    reference_id INTEGER,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(bucket_id) REFERENCES or_cash_buckets(id)
  );
  CREATE INDEX IF NOT EXISTS idx_or_bucket_ledger_tenant ON or_cash_bucket_ledger(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS or_supplier_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    supplier_id INTEGER NOT NULL,
    lead_time_days INTEGER NOT NULL DEFAULT 2,
    fill_rate_score REAL NOT NULL DEFAULT 1.0,
    deliveries_count INTEGER NOT NULL DEFAULT 0,
    default_payment_plan TEXT NOT NULL DEFAULT 'CASH_ON_DELIVERY' CHECK(default_payment_plan IN ('CASH_ON_DELIVERY', 'CREDIT', 'SPLIT')),
    min_order_usd REAL NOT NULL DEFAULT 0,
    delivery_fee_usd REAL NOT NULL DEFAULT 0,
    delivery_days TEXT,
    notes TEXT,
    UNIQUE(tenant_id, supplier_id),
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS or_owner_draws (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    owner_user_id INTEGER,
    recorded_by_user_id INTEGER,
    draw_date TEXT NOT NULL,
    draw_type TEXT NOT NULL CHECK(draw_type IN ('CASH', 'GOODS', 'MEAL_RECIPE', 'MIXED')),
    cash_amount REAL NOT NULL DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    exchange_rate REAL DEFAULT 1,
    goods_cost_total REAL NOT NULL DEFAULT 0,
    total_draw_value REAL NOT NULL DEFAULT 0,
    cash_source TEXT,
    account_id INTEGER,
    exceeded_cap INTEGER NOT NULL DEFAULT 0,
    override_reason TEXT,
    core_cash_tx_id INTEGER,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );
  CREATE INDEX IF NOT EXISTS idx_or_owner_draws_tenant_date ON or_owner_draws(tenant_id, draw_date);

  CREATE TABLE IF NOT EXISTS or_owner_draw_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    owner_draw_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity REAL NOT NULL,
    unit_cost_snapshot REAL NOT NULL DEFAULT 0,
    line_cost_total REAL NOT NULL DEFAULT 0,
    core_stock_tx_id INTEGER,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(owner_draw_id) REFERENCES or_owner_draws(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_or_owner_draw_items_draw ON or_owner_draw_items(owner_draw_id);

  CREATE TABLE IF NOT EXISTS or_po_commitments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    po_number TEXT,
    core_transaction_id INTEGER,
    supplier_id INTEGER NOT NULL,
    expected_delivery_date TEXT NOT NULL,
    payment_plan TEXT NOT NULL DEFAULT 'CASH_ON_DELIVERY' CHECK(payment_plan IN ('CASH_ON_DELIVERY', 'CREDIT', 'SPLIT')),
    estimated_order_total REAL NOT NULL DEFAULT 0,
    locked_cash_amount REAL NOT NULL DEFAULT 0,
    actual_received_total REAL NOT NULL DEFAULT 0,
    actual_cash_paid REAL NOT NULL DEFAULT 0,
    actual_credit_added REAL NOT NULL DEFAULT 0,
    released_cash_amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT', 'APPROVED_LOCKED', 'PARTIALLY_RECEIVED', 'SETTLED', 'CANCELLED')),
    approved_by_user_id INTEGER,
    approved_at DATETIME,
    settled_at DATETIME,
    notes TEXT,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );
  CREATE INDEX IF NOT EXISTS idx_or_po_commit_delivery ON or_po_commitments(tenant_id, expected_delivery_date, status);

  CREATE TABLE IF NOT EXISTS or_po_commitment_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    po_commitment_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    ordered_qty REAL NOT NULL,
    received_qty REAL NOT NULL DEFAULT 0,
    unit_cost REAL NOT NULL DEFAULT 0,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(po_commitment_id) REFERENCES or_po_commitments(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_or_po_items_commit ON or_po_commitment_items(po_commitment_id);

  CREATE TABLE IF NOT EXISTS or_stock_anomalies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    anomaly_type TEXT NOT NULL CHECK(anomaly_type IN ('NEGATIVE_STOCK_SALE', 'STAFF_SHELF_EMPTY', 'HIGH_VARIANCE', 'EXPIRY_CHECK')),
    reported_by_user_id INTEGER,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'QUEUED', 'RESOLVED')),
    resolved_at DATETIME,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );
  CREATE INDEX IF NOT EXISTS idx_or_anomaly_open ON or_stock_anomalies(tenant_id, status);

  CREATE TABLE IF NOT EXISTS or_cycle_count_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    session_date TEXT NOT NULL,
    session_type TEXT NOT NULL DEFAULT 'DAILY_ABC' CHECK(session_type IN ('DAILY_ABC', 'PERISHABLE_CHECK', 'ANOMALY_AUDIT', 'SPOT_CHECK')),
    assigned_user_id INTEGER,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'IN_PROGRESS', 'PENDING_APPROVAL', 'COMPLETED')),
    total_items_planned INTEGER NOT NULL DEFAULT 0,
    total_variance_cost REAL NOT NULL DEFAULT 0,
    started_at DATETIME,
    completed_at DATETIME,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );
  CREATE INDEX IF NOT EXISTS idx_or_cycle_session_date ON or_cycle_count_sessions(tenant_id, session_date);

  CREATE TABLE IF NOT EXISTS or_cycle_count_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    session_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    priority_reason TEXT,
    system_qty_snapshot REAL NOT NULL DEFAULT 0,
    counted_qty REAL,
    variance_qty REAL,
    unit_cost_snapshot REAL NOT NULL DEFAULT 0,
    variance_cost REAL,
    core_adjustment_tx_id INTEGER,
    counted_at DATETIME,
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(session_id) REFERENCES or_cycle_count_sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_or_cycle_items_session ON or_cycle_count_items(session_id);

  CREATE TABLE IF NOT EXISTS or_action_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    action_date TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK(priority IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT,
    reference_type TEXT,
    reference_id INTEGER,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'DISMISSED', 'DONE')),
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );
  CREATE INDEX IF NOT EXISTS idx_or_action_queue_tenant ON or_action_queue(tenant_id, status, action_date);

  CREATE TABLE IF NOT EXISTS or_sku_metrics (
    tenant_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    weighted_daily_sales REAL NOT NULL DEFAULT 0,
    demand_std_30d REAL NOT NULL DEFAULT 0,
    safety_stock REAL NOT NULL DEFAULT 0,
    primary_supplier_id INTEGER,
    revenue_30d REAL NOT NULL DEFAULT 0,
    gross_margin_30d REAL NOT NULL DEFAULT 0,
    days_of_supply REAL,
    abc_class TEXT NOT NULL DEFAULT 'C' CHECK(abc_class IN ('A', 'B', 'C')),
    cash_velocity_score REAL NOT NULL DEFAULT 0,
    last_counted_at DATETIME,
    computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(tenant_id, product_id)
  );

  CREATE TABLE IF NOT EXISTS or_pipeline_runs (
    tenant_id INTEGER NOT NULL,
    run_date TEXT NOT NULL,
    trigger_source TEXT NOT NULL DEFAULT 'manual',
    summary_json TEXT,
    ran_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(tenant_id, run_date)
  );
`);
try { db.exec("ALTER TABLE or_supplier_profiles ADD COLUMN min_order_usd REAL NOT NULL DEFAULT 0;"); } catch {}
try { db.exec("ALTER TABLE or_supplier_profiles ADD COLUMN delivery_fee_usd REAL NOT NULL DEFAULT 0;"); } catch {}
try { db.exec("ALTER TABLE or_sku_metrics ADD COLUMN demand_std_30d REAL NOT NULL DEFAULT 0;"); } catch {}
try { db.exec("ALTER TABLE or_sku_metrics ADD COLUMN safety_stock REAL NOT NULL DEFAULT 0;"); } catch {}
try { db.exec("ALTER TABLE or_sku_metrics ADD COLUMN primary_supplier_id INTEGER;"); } catch {}
try { db.exec("ALTER TABLE or_tenant_config ADD COLUMN owner_stakeholder_id INTEGER;"); } catch {}

// Sync Metadata Migration (for Supabase Offline-First Sync)
// Local-only tables are never synced, so they get no sync columns or triggers (adding created_at
// to them failed with "non-constant default" at every start). sync_tombstones' global_id is the
// TOMBSTONED row's id, not its own.
const localOnlyTables = new Set(['sync_tombstones', '_migrations', 'cloud_session', 'sync_cursor', 'or_sku_metrics', 'or_pipeline_runs']);
const allTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
for (const table of allTables) {
  if (localOnlyTables.has(table.name)) continue;
  const tableCols = db.prepare(`PRAGMA table_info(${table.name})`).all() as { name: string }[];
  const colNames = tableCols.map(c => c.name);
  
  if (!colNames.includes('global_id')) {
    try { db.exec(`ALTER TABLE ${table.name} ADD COLUMN global_id TEXT`); } catch (e) {}
  }
  if (!colNames.includes('created_at')) {
    try { db.exec(`ALTER TABLE ${table.name} ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP`); } catch (e) { console.error(e); }
  }
  if (!colNames.includes('updated_at')) {
    try { db.exec(`ALTER TABLE ${table.name} ADD COLUMN updated_at DATETIME`); } catch (e) { console.error(e); }
  }
  if (!colNames.includes('deleted_at')) {
    try { db.exec(`ALTER TABLE ${table.name} ADD COLUMN deleted_at DATETIME`); } catch (e) { console.error(e); }
  }
  if (!colNames.includes('last_synced_at')) {
    try { db.exec(`ALTER TABLE ${table.name} ADD COLUMN last_synced_at DATETIME`); } catch (e) { console.error(e); }
  }

  // Create triggers to auto-generate UUIDs and update timestamps
  try {
    // Backfill global_id and timestamps for existing rows
    db.exec(`
      UPDATE ${table.name} SET global_id = lower(
        hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))
      ) WHERE global_id IS NULL;
      UPDATE ${table.name} SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table.name}_global_id
      AFTER INSERT ON ${table.name}
      FOR EACH ROW
      BEGIN
        UPDATE ${table.name} SET 
          global_id = COALESCE(NEW.global_id, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
          updated_at = COALESCE(NEW.updated_at, CURRENT_TIMESTAMP)
        WHERE rowid = NEW.rowid;
      END;
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table.name}_updated_at
      AFTER UPDATE ON ${table.name}
      FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
      BEGIN
        UPDATE ${table.name} SET updated_at = CURRENT_TIMESTAMP WHERE rowid = NEW.rowid;
      END;
    `);
  } catch (e) {
    console.error(`Trigger error on ${table.name}:`, e);
  }
}

// One live listing per (store, product); soft-deleted listings don't count. Needs deleted_at, which
// the sync-metadata block above adds.
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_store_listings_live ON store_listings(store_id, product_id) WHERE deleted_at IS NULL");

// Derived-balance migration: stakeholder.balance becomes balance_baseline + Σ(transaction effects)
// (see server/balance.ts). This column is intentionally NOT synced to the cloud (see
// server/sync.ts) — it holds this register's manual balance-payment adjustments going forward.
// One-time reconciliation: because balances had drifted (incremental += / -= corrupted by edits,
// deletes and sync), we RECONCILE every balance to its transaction/payment history at migration
// (baseline = 0, balance = transaction effect). Debt payments made via the POS ("Receive Debt")
// are stored as transactions, so they're included; only Cash-Flow-Register collections (which
// aren't tied to a transaction) are not, and would need re-entering.
const stakeholderCols = db.prepare("PRAGMA table_info(stakeholders)").all() as any[];
if (!stakeholderCols.some((c: any) => c.name === 'balance_baseline')) {
  try {
    db.exec("ALTER TABLE stakeholders ADD COLUMN balance_baseline REAL DEFAULT 0");
    const sts = db.prepare("SELECT id, tenant_id FROM stakeholders").all() as any[];
    const paidStmt = db.prepare("SELECT IFNULL(SUM(amount / exchange_rate), 0) as paid FROM payments WHERE transaction_id = ? AND method != 'credit'");
    const txStmt = db.prepare("SELECT id, type, total_amount FROM transactions WHERE stakeholder_id = ? AND tenant_id = ?");
    const seed = db.prepare("UPDATE stakeholders SET balance_baseline = 0, balance = ? WHERE id = ?");
    for (const s of sts) {
      let effect = 0;
      for (const t of txStmt.all(s.id, s.tenant_id) as any[]) {
        const unpaid = (t.total_amount || 0) - ((paidStmt.get(t.id) as any)?.paid || 0);
        if (t.type === 'sale' || t.type === 'purchase') effect -= unpaid;
        else if (t.type === 'refund') effect += unpaid;
      }
      seed.run(effect, s.id);
    }
    console.log(`Reconciled balance for ${sts.length} stakeholders (derived-balance migration).`);
  } catch (e) {
    console.error('balance_baseline migration error:', e);
  }
}

// Repair cross-tenant user_id references. A transaction (or cash_flow row) whose user_id points
// to a user from a DIFFERENT tenant breaks cloud sync: the push translates user_id to that user's
// global_id, which — if the other tenant is a non-synced seed account (e.g. Demo Business, user
// id 1) — isn't present in the cloud users table, so the whole batch fails the users FK and NO
// sales sync. This reassigns such rows to their own tenant's admin/first user (or NULL if none).
try {
  db.exec(`
    UPDATE transactions
       SET user_id = (SELECT id FROM users u WHERE u.tenant_id = transactions.tenant_id ORDER BY (u.role = 'admin') DESC, u.id LIMIT 1)
     WHERE user_id IS NOT NULL
       AND user_id NOT IN (SELECT id FROM users u2 WHERE u2.tenant_id = transactions.tenant_id);
    UPDATE cash_flow
       SET user_id = (SELECT id FROM users u WHERE u.tenant_id = cash_flow.tenant_id ORDER BY (u.role = 'admin') DESC, u.id LIMIT 1)
     WHERE user_id IS NOT NULL
       AND user_id NOT IN (SELECT id FROM users u2 WHERE u2.tenant_id = cash_flow.tenant_id);
    UPDATE transactions
       SET stakeholder_id = (SELECT id FROM stakeholders s WHERE s.tenant_id = transactions.tenant_id ORDER BY (s.name = 'Walk-in Customer') DESC, (s.type = 'customer') DESC, s.id LIMIT 1)
     WHERE stakeholder_id IS NOT NULL
       AND stakeholder_id NOT IN (SELECT id FROM stakeholders s2 WHERE s2.tenant_id = transactions.tenant_id);
  `);
} catch (e) {
  console.error('Cross-tenant reference repair error:', e);
}

// One-time RECOVERY: the first derived-balance migration computed balances from ACTIVE
// transactions only, so any customer debt whose credit sales had been archived by a past
// day-settlement was zeroed. Rebuild it: fold each stakeholder's ARCHIVED transaction effect into
// their baseline, then recompute balance = baseline + active effect. Convention: negative = owes
// us; a 'credit' payment is not real money so it never reduces the unpaid amount. Runs once
// (guarded by _migrations) and only ever ADDS back archived debt — it can't make a balance worse.
db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
if (!db.prepare("SELECT 1 FROM _migrations WHERE name = 'archived_balance_recovery_v1'").get()) {
  try {
    const effectOf = (txRows: any[], paidStmt: any) => {
      let e = 0;
      for (const t of txRows) {
        const unpaid = (t.total_amount || 0) - ((paidStmt.get(t.id) as any)?.p || 0);
        if (t.type === 'sale' || t.type === 'purchase') e -= unpaid;
        else if (t.type === 'refund') e += unpaid;
      }
      return e;
    };
    const archPaid = db.prepare("SELECT IFNULL(SUM(amount / exchange_rate), 0) p FROM archived_payments WHERE transaction_id = ? AND method != 'credit'");
    const actPaid = db.prepare("SELECT IFNULL(SUM(amount / exchange_rate), 0) p FROM payments WHERE transaction_id = ? AND method != 'credit'");
    const archTx = db.prepare("SELECT id, type, total_amount FROM archived_transactions WHERE stakeholder_id = ? AND tenant_id = ?");
    const actTx = db.prepare("SELECT id, type, total_amount FROM transactions WHERE stakeholder_id = ? AND tenant_id = ?");
    const sts = db.prepare("SELECT id, tenant_id, balance_baseline FROM stakeholders").all() as any[];
    const setRow = db.prepare("UPDATE stakeholders SET balance_baseline = ?, balance = ? WHERE id = ?");
    let restored = 0;
    for (const s of sts) {
      const archEff = effectOf(archTx.all(s.id, s.tenant_id) as any[], archPaid);
      const actEff = effectOf(actTx.all(s.id, s.tenant_id) as any[], actPaid);
      const newBaseline = (s.balance_baseline || 0) + archEff;
      setRow.run(newBaseline, newBaseline + actEff, s.id);
      if (Math.abs(archEff) > 0.005) restored++;
    }
    db.prepare("INSERT INTO _migrations (name) VALUES ('archived_balance_recovery_v1')").run();
    console.log(`Archived-balance recovery: restored carried-over debt for ${restored} stakeholders (of ${sts.length}).`);
  } catch (e) {
    console.error('archived_balance_recovery_v1 error:', e);
  }
}

// Stakeholder balance changelog (additive audit trail, local only — not cloud-synced). Rows are
// written by server/balance.ts whenever a persisted balance changes. Seed ONE opening row per
// stakeholder that has no history so the chain starts at today's balance (read-only w.r.t. balances).
db.exec(`
  CREATE TABLE IF NOT EXISTS stakeholder_balance_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    stakeholder_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    source TEXT NOT NULL,
    reference_id INTEGER,
    delta REAL NOT NULL,
    balance_before REAL NOT NULL,
    balance_after REAL NOT NULL,
    user_id INTEGER,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sbl_tenant_stakeholder ON stakeholder_balance_log(tenant_id, stakeholder_id, id);
`);
if (!db.prepare("SELECT 1 FROM _migrations WHERE name = 'balance_log_seed_v1'").get()) {
  try {
    db.exec(`
      INSERT INTO stakeholder_balance_log (tenant_id, stakeholder_id, source, delta, balance_before, balance_after)
      SELECT s.tenant_id, s.id, 'history_start', IFNULL(s.balance, 0), 0, IFNULL(s.balance, 0)
      FROM stakeholders s
      WHERE NOT EXISTS (SELECT 1 FROM stakeholder_balance_log l WHERE l.stakeholder_id = s.id AND l.tenant_id = s.tenant_id)
    `);
    db.prepare("INSERT INTO _migrations (name) VALUES ('balance_log_seed_v1')").run();
  } catch (e) {
    console.error('balance_log_seed_v1 error:', e);
  }
}
// The seed rows used to be written as source 'opening'; rename them so the customer statement can tell
// the one-time "history starts here" marker from a real opening balance (creation / import).
if (!db.prepare("SELECT 1 FROM _migrations WHERE name = 'balance_log_history_start_v1'").get()) {
  try {
    db.exec("UPDATE stakeholder_balance_log SET source = 'history_start' WHERE source = 'opening' AND note IS NULL AND user_id IS NULL AND balance_before = 0");
    db.prepare("INSERT INTO _migrations (name) VALUES ('balance_log_history_start_v1')").run();
  } catch (e) {
    console.error('balance_log_history_start_v1 error:', e);
  }
}

// Historical lines predate the unit_cost snapshot; the product's current cost is the best available
// estimate. Done ONCE so later cost changes never rewrite history.
if (!db.prepare("SELECT 1 FROM _migrations WHERE name = 'unit_cost_backfill_v1'").get()) {
  try {
    for (const t of ['transaction_items', 'archived_transaction_items']) {
      db.exec(`UPDATE ${t} SET unit_cost = (SELECT p.cost FROM products p WHERE p.id = ${t}.product_id) WHERE unit_cost IS NULL`);
    }
    db.prepare("INSERT INTO _migrations (name) VALUES ('unit_cost_backfill_v1')").run();
  } catch (e) {
    console.error('unit_cost_backfill_v1 error:', e);
  }
}

// Legacy package pricing (package_price / units_per_package) becomes a real "Pack" unit so it can
// carry its own barcode and be sold as a unit. Legacy columns are kept for older devices/cloud.
// Exported so the regression suite can re-run it against a seeded legacy product.
export function runUomFromPackageMigration() {
  if (db.prepare("SELECT 1 FROM _migrations WHERE name = 'uom_from_package_v1'").get()) return;
  try {
    db.exec(`
      INSERT INTO product_units (tenant_id, product_id, name, factor, price, price_lbp, sort_order)
      SELECT p.tenant_id, p.id, 'Pack', p.units_per_package, p.package_price, p.package_price_lbp, 0
      FROM products p
      WHERE p.package_price > 0 AND p.units_per_package > 1 AND p.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM product_units u WHERE u.product_id = p.id AND u.deleted_at IS NULL)
    `);
    db.prepare("INSERT INTO _migrations (name) VALUES ('uom_from_package_v1')").run();
  } catch (e) {
    console.error('uom_from_package_v1 error:', e);
  }
}
runUomFromPackageMigration();

// Rows archived by settlements that predate settlement_id: the old client POSTed the daily report
// seconds BEFORE calling the settlement, so a report belongs to the rows archived just after it.
// Attach each unlinked archived row to the tenant's latest report created no later than
// archived_at + 120s (and not more than 10 minutes before it — an older report is a different
// close). Rows with no such report stay unlinked. Exported so the suite can re-run it.
export function runSettlementLinkBackfill() {
  if (db.prepare("SELECT 1 FROM _migrations WHERE name = 'settlement_link_backfill_v1'").get()) return;
  try {
    for (const t of ['archived_transactions', 'archived_cash_flow']) {
      db.exec(`
        UPDATE ${t} SET settlement_id = (
          SELECT r.id FROM daily_reports r
          WHERE r.tenant_id = ${t}.tenant_id
            AND r.created_at <= datetime(${t}.archived_at, '+120 seconds')
            AND r.created_at >= datetime(${t}.archived_at, '-600 seconds')
          ORDER BY r.created_at DESC, r.id DESC LIMIT 1
        ) WHERE settlement_id IS NULL AND archived_at IS NOT NULL
      `);
    }
    db.exec(`
      UPDATE daily_reports SET settled_at = (
        SELECT MAX(a) FROM (
          SELECT archived_at AS a FROM archived_transactions WHERE settlement_id = daily_reports.id
          UNION ALL
          SELECT archived_at AS a FROM archived_cash_flow WHERE settlement_id = daily_reports.id
        )
      ) WHERE settled_at IS NULL AND (
        EXISTS (SELECT 1 FROM archived_transactions WHERE settlement_id = daily_reports.id)
        OR EXISTS (SELECT 1 FROM archived_cash_flow WHERE settlement_id = daily_reports.id)
      )
    `);
    db.prepare("INSERT INTO _migrations (name) VALUES ('settlement_link_backfill_v1')").run();
  } catch (e) {
    console.error('settlement_link_backfill_v1 error:', e);
  }
}
runSettlementLinkBackfill();

// 003 (specs/003-retail-ordering, research R5): listing orderable units were stored as this register's local
// product_units ids, which mean nothing on other registers or in the cloud. Convert them to unit keys ("base" =
// the product's base unit, else the unit's global_id). The old meaning always included the base unit. Ids with
// no unit (deleted, other tenant/product) are dropped. Only integer arrays are touched, so it is idempotent; the
// updated_at trigger marks converted rows for push. Exported so the suite can re-run it.
export function convertOrderableUnitIds(database: any = db): number {
  const rows = database.prepare("SELECT id, tenant_id, product_id, orderable_unit_ids FROM store_listings WHERE orderable_unit_ids IS NOT NULL AND orderable_unit_ids <> ''").all() as any[];
  const unitGid = database.prepare('SELECT global_id FROM product_units WHERE id = ? AND tenant_id = ? AND product_id = ? AND global_id IS NOT NULL');
  const save = database.prepare('UPDATE store_listings SET orderable_unit_ids = ? WHERE id = ? AND tenant_id = ?');
  let converted = 0;
  database.transaction(() => {
    for (const r of rows) {
      let ids: any;
      try { ids = JSON.parse(r.orderable_unit_ids); } catch { continue; }
      if (!Array.isArray(ids) || !ids.every((x: any) => Number.isInteger(x))) continue;
      const keys = ['base'];
      for (const id of ids) {
        const u = unitGid.get(id, r.tenant_id, r.product_id) as any;
        if (u && !keys.includes(u.global_id)) keys.push(u.global_id);
      }
      save.run(JSON.stringify(keys), r.id, r.tenant_id);
      converted++;
    }
  })();
  return converted;
}
{
  const n = convertOrderableUnitIds();
  if (n) console.log(`[db] converted orderable units of ${n} store listing(s) to unit keys`);
}

// Seed data if empty
const tenantCount = db.prepare("SELECT COUNT(*) as count FROM tenants").get() as { count: number };
if (tenantCount.count === 0) {
  // This seed tenant's password is only ever checked by the OFFLINE local-bcrypt login fallback
  // (see establishLogin in server/routes.ts) — a real customer's tenant comes from the cloud
  // registration flow instead. A fixed fallback like 'admin123' would be a standing, publicly
  // known credential in every install (the packaged app ships with no .env at all, so this
  // fallback is what every real install actually uses unless DEFAULT_ADMIN_PASSWORD is set).
  // Generating a random one instead only matters once — it's hashed and stored in `tenants.password`
  // right below, so nothing needs to remember or persist the plaintext afterward.
  const hashedDefaultPassword = bcrypt.hashSync(process.env.DEFAULT_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url'), 10);
  const result = db.prepare("INSERT INTO tenants (name, email, password) VALUES (?, ?, ?)").run('Demo Business', 'demo@example.com', hashedDefaultPassword);
  const tenantId = result.lastInsertRowid;

  const insertProduct = db.prepare("INSERT INTO products (tenant_id, barcode, name, price, stock, category) VALUES (?, ?, ?, ?, ?, ?)");
  insertProduct.run(tenantId, "1001", "Whole Milk 1L", 1.50, 50, "Dairy");
  insertProduct.run(tenantId, "1002", "White Bread", 2.20, 30, "Bakery");
  insertProduct.run(tenantId, "1003", "Coffee Beans 500g", 12.00, 20, "Pantry");
  insertProduct.run(tenantId, "1004", "Organic Eggs 12pk", 4.50, 40, "Dairy");
  
  const insertStakeholder = db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, ?, ?)");
  insertStakeholder.run(tenantId, "Walk-in Customer", "customer");
  insertStakeholder.run(tenantId, "Global Foods Inc", "supplier");

  const insertUser = db.prepare("INSERT INTO users (tenant_id, name, role) VALUES (?, ?, ?)");
  insertUser.run(tenantId, "Admin", "admin");

  const insertCurrency = db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, ?, ?, ?, ?)");
  insertCurrency.run(tenantId, "USD", "$", 1, 1);
  insertCurrency.run(tenantId, "EUR", "€", 0.92, 0);
  insertCurrency.run(tenantId, "LBP", "LL", 89500, 0);
}

// The super-admin ('hasbach') account is intentionally NOT auto-seeded here — it lives only
// in Supabase (a single, deliberately-created row with its own password). Every fresh local
// install therefore ships with no super-admin account and no default/hardcoded password at
// all. Logging in still works from any machine: /api/auth/login already tries Supabase first
// and upserts the authenticated tenant into local SQLite on success, so the correct hash gets
// cached locally (for offline fallback on that machine) only after a real, successful cloud
// login — never before.

export function logAction(tenantId: number | string, userId: number | string | null, action: string, details: string) {
  try {
    db.prepare("INSERT INTO user_logs (tenant_id, user_id, action, details) VALUES (?, ?, ?, ?)").run(tenantId, userId, action, details);
  } catch (err) {
    console.error('Logging error:', err);
  }
}
