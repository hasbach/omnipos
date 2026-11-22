// Cash accounts (Cash Drawer + Savings / Reserve / Safe / Bank) and atomic linked transfers.
// Balances are always derived (never stored as a running total), honoring Constitution Principle I.
// Non-drawer accounts persist continuously across End-of-Day settlements.
import { randomBytes } from "node:crypto";
import { db, logAction } from "./db.js";
import { ValidationError, validationErrorBody } from "./errors.js";
import { computeRegisterSummary } from "./settlement.js";

export interface CashAccountRow {
  id: number;
  tenant_id: number;
  name: string;
  kind: "drawer" | "savings" | "bank";
  is_default: number;
  active: number;
  created_at: string;
}

export interface CashAccountWithBalance extends CashAccountRow {
  balance_usd: number;
  by_currency: Record<string, number>;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function cleanName(v: any): string {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (s.length < 1 || s.length > 50) {
    throw new ValidationError("Account name must be 1 to 50 characters.", 400, {
      code: "ACCOUNT_NAME_INVALID",
      field: "name",
    });
  }
  return s;
}

function cleanKind(v: any): "savings" | "bank" {
  if (v === "bank") return "bank";
  return "savings";
}

/** Ensures the tenant has a built-in default Cash Drawer account and returns it. */
export function ensureDefaultCashAccount(tenantId: number): CashAccountRow {
  const existing = db
    .prepare("SELECT * FROM cash_accounts WHERE tenant_id = ? AND is_default = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1")
    .get(tenantId) as CashAccountRow | undefined;
  if (existing) return existing;

  const info = db
    .prepare("INSERT INTO cash_accounts (tenant_id, name, kind, is_default, active) VALUES (?, 'Cash Drawer', 'drawer', 1, 1)")
    .run(tenantId);
  return db.prepare("SELECT * FROM cash_accounts WHERE id = ?").get(Number(info.lastInsertRowid)) as CashAccountRow;
}

/** Resolves an optional account_id to a valid account owned by tenantId, defaulting to Cash Drawer. */
export function resolveAccountId(tenantId: number, requested: any, requireActive = false): number {
  const drawer = ensureDefaultCashAccount(tenantId);
  if (requested === undefined || requested === null || requested === "") return drawer.id;
  const id = Number(requested);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError("Invalid cash account.", 400, { code: "ACCOUNT_INVALID", field: "account_id" });
  }
  const acc = db
    .prepare("SELECT * FROM cash_accounts WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL")
    .get(id, tenantId) as CashAccountRow | undefined;
  if (!acc) {
    throw new ValidationError("Cash account not found.", 404, { code: "ACCOUNT_NOT_FOUND", field: "account_id" });
  }
  if (requireActive && !acc.active) {
    throw new ValidationError("This cash account is inactive.", 400, { code: "ACCOUNT_INACTIVE", field: "account_id" });
  }
  return acc.id;
}

/** Returns the default drawer id for a tenant (creating it if missing). */
export function defaultDrawerId(tenantId: number): number {
  return ensureDefaultCashAccount(tenantId).id;
}

/** Derives continuous balances (USD + per-currency native) for a non-drawer account across live + archived tables. */
export function computeAccountBalance(tenantId: number, accountId: number): { balance_usd: number; by_currency: Record<string, number> } {
  const cfRows = db.prepare(`
    SELECT type, currency, amount, IFNULL(NULLIF(exchange_rate, 0), 1) AS rate
    FROM (
      SELECT type, currency, amount, exchange_rate FROM cash_flow WHERE tenant_id = ? AND account_id = ?
      UNION ALL
      SELECT type, currency, amount, exchange_rate FROM archived_cash_flow WHERE tenant_id = ? AND account_id = ?
    )
  `).all(tenantId, accountId, tenantId, accountId) as any[];

  const payRows = db.prepare(`
    SELECT tx_type, currency, amount, IFNULL(NULLIF(exchange_rate, 0), 1) AS rate
    FROM (
      SELECT t.type AS tx_type, p.currency, p.amount, p.exchange_rate
      FROM payments p JOIN transactions t ON t.id = p.transaction_id
      WHERE t.tenant_id = ? AND p.account_id = ? AND p.method = 'cash'
      UNION ALL
      SELECT at.type AS tx_type, ap.currency, ap.amount, ap.exchange_rate
      FROM archived_payments ap JOIN archived_transactions at ON at.id = ap.transaction_id
      WHERE at.tenant_id = ? AND ap.account_id = ? AND ap.method = 'cash'
    )
  `).all(tenantId, accountId, tenantId, accountId) as any[];

  let usd = 0;
  const byCur: Record<string, number> = {};

  const add = (cur: string, nativeAmt: number, usdAmt: number) => {
    usd += usdAmt;
    const key = cur || "USD";
    byCur[key] = (byCur[key] || 0) + nativeAmt;
  };

  for (const r of cfRows) {
    const sign = r.type === "in" ? 1 : -1;
    const amt = Number(r.amount) || 0;
    add(r.currency, sign * amt, sign * (amt / (Number(r.rate) || 1)));
  }

  for (const r of payRows) {
    // Sales add to the account; purchases & refunds deduct from it.
    const sign = r.tx_type === "sale" ? 1 : -1;
    const amt = Number(r.amount) || 0;
    add(r.currency, sign * amt, sign * (amt / (Number(r.rate) || 1)));
  }

  for (const k of Object.keys(byCur)) {
    byCur[k] = round2(byCur[k]);
    if (Math.abs(byCur[k]) < 0.005) delete byCur[k];
  }

  return { balance_usd: round2(usd), by_currency: byCur };
}

