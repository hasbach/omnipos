# Customer / Supplier Statement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Back-office statement for any customer/supplier in two modes — "Unpaid orders" (FIFO open items whose total equals the balance) and "Account activity" (From–To ledger) — printable on A4, on the receipt printer (ESC/POS), or saved as PDF, with correct Arabic.

**Architecture:** All statement content is built on the server: `server/statement.ts` (math: ledger, open items, activity), `server/statementDocument.ts` (localized, formatted document), `server/statementHtml.ts` (A4 / 80 mm HTML) and `server/printing/statement.ts` (ESC/POS). The UI (`src/pages/statement/StatementView.tsx`) only picks options, previews the server HTML in a sandboxed iframe, and hands the same HTML to new Electron IPC handlers for the print dialog / PDF.

**Tech Stack:** Node + Express + better-sqlite3 (server), node:test via tsx (tests), React + Tailwind (UI), Electron IPC (`webContents.print`, `printToPDF`), existing `EscPos` builder with Arabic raster / code-page support.

Spec: `docs/superpowers/specs/2026-10-13-party-statement-design.md`

## Global Constraints

- Sign convention (server/balance.ts): negative balance = party owes us (customer) / we owe them (supplier). Never change balance math; statements are read-only.
- Open-mode invariant: `previous_balance + Σ orders.remaining = −stakeholders.balance` (to the cent) when the balance is negative.
- Activity-mode invariant: `opening + Σ effect(rows) = closing`; day boundaries are **local** midnight (stored timestamps are UTC `YYYY-MM-DD HH:MM:SS` or ISO with `Z`).
- Printed language = store setting `language` (`en` | `ar` | `fr`, default `en`); Arabic HTML is `dir="rtl"`.
- Money: USD lines; LBP originals shown on LBP payment lines; final total also shown in the local currency at today's rate (`localCurrencyFor`).
- Permissions: new routes use the same rule as `/api/reports/customer-statement/:id` — `need: ['reports.view', 'parties.view']` (ANY one is enough).
- HTML uses system fonts `"Segoe UI", Tahoma, Arial, sans-serif` (Chromium shapes Arabic; the off-screen print window cannot load the app's bundled fonts).
- ESC/POS text must be latin1-safe except RTL text (which `EscPos` rasterizes/code-pages): use `~` not `≈` on receipts.
- Tests: single file → `npm rebuild better-sqlite3` once, then `npx tsx --test tests/<file>.test.ts`; full suite → `npm test` (restores the Electron build itself). Run `npm run rebuild` before launching Electron after single-file runs.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `feat/party-statement`.

## File Structure

| File | Responsibility |
|---|---|
| `server/statement.ts` (modify) | Ledger (`buildStatement`, gains `tx_id`/`archived`/`method` on rows), item loader, local-date helpers, `buildOpenStatement`, `buildActivityStatement` |
| `server/printing/statementLabels.ts` (create) | en/ar/fr fixed strings for printed statements |
| `server/statementFormat.ts` (create) | `usd`, `localAmount`, `balanceText`, `qtyText`, `itemName` — shared by HTML + ESC/POS |
| `server/statementDocument.ts` (create) | `parseStatementOpts`, `buildStatementDocument` (party, business, labels, localized rows) |
| `server/statementHtml.ts` (create) | `renderStatementHtml(doc, 'a4' \| 'receipt')` |
| `server/printing/statement.ts` (create) | `buildStatementBuffer({ doc, paperWidth, arabic })` |
| `server/routes.ts` (modify) | `GET /api/reports/statement/:id`, `GET /api/reports/statement/:id/html`, `POST /api/print/statement` |
| `server/permissions.ts` (modify) | rules for the three routes |
| `electron-main.js`, `electron-preload.cjs`, `src/types.ts` (modify) | `print:html` (dialog) and `print:pdf` (save PDF) IPC |
| `src/pages/statement/printStatement.ts` (create) | renderer wrappers with browser fallback |
| `src/pages/statement/StatementView.tsx` (create) | mode / range / format controls + iframe preview + actions |
| `src/intl/locales/statement.ts` (create) | UI strings (`stm_*`) |
| `src/pages/stakeholders/DetailDrawer.tsx`, `src/pages/reports/CustomerStatementTab.tsx` (modify) | use `StatementView` |
| `tests/statement-open.test.ts`, `tests/statement-activity.test.ts`, `tests/statement-document.test.ts`, `tests/statement-print.test.ts` (create) | server tests |

---

### Task 1: Ledger rows carry transaction id, archive flag and payment method; item loader and local-date helpers

**Files:**
- Modify: `server/statement.ts`
- Test: `tests/statement-activity.test.ts` (create; later tasks add to it)

**Interfaces:**
- Produces (exported from `server/statement.ts`):
  - `interface StatementItem { name: string; unit: string | null; factor: number | null; qty: number; unit_price: number; line_total: number; discount: { type: string; value: number } | null }`
  - `loadStatementItems(txId: number, archived: boolean): StatementItem[]`
  - `localDateOf(stamp: string): string` → `YYYY-MM-DD` in machine local time
  - `localStampLabel(stamp: string): string` → `DD/MM/YYYY HH:mm` local
  - `round2(n: number): number`
  - `buildStatement(...)` rows gain optional `tx_id: number`, `archived: 0 | 1`, `method: string` (payment rows only)

- [ ] **Step 1: Write the failing test**

Create `tests/statement-activity.test.ts`:

```ts
// Statement building blocks + "Account activity" mode (From–To ledger with local-midnight days).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let productId: number;
let stmt: typeof import("../server/statement.js");

before(async () => {
  app = await createTestApp();
  stmt = await import("../server/statement.js");
  tenantId = seedTenant(app.db, "Activity Co", "activity-co@example.com");
  productId = seedProduct(app.db, tenantId, { barcode: "AC-1", name: "Act Item", price: 25, stock: 500 });
});
after(async () => { await app.close(); });

const near = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} != ${b}`);
const post = async (body: any) => {
  const r = await app.api("POST", "/api/transactions", { tenantId, body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id as number;
};
// A local wall-clock moment as the UTC stamp SQLite stores (works in any test-machine time zone).
const utcStamp = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
const backdate = (txId: number, d: Date) => {
  app.db.prepare("UPDATE transactions SET created_at = ? WHERE id = ?").run(utcStamp(d), txId);
  app.db.prepare("UPDATE payments SET created_at = ? WHERE transaction_id = ?").run(utcStamp(d), txId);
};

test("ledger rows carry tx_id / archived / method and items load with units", async () => {
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Rows Customer", type: "customer" } })).body.id;
  const s1 = await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 10, method: "cash", currency: "USD", exchange_rate: 1 }] });
  const rows = stmt.buildStatement(tenantId, cust);
  const inv = rows.find((r: any) => r.type === "sale");
  assert.equal(inv.tx_id, s1);
  assert.equal(inv.archived, 0);
  const pay = rows.find((r: any) => r.type === "payment");
  assert.equal(pay.tx_id, s1);
  assert.equal(pay.method, "cash");

  const items = stmt.loadStatementItems(s1, false);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "Act Item");
  assert.equal(items[0].unit, null);
  near(items[0].qty, 2); near(items[0].unit_price, 25); near(items[0].line_total, 50);
});

test("local date helpers convert stored UTC stamps to local days", () => {
  const d = new Date(2026, 0, 15, 0, 30); // 15 Jan 2026 00:30 local
  assert.equal(stmt.localDateOf(utcStamp(d)), "2026-01-15");
  assert.equal(stmt.localDateOf(d.toISOString()), "2026-01-15");
  assert.equal(stmt.localStampLabel(utcStamp(d)), "15/01/2026 00:30");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm rebuild better-sqlite3` then `npx tsx --test tests/statement-activity.test.ts`
Expected: FAIL — `inv.tx_id` is `undefined` / `stmt.loadStatementItems is not a function`.

- [ ] **Step 3: Implement**

In `server/statement.ts`:

1. Extend `interface Ev` with three optional fields:

```ts
  method?: string;    // payment rows: the payment method
  tx_id?: number;     // every row that comes from a transaction
  archived?: boolean; // that transaction lives in the archived_* tables (settled)
```

2. In the transaction loop, add `method: p.method` to each of the four `events.push({...})` calls inside `for (const p of payments)` (the `on_account`, debt-ticket, `refund_payment` and `payment` pushes).

3. At the very end of the `for (const t of txns)` loop body (after the residue block), tag the transaction's events:

```ts
    for (const e of events.slice(txStart)) { e.tx_id = t.id; e.archived = !!t.archived; }
```

4. In the final `events.map(...)`, after the `if (e.currency !== undefined) {...}` block and before `return row;`, add:

```ts
    if (e.tx_id !== undefined) { row.tx_id = e.tx_id; row.archived = e.archived ? 1 : 0; }
    if (e.method !== undefined) row.method = e.method;
```

5. Append the helpers at the end of the file:

```ts
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const pad = (n: number) => String(n).padStart(2, '0');

// Stored stamps are UTC: SQLite 'YYYY-MM-DD HH:MM:SS' (no zone) or cloud ISO with Z / +00:00.
function parseStamp(stamp: string): Date | null {
  const s = String(stamp || '').trim().replace(' ', 'T');
  if (!s) return null;
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local calendar day (YYYY-MM-DD) of a stored UTC stamp. */
export function localDateOf(stamp: string): string {
  const d = parseStamp(stamp);
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : String(stamp || '').slice(0, 10);
}

/** "DD/MM/YYYY HH:mm" in local time, for printed statements. */
export function localStampLabel(stamp: string): string {
  const d = parseStamp(stamp);
  return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}` : String(stamp || '');
}

export interface StatementItem {
  name: string;
  unit: string | null;     // unit of measure name ("Carton") when sold in a unit
  factor: number | null;   // pieces per unit
  qty: number;             // in the unit when there is one, else pieces
  unit_price: number;      // per unit (per piece without a unit)
  line_total: number;      // before line discount, same as the sale receipt
  discount: { type: string; value: number } | null;
}

/** Product lines of one transaction (live or archived), shaped for printing. */
export function loadStatementItems(txId: number, archived: boolean): StatementItem[] {
  const table = archived ? 'archived_transaction_items' : 'transaction_items';
  const rows = db.prepare(`
    SELECT ti.*, COALESCE(p.name, 'Item') AS name FROM ${table} ti LEFT JOIN products p ON ti.product_id = p.id
    WHERE ti.transaction_id = ? ORDER BY ti.id ASC
  `).all(txId) as any[];
  return rows.map((r) => {
    const factor = r.uom_id && r.uom_name ? Number(r.uom_factor) || 1 : null;
    const qty = factor ? (r.uom_qty ?? r.quantity / factor) : r.quantity;
    return {
      name: r.name,
      unit: factor ? r.uom_name : null,
      factor,
      qty: Math.round(qty * 1000) / 1000,
      unit_price: round2(factor ? r.unit_price * factor : r.unit_price),
      line_total: round2(r.unit_price * r.quantity),
      discount: r.discount_type && r.discount_value > 0 ? { type: r.discount_type, value: r.discount_value } : null,
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/statement-activity.test.ts tests/statement.test.ts`
Expected: PASS (all; the existing statement tests are unaffected — fields are additive).

- [ ] **Step 5: Commit**

```bash
git add server/statement.ts tests/statement-activity.test.ts
git commit -m "feat(statement): ledger rows carry tx id/method; item loader and local-date helpers"
```

---

### Task 2: "Unpaid orders" mode — FIFO open items

**Files:**
- Modify: `server/statement.ts`
- Test: `tests/statement-open.test.ts` (create)

**Interfaces:**
- Consumes: `buildStatement`, `loadStatementItems`, `localStampLabel`, `round2` (Task 1)
- Produces:
  - `interface OpenOrder { id: number; reference: string; date: string; date_label: string; type: 'sale' | 'purchase'; items: StatementItem[]; discount: { type: string; value: number } | null; total: number; paid: number; remaining: number; status: 'unpaid' | 'partial' }`
  - `interface OpenStatement { previous_balance: number; orders: OpenOrder[]; total_due: number; credit: number }`
  - `buildOpenStatement(tenantId: number, stakeholderId: number | string): OpenStatement | null` (null = no such party)

- [ ] **Step 1: Write the failing test**

Create `tests/statement-open.test.ts`:

```ts
// "Unpaid orders" statement: balance payments pay the OLDEST orders first, so what is still owed is
// always the newest debts. The printed total must equal the party's balance exactly.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let productId: number;
let stmt: typeof import("../server/statement.js");

before(async () => {
  app = await createTestApp();
  stmt = await import("../server/statement.js");
  tenantId = seedTenant(app.db, "Open Items Co", "open-items@example.com");
  productId = seedProduct(app.db, tenantId, { barcode: "OI-1", name: "Open Item", price: 25, stock: 500 });
});
after(async () => { await app.close(); });

const near = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} != ${b}`);
const balanceOf = (id: number) => (app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(id) as any).balance as number;
const party = async (name: string, type = "customer", balance?: number) =>
  (await app.api("POST", "/api/stakeholders", { tenantId, body: { name, type, ...(balance !== undefined ? { balance } : {}) } })).body.id as number;
const post = async (body: any) => {
  const r = await app.api("POST", "/api/transactions", { tenantId, body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id as number;
};
const sale = (cust: number, quantity: number, payments: any[] = []) =>
  post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity }], currency: "USD", exchange_rate: 1, payments });
