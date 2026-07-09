import fs from "fs";
import path from "path";
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
  const hashedDefaultPassword = bcrypt.hashSync(process.env.DEFAULT_ADMIN_PASSWORD || 'admin123', 10);
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
try { db.exec("ALTER TABLE transactions ADD COLUMN idempotency_key TEXT;"); } catch {}

// Sync Metadata Migration (for Supabase Offline-First Sync)
const allTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
for (const table of allTables) {
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

// Seed data if empty
const tenantCount = db.prepare("SELECT COUNT(*) as count FROM tenants").get() as { count: number };
if (tenantCount.count === 0) {
  const hashedDefaultPassword = bcrypt.hashSync(process.env.DEFAULT_ADMIN_PASSWORD || 'admin123', 10);
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
