// Cash-flow register: manual movements, categories/counterparty, admin edit with audit trail, and
// analytics over live + archived (settled) rows. Permission checks are NOT done here — the central
// permission middleware (server/permissions.ts) gates `PUT /api/cash-flow/:id` etc. by route pattern.
//
// Money model: rows keep the entered currency + exchange_rate (LBP per USD); every total below is
// USD = amount / exchange_rate, the same convention as the register summary in server/settlement.ts.
import { db, logAction } from "./db.js";
import { parseRegisterScope, registerWindow } from "./settlement.js";
import { ValidationError, validationErrorBody } from "./errors.js";
import { randomBytes } from "node:crypto";

export const CASH_FLOW_CATEGORIES = [
  "top_up", "loan_in", "loan_repayment", "owner_withdrawal", "expense",
  "supplier_payment", "customer_collection", "other",
] as const;
export type CashFlowCategory = typeof CASH_FLOW_CATEGORIES[number];

// Which direction a category may take. `other` is open. Enforced on create AND edit so the
// analytics (borrowed vs repaid, top-ups) can't be skewed by an impossible pairing.
const CATEGORY_TYPES: Record<CashFlowCategory, Array<"in" | "out">> = {
  top_up: ["in"],
  loan_in: ["in"],
  customer_collection: ["in"],
  loan_repayment: ["out"],
  owner_withdrawal: ["out"],
  expense: ["out"],
  supplier_payment: ["out"],
  other: ["in", "out"],
};

// Automatic rows written by other modules (balance payments, payments on archived invoices).
export const AUTO_CATEGORY = { collect: "customer_collection", pay: "supplier_payment" } as const;

const EDITABLE_FIELDS = ["type", "amount", "currency", "exchange_rate", "category", "counterparty", "reason"] as const;

function tenantUserId(tenantId: number, requested: any): number | null {
  if (requested) {
    const u = db.prepare("SELECT id FROM users WHERE id = ? AND tenant_id = ?").get(requested, tenantId) as any;
    if (u) return u.id;
  }
  const first = db.prepare("SELECT id FROM users WHERE tenant_id = ? ORDER BY (role = 'admin') DESC, id LIMIT 1").get(tenantId) as any;
  return first ? first.id : null;
}

function cleanText(v: any, max = 200): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

interface CustomCategoryRow { id: number; key: string; name: string; direction: "in" | "out" | "both"; active: number; sort_order: number }

function customCategory(tenantId: number, key: string): CustomCategoryRow | undefined {
  return db.prepare("SELECT id, key, name, direction, active, sort_order FROM cash_flow_categories WHERE tenant_id = ? AND key = ? AND deleted_at IS NULL")
    .get(tenantId, key) as CustomCategoryRow | undefined;
}

// Built-ins as today, OR an active custom category of THIS tenant whose direction allows the type.
// `keep` is the category the row already has (edit): an inactive custom category may stay on the row
// until the category itself is changed — hiding a category never blocks editing an old movement.
function validateCategory(category: any, type: string, tenantId: number, keep?: string | null): string {
  const c = category === undefined || category === null || category === "" ? "other" : String(category);
  const mismatch = () => new ValidationError("This category does not match the movement type (cash in / cash out).", 400,
    { code: "CASHFLOW_CATEGORY_TYPE_MISMATCH", field: "category" });
  if ((CASH_FLOW_CATEGORIES as readonly string[]).includes(c)) {
    if (!CATEGORY_TYPES[c as CashFlowCategory].includes(type as any)) throw mismatch();
    return c;
  }
  const custom = customCategory(tenantId, c);
  if (!custom || (!custom.active && c !== keep)) {
    throw new ValidationError("Unknown cash-flow category.", 400, { code: "CASHFLOW_CATEGORY_INVALID", field: "category" });
  }
  if (custom.direction !== "both" && custom.direction !== type) throw mismatch();
  return c;
}