const collect = async (id: number, amount: number, direction = "collect") => {
  const r = await app.api("POST", "/api/balance-payment", { tenantId, body: { stakeholder_id: id, amount, currency: "USD", exchange_rate: 1, direction } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
};
const totalsMatch = (o: any, id: number) => {
  const sum = o.previous_balance + o.orders.reduce((s: number, x: any) => s + x.remaining, 0);
  near(sum, -balanceOf(id), "previous + remaining == amount owed");
  near(o.total_due, -balanceOf(id), "total_due == amount owed");
};

test("a balance payment pays the oldest orders first; the crossing order is partial", async () => {
  const c = await party("FIFO Customer");
  await sale(c, 1);            // 25 — fully covered by the collection
  const s2 = await sale(c, 1); // 25 — 5 covered
  const s3 = await sale(c, 1); // 25 — untouched
  await collect(c, 30);
  const o = stmt.buildOpenStatement(tenantId, c)!;
  totalsMatch(o, c);
  assert.deepEqual(o.orders.map((x) => x.id), [s2, s3], "oldest first, fully paid order omitted");
  assert.equal(o.orders[0].status, "partial"); near(o.orders[0].paid, 5); near(o.orders[0].remaining, 20);
  assert.equal(o.orders[1].status, "unpaid"); near(o.orders[1].remaining, 25);
  assert.equal(o.orders[1].items[0].name, "Open Item");
  near(o.previous_balance, 0);
});

test("money paid at the time of sale shows as paid on that order", async () => {
  const c = await party("Paid At Sale");
  const s = await sale(c, 2, [{ amount: 20, method: "cash", currency: "USD", exchange_rate: 1 }]);
  const o = stmt.buildOpenStatement(tenantId, c)!;
  totalsMatch(o, c);
  assert.equal(o.orders.length, 1);
  assert.equal(o.orders[0].id, s);
  near(o.orders[0].total, 50); near(o.orders[0].paid, 20); near(o.orders[0].remaining, 30);
  assert.equal(o.orders[0].status, "partial");
  assert.equal(o.orders[0].reference.length > 0, true);
});

test("an opening debt is the previous balance", async () => {
  const c = await party("Opening Debt", "customer", -20);
  await sale(c, 1);
  const o = stmt.buildOpenStatement(tenantId, c)!;
  totalsMatch(o, c);
  near(o.previous_balance, 20);
  assert.equal(o.orders.length, 1);
});

test("an opening debt older than the orders is paid first by a collection", async () => {
  const c = await party("Opening Paid First", "customer", -20);
  await sale(c, 1);
  await collect(c, 20);
  const o = stmt.buildOpenStatement(tenantId, c)!;
  totalsMatch(o, c);
  near(o.previous_balance, 0);
  near(o.orders[0].remaining, 25);
});

test("overpayment: no unpaid orders, credit shown", async () => {
  const c = await party("Overpaid");
  await sale(c, 1);
  await collect(c, 40);
  const o = stmt.buildOpenStatement(tenantId, c)!;
  assert.equal(o.orders.length, 0);
  near(o.total_due, 0);
  near(o.credit, 15);
});

test("a refund reduces what is owed (newest orders stay)", async () => {
  const c = await party("Refunder");
  const s1 = await sale(c, 1);
  const s2 = await sale(c, 1);
  await post({ type: "refund", original_transaction_id: s1, stakeholder_id: c, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] });
  const o = stmt.buildOpenStatement(tenantId, c)!;
  totalsMatch(o, c);
  assert.deepEqual(o.orders.map((x) => x.id), [s2]);
});

test("supplier: purchases, partial payment, total equals what we owe", async () => {
  const s = await party("Open Supplier", "supplier");
  const p1 = await post({ type: "purchase", stakeholder_id: s, items: [{ id: productId, quantity: 4, price: 25 }], currency: "USD", exchange_rate: 1, payments: [] }); // 100
  const p2 = await post({ type: "purchase", stakeholder_id: s, items: [{ id: productId, quantity: 2, price: 20 }], currency: "USD", exchange_rate: 1, payments: [] }); // 40
  await collect(s, 70, "pay");
  const o = stmt.buildOpenStatement(tenantId, s)!;
  totalsMatch(o, s);
  assert.deepEqual(o.orders.map((x) => [x.id, x.type, x.status]), [[p1, "purchase", "partial"], [p2, "purchase", "unpaid"]]);
  near(o.orders[0].remaining, 30);
});

test("settled (archived) orders still appear while unpaid", async () => {
  const c = await party("Archived Debtor");
  const s = await sale(c, 2, [{ amount: 20, method: "cash", currency: "USD", exchange_rate: 1 }]); // 30 owed
  const settle = await app.api("POST", "/api/tenant/settlement", { tenantId, body: {} });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));
  const o = stmt.buildOpenStatement(tenantId, c)!;
  totalsMatch(o, c);
  assert.equal(o.orders[0].id, s);
  near(o.orders[0].remaining, 30);
  assert.equal(o.orders[0].items.length, 1, "archived items loaded");
});