export function listCashAccounts(tenantId: number, includeInactive = false): CashAccountWithBalance[] {
  ensureDefaultCashAccount(tenantId);
  const rows = db
    .prepare(`SELECT * FROM cash_accounts WHERE tenant_id = ? AND deleted_at IS NULL ${includeInactive ? "" : "AND active = 1"} ORDER BY is_default DESC, id ASC`)
    .all(tenantId) as CashAccountRow[];

  const drawerSummary = computeRegisterSummary(tenantId, "shift");

  return rows.map((acc) => {
    if (acc.is_default === 1) {
      return {
        ...acc,
        balance_usd: round2(drawerSummary.expectedBalance || 0),
        by_currency: {},
      };
    }
    const bal = computeAccountBalance(tenantId, acc.id);
    return {
      ...acc,
      balance_usd: bal.balance_usd,
      by_currency: bal.by_currency,
    };
  });
}

function assertNameFree(tenantId: number, name: string, exceptId: number | null) {
  const clash = db
    .prepare("SELECT id FROM cash_accounts WHERE tenant_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?) AND id != ?")
    .get(tenantId, name, exceptId ?? -1);
  if (clash) {
    throw new ValidationError("An account with this name already exists.", 400, {
      code: "ACCOUNT_NAME_TAKEN",
      field: "name",
    });
  }
}