function validateMoney(amount: any, rate: any) {
  const a = Number(amount);
  if (!Number.isFinite(a) || a <= 0) throw new ValidationError("Amount must be greater than zero.", 400, { code: "CASHFLOW_AMOUNT_INVALID", field: "amount" });
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) throw new ValidationError("Exchange rate must be greater than zero.", 400, { code: "CASHFLOW_RATE_INVALID", field: "exchange_rate" });
  return { amount: a, rate: r };
}

const snapshot = (row: any) => Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, row[f] ?? null]));

// Find a row by id in the live table first, then the archive (ids are AUTOINCREMENT-unique, so
// a settled row never shares an id with a live one). `?archived=1` forces the archive.
function findRow(tenantId: number, id: number, forceArchived: boolean) {
  if (!forceArchived) {
    const live = db.prepare("SELECT * FROM cash_flow WHERE id = ? AND tenant_id = ?").get(id, tenantId) as any;
    if (live) return { row: live, archived: false };
  }
  const arch = db.prepare("SELECT * FROM archived_cash_flow WHERE id = ? AND tenant_id = ?").get(id, tenantId) as any;
  return arch ? { row: arch, archived: true } : null;
}

export function getCashFlowEdits(tenantId: number, id: number) {
  const rows = db.prepare(`
    SELECT e.*, u.name AS user_name FROM cash_flow_edits e LEFT JOIN users u ON u.id = e.user_id
    WHERE e.tenant_id = ? AND e.cash_flow_id = ? ORDER BY e.created_at DESC, e.id DESC
  `).all(tenantId, id) as any[];
  return rows.map((r) => ({
    ...r,
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null,
  }));
}

const EDIT_COUNT_SQL = "(SELECT COUNT(*) FROM cash_flow_edits e WHERE e.tenant_id = c.tenant_id AND e.cash_flow_id = c.id)";