test("unknown party returns null", () => {
  assert.equal(stmt.buildOpenStatement(tenantId, 999999), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/statement-open.test.ts`
Expected: FAIL — `stmt.buildOpenStatement is not a function`.

- [ ] **Step 3: Implement**

Append to `server/statement.ts`:

```ts
export interface OpenOrder {
  id: number;
  reference: string;   // "MAIN-0042" or "#42"
  date: string;
  date_label: string;
  type: 'sale' | 'purchase';
  items: StatementItem[];
  discount: { type: string; value: number } | null;
  total: number;
  paid: number;        // total − remaining (at-sale payments + the FIFO share of later payments)
  remaining: number;
  status: 'unpaid' | 'partial';
}

export interface OpenStatement {
  previous_balance: number; // debt not tied to a listed order (opening, imports, manual edits)
  orders: OpenOrder[];      // oldest first
  total_due: number;        // = previous_balance + Σ remaining = −balance
  credit: number;           // > 0 when the balance is in the party's favour
}

function receiptRef(tx: any): string {
  return tx.terminal_id && tx.terminal_sequence ? `${tx.terminal_id}-${String(tx.terminal_sequence).padStart(4, '0')}` : `#${tx.id}`;
}

// "Unpaid orders": payments are applied to the OLDEST debts first, so the amount still owed is made of
// the NEWEST debts. Walk the debts newest -> oldest until they add up to what is owed; the debt where
// the sum crosses the balance is partially paid, older ones are fully paid. The total equals the
// balance by construction (any gap the history can't explain goes to previous_balance).
export function buildOpenStatement(tenantId: number, stakeholderId: number | string): OpenStatement | null {
  const st = db.prepare("SELECT balance FROM stakeholders WHERE id = ? AND tenant_id = ?").get(stakeholderId, tenantId) as any;
  if (!st) return null;
  const balance = round2(st.balance || 0);
  const due = -balance;
  if (due <= 0.005) return { previous_balance: 0, orders: [], total_due: 0, credit: balance > 0.005 ? balance : 0 };

  // One slot per transaction (its rows summed) or per non-transaction row, in ledger order.
  type Slot = { tx_id?: number; archived?: boolean; type: string; date: string; effect: number };
  const slots: Slot[] = [];
  const byTx = new Map<number, Slot>();
  for (const r of buildStatement(tenantId, stakeholderId)) {
    if (r.tx_id == null) { slots.push({ type: r.type, date: r.date, effect: r.effect }); continue; }
    let s = byTx.get(r.tx_id);
    if (!s) { s = { tx_id: r.tx_id, archived: !!r.archived, type: r.type, date: r.date, effect: 0 }; byTx.set(r.tx_id, s); slots.push(s); }
    s.effect += r.effect;
  }
  const debts = slots.filter((s) => s.effect < -0.005 && (s.tx_id == null || s.type === 'sale' || s.type === 'purchase'));

  let left = round2(due);
  const taken: { slot: Slot; remaining: number }[] = [];
  for (let i = debts.length - 1; i >= 0 && left > 0.005; i--) {
    const take = Math.min(round2(-debts[i].effect), left);
    taken.unshift({ slot: debts[i], remaining: round2(take) });
    left = round2(left - take);
  }

  let previous = left > 0.005 ? left : 0;
  const orders: OpenOrder[] = [];
  for (const { slot, remaining } of taken) {
    if (slot.tx_id == null) { previous = round2(previous + remaining); continue; }
    const tx = db.prepare(`SELECT * FROM ${slot.archived ? 'archived_transactions' : 'transactions'} WHERE id = ?`).get(slot.tx_id) as any || { id: slot.tx_id, total_amount: remaining };
    const total = round2(tx.total_amount || 0);
    orders.push({
      id: slot.tx_id,
      reference: receiptRef(tx),
      date: slot.date,
      date_label: localStampLabel(slot.date),
      type: slot.type as 'sale' | 'purchase',
      items: loadStatementItems(slot.tx_id, !!slot.archived),
      discount: tx.discount_type && tx.discount_value > 0 ? { type: tx.discount_type, value: tx.discount_value } : null,
      total,
      paid: round2(total - remaining),
      remaining,
      status: remaining < total - 0.005 ? 'partial' : 'unpaid',
    });
  }
  return { previous_balance: previous, orders, total_due: round2(due), credit: 0 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/statement-open.test.ts tests/statement.test.ts`
Expected: PASS. If "supplier" fails on direction, check `/api/balance-payment` in `server/routes.ts` for the supplier direction value (the existing statement test uses `"pay"`).

- [ ] **Step 5: Commit**

```bash
git add server/statement.ts tests/statement-open.test.ts
git commit -m "feat(statement): unpaid-orders mode with oldest-first allocation"
```

---

### Task 3: "Account activity" mode — From–To ledger

**Files:**
- Modify: `server/statement.ts`
- Test: `tests/statement-activity.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers, `buildStatement`
- Produces:
  - `interface ActivityRow { date: string; date_label: string; type: string; reference: string; method: string | null; debit: number; credit: number; effect: number; balance: number; currency?: string; amount_original?: number; tx_id?: number; items?: StatementItem[] }`
  - `interface ActivityStatement { from: string; to: string; opening: number; rows: ActivityRow[]; closing: number; total_debit: number; total_credit: number }`
  - `buildActivityStatement(tenantId: number, stakeholderId: number | string, from: string, to: string): ActivityStatement`

- [ ] **Step 1: Write the failing test**

Append to `tests/statement-activity.test.ts`:

```ts
test("activity: opening before From, rows inside the local-day range, closing at To", async () => {
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Range Customer", type: "customer" } })).body.id;
  const before1 = await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] }); // -25
  const inRange = await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 10, method: "cash", currency: "USD", exchange_rate: 1 }] }); // -50 +10
  const after1 = await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] }); // -25
  backdate(before1, new Date(2026, 0, 14, 23, 50)); // 14 Jan, 23:50 local — before From
  backdate(inRange, new Date(2026, 0, 15, 0, 30));  // 15 Jan, 00:30 local — first minutes of From
  backdate(after1, new Date(2026, 0, 16, 0, 30));   // 16 Jan, 00:30 local — after To

  const a = stmt.buildActivityStatement(tenantId, cust, "2026-01-15", "2026-01-15");
  near(a.opening, -25, "opening");
  assert.deepEqual(a.rows.map((r) => r.type), ["sale", "payment"]);
  assert.equal(a.rows[0].tx_id, inRange);
  assert.equal(a.rows[0].items?.length, 1);
  near(a.rows[0].items![0].qty, 2);
  assert.equal(a.rows[1].method, "cash");
  near(a.closing, -65, "closing");
  near(a.opening + a.rows.reduce((s, r) => s + r.effect, 0), a.closing, "opening + movements == closing");
  near(a.total_debit, 50); near(a.total_credit, 10);
});

test("activity: an empty range keeps opening == closing", async () => {
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Quiet Customer", type: "customer" } })).body.id;
  const s = await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] });
  backdate(s, new Date(2026, 0, 10, 12, 0));
  const a = stmt.buildActivityStatement(tenantId, cust, "2026-02-01", "2026-02-28");
  assert.equal(a.rows.filter((r) => r.type === "sale").length, 0);
  near(a.opening, -25); near(a.closing, -25);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/statement-activity.test.ts`
Expected: FAIL — `stmt.buildActivityStatement is not a function`.

- [ ] **Step 3: Implement**

Append to `server/statement.ts`:

```ts
export interface ActivityRow {
  date: string;
  date_label: string;
  type: string;
  reference: string;
  method: string | null;
  debit: number;
  credit: number;
  effect: number;
  balance: number;          // running balance after this row (app sign convention)
  currency?: string;
  amount_original?: number;
  tx_id?: number;
  items?: StatementItem[];  // invoice / purchase / refund rows only
}

export interface ActivityStatement {
  from: string;
  to: string;
  opening: number;          // balance at the start of `from` (local midnight)
  rows: ActivityRow[];
  closing: number;          // balance at the end of `to`
  total_debit: number;
  total_credit: number;
}

const INVOICE_TYPES = new Set(['sale', 'purchase', 'refund']);

// "Account activity" between two LOCAL calendar days (inclusive), cut out of the full ledger so the
// opening and closing balances are exactly the running balance at those points.
export function buildActivityStatement(tenantId: number, stakeholderId: number | string, from: string, to: string): ActivityStatement {
  let opening = 0;
  const rows: ActivityRow[] = [];
  for (const r of buildStatement(tenantId, stakeholderId)) {
    const day = localDateOf(r.date);
    if (day < from) { opening = r.balance; continue; }
    if (day > to) continue;
    const row: ActivityRow = {
      date: r.date, date_label: localStampLabel(r.date), type: r.type, reference: r.reference,
      method: r.method ?? null, debit: r.debit, credit: r.credit, effect: r.effect, balance: r.balance,
    };
    if (r.currency !== undefined) { row.currency = r.currency; row.amount_original = r.amount_original; }
    if (r.tx_id != null && INVOICE_TYPES.has(r.type)) {
      row.tx_id = r.tx_id;
      row.items = loadStatementItems(r.tx_id, !!r.archived);
    }
    rows.push(row);
  }
  const closing = rows.length ? rows[rows.length - 1].balance : opening;
  return {
    from, to,
    opening: round2(opening),
    rows,
    closing: round2(closing),
    total_debit: round2(rows.reduce((s, r) => s + r.debit, 0)),
    total_credit: round2(rows.reduce((s, r) => s + r.credit, 0)),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/statement-activity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/statement.ts tests/statement-activity.test.ts
git commit -m "feat(statement): account-activity mode with local-day range"
```

---

### Task 4: Labels, formatting, statement document and JSON + HTML endpoints

**Files:**
- Create: `server/printing/statementLabels.ts`, `server/statementFormat.ts`, `server/statementDocument.ts`, `server/statementHtml.ts`
- Modify: `server/routes.ts` (near `app.get("/api/reports/customer-statement/:id"` ~line 2424), `server/permissions.ts` (after line 188)
- Test: `tests/statement-document.test.ts` (create)

**Interfaces:**
- Consumes: `buildOpenStatement`, `buildActivityStatement`, `localStampLabel`, `OpenStatement`, `ActivityStatement`, `ActivityRow`, `StatementItem` (Tasks 1–3); `localCurrencyFor` (`server/localCurrency.ts`); `paymentMethodLabel` (`server/printing/receiptLabels.ts`)
- Produces:
  - `type StatementLanguage = 'en' | 'ar' | 'fr'`; `interface StatementLabels` (keys below); `statementLabels(lang?: string | null): StatementLabels`
  - `usd(n)`, `localAmount(usdAmount, cur)`, `balanceText(balance, partyType, L)`, `qtyText(q)`, `itemName(it)` from `server/statementFormat.ts`
  - `interface StatementOpts { mode: 'open' | 'activity'; from?: string; to?: string }`; `parseStatementOpts(src: any): StatementOpts | null`
  - `interface StatementBusiness { name: string; address: string; phone: string; language: StatementLanguage }`
  - `interface DocActivityRow extends ActivityRow { label: string; original_label: string | null }`
  - `interface StatementDocument { mode; party: { id: number; name: string; type: 'customer' | 'supplier'; address: string; phone: string; balance: number }; business: StatementBusiness; labels: StatementLabels; printed_at: string; open?: OpenStatement; activity?: Omit<ActivityStatement, 'rows'> & { rows: DocActivityRow[]; from_label: string; to_label: string }; local_currency: { code: string; symbol: string; rate: number } | null }`
  - `buildStatementDocument(tenantId, stakeholderId, opts: StatementOpts, business: StatementBusiness): StatementDocument | null`
  - `renderStatementHtml(doc: StatementDocument, format: 'a4' | 'receipt'): string`
  - Routes: `GET /api/reports/statement/:id?mode&from&to` → `StatementDocument`; `GET /api/reports/statement/:id/html?mode&from&to&format` → `text/html`

- [ ] **Step 1: Write the failing test**

Create `tests/statement-document.test.ts`:

```ts
// Statement document (JSON) + HTML rendering: localized labels, Arabic RTL, totals, validation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let productId: number;
let cust: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Doc Co", "doc-co@example.com");
  productId = seedProduct(app.db, tenantId, { barcode: "DC-1", name: "مياه", price: 25, stock: 500 });
  cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "محمد الحسن", type: "customer", address: "بيروت – الحمرا" } })).body.id;
  const r = await app.api("POST", "/api/transactions", { tenantId, body: { type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 10, method: "cash", currency: "USD", exchange_rate: 1 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});
after(async () => { await app.close(); });

const setLanguage = (lang: string) => {
  app.db.prepare("DELETE FROM settings WHERE tenant_id = ? AND key = 'language'").run(tenantId);
  app.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'language', ?)").run(tenantId, lang);
};

test("JSON document: open mode with party, labels and totals", async () => {
  setLanguage("en");
  const r = await app.api("GET", `/api/reports/statement/${cust}?mode=open`, { tenantId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const doc = r.body;
  assert.equal(doc.mode, "open");
  assert.equal(doc.party.name, "محمد الحسن");
  assert.equal(doc.party.address, "بيروت – الحمرا");
  assert.equal(doc.business.language, "en");
  assert.equal(doc.labels.totalDue, "Total due");
  assert.equal(doc.open.orders.length, 1);
  assert.ok(Math.abs(doc.open.total_due - 40) < 0.005);
});

test("JSON document: activity mode needs a valid range", async () => {
  const bad = await app.api("GET", `/api/reports/statement/${cust}?mode=activity&from=2026-02-01`, { tenantId });
  assert.equal(bad.status, 400);
  const ok = await app.api("GET", `/api/reports/statement/${cust}?mode=activity&from=2000-01-01&to=2100-01-01`, { tenantId });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const pay = ok.body.activity.rows.find((x: any) => x.type === "payment");
  assert.equal(pay.label, "Payment (Cash)");
});

test("unknown party is 404", async () => {
  const r = await app.api("GET", `/api/reports/statement/999999?mode=open`, { tenantId });
  assert.equal(r.status, 404);
});

test("HTML: Arabic store renders RTL with Arabic labels and the party name", async () => {
  setLanguage("ar");
  const r = await app.api("GET", `/api/reports/statement/${cust}/html?mode=open&format=a4`, { tenantId });
  assert.equal(r.status, 200);
  const html = String(r.body);
  assert.ok(html.includes('dir="rtl"'));
  assert.ok(html.includes("محمد الحسن"));
  assert.ok(html.includes("مياه"));
  assert.ok(html.includes("المبلغ المستحق"));
  assert.ok(html.includes("$40.00"));
  setLanguage("en");
});

test("HTML: receipt format and escaping", async () => {
  const name = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "<b>X</b>", type: "customer" } })).body.id;
  const r = await app.api("GET", `/api/reports/statement/${name}/html?mode=open&format=receipt`, { tenantId });
  const html = String(r.body);
  assert.ok(html.includes('class="receipt"'));
  assert.ok(html.includes("&lt;b&gt;X&lt;/b&gt;"));
  assert.ok(!html.includes("<b>X</b>"));
});
```

Note: if `app.api` returns a non-JSON body as a string, `r.body` is the HTML; if `tests/helpers/testApp.ts` parses only JSON, check it and adapt by reading `r.body` as text (look at how `api` builds `body`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/statement-document.test.ts`
Expected: FAIL — 404 on `/api/reports/statement/:id`.

- [ ] **Step 3: Create `server/printing/statementLabels.ts`**

```ts
// Fixed strings printed on customer / supplier statements (A4 / PDF HTML and ESC/POS receipt), in the
// store's language (settings key `language`). Arabic layout/shaping is handled by the renderers.
export type StatementLanguage = 'en' | 'ar' | 'fr';

export interface StatementLabels {
  title: string; unpaidOrders: string; accountActivity: string; printed: string; period: string;
  customer: string; supplier: string; address: string; phone: string; walkIn: string; unnamedBusiness: string;
  previousBalance: string; unpaid: string; partial: string;
  product: string; unit: string; qty: string; price: string; total: string; discount: string;
  orderTotal: string; paid: string; remaining: string; totalDue: string; totalWeOwe: string;
  noUnpaid: string; creditBalance: string;
  date: string; ref: string; description: string; debit: string; credit: string; balance: string;
  openingBalance: string; closingBalance: string; totalDebit: string; totalCredit: string; noActivity: string;
  balanceDue: string; balanceWeOwe: string; balanceCredit: string; balanceSettled: string;
  signature: string;
  kinds: Record<string, string>;
}

const en: StatementLabels = {
  title: 'Statement of account', unpaidOrders: 'Unpaid orders', accountActivity: 'Account activity', printed: 'Printed', period: 'Period',
  customer: 'Customer', supplier: 'Supplier', address: 'Address', phone: 'Phone', walkIn: 'Walk-in customer', unnamedBusiness: 'Unnamed Business',
  previousBalance: 'Previous balance', unpaid: 'Unpaid', partial: 'Partially paid',
  product: 'Product', unit: 'Unit', qty: 'Qty', price: 'Price', total: 'Total', discount: 'Discount',
  orderTotal: 'Order total', paid: 'Paid', remaining: 'Remaining', totalDue: 'Total due', totalWeOwe: 'Total we owe',
  noUnpaid: 'No unpaid orders', creditBalance: 'Credit balance',
  date: 'Date', ref: 'Ref', description: 'Description', debit: 'Debit', credit: 'Credit', balance: 'Balance',
  openingBalance: 'Opening balance', closingBalance: 'Closing balance', totalDebit: 'Total debit', totalCredit: 'Total credit', noActivity: 'No activity in this period',
  balanceDue: 'Due', balanceWeOwe: 'We owe', balanceCredit: 'Credit', balanceSettled: 'Settled',
  signature: 'Signature',
  kinds: {
    opening: 'Opening balance & earlier adjustments', sale: 'Sale', refund: 'Refund', purchase: 'Purchase', payment: 'Payment',
    refund_payment: 'Refund paid out', on_account: 'On account', balance_collection: 'Balance collection',
    supplier_payment: 'Supplier payment', manual_edit: 'Manual edit', import: 'Import',
  },
};

const ar: StatementLabels = {
  title: 'كشف حساب', unpaidOrders: 'الطلبات غير المدفوعة', accountActivity: 'حركة الحساب', printed: 'تاريخ الطباعة', period: 'الفترة',
  customer: 'الزبون', supplier: 'المورد', address: 'العنوان', phone: 'الهاتف', walkIn: 'زبون عابر', unnamedBusiness: 'متجر بدون اسم',
  previousBalance: 'رصيد سابق', unpaid: 'غير مدفوع', partial: 'مدفوع جزئياً',
  product: 'المنتج', unit: 'الوحدة', qty: 'الكمية', price: 'السعر', total: 'المجموع', discount: 'خصم',
  orderTotal: 'مجموع الطلب', paid: 'المدفوع', remaining: 'المتبقي', totalDue: 'المبلغ المستحق', totalWeOwe: 'المبلغ المستحق علينا',
  noUnpaid: 'لا توجد طلبات غير مدفوعة', creditBalance: 'رصيد دائن',
  date: 'التاريخ', ref: 'المرجع', description: 'البيان', debit: 'مدين', credit: 'دائن', balance: 'الرصيد',
  openingBalance: 'الرصيد الافتتاحي', closingBalance: 'الرصيد الختامي', totalDebit: 'مجموع المدين', totalCredit: 'مجموع الدائن', noActivity: 'لا توجد حركة في هذه الفترة',
  balanceDue: 'مستحق', balanceWeOwe: 'علينا', balanceCredit: 'دائن', balanceSettled: 'مسدد',
  signature: 'التوقيع',
  kinds: {
    opening: 'رصيد افتتاحي وتعديلات سابقة', sale: 'بيع', refund: 'مرتجع', purchase: 'شراء', payment: 'دفعة',
    refund_payment: 'رد مبلغ مرتجع', on_account: 'على الحساب', balance_collection: 'تحصيل رصيد',
    supplier_payment: 'دفعة للمورد', manual_edit: 'تعديل يدوي', import: 'استيراد',
  },
};

const fr: StatementLabels = {
  title: 'Relevé de compte', unpaidOrders: 'Commandes impayées', accountActivity: 'Mouvements du compte', printed: 'Imprimé le', period: 'Période',
  customer: 'Client', supplier: 'Fournisseur', address: 'Adresse', phone: 'Téléphone', walkIn: 'Client de passage', unnamedBusiness: 'Commerce sans nom',
  previousBalance: 'Solde antérieur', unpaid: 'Impayée', partial: 'Partiellement payée',
  product: 'Produit', unit: 'Unité', qty: 'Qté', price: 'Prix', total: 'Total', discount: 'Remise',
  orderTotal: 'Total commande', paid: 'Payé', remaining: 'Reste', totalDue: 'Total dû', totalWeOwe: 'Total que nous devons',
  noUnpaid: 'Aucune commande impayée', creditBalance: 'Solde créditeur',
  date: 'Date', ref: 'Réf', description: 'Libellé', debit: 'Débit', credit: 'Crédit', balance: 'Solde',
  openingBalance: 'Solde d’ouverture', closingBalance: 'Solde de clôture', totalDebit: 'Total débit', totalCredit: 'Total crédit', noActivity: 'Aucun mouvement sur cette période',
  balanceDue: 'Dû', balanceWeOwe: 'Nous devons', balanceCredit: 'Crédit', balanceSettled: 'Soldé',
  signature: 'Signature',
  kinds: {
    opening: 'Solde d’ouverture et ajustements antérieurs', sale: 'Vente', refund: 'Remboursement', purchase: 'Achat', payment: 'Paiement',
    refund_payment: 'Remboursement versé', on_account: 'Sur compte', balance_collection: 'Encaissement de solde',
    supplier_payment: 'Paiement fournisseur', manual_edit: 'Modification manuelle', import: 'Import',
  },
};

export function statementLabels(lang?: string | null): StatementLabels {
  return lang === 'ar' ? ar : lang === 'fr' ? fr : en;
}
```

- [ ] **Step 4: Create `server/statementFormat.ts`**

```ts
// Number formatting shared by the statement HTML and ESC/POS renderers.
import type { StatementLabels } from './printing/statementLabels.js';
import type { StatementItem } from './statement.js';

export function usd(n: number): string {
  const v = Math.abs(n) < 0.005 ? 0 : n;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** USD amount in the local currency at its current rate, e.g. "4,072,250 LL"; null for USD-only tenants. */
export function localAmount(usdAmount: number, cur: { code: string; symbol: string; rate: number } | null): string | null {
  if (!cur || !(cur.rate > 0)) return null;
  return `${Math.round(usdAmount * cur.rate).toLocaleString('en-US')} ${cur.symbol || cur.code}`;
}

/** "$12.00 Due" / "$12.00 We owe" (supplier) / "$3.00 Credit" / "$0.00 Settled". */
export function balanceText(balance: number, partyType: string, L: StatementLabels): string {
  if (Math.abs(balance) < 0.005) return `${usd(0)} ${L.balanceSettled}`;
  const word = balance < 0 ? (partyType === 'supplier' ? L.balanceWeOwe : L.balanceDue) : L.balanceCredit;
  return `${usd(Math.abs(balance))} ${word}`;
}

export function qtyText(q: number): string {
  return String(Math.round(q * 1000) / 1000);
}

/** "Water 0.5L - Carton x24" for a unit-of-measure line, else the product name. */
export function itemName(it: StatementItem): string {
  return it.unit ? `${it.name} - ${it.unit} x${it.factor}` : it.name;
}
```

- [ ] **Step 5: Create `server/statementDocument.ts`**

```ts
// Everything a printed statement needs, already localized: party, business header, labels, totals and
// (activity mode) a translated label per row. Shared by GET /api/reports/statement/:id(/html) and
// POST /api/print/statement so every output prints exactly the same content.
import { db } from './db.js';
import { buildOpenStatement, buildActivityStatement, localStampLabel, type OpenStatement, type ActivityStatement, type ActivityRow } from './statement.js';
import { localCurrencyFor } from './localCurrency.js';
import { statementLabels, type StatementLabels, type StatementLanguage } from './printing/statementLabels.js';
import { paymentMethodLabel } from './printing/receiptLabels.js';

export interface StatementOpts { mode: 'open' | 'activity'; from?: string; to?: string }
export interface StatementBusiness { name: string; address: string; phone: string; language: StatementLanguage }
export interface DocActivityRow extends ActivityRow { label: string; original_label: string | null }
export interface StatementDocument {
  mode: 'open' | 'activity';
  party: { id: number; name: string; type: 'customer' | 'supplier'; address: string; phone: string; balance: number };
  business: StatementBusiness;
  labels: StatementLabels;
  printed_at: string;
  open?: OpenStatement;
  activity?: Omit<ActivityStatement, 'rows'> & { rows: DocActivityRow[]; from_label: string; to_label: string };
  local_currency: { code: string; symbol: string; rate: number } | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** mode/from/to from a query string or JSON body; null when activity mode lacks a valid range. */
export function parseStatementOpts(src: any): StatementOpts | null {
  if (src?.mode !== 'activity') return { mode: 'open' };
  const from = String(src?.from ?? ''), to = String(src?.to ?? '');
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) return null;
  return { mode: 'activity', from, to };
}

const dmy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

export function buildStatementDocument(tenantId: number, stakeholderId: number | string, opts: StatementOpts, business: StatementBusiness): StatementDocument | null {
  const st = db.prepare("SELECT id, name, type, address, phone, balance FROM stakeholders WHERE id = ? AND tenant_id = ?").get(stakeholderId, tenantId) as any;
  if (!st) return null;
  const labels = statementLabels(business.language);
  const doc: StatementDocument = {
    mode: opts.mode,
    party: {
      id: st.id, name: st.name === 'Walk-in Customer' ? labels.walkIn : st.name, type: st.type,
      address: st.address || '', phone: st.phone || '', balance: st.balance || 0,
    },
    business, labels,
    printed_at: localStampLabel(new Date().toISOString()),
    local_currency: localCurrencyFor(tenantId),
  };
  if (opts.mode === 'open') {
    doc.open = buildOpenStatement(tenantId, stakeholderId) ?? undefined;
    return doc;
  }
  const symbols: Record<string, string> = Object.fromEntries(
    (db.prepare("SELECT code, symbol FROM currencies WHERE tenant_id = ?").all(tenantId) as any[]).map((c) => [c.code, c.symbol || c.code]),
  );
  const a = buildActivityStatement(tenantId, stakeholderId, opts.from!, opts.to!);
  doc.activity = {
    ...a,
    from_label: dmy(a.from),
    to_label: dmy(a.to),
    rows: a.rows.map((r) => {
      const kind = labels.kinds[r.type] ?? r.type;
      return {
        ...r,
        label: r.method ? `${kind} (${paymentMethodLabel(business.language, r.method)})` : kind,
        original_label: r.currency && r.currency !== 'USD' && r.amount_original != null
          ? `${Math.round(r.amount_original).toLocaleString('en-US')} ${symbols[r.currency] || r.currency}` : null,
      };
    }),
  };
  return doc;
}
```

Check `paymentMethodLabel('en', 'cash')` returns `"Cash"` (see `receiptLabels.ts` `paymentMethods.cash`); the test expects `"Payment (Cash)"` — adjust the test string to whatever the English label actually is.

- [ ] **Step 6: Create `server/statementHtml.ts`**

```ts
// Printable statement page (A4 / PDF, or an 80 mm receipt layout for printers driven through Windows).
// Self-contained HTML (no scripts, no external assets) so it can be previewed in a sandboxed iframe and
// printed from an off-screen Electron window. System fonts carry Arabic; Chromium does the shaping.
import type { StatementDocument } from './statementDocument.js';
import { usd, localAmount, balanceText, qtyText, itemName } from './statementFormat.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const num = (s: string) => `<span class="n" dir="ltr">${esc(s)}</span>`;

function css(receipt: boolean): string {
  return `
@page { ${receipt ? 'size: 80mm auto; margin: 0;' : 'size: A4; margin: 12mm;'} }
* { box-sizing: border-box; }
html, body { background: #fff; color: #000; }
body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; margin: 0; font-size: 12px; line-height: 1.35; }
body.receipt { width: 72mm; margin: 0 auto; padding: 2mm 0; font-size: 11px; }
.n { unicode-bidi: isolate; white-space: nowrap; font-variant-numeric: tabular-nums; }
.head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.receipt .head { display: block; text-align: center; }
.head .doc { text-align: end; }
.receipt .head .doc { text-align: center; margin-top: 6px; }
h1 { font-size: 18px; margin: 0; } .receipt h1 { font-size: 14px; }
h2 { font-size: 15px; margin: 0; } .receipt h2 { font-size: 12px; }
.muted { color: #444; }
.party { margin: 10px 0; padding: 6px 0; border-top: 1px solid #000; border-bottom: 1px solid #000; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 3px 4px; text-align: start; vertical-align: top; }
th { border-bottom: 1px solid #000; font-weight: 600; }
.end { text-align: end; }
.line { display: flex; justify-content: space-between; gap: 8px; }
.order { border-bottom: 1px dashed #777; padding: 6px 0; break-inside: avoid; }
.order-head { display: flex; justify-content: space-between; font-weight: 600; gap: 8px; }
.badge { border: 1px solid #000; border-radius: 3px; padding: 0 4px; font-size: 10px; font-weight: 600; }
.sums { margin-top: 4px; margin-inline-start: auto; width: 55%; } .receipt .sums { width: 100%; }
.total { border-top: 2px solid #000; margin-top: 10px; padding-top: 6px; font-size: 15px; font-weight: 700; }
.receipt .total { font-size: 13px; }
tr.items td { font-size: 10.5px; color: #333; padding-top: 0; }
tr.items td:first-child { padding-inline-start: 18px; }
.mv { border-bottom: 1px dashed #999; padding: 3px 0; }
.sign { margin-top: 48px; }
.receipt .sign { margin-top: 28px; }
`;
}

export function renderStatementHtml(doc: StatementDocument, format: 'a4' | 'receipt'): string {
  const L = doc.labels;
  const receipt = format === 'receipt';
  const supplier = doc.party.type === 'supplier';
  const out: string[] = [];

  // Header
  out.push(`<div class="head"><div>
    <h1>${esc(doc.business.name || L.unnamedBusiness)}</h1>
    ${doc.business.address ? `<div class="muted">${esc(doc.business.address)}</div>` : ''}
    ${doc.business.phone ? `<div class="muted">${num(doc.business.phone)}</div>` : ''}
  </div><div class="doc">
    <h2>${esc(L.title)}</h2>
    <div>${esc(doc.mode === 'open' ? L.unpaidOrders : L.accountActivity)}</div>
    ${doc.activity ? `<div>${esc(L.period)}: ${num(`${doc.activity.from_label} – ${doc.activity.to_label}`)}</div>` : ''}
    <div class="muted">${esc(L.printed)}: ${num(doc.printed_at)}</div>
  </div></div>`);
  out.push(`<div class="party">
    <div><b>${esc(supplier ? L.supplier : L.customer)}:</b> ${esc(doc.party.name)}</div>
    ${doc.party.address ? `<div>${esc(L.address)}: ${esc(doc.party.address)}</div>` : ''}
    ${doc.party.phone ? `<div>${esc(L.phone)}: ${num(doc.party.phone)}</div>` : ''}
  </div>`);

  const local = (amount: number) => localAmount(amount, doc.local_currency);

  if (doc.open) {
    const o = doc.open;
    if (!o.orders.length && o.previous_balance <= 0.005) {
      out.push(`<p><b>${esc(L.noUnpaid)}</b></p>`);
      if (o.credit > 0.005) out.push(`<div class="line"><span>${esc(L.creditBalance)}</span>${num(usd(o.credit))}</div>`);
    } else {
      if (o.previous_balance > 0.005) {
        out.push(`<div class="line order"><b>${esc(L.previousBalance)}</b>${num(usd(o.previous_balance))}</div>`);
      }
      for (const ord of o.orders) {
        const head = receipt
          ? `<tr><th>${esc(L.product)}</th><th class="end">${esc(L.qty)}</th><th class="end">${esc(L.total)}</th></tr>`
          : `<tr><th>${esc(L.product)}</th><th>${esc(L.unit)}</th><th class="end">${esc(L.qty)}</th><th class="end">${esc(L.price)}</th><th class="end">${esc(L.total)}</th></tr>`;
        const lines = ord.items.map((it) => {
          const disc = it.discount ? ` <span class="muted">(${esc(L.discount)} ${num(it.discount.type === 'percentage' ? `${it.discount.value}%` : usd(it.discount.value))})</span>` : '';
          return receipt
            ? `<tr><td>${esc(itemName(it))}${disc}</td><td class="end">${num(qtyText(it.qty))}</td><td class="end">${num(usd(it.line_total))}</td></tr>`
            : `<tr><td>${esc(it.name)}${disc}</td><td>${esc(it.unit ? `${it.unit} x${it.factor}` : '')}</td><td class="end">${num(qtyText(it.qty))}</td><td class="end">${num(usd(it.unit_price))}</td><td class="end">${num(usd(it.line_total))}</td></tr>`;
        }).join('');
        out.push(`<div class="order">
          <div class="order-head"><span>${num(ord.reference)} · ${num(ord.date_label)}</span><span class="badge">${esc(ord.status === 'partial' ? L.partial : L.unpaid)}</span></div>
          <table>${head}${lines}</table>
          <table class="sums">
            <tr><td>${esc(L.orderTotal)}</td><td class="end">${num(usd(ord.total))}</td></tr>
            ${ord.discount ? `<tr><td>${esc(L.discount)}</td><td class="end">${num(ord.discount.type === 'percentage' ? `${ord.discount.value}%` : usd(ord.discount.value))}</td></tr>` : ''}
            ${ord.paid > 0.005 ? `<tr><td>${esc(L.paid)}</td><td class="end">${num(usd(ord.paid))}</td></tr>` : ''}
            <tr><td><b>${esc(L.remaining)}</b></td><td class="end"><b>${num(usd(ord.remaining))}</b></td></tr>
          </table>
        </div>`);
      }
      const lc = local(o.total_due);
      out.push(`<div class="total"><div class="line"><span>${esc(supplier ? L.totalWeOwe : L.totalDue)}</span>${num(usd(o.total_due))}</div>
        ${lc ? `<div class="line"><span></span>${num(`≈ ${lc}`)}</div>` : ''}</div>`);
    }
  }

  if (doc.activity) {
    const a = doc.activity;
    const amt = (r: { debit: number; credit: number }) => (r.debit ? usd(r.debit) : r.credit ? usd(r.credit) : '');
    if (receipt) {
      out.push(`<div class="line mv"><b>${esc(L.openingBalance)}</b>${num(balanceText(a.opening, doc.party.type, L))}</div>`);
      if (!a.rows.length) out.push(`<p>${esc(L.noActivity)}</p>`);
      for (const r of a.rows) {
        const items = (r.items || []).map((it) => `<div class="line muted"><span>&nbsp;&nbsp;${esc(itemName(it))} × ${num(qtyText(it.qty))}</span>${num(usd(it.line_total))}</div>`).join('');
        out.push(`<div class="mv">
          <div class="line"><span>${num(r.date_label.slice(0, 10))} ${num(r.reference)}</span>${num(balanceText(r.balance, doc.party.type, L))}</div>
          <div class="line"><span>${esc(r.label)}${r.original_label ? ` (${num(r.original_label)})` : ''}</span><span>${esc(r.debit ? L.debit : r.credit ? L.credit : '')} ${num(amt(r))}</span></div>
          ${items}</div>`);
      }
    } else {
      const rows = a.rows.map((r) => {
        const items = (r.items || []).map((it) => `<tr class="items"><td colspan="3">${esc(itemName(it))} — ${num(qtyText(it.qty))} × ${num(usd(it.unit_price))}</td><td class="end" colspan="2">${num(usd(it.line_total))}</td><td></td></tr>`).join('');
        return `<tr><td>${num(r.date_label)}</td><td>${num(r.reference)}</td><td>${esc(r.label)}${r.original_label ? ` <span class="muted">(${num(r.original_label)})</span>` : ''}</td>
          <td class="end">${r.debit ? num(usd(r.debit)) : ''}</td><td class="end">${r.credit ? num(usd(r.credit)) : ''}</td><td class="end">${num(balanceText(r.balance, doc.party.type, L))}</td></tr>${items}`;
      }).join('');
      out.push(`<table>
        <tr><th>${esc(L.date)}</th><th>${esc(L.ref)}</th><th>${esc(L.description)}</th><th class="end">${esc(L.debit)}</th><th class="end">${esc(L.credit)}</th><th class="end">${esc(L.balance)}</th></tr>
        <tr><td colspan="5"><b>${esc(L.openingBalance)}</b></td><td class="end"><b>${num(balanceText(a.opening, doc.party.type, L))}</b></td></tr>
        ${rows || `<tr><td colspan="6">${esc(L.noActivity)}</td></tr>`}
        <tr><td colspan="3"><b>${esc(L.totalDebit)} / ${esc(L.totalCredit)}</b></td><td class="end"><b>${num(usd(a.total_debit))}</b></td><td class="end"><b>${num(usd(a.total_credit))}</b></td><td></td></tr>
      </table>`);
    }
    const lc = local(Math.abs(a.closing));
    out.push(`<div class="total"><div class="line"><span>${esc(L.closingBalance)}</span>${num(balanceText(a.closing, doc.party.type, L))}</div>
      ${lc && Math.abs(a.closing) >= 0.005 ? `<div class="line"><span></span>${num(`≈ ${lc}`)}</div>` : ''}</div>`);
  }

  out.push(`<div class="sign">${esc(L.signature)}: ____________________</div>`);

  const rtl = doc.business.language === 'ar';
  return `<!doctype html><html lang="${doc.business.language}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${esc(L.title)} - ${esc(doc.party.name)}</title><style>${css(receipt)}</style></head><body class="${receipt ? 'receipt' : 'a4'}">${out.join('\n')}</body></html>`;
}
```

- [ ] **Step 7: Add the routes in `server/routes.ts`**

Imports at the top (next to `import { buildStatement } from "./statement.js";`):

```ts
import { buildStatementDocument, parseStatementOpts, type StatementBusiness } from "./statementDocument.js";
import { renderStatementHtml } from "./statementHtml.js";
```

Module-level helper next to `getSettingsMap` (after it, ~line 180):

```ts
// Business header + printed language for statements (server/statementDocument.ts).
function statementBusiness(tenantId: number): StatementBusiness {
  const s = getSettingsMap(tenantId);
  const language = s.language === 'ar' || s.language === 'fr' ? s.language : 'en';
  return { name: s.store_name || '', address: s.business_address || '', phone: s.business_phone || '', language };
}
```

Directly after the existing `app.get("/api/reports/customer-statement/:id", ...)` handler:

```ts
  // Printable statement: mode=open (unpaid orders, FIFO) or mode=activity&from&to (local days).
  app.get("/api/reports/statement/:id", authenticate, (req: any, res) => {
    const opts = parseStatementOpts(req.query);
    if (!opts) return res.status(400).json({ error: "from and to (YYYY-MM-DD, from <= to) are required for activity" });
    const doc = buildStatementDocument(req.session.tenantId, req.params.id, opts, statementBusiness(req.session.tenantId));
    if (!doc) return res.status(404).json({ error: "Customer/supplier not found" });
    res.json(doc);
  });

  app.get("/api/reports/statement/:id/html", authenticate, (req: any, res) => {
    const opts = parseStatementOpts(req.query);
    if (!opts) return res.status(400).json({ error: "from and to (YYYY-MM-DD, from <= to) are required for activity" });
    const doc = buildStatementDocument(req.session.tenantId, req.params.id, opts, statementBusiness(req.session.tenantId));
    if (!doc) return res.status(404).json({ error: "Customer/supplier not found" });
    res.type("html").send(renderStatementHtml(doc, req.query.format === "receipt" ? "receipt" : "a4"));
  });
```

- [ ] **Step 8: Add permission rules in `server/permissions.ts`**

After the `'/api/reports/customer-statement/:id'` line (~188):

```ts
  { method: 'GET', pattern: '/api/reports/statement/:id', need: ['reports.view', 'parties.view'] },
  { method: 'GET', pattern: '/api/reports/statement/:id/html', need: ['reports.view', 'parties.view'] },
```

Then check `tests/permissions.test.ts` for a test that enumerates every route needing a rule; if one exists, run it in Step 9.

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx tsx --test tests/statement-document.test.ts tests/permissions.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/printing/statementLabels.ts server/statementFormat.ts server/statementDocument.ts server/statementHtml.ts server/routes.ts server/permissions.ts tests/statement-document.test.ts
git commit -m "feat(statement): localized statement document with JSON and HTML endpoints"
```

---

### Task 5: Receipt-printer statement (ESC/POS) and `POST /api/print/statement`

**Files:**
- Create: `server/printing/statement.ts`
- Modify: `server/routes.ts` (after the `/api/print/receipt` handler ~line 2995), `server/permissions.ts`
- Test: `tests/statement-print.test.ts` (create)

**Interfaces:**
- Consumes: `StatementDocument`, `buildStatementDocument`, `parseStatementOpts` (Task 4); `usd`, `localAmount`, `balanceText`, `itemName` (Task 4); `EscPos`, `paperWidthToColumns`, `ArabicTextMode` (`server/printing/escpos.ts`); `resolveReceiptPrinter`, `printerArabicMode`, `sendToPrinter`, `statementBusiness` (routes.ts)
- Produces: `buildStatementBuffer(opts: { doc: StatementDocument; paperWidth?: number; arabic?: ArabicTextMode | null }): Buffer`; route `POST /api/print/statement` body `{ stakeholderId, mode, from?, to?, printerId? }` → `{ success: true }` | 4xx/5xx `{ error }`

- [ ] **Step 1: Write the failing test**

Create `tests/statement-print.test.ts`:

```ts
// Statement on the receipt printer: ESC/POS buffer (Arabic via raster image or code page) and the
// print route sending it to the configured printer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let productId: number;
let cust: number;
let fakePrinter: net.Server;
let received: Buffer[] = [];
const RASTER = Buffer.from([0x1d, 0x76, 0x30, 0x00]);

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Print Stmt Co", "print-stmt@example.com");
  productId = seedProduct(app.db, tenantId, { barcode: "PS-1", name: "Paper Roll", price: 25, stock: 500 });
  cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "محمد الحسن", type: "customer", address: "بيروت" } })).body.id;
  const r = await app.api("POST", "/api/transactions", { tenantId, body: { type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  fakePrinter = net.createServer((s) => s.on("data", (c) => received.push(c)));
  await new Promise<void>((resolve) => fakePrinter.listen(0, "127.0.0.1", resolve));
});
after(async () => { fakePrinter.close(); await app.close(); });

const docFor = async (mode: "open" | "activity") => {
  const { buildStatementDocument } = await import("../server/statementDocument.js");
  return buildStatementDocument(tenantId, cust, mode === "open" ? { mode } : { mode, from: "2000-01-01", to: "2100-01-01" },
    { name: "Acme", address: "", phone: "", language: "en" })!;
};

test("ESC/POS open statement: Latin text plain, Arabic name as an image, total printed", async () => {
  const { buildStatementBuffer } = await import("../server/printing/statement.js");
  for (const width of [80, 58]) {
    const buf = buildStatementBuffer({ doc: await docFor("open"), paperWidth: width });
    const text = buf.toString("latin1");
    assert.ok(text.includes("Paper Roll"), `item line at ${width}mm`);
    assert.ok(text.includes("Total due"), `total line at ${width}mm`);
    assert.ok(text.includes("$25.00"));
    assert.ok(buf.indexOf(RASTER) !== -1, "Arabic customer name rendered as a raster image");
  }
});

test("ESC/POS with an Arabic code page prints the name as text, not images", async () => {
  const { buildStatementBuffer } = await import("../server/printing/statement.js");
  const buf = buildStatementBuffer({ doc: await docFor("open"), paperWidth: 80, arabic: { codepage: 22, encoding: "cp864" } as any });
  assert.equal(buf.indexOf(RASTER), -1);
});

test("ESC/POS activity statement prints opening and closing balances", async () => {
  const { buildStatementBuffer } = await import("../server/printing/statement.js");
  const text = buildStatementBuffer({ doc: await docFor("activity"), paperWidth: 80 }).toString("latin1");
  assert.ok(text.includes("Opening balance"));
  assert.ok(text.includes("Closing balance"));
});

test("POST /api/print/statement: 404 without a printer, then sends bytes to the configured printer", async () => {
  const none = await app.api("POST", "/api/print/statement", { tenantId, body: { stakeholderId: cust, mode: "open" } });
  assert.equal(none.status, 404);

  app.db.prepare(`INSERT INTO printers (tenant_id, name, type, connection, address, paper_width, is_default, enabled)
    VALUES (?, 'Counter', 'receipt', 'network', ?, 80, 1, 1)`).run(tenantId, `127.0.0.1:${(fakePrinter.address() as any).port}`);

  const bad = await app.api("POST", "/api/print/statement", { tenantId, body: { stakeholderId: cust, mode: "activity" } });
  assert.equal(bad.status, 400);

  const ok = await app.api("POST", "/api/print/statement", { tenantId, body: { stakeholderId: cust, mode: "open" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(Buffer.concat(received).toString("latin1").includes("Paper Roll"));
});
```

Before running: open `server/printing/arabic.ts` and use a real `ArabicEncoding` value and a code page that encoding supports for the code-page test (replace `{ codepage: 22, encoding: "cp864" }` if the type names differ — `tests/arabic-text-printing.test.ts` shows working values).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/statement-print.test.ts`
Expected: FAIL — cannot find module `../server/printing/statement.js`.

- [ ] **Step 3: Create `server/printing/statement.ts`**

```ts
// Customer / supplier statement on a thermal receipt printer. Same EscPos helpers as sale receipts, so
// Arabic names, addresses and products go through the same raster-image / code-page path.
import { EscPos, paperWidthToColumns, type ArabicTextMode } from "./escpos.js";
import type { StatementDocument } from "../statementDocument.js";
import { usd, localAmount, balanceText, itemName } from "../statementFormat.js";

export function buildStatementBuffer(opts: { doc: StatementDocument; paperWidth?: number; arabic?: ArabicTextMode | null }): Buffer {
  const { doc } = opts;
  const L = doc.labels;
  const p = new EscPos(paperWidthToColumns(opts.paperWidth), opts.arabic);

  p.init();
  p.feed(2);
  p.align('center').bold(true);
  p.text(doc.business.name || L.unnamedBusiness).feed(1);
  p.bold(false);
  if (doc.business.address) p.text(doc.business.address).feed(1);
  if (doc.business.phone) p.text(doc.business.phone).feed(1);
  p.bold(true).text(L.title).feed(1).bold(false);
  p.text(doc.mode === 'open' ? L.unpaidOrders : L.accountActivity).feed(1);
  if (doc.activity) p.text(`${doc.activity.from_label} - ${doc.activity.to_label}`).feed(1);
  p.text(`${L.printed}: ${doc.printed_at}`).feed(1);
  p.hr();

  p.align('left');
  p.labeled(`${doc.party.type === 'supplier' ? L.supplier : L.customer}:`, doc.party.name);
  if (doc.party.address) p.labeled(`${L.address}:`, doc.party.address);
  if (doc.party.phone) p.labeled(`${L.phone}:`, doc.party.phone);
  p.hr();

  if (doc.open) {
    const o = doc.open;
    if (!o.orders.length && o.previous_balance <= 0.005) {
      p.text(L.noUnpaid).feed(1);
      if (o.credit > 0.005) p.kv(L.creditBalance, usd(o.credit));
    } else {
      if (o.previous_balance > 0.005) { p.kv(L.previousBalance, usd(o.previous_balance)); p.hr(); }
      for (const ord of o.orders) {
        p.bold(true);
        p.kv(`${ord.reference} ${ord.date_label.slice(0, 10)}`, ord.status === 'partial' ? L.partial : L.unpaid);
        p.bold(false);
        for (const it of ord.items) p.itemLine(itemName(it), it.qty, usd(it.line_total));
        p.kv(`  ${L.orderTotal}`, usd(ord.total));
        if (ord.paid > 0.005) p.kv(`  ${L.paid}`, usd(ord.paid));
        p.kv(`  ${L.remaining}`, usd(ord.remaining));
        p.hr();
      }
      p.bold(true);
      p.kv(doc.party.type === 'supplier' ? L.totalWeOwe : L.totalDue, usd(o.total_due));
      p.bold(false);
      const lc = localAmount(o.total_due, doc.local_currency);
      if (lc) p.kv('', `~ ${lc}`);
    }
  }

  if (doc.activity) {
    const a = doc.activity;
    p.kv(L.openingBalance, balanceText(a.opening, doc.party.type, L));
    p.hr();
    if (!a.rows.length) p.text(L.noActivity).feed(1);
    for (const r of a.rows) {
      p.kv(`${r.date_label.slice(0, 10)} ${r.reference}`, balanceText(r.balance, doc.party.type, L));
      const amount = r.debit ? `${L.debit} ${usd(r.debit)}` : r.credit ? `${L.credit} ${usd(r.credit)}` : '';
      p.kv(`  ${r.label}${r.original_label ? ` (${r.original_label})` : ''}`, amount);
      for (const it of r.items || []) p.itemLine(`  ${itemName(it)}`, it.qty, usd(it.line_total));
    }
    p.hr();
    p.bold(true);
    p.kv(L.closingBalance, balanceText(a.closing, doc.party.type, L));
    p.bold(false);
    const lc = Math.abs(a.closing) >= 0.005 ? localAmount(Math.abs(a.closing), doc.local_currency) : null;
    if (lc) p.kv('', `~ ${lc}`);
  }

  p.feed(1);
  p.text(`${L.signature}: ______________`).feed(6);
  p.cut();
  return p.toBuffer();
}
```

- [ ] **Step 4: Add the route in `server/routes.ts`**

Import at the top next to the receipt import:

```ts
import { buildStatementBuffer } from "./printing/statement.js";
```

After the `/api/print/receipt` handler:

```ts
  // Customer / supplier statement on the receipt printer (back office "Print → Receipt").
  app.post("/api/print/statement", authenticate, async (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { stakeholderId, printerId } = req.body || {};
    try {
      const printer = resolveReceiptPrinter(tenantId, printerId);
      if (!printer) return res.status(404).json({ error: "No enabled receipt printer configured" });
      const opts = parseStatementOpts(req.body);
      if (!opts) return res.status(400).json({ error: "from and to (YYYY-MM-DD, from <= to) are required for activity" });
      const doc = buildStatementDocument(tenantId, stakeholderId, opts, statementBusiness(tenantId));
      if (!doc) return res.status(404).json({ error: "Customer/supplier not found" });
      await sendToPrinter(printer, buildStatementBuffer({ doc, paperWidth: printer.paper_width, arabic: printerArabicMode(printer) }));
      res.json({ success: true });
    } catch (err: any) {
      console.error('Print statement error:', err.message);
      res.status(500).json({ error: err.message || 'Failed to print statement' });
    }
  });
```

- [ ] **Step 5: Permission rule in `server/permissions.ts`**

Next to the two rules added in Task 4:

```ts
  { method: 'POST', pattern: '/api/print/statement', need: ['reports.view', 'parties.view'] },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/statement-print.test.ts tests/permissions.test.ts tests/receipt-arabic-address.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/printing/statement.ts server/routes.ts server/permissions.ts tests/statement-print.test.ts
git commit -m "feat(statement): print statements on the receipt printer (ESC/POS)"
```

---

### Task 6: Electron print dialog and Save-as-PDF IPC

**Files:**
- Modify: `electron-main.js` (after the `print:silent-html` handler, ~line 262), `electron-preload.cjs`, `src/types.ts` (inside `electronAPI`)
- Create: `src/pages/statement/printStatement.ts`

**Interfaces:**
- Produces:
  - IPC `print:html` `{ html }` → `{ success: boolean; error: string | null }` (`error: 'cancelled'` when the user cancels)
  - IPC `print:pdf` `{ html, fileName }` → `{ success: boolean; error: string | null; path?: string }`
  - `window.electronAPI.printHtml(html)`, `window.electronAPI.savePdf(html, fileName)`
  - `printStatementHtml(html: string): Promise<void>` and `saveStatementPdf(html: string, fileName: string): Promise<string | null>` (path, or null when cancelled / browser fallback)

No automated test (Electron main process); verified manually in Task 8.

- [ ] **Step 1: Add the IPC handlers in `electron-main.js`**

Immediately after the closing `});` of `ipcMain.handle('print:silent-html', ...)`:

```js
  // Back-office statement printing: render the HTML off-screen (from a temp file — data: URLs get too
  // long for big statements), then show the system print dialog (user picks the A4 / receipt printer)
  // or save an A4 PDF.
  const renderHtmlOffscreen = async (html) => {
    const file = path.join(app.getPath('temp'), `omnipos-print-${crypto.randomUUID()}.html`);
    fs.writeFileSync(file, html, 'utf8');
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
    try {
      await win.loadFile(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
    return win;
  };

  ipcMain.removeHandler('print:html');
  ipcMain.handle('print:html', async (_event, { html }) => {
    let win;
    try {
      win = await renderHtmlOffscreen(html);
      return await new Promise((resolve) => {
        win.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
          resolve({ success, error: success ? null : (failureReason || 'cancelled') });
        });
      });
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
    }
  });

  ipcMain.removeHandler('print:pdf');
  ipcMain.handle('print:pdf', async (event, { html, fileName }) => {
    let win;
    try {
      const safeName = String(fileName || 'statement.pdf').replace(/[\\/:*?"<>|]/g, '_');
      const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
        defaultPath: path.join(app.getPath('documents'), safeName),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (canceled || !filePath) return { success: false, error: 'cancelled' };
      win = await renderHtmlOffscreen(html);
      const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true });
      fs.writeFileSync(filePath, pdf);
      return { success: true, error: null, path: filePath };
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
    }
  });
```

(`app`, `BrowserWindow`, `dialog`, `ipcMain`, `crypto`, `path`, `fs` are already imported at the top of the file.)

- [ ] **Step 2: Expose them in `electron-preload.cjs`**

After the `printSilent` line:

```js
  // Back-office statements: system print dialog, and Save as PDF (A4) — see electron-main.js.
  printHtml: (html) => ipcRenderer.invoke('print:html', { html }),
  savePdf: (html, fileName) => ipcRenderer.invoke('print:pdf', { html, fileName }),
```

- [ ] **Step 3: Type them in `src/types.ts`**

After the `printSilent` member of `electronAPI`:

```ts
      // Statement printing — see electron-main.js's 'print:html' / 'print:pdf' handlers.
      printHtml?: (html: string) => Promise<{ success: boolean; error: string | null }>;
      savePdf?: (html: string, fileName: string) => Promise<{ success: boolean; error: string | null; path?: string }>;
```

- [ ] **Step 4: Create `src/pages/statement/printStatement.ts`**

```ts
// Print / save a statement page produced by GET /api/reports/statement/:id/html. In Electron this goes
// through the 'print:html' / 'print:pdf' IPC handlers; in a plain browser (preview server) it falls back
// to a print window, whose dialog also offers "Save as PDF".

function browserPrint(html: string): void {
  const w = window.open('', '_blank');
  if (!w) throw new Error('Pop-up blocked');
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

/** System print dialog for the given statement page. Resolves quietly when the user cancels. */
export async function printStatementHtml(html: string): Promise<void> {
  const api = window.electronAPI;
  if (api?.printHtml) {
    const r = await api.printHtml(html);
    if (!r.success && r.error && r.error !== 'cancelled') throw new Error(r.error);
    return;
  }
  browserPrint(html);
}

/** Saves an A4 PDF; returns the saved path, or null when cancelled / handled by the browser dialog. */
export async function saveStatementPdf(html: string, fileName: string): Promise<string | null> {
  const api = window.electronAPI;
  if (api?.savePdf) {
    const r = await api.savePdf(html, fileName);
    if (!r.success) {
      if (r.error && r.error !== 'cancelled') throw new Error(r.error);
      return null;
    }
    return r.path ?? null;
  }
  browserPrint(html);
  return null;
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no new errors in `src/types.ts` or `src/pages/statement/printStatement.ts` (compare against `git stash`-free baseline: run it once before Step 1 if the project has pre-existing errors, and only check that none are added).

- [ ] **Step 6: Commit**

```bash
git add electron-main.js electron-preload.cjs src/types.ts src/pages/statement/printStatement.ts
git commit -m "feat(statement): Electron print dialog and save-as-PDF IPC"
```

---

### Task 7: `StatementView` UI and wiring into the drawer and Reports

**Files:**
- Create: `src/pages/statement/StatementView.tsx`, `src/intl/locales/statement.ts`
- Modify: `src/pages/stakeholders/DetailDrawer.tsx`, `src/pages/reports/CustomerStatementTab.tsx`

**Interfaces:**
- Consumes: routes from Tasks 4–5; `printStatementHtml`, `saveStatementPdf` (Task 6); `Tabs`, `Button`, `DateRangePicker`, `useToast`, `Skeleton` (`src/components/ui`); `resolveDateRangePreset`, `partyDisplayName` (`src/lib/format`); `useI18n` (`src/intl/index`)
- Produces: `StatementView({ stakeholder }: { stakeholder: { id: number; name: string; type: string; balance: number } })`

- [ ] **Step 1: Create `src/intl/locales/statement.ts`**

(Auto-registered: `src/intl/index.tsx` globs `./locales/*.ts`.)

```ts
// Strings for the customer / supplier statement view (src/pages/statement/*). Keys are prefixed stm_.
// The printed statement itself is localized on the server (server/printing/statementLabels.ts).
export default {
  en: {
    stm_mode_open: 'Unpaid orders',
    stm_mode_activity: 'Account activity',
    stm_format_a4: 'A4',
    stm_format_receipt: 'Receipt',
    stm_all_dates: 'All',
    stm_print: 'Print',
    stm_save_pdf: 'Save PDF',
    stm_export_excel: 'Excel',
    stm_pdf_saved: 'PDF saved',
    stm_print_failed: 'Printing failed',
    stm_print_as_a4: 'Print as A4',
    stm_receipt_sent: 'Statement sent to the receipt printer',
    stm_long_for_receipt: 'This statement has {n} movements — A4 is easier to read.',
    stm_load_failed: 'Could not load the statement',
  },
  ar: {
    stm_mode_open: 'الطلبات غير المدفوعة',
    stm_mode_activity: 'حركة الحساب',
    stm_format_a4: 'A4',
    stm_format_receipt: 'إيصال',
    stm_all_dates: 'الكل',
    stm_print: 'طباعة',
    stm_save_pdf: 'حفظ PDF',
    stm_export_excel: 'Excel',
    stm_pdf_saved: 'تم حفظ ملف PDF',
    stm_print_failed: 'فشلت الطباعة',
    stm_print_as_a4: 'اطبع A4',
    stm_receipt_sent: 'تم إرسال الكشف إلى طابعة الإيصالات',
    stm_long_for_receipt: 'يحتوي هذا الكشف على {n} حركة — قراءة A4 أسهل.',
    stm_load_failed: 'تعذر تحميل الكشف',
  },
  fr: {
    stm_mode_open: 'Commandes impayées',
    stm_mode_activity: 'Mouvements du compte',
    stm_format_a4: 'A4',
    stm_format_receipt: 'Ticket',
    stm_all_dates: 'Tout',
    stm_print: 'Imprimer',
    stm_save_pdf: 'Enregistrer PDF',
    stm_export_excel: 'Excel',
    stm_pdf_saved: 'PDF enregistré',
    stm_print_failed: "Échec de l'impression",
    stm_print_as_a4: 'Imprimer en A4',
    stm_receipt_sent: 'Relevé envoyé à l’imprimante de tickets',
    stm_long_for_receipt: 'Ce relevé contient {n} mouvements — le format A4 est plus lisible.',
    stm_load_failed: 'Impossible de charger le relevé',
  },
};
```

Check `src/intl/index.tsx` for how placeholders are substituted; if `t` has no interpolation, use `t('stm_long_for_receipt').replace('{n}', String(n))` as written below.

- [ ] **Step 2: Create `src/pages/statement/StatementView.tsx`**

Before writing, open `src/components/ui/ToastProvider.tsx` and confirm the `useToast()` API (`toast.success(msg)`, `toast.error(msg)`; whether an `action` option exists). If there is no action button support, show the "Print as A4" option as a plain `Button` rendered next to the error state (`receiptError` below) — the code already does that.

```tsx
import React, { useEffect, useState } from 'react';
import { Printer, FileDown, FileSpreadsheet } from 'lucide-react';
import { Button, DateRangePicker, Skeleton, Tabs, useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { resolveDateRangePreset, partyDisplayName, type DateRange } from '../../lib/format';
import { api } from '../../lib/api';
import { exportRowsToExcel } from '../reports/exportUtils';
import { printStatementHtml, saveStatementPdf } from './printStatement';

type Mode = 'open' | 'activity';
type Format = 'a4' | 'receipt';

export interface StatementViewProps {
  stakeholder: { id: number; name: string; type: string; balance: number };
}

const RECEIPT_ROW_WARNING = 200;

function query(mode: Mode, range: DateRange, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({ mode, ...(mode === 'activity' ? { from: range.from, to: range.to } : {}), ...extra });
  return p.toString();
}

export function StatementView({ stakeholder }: StatementViewProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(stakeholder.balance < -0.005 ? 'open' : 'activity');
  const [range, setRange] = useState<DateRange>(() => resolveDateRangePreset('this_month'));
  const [format, setFormat] = useState<Format>('a4');
  const [html, setHtml] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);

  useEffect(() => {
    setMode(stakeholder.balance < -0.005 ? 'open' : 'activity');
  }, [stakeholder.id]);

  const htmlUrl = (f: Format) => `/api/reports/statement/${stakeholder.id}/html?${query(mode, range, { format: f })}`;

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setReceiptError(null);
    fetch(htmlUrl(format))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((h) => !cancelled && setHtml(h))
      .catch(() => { if (!cancelled) { setHtml(''); toast.error(t('stm_load_failed', 'Could not load the statement')); } });
    if (mode === 'activity') {
      api.get<{ activity?: { rows: unknown[] } }>(`/api/reports/statement/${stakeholder.id}?${query(mode, range)}`)
        .then((d) => !cancelled && setRowCount(d.activity?.rows.length ?? 0))
        .catch(() => !cancelled && setRowCount(0));
    } else {
      setRowCount(0);
    }
    return () => { cancelled = true; };
  }, [stakeholder.id, mode, range.from, range.to, format]);

  const a4Html = async () => (format === 'a4' && html ? html : fetch(htmlUrl('a4')).then((r) => r.text()));

  const printA4 = async () => {
    setBusy(true);
    try { await printStatementHtml(await a4Html()); }
    catch (e: any) { toast.error(`${t('stm_print_failed', 'Printing failed')}: ${e?.message || e}`); }
    finally { setBusy(false); }
  };

  const handlePrint = async () => {
    if (format === 'a4') return printA4();
    setBusy(true);
    setReceiptError(null);
    try {
      const body = { stakeholderId: stakeholder.id, mode, ...(mode === 'activity' ? { from: range.from, to: range.to } : {}) };
      const res = await fetch('/api/print/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 404) {
        // No ESC/POS receipt printer configured: print the 80 mm HTML layout through Windows.
        await printStatementHtml(html || (await fetch(htmlUrl('receipt')).then((r) => r.text())));
      } else if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || String(res.status));
      } else {
        toast.success(t('stm_receipt_sent', 'Statement sent to the receipt printer'));
      }
    } catch (e: any) {
      setReceiptError(e?.message || String(e));
      toast.error(`${t('stm_print_failed', 'Printing failed')}: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  // Activity mode only: the movements as a spreadsheet (same columns as the printed table).
  const handleExcel = async () => {
    try {
      const doc = await api.get<any>(`/api/reports/statement/${stakeholder.id}?${query('activity', range)}`);
      const rows = doc.activity.rows as any[];
      const L = doc.labels;
      exportRowsToExcel(rows, [
        { key: 'date', header: L.date, value: (r) => r.date_label },
        { key: 'ref', header: L.ref, value: (r) => r.reference },
        { key: 'desc', header: L.description, value: (r) => (r.original_label ? `${r.label} (${r.original_label})` : r.label) },
        { key: 'debit', header: L.debit, value: (r) => r.debit || '', align: 'right' },
        { key: 'credit', header: L.credit, value: (r) => r.credit || '', align: 'right' },
        { key: 'balance', header: L.balance, value: (r) => r.balance, align: 'right' },
      ], {
        fileName: `statement-${partyDisplayName(stakeholder.name, t)}-${range.from}-${range.to}`,
        title: `${L.title} — ${L.accountActivity}`,
        subtitle: `${doc.party.name} · ${doc.activity.from_label} – ${doc.activity.to_label}`,
        businessName: doc.business.name,
      });
    } catch (e: any) {
      toast.error(`${t('stm_load_failed', 'Could not load the statement')}: ${e?.message || e}`);
    }
  };

  const handlePdf = async () => {
    setBusy(true);
    try {
      const day = new Date().toISOString().slice(0, 10);
      const saved = await saveStatementPdf(await a4Html(), `statement-${partyDisplayName(stakeholder.name, t)}-${day}.pdf`);
      if (saved) toast.success(`${t('stm_pdf_saved', 'PDF saved')}: ${saved}`);
    } catch (e: any) {
      toast.error(`${t('stm_print_failed', 'Printing failed')}: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          items={[{ value: 'open', label: t('stm_mode_open', 'Unpaid orders') }, { value: 'activity', label: t('stm_mode_activity', 'Account activity') }]}
          value={mode}
          onChange={(v) => setMode(v as Mode)}
        />
        {mode === 'activity' && (
          <>
            <DateRangePicker value={range} onChange={(r) => setRange(r)} />
            <Button variant="ghost" size="sm" onClick={() => setRange({ from: '2000-01-01', to: resolveDateRangePreset('today').to })}>
              {t('stm_all_dates', 'All')}
            </Button>
          </>
        )}
        <div className="ms-auto flex items-center gap-2">
          <Tabs
            items={[{ value: 'a4', label: t('stm_format_a4', 'A4') }, { value: 'receipt', label: t('stm_format_receipt', 'Receipt') }]}
            value={format}
            onChange={(v) => setFormat(v as Format)}
          />
          <Button variant="secondary" size="sm" onClick={handlePrint} disabled={busy || !html}>
            <Printer size={14} /> {t('stm_print', 'Print')}
          </Button>
          <Button variant="secondary" size="sm" onClick={handlePdf} disabled={busy || html === null}>
            <FileDown size={14} /> {t('stm_save_pdf', 'Save PDF')}
          </Button>
          {mode === 'activity' && (
            <Button variant="secondary" size="sm" onClick={handleExcel} disabled={busy}>
              <FileSpreadsheet size={14} /> {t('stm_export_excel', 'Excel')}
            </Button>
          )}
        </div>
      </div>

      {format === 'receipt' && rowCount > RECEIPT_ROW_WARNING && (
        <p className="text-sm text-warning">{t('stm_long_for_receipt', 'This statement has {n} movements — A4 is easier to read.').replace('{n}', String(rowCount))}</p>
      )}
      {receiptError && (
        <div className="flex items-center gap-2 text-sm text-danger">
          <span>{receiptError}</span>
          <Button variant="secondary" size="sm" onClick={printA4} disabled={busy}>{t('stm_print_as_a4', 'Print as A4')}</Button>
        </div>
      )}

      {html === null ? (
        <Skeleton className="h-[60vh] w-full" />
      ) : (
        <iframe
          title={t('stm_print', 'Print')}
          srcDoc={html}
          sandbox=""
          className={`h-[65vh] rounded-md border border-border bg-white ${format === 'receipt' ? 'mx-auto w-[340px]' : 'w-full'}`}
        />
      )}
    </div>
  );
}

export default StatementView;
```

Check: `resolveDateRangePreset` accepts `'today'` and `'this_month'` (see `DateRangePreset` in `src/lib/format.ts`); `Button` supports `variant="ghost"` (see `ButtonVariant`) — use `secondary` if not; Tailwind token `text-warning` exists in `src/index.css` — use `text-text-2` if not.

- [ ] **Step 3: Use it in the drawer — `src/pages/stakeholders/DetailDrawer.tsx`**

1. Add `import { StatementView } from '../statement/StatementView';`.
2. Replace the whole `{tab === 'statement' && ( ... )}` block with:

```tsx
        {tab === 'statement' && <StatementView stakeholder={stakeholder} />}
```

3. Delete what only the old block used: the `statement` state and its `setStatement(null)` reset, the `tab === 'statement'` branch of the data-loading effect, `StatementRow`, `statementColumns`, `moneyCell`, `handlePrintStatement`, `handleExportStatement`; then remove imports left unused (`Printer`, `FileDown`, `originalAmountLabel`, `statementKindLabel`, `statementDescription`, `balanceText`, `formatDate`, `formatDateTime`, etc. — let `npx tsc --noEmit` / the editor tell you which are now unused; keep anything other tabs still use).

- [ ] **Step 4: Use it in Reports — `src/pages/reports/CustomerStatementTab.tsx`**

Keep the party picker and the Balance history section; replace the printable ledger with `StatementView`:

1. Add `import { StatementView } from '../statement/StatementView';`.
2. Remove the rows fetch effect, `rows`/`loading`/`currencies` state, `columns`, `exportColumns`, `meta`, `moneyCell`, `usd`, `kindLabel`, `TYPE_VARIANT`, and the `ReportToolbar` / `DataTable` / closing-balance JSX.
3. Make the `stakeholders` list include `balance` (it comes from `/api/stakeholders`; if `StakeholderLite` in `./types.ts` lacks `balance: number`, add it).
4. Render, in place of the old `printable-report` block:

```tsx
      {id && party && (
        <div className="space-y-4">
          <StatementView stakeholder={party} />
          <div className="pt-2">
            <p className="mb-2 text-sm font-semibold text-text">{t('bal_log_title', 'Balance history')}</p>
            <BalanceLogTable stakeholderId={id} />
          </div>
        </div>
      )}
```

5. Drop imports that became unused. `businessName` prop stays (Reports passes it) — prefix it with `_` in the destructuring only if the linter complains.

- [ ] **Step 5: Type-check and run the server tests**

Run: `npx tsc --noEmit -p .` → no new errors.
Run: `npm test` → all suites pass (this also restores the Electron build of better-sqlite3).

- [ ] **Step 6: Commit**

```bash
git add src/pages/statement/StatementView.tsx src/intl/locales/statement.ts src/pages/stakeholders/DetailDrawer.tsx src/pages/reports/CustomerStatementTab.tsx src/pages/reports/types.ts
git commit -m "feat(statement): statement view with unpaid/activity modes, A4/receipt preview, print and PDF"
```

---

### Task 8: Verify in the app

**Files:** none (fixes go back to the task that owns the file).

- [ ] **Step 1: Preview-server check (browser)**

Start the preview server (`.claude/launch.json`, `preview_start`), sign in to the local dev tenant (never a customer tenant), open a customer with unpaid orders → Statement tab. Check:
- Unpaid orders: partial order shows paid/remaining; "Total due" equals the drawer's balance.
- Account activity: change the range; opening + rows + closing render; "All" works.
- Receipt toggle narrows the preview to 80 mm.
- Switch store language to Arabic (Settings) → preview is right-to-left and Arabic names/products are joined correctly.
- Reports → Customer statement: pick a supplier → "Total we owe"; Aging row click opens the statement.
- Console has no errors (`read_console_messages`).

- [ ] **Step 2: Electron check**

`npm run rebuild`, launch the app in Electron, then on a party:
- Print with A4 → system print dialog opens; cancel closes quietly.
- Save PDF → save dialog; open the PDF and confirm Arabic is shaped and RTL.
- Print with Receipt and no receipt printer configured → falls back to the print dialog with the 80 mm layout.

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: all test files pass.

- [ ] **Step 4: Commit any fixes, then hand off**

```bash
git status
```

Use superpowers:finishing-a-development-branch to decide merge / PR.