export function setupCashAccountRoutes(app: any, authenticate: any, broadcast: Function) {
  const fail = (res: any, e: any) => {
    if (e instanceof ValidationError) return res.status(e.status).json(validationErrorBody(e));
    return res.status(500).json({ error: e?.message || String(e) });
  };

  app.get("/api/cash-accounts", authenticate, (req: any, res: any) => {
    try {
      const includeInactive = req.query.include_inactive === "1";
      res.json(listCashAccounts(req.session.tenantId, includeInactive));
    } catch (e) { fail(res, e); }
  });

  app.post("/api/cash-accounts", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      ensureDefaultCashAccount(tenantId);
      const name = cleanName(req.body?.name);
      assertNameFree(tenantId, name, null);
      const kind = cleanKind(req.body?.kind);

      const info = db
        .prepare("INSERT INTO cash_accounts (tenant_id, name, kind, is_default, active) VALUES (?, ?, ?, 0, 1)")
        .run(tenantId, name, kind);
      const id = Number(info.lastInsertRowid);
      logAction(tenantId, req.session.userId ?? null, "Cash Account Created", `${name} (${kind})`);
      broadcast({ type: "CASH_FLOW_UPDATED" }, tenantId);
      res.json({ success: true, id, account: listCashAccounts(tenantId, true).find((a) => a.id === id) });
    } catch (e) { fail(res, e); }
  });

  app.put("/api/cash-accounts/:id", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const id = parseInt(req.params.id, 10);
      const cur = Number.isFinite(id)
        ? (db.prepare("SELECT * FROM cash_accounts WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL").get(id, tenantId) as CashAccountRow | undefined)
        : undefined;
      if (!cur) throw new ValidationError("Cash account not found.", 404, { code: "ACCOUNT_NOT_FOUND" });

      const name = req.body?.name !== undefined ? cleanName(req.body.name) : cur.name;
      if (name.toLowerCase() !== cur.name.toLowerCase()) assertNameFree(tenantId, name, cur.id);

      let active = cur.active;
      if (req.body?.active !== undefined) {
        const nextActive = req.body.active === true || req.body.active === 1 || req.body.active === "1" ? 1 : 0;
        if (cur.is_default === 1 && nextActive === 0) {
          throw new ValidationError("The default Cash Drawer account cannot be disabled.", 400, { code: "ACCOUNT_DEFAULT_LOCKED" });
        }
        active = nextActive;
      }

      const kind = cur.is_default === 1 ? "drawer" : (req.body?.kind !== undefined ? cleanKind(req.body.kind) : cur.kind);
      db.prepare("UPDATE cash_accounts SET name = ?, kind = ?, active = ? WHERE id = ? AND tenant_id = ?")
        .run(name, kind, active, cur.id, tenantId);
      logAction(tenantId, req.session.userId ?? null, "Cash Account Updated", `${cur.name} -> ${name} (${active ? "active" : "inactive"})`);
      broadcast({ type: "CASH_FLOW_UPDATED" }, tenantId);
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });

  // Atomic internal transfer between two accounts (zero P&L impact).
  app.post("/api/cash-accounts/transfer", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const b = req.body || {};
      const fromId = resolveAccountId(tenantId, b.from_account_id, true);
      const toId = resolveAccountId(tenantId, b.to_account_id, true);
      if (fromId === toId) {
        throw new ValidationError("Source and destination accounts must be different.", 400, {
          code: "TRANSFER_SAME_ACCOUNT",
          field: "to_account_id",
        });
      }
      const amount = Number(b.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new ValidationError("Amount must be greater than zero.", 400, { code: "CASHFLOW_AMOUNT_INVALID", field: "amount" });
      }
      const rate = Number(b.exchange_rate ?? 1);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new ValidationError("Exchange rate must be greater than zero.", 400, { code: "CASHFLOW_RATE_INVALID", field: "exchange_rate" });
      }
      const currency = typeof b.currency === "string" && b.currency.trim() ? b.currency.trim().slice(0, 10) : "USD";
      const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";

      const fromAcc = db.prepare("SELECT * FROM cash_accounts WHERE id = ? AND tenant_id = ?").get(fromId, tenantId) as CashAccountRow;
      const toAcc = db.prepare("SELECT * FROM cash_accounts WHERE id = ? AND tenant_id = ?").get(toId, tenantId) as CashAccountRow;

      let userId: number | null = null;
      if (b.user_id || req.session.userId) {
        const u = db.prepare("SELECT id FROM users WHERE id = ? AND tenant_id = ?").get(b.user_id ?? req.session.userId, tenantId) as any;
        if (u) userId = u.id;
      }
      if (userId == null) {
        const first = db.prepare("SELECT id FROM users WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY (role = 'admin') DESC, id LIMIT 1").get(tenantId) as any;
        userId = first ? first.id : null;
      }

      const transferId = "tr_" + randomBytes(8).toString("hex");
      const note = reason || `Transfer: ${fromAcc.name} -> ${toAcc.name}`;

      let outId = 0;
      let inId = 0;
      db.transaction(() => {
        const outInfo = db.prepare(
          "INSERT INTO cash_flow (tenant_id, user_id, type, amount, currency, exchange_rate, reason, category, counterparty, account_id, transfer_id) VALUES (?, ?, 'out', ?, ?, ?, ?, 'transfer', ?, ?, ?)"
        ).run(tenantId, userId, amount, currency, rate, note, toAcc.name, fromAcc.id, transferId);
        outId = Number(outInfo.lastInsertRowid);

        const inInfo = db.prepare(
          "INSERT INTO cash_flow (tenant_id, user_id, type, amount, currency, exchange_rate, reason, category, counterparty, account_id, transfer_id) VALUES (?, ?, 'in', ?, ?, ?, ?, 'transfer', ?, ?, ?)"
        ).run(tenantId, userId, amount, currency, rate, note, fromAcc.name, toAcc.id, transferId);
        inId = Number(inInfo.lastInsertRowid);
      })();

      logAction(tenantId, userId, "Cash Account Transfer", `${amount} ${currency}: ${fromAcc.name} -> ${toAcc.name}${reason ? ` (${reason})` : ""}`);
      broadcast({ type: "CASH_FLOW_UPDATED" }, tenantId);
      res.json({ success: true, transfer_id: transferId, out_id: outId, in_id: inId });
    } catch (e) { fail(res, e); }
  });
}