export function editCashFlow(tenantId: number, id: number, userId: number | null, body: any, forceArchived = false) {
  const editReason = cleanText(body?.edit_reason, 500);
  if (!editReason || editReason.length < 3) {
    throw new ValidationError("A reason for the edit (at least 3 characters) is required.", 400, { code: "CASHFLOW_EDIT_REASON_REQUIRED", field: "edit_reason" });
  }
  const found = findRow(tenantId, id, forceArchived);
  if (!found) throw new ValidationError("Cash-flow entry not found.", 404, { code: "CASHFLOW_NOT_FOUND" });
  const { row, archived } = found;

  const type = body.type !== undefined ? String(body.type) : row.type;
  if (type !== "in" && type !== "out") throw new ValidationError("Type must be 'in' or 'out'.", 400, { code: "CASHFLOW_TYPE_INVALID", field: "type" });
  const { amount, rate } = validateMoney(body.amount !== undefined ? body.amount : row.amount, body.exchange_rate !== undefined ? body.exchange_rate : (row.exchange_rate || 1));
  const currency = body.currency !== undefined ? (cleanText(body.currency, 10) || "USD") : (row.currency || "USD");
  // A row with no category reads as 'other'; keep that unless the caller sets one.
  const category = validateCategory(body.category !== undefined ? body.category : (row.category || "other"), type, tenantId, row.category || "other");
  const counterparty = body.counterparty !== undefined ? cleanText(body.counterparty) : (row.counterparty ?? null);
  const reason = body.reason !== undefined ? (cleanText(body.reason, 500) ?? "") : (row.reason ?? "");

  const before = snapshot({ ...row, category: row.category || "other" });
  const after = { type, amount, currency, exchange_rate: rate, category, counterparty, reason };
  if (JSON.stringify(before) === JSON.stringify(after)) {
    throw new ValidationError("Nothing was changed.", 400, { code: "CASHFLOW_NO_CHANGES" });
  }

  const table = archived ? "archived_cash_flow" : "cash_flow";
  db.transaction(() => {
    db.prepare(`UPDATE ${table} SET type = ?, amount = ?, currency = ?, exchange_rate = ?, category = ?, counterparty = ?, reason = ? WHERE id = ? AND tenant_id = ?`)
      .run(type, amount, currency, rate, category, counterparty, reason, id, tenantId);
    db.prepare("INSERT INTO cash_flow_edits (tenant_id, cash_flow_id, archived, user_id, edit_reason, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(tenantId, id, archived ? 1 : 0, userId, editReason, JSON.stringify(before), JSON.stringify(after));
  })();

  logAction(tenantId, userId, "Cash Flow Edited",
    `#${id}${archived ? " (settled)" : ""}: ${before.amount} ${before.currency} → ${amount} ${currency}. Reason: ${editReason}`);
  return { archived, before, after };
}

interface AnalyticsFilters {
  from: string | null; to: string | null; type: string | null; category: string | null;
  q: string | null; counterparty: string | null;
}

function parseFilters(query: any): AnalyticsFilters {
  const date = (v: any) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const str = (v: any) => (typeof v === "string" && v.trim() && v !== "all" ? v.trim() : null);
  const type = str(query.type);
  return {
    from: date(query.from), to: date(query.to),
    type: type === "in" || type === "out" ? type : null,
    category: str(query.category), q: str(query.q), counterparty: str(query.counterparty),
  };
}

// One unified view over the live and archived tables. `day` is the LOCAL calendar date of created_at
// (stored UTC by SQLite), like every other date-bounded report in the app.
const UNION_SQL = `
  SELECT c.id, 0 AS archived, NULL AS settlement_id, c.tenant_id, c.user_id, c.type, c.amount, c.currency,
         IFNULL(NULLIF(c.exchange_rate, 0), 1) AS exchange_rate, COALESCE(c.category, 'other') AS category,
         c.counterparty, c.reason, c.created_at, ${EDIT_COUNT_SQL} AS edit_count
    FROM cash_flow c WHERE c.tenant_id = @tenant
  UNION ALL
  SELECT c.id, 1, c.settlement_id, c.tenant_id, c.user_id, c.type, c.amount, c.currency,
         IFNULL(NULLIF(c.exchange_rate, 0), 1), COALESCE(c.category, 'other'),
         c.counterparty, c.reason, c.created_at, ${EDIT_COUNT_SQL}
    FROM archived_cash_flow c WHERE c.tenant_id = @tenant
`;

function whereFor(f: AnalyticsFilters, opts: { ignoreFrom?: boolean; ignoreTypeCategory?: boolean } = {}) {
  const parts: string[] = [];
  const params: Record<string, any> = {};
  if (f.from && !opts.ignoreFrom) { parts.push("date(created_at, 'localtime') >= @from"); params.from = f.from; }
  if (f.to) { parts.push("date(created_at, 'localtime') <= @to"); params.to = f.to; }
  if (!opts.ignoreTypeCategory) {
    if (f.type) { parts.push("type = @type"); params.type = f.type; }
    if (f.category) { parts.push("category = @category"); params.category = f.category; }
  }
  if (f.counterparty) { parts.push("LOWER(IFNULL(counterparty, '')) LIKE @cp ESCAPE '\\'"); params.cp = `%${escapeLike(f.counterparty.toLowerCase())}%`; }
  if (f.q) {
    parts.push("(LOWER(IFNULL(reason, '')) LIKE @q ESCAPE '\\' OR LOWER(IFNULL(counterparty, '')) LIKE @q ESCAPE '\\' OR LOWER(category) LIKE @q ESCAPE '\\' OR category IN (SELECT key FROM cash_flow_categories WHERE tenant_id = @tenant AND deleted_at IS NULL AND LOWER(name) LIKE @q ESCAPE '\\'))");
    params.q = `%${escapeLike(f.q.toLowerCase())}%`;
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

function escapeLike(s: string) { return s.replace(/[\\%_]/g, (m) => `\\${m}`); }

export function computeCashFlowAnalytics(tenantId: number, query: any) {
  const f = parseFilters(query);
  const { sql: where, params } = whereFor(f);
  const base = `WITH u AS (${UNION_SQL}) `;
  const p = { tenant: tenantId, ...params };
  const usd = "amount / exchange_rate";

  const t = db.prepare(`${base} SELECT
      IFNULL(SUM(CASE WHEN type = 'in' THEN ${usd} ELSE 0 END), 0) AS total_in,
      IFNULL(SUM(CASE WHEN type = 'out' THEN ${usd} ELSE 0 END), 0) AS total_out,
      COUNT(*) AS count FROM u ${where}`).get(p) as any;

  const by_category = (db.prepare(`${base} SELECT category, type, COUNT(*) AS count, SUM(${usd}) AS total
      FROM u ${where} GROUP BY category, type ORDER BY total DESC`).all(p) as any[])
    .map((r) => ({ category: r.category, type: r.type, count: r.count, total: r.total }));

  const by_day = (db.prepare(`${base} SELECT date(created_at, 'localtime') AS date,
      SUM(CASE WHEN type = 'in' THEN ${usd} ELSE 0 END) AS "in",
      SUM(CASE WHEN type = 'out' THEN ${usd} ELSE 0 END) AS "out"
      FROM u ${where} GROUP BY date ORDER BY date`).all(p) as any[])
    .map((r) => ({ date: r.date, in: r.in, out: r.out }));

  // Loans are cumulative: a loan taken last month and repaid this month must net out, so the date
  // window's START and the type/category filters are ignored (the end date and text filters apply).
  const loanW = whereFor(f, { ignoreFrom: true, ignoreTypeCategory: true });
  const by_counterparty = (db.prepare(`${base} SELECT IFNULL(NULLIF(TRIM(counterparty), ''), '') AS counterparty,
      SUM(CASE WHEN category = 'loan_in' THEN ${usd} ELSE 0 END) AS borrowed,
      SUM(CASE WHEN category = 'loan_repayment' THEN ${usd} ELSE 0 END) AS repaid
      FROM u ${loanW.sql ? loanW.sql + " AND" : "WHERE"} category IN ('loan_in', 'loan_repayment')
      GROUP BY IFNULL(NULLIF(TRIM(counterparty), ''), '')`).all({ tenant: tenantId, ...loanW.params }) as any[])
    .map((r) => ({ counterparty: r.counterparty, borrowed: r.borrowed, repaid: r.repaid, outstanding: r.borrowed - r.repaid }))
    .sort((a, b) => b.outstanding - a.outstanding);

  const rows = (db.prepare(`${base} SELECT f.*, us.name AS user_name, f.amount / f.exchange_rate AS amount_usd
      FROM (SELECT * FROM u ${where}) f LEFT JOIN users us ON us.id = f.user_id
      ORDER BY f.created_at DESC, f.id DESC LIMIT 5000`).all(p) as any[])
    .map((r) => ({ ...r, archived: !!r.archived, edited: r.edit_count > 0 }));

  return {
    totals: { in: t.total_in, out: t.total_out, net: t.total_in - t.total_out, count: t.count },
    by_category, by_counterparty, by_day, rows,
  };
}

function listCategories(tenantId: number) {
  const custom = db.prepare("SELECT id, key, name, direction, active, sort_order FROM cash_flow_categories WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY sort_order, LOWER(name), id")
    .all(tenantId) as CustomCategoryRow[];
  return {
    builtin: CASH_FLOW_CATEGORIES.map((key) => {
      const d = CATEGORY_TYPES[key];
      return { key, direction: d.length === 2 ? "both" : d[0] };
    }),
    custom: custom.map((c) => ({ ...c, active: !!c.active })),
  };
}

function cleanCategoryName(v: any): string {
  const name = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (name.length < 1 || name.length > 40) {
    throw new ValidationError("The category name must be 1 to 40 characters.", 400, { code: "CASHFLOW_CATEGORY_NAME_INVALID", field: "name" });
  }
  return name;
}

function cleanDirection(v: any): "in" | "out" | "both" {
  if (v !== "in" && v !== "out" && v !== "both") {
    throw new ValidationError("Choose whether the category is for cash in, cash out or both.", 400, { code: "CASHFLOW_CATEGORY_DIRECTION_INVALID", field: "direction" });
  }
  return v;
}

function assertNameFree(tenantId: number, name: string, exceptId: number | null) {
  const clash = db.prepare("SELECT id FROM cash_flow_categories WHERE tenant_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?) AND id != ?")
    .get(tenantId, name, exceptId ?? -1);
  if (clash) throw new ValidationError("A category with this name already exists.", 400, { code: "CASHFLOW_CATEGORY_NAME_TAKEN", field: "name" });
}

export function setupCashFlowRoutes(app: any, authenticate: any, broadcast: Function) {
  const fail = (res: any, e: any) => {
    if (e instanceof ValidationError) return res.status(e.status).json(validationErrorBody(e));
    return res.status(500).json({ error: e?.message || String(e) });
  };

  // The live, open register (everything since the last close) — the Cash Flow page's "today" view.
  app.get("/api/cash-flow", authenticate, (req: any, res: any) => {
    const tenantId = req.session.tenantId;
    const { since } = registerWindow(tenantId, parseRegisterScope(req.query.scope)); // ?scope=day = since the last settlement
    const entries = db.prepare(`
      SELECT c.*, COALESCE(c.category, 'other') AS category, ${EDIT_COUNT_SQL} AS edit_count
      FROM cash_flow c WHERE c.tenant_id = ? AND c.created_at > ? ORDER BY c.created_at DESC, c.id DESC
    `).all(tenantId, since) as any[];
    res.json(entries.map((e) => ({ ...e, edited: e.edit_count > 0 })));
  });

  app.post("/api/cash-flow", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const userId = tenantUserId(tenantId, req.body.user_id);
      const { type, currency, exchange_rate } = req.body;
      if (type !== "in" && type !== "out") throw new ValidationError("Type must be 'in' or 'out'.", 400, { code: "CASHFLOW_TYPE_INVALID", field: "type" });
      const { amount, rate } = validateMoney(req.body.amount, exchange_rate ?? 1);
      const category = validateCategory(req.body.category, type, tenantId);
      const counterparty = cleanText(req.body.counterparty);
      const reason = req.body.reason ?? "";

      db.prepare("INSERT INTO cash_flow (tenant_id, user_id, type, amount, currency, exchange_rate, reason, category, counterparty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(tenantId, userId, type, amount, currency || "USD", rate, reason, category, counterparty);

      logAction(tenantId, userId, `Cash ${type === "in" ? "In" : "Out"}`,
        `Amount: ${amount} ${currency || "USD"}, Category: ${category}${counterparty ? `, ${counterparty}` : ""}, Reason: ${reason}`);
      broadcast({ type: "CASH_FLOW_UPDATED" }, tenantId);
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });

  // ---- custom categories (Settings -> Cash flow categories) ----
  // Reading is open to anyone who can use the register; POST / PUT are settings.manage (permissions.ts).
  app.get("/api/cash-flow/categories", authenticate, (req: any, res: any) => {
    try { res.json(listCategories(req.session.tenantId)); } catch (e) { fail(res, e); }
  });

  app.post("/api/cash-flow/categories", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const name = cleanCategoryName(req.body?.name);
      assertNameFree(tenantId, name, null);
      const direction = cleanDirection(req.body?.direction);
      const next = (db.prepare("SELECT IFNULL(MAX(sort_order), 0) + 1 AS n FROM cash_flow_categories WHERE tenant_id = ?").get(tenantId) as any).n;
      const key = "c_" + randomBytes(6).toString("hex");
      const info = db.prepare("INSERT INTO cash_flow_categories (tenant_id, key, name, direction, active, sort_order) VALUES (?, ?, ?, ?, 1, ?)")
        .run(tenantId, key, name, direction, next);
      logAction(tenantId, req.session.userId ?? null, "Cash Flow Category Created", `${name} (${direction})`);
      broadcast({ type: "CASH_FLOW_CATEGORIES_UPDATED" }, tenantId);
      res.json({ success: true, id: Number(info.lastInsertRowid), key });
    } catch (e) { fail(res, e); }
  });

  app.put("/api/cash-flow/categories/:id", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const id = parseInt(req.params.id, 10);
      const cur = Number.isFinite(id)
        ? db.prepare("SELECT id, key, name, direction, active, sort_order FROM cash_flow_categories WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL").get(id, tenantId) as CustomCategoryRow | undefined
        : undefined;
      if (!cur) throw new ValidationError("Category not found.", 404, { code: "CASHFLOW_CATEGORY_NOT_FOUND" });
      const b = req.body || {};
      const name = b.name !== undefined ? cleanCategoryName(b.name) : cur.name;
      if (name !== cur.name) assertNameFree(tenantId, name, cur.id);
      const direction = b.direction !== undefined ? cleanDirection(b.direction) : cur.direction;
      if (direction !== cur.direction && direction !== "both") {
        // Narrowing the direction is refused while a movement of the opposite type carries this category.
        const opposite = direction === "in" ? "out" : "in";
        const used = (db.prepare(`SELECT (SELECT COUNT(*) FROM cash_flow WHERE tenant_id = @t AND category = @k AND type = @o)
                                   + (SELECT COUNT(*) FROM archived_cash_flow WHERE tenant_id = @t AND category = @k AND type = @o) AS n`)
          .get({ t: tenantId, k: cur.key, o: opposite }) as any).n;
        if (used > 0) {
          throw new ValidationError("Movements of the opposite type already use this category, so its direction cannot be narrowed.", 400,
            { code: "CASHFLOW_CATEGORY_DIRECTION_IN_USE", field: "direction" });
        }
      }
      const active = b.active !== undefined ? (b.active === true || b.active === 1 || b.active === "1" ? 1 : 0) : cur.active;
      const sort = b.sort_order !== undefined && Number.isFinite(Number(b.sort_order)) ? Math.trunc(Number(b.sort_order)) : cur.sort_order;
      db.prepare("UPDATE cash_flow_categories SET name = ?, direction = ?, active = ?, sort_order = ? WHERE id = ? AND tenant_id = ?")
        .run(name, direction, active, sort, cur.id, tenantId);
      logAction(tenantId, req.session.userId ?? null, "Cash Flow Category Updated",
        `${cur.name} → ${name} (${direction}, ${active ? "active" : "hidden"})`);
      broadcast({ type: "CASH_FLOW_CATEGORIES_UPDATED" }, tenantId);
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/cash-flow/analytics", authenticate, (req: any, res: any) => {
    try { res.json(computeCashFlowAnalytics(req.session.tenantId, req.query)); } catch (e) { fail(res, e); }
  });

  app.get("/api/cash-flow/:id/edits", authenticate, (req: any, res: any) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    res.json(getCashFlowEdits(req.session.tenantId, id));
  });

  // Admin edit of a live OR settled row. edit_reason is mandatory; every edit is audited.
  app.put("/api/cash-flow/:id", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) throw new ValidationError("Invalid id", 400, { code: "CASHFLOW_NOT_FOUND" });
      const userId = tenantUserId(tenantId, req.session.userId ?? req.body?.user_id);
      const result = editCashFlow(tenantId, id, userId, req.body || {}, req.query.archived === "1");
      broadcast({ type: "CASH_FLOW_UPDATED" }, tenantId);
      res.json({ success: true, ...result });
    } catch (e) { fail(res, e); }
  });
}
