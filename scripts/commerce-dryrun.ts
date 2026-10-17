// Upgrade dry run for the commerce foundation (specs/001-commerce-domain-foundation, US1 / SC-001).
//
// Copies a database, measures it, runs the CURRENT schema setup (server/db.ts) on the copy, measures
// again and prints every difference. Exit code 1 if anything that matters to a shop changed.
// The original file is never opened for writing.
//
// better-sqlite3 is built for Electron in this repo, so switch to the Node build around the run:
//   npm rebuild better-sqlite3
//   npx tsx scripts/commerce-dryrun.ts "C:\path\to\copy-of-pos.db"
//   npm run rebuild
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

type Snapshot = Record<string, number | string>;

function has(db: any, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function measure(db: any): Snapshot {
  const out: Snapshot = {};
  const one = (key: string, sql: string, table: string) => {
    if (!has(db, table)) return;
    out[key] = Number((db.prepare(sql).get() as any).v ?? 0);
  };
  for (const t of ["tenants", "products", "product_units", "stakeholders", "users", "transactions", "transaction_items",
    "payments", "archived_transactions", "archived_transaction_items", "archived_payments", "cash_flow",
    "archived_cash_flow", "daily_reports", "settings", "currencies"]) {
    one(`count.${t}`, `SELECT COUNT(*) v FROM ${t}`, t);
  }
  one("sum.products.stock", "SELECT ROUND(IFNULL(SUM(stock), 0), 6) v FROM products", "products");
  one("sum.transactions.total", "SELECT ROUND(IFNULL(SUM(total_amount), 0), 6) v FROM transactions", "transactions");
  one("sum.archived_transactions.total", "SELECT ROUND(IFNULL(SUM(total_amount), 0), 6) v FROM archived_transactions", "archived_transactions");
  one("sum.payments.amount", "SELECT ROUND(IFNULL(SUM(amount), 0), 6) v FROM payments", "payments");
  one("sum.archived_payments.amount", "SELECT ROUND(IFNULL(SUM(amount), 0), 6) v FROM archived_payments", "archived_payments");
  one("sum.cash_flow.amount", "SELECT ROUND(IFNULL(SUM(amount), 0), 6) v FROM cash_flow", "cash_flow");
  if (has(db, "stakeholders")) {
    for (const r of db.prepare("SELECT id, ROUND(IFNULL(balance, 0), 6) b FROM stakeholders ORDER BY id").all() as any[]) {
      out[`balance.stakeholder.${r.id}`] = r.b;
    }
  }
  if (has(db, "products")) {
    for (const r of db.prepare("SELECT id, price, ROUND(IFNULL(stock, 0), 6) s FROM products ORDER BY id").all() as any[]) {
      out[`product.${r.id}`] = `${r.price}|${r.s}`;
    }
  }
  return out;
}

async function main() {
  const src = process.argv[2];
  if (!src || !fs.existsSync(src)) {
    console.error("Usage: npx tsx scripts/commerce-dryrun.ts <path to a COPY of pos.db>");
    process.exit(2);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "omnipos-dryrun-"));
  fs.copyFileSync(src, path.join(work, "pos.db"));

  const before = (() => {
    const db = new Database(path.join(work, "pos.db"), { readonly: true });
    try { return measure(db); } finally { db.close(); }
  })();

  // server/db.ts opens "pos.db" relative to the working directory (outside production/Electron).
  const prevCwd = process.cwd();
  process.chdir(work);
  let after: Snapshot;
  try {
    const { db } = await import("../server/db.js");
    after = measure(db);
    const commerce = {
      stores: Number((db.prepare("SELECT COUNT(*) v FROM stores").get() as any).v),
      store_listings: Number((db.prepare("SELECT COUNT(*) v FROM store_listings").get() as any).v),
      commerce_enabled: Number((db.prepare("SELECT COUNT(*) v FROM settings WHERE key = 'commerce_enabled'").get() as any).v),
    };
    console.log("Commerce tables after upgrade:", commerce);
    if (commerce.stores || commerce.store_listings || commerce.commerce_enabled) {
      console.error("FAIL: the upgrade created commerce rows on its own.");
      process.exitCode = 1;
    }
    db.close();
  } finally {
    process.chdir(prevCwd);
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs = [...keys].filter((k) => before[k] !== after[k]).sort();
  console.log(`Measured ${keys.size} values (${Object.keys(before).filter((k) => k.startsWith("balance.")).length} balances).`);
  if (diffs.length === 0) {
    console.log("OK: no differences in counts, stock, invoice totals, payments or balances.");
  } else {
    console.error(`FAIL: ${diffs.length} difference(s):`);
    for (const k of diffs.slice(0, 200)) console.error(`  ${k}: ${before[k]} -> ${after[k]}`);
    process.exitCode = 1;
  }
  console.log(`(work copy left at ${work})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
