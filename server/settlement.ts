// End-of-Day settlement detail — docs/plans/2026-09-29-settlement-detail.md.
//
// A settlement is now ONE atomic record: `daily_reports` holds the totals, the counted cash per
// currency and a full breakdown snapshot taken from the live data at the moment of closing, and the
// archived rows it moved carry `settlement_id`. From that link the breakdown can be REBUILT later
// and compared with the snapshot, which is how "changed after closing" (an archived invoice edited
// afterwards) is detected. Admin corrections are appended to `settlement_corrections`; the
// original report numbers are never modified.
//
// All money is USD (payment.amount / payment.exchange_rate) unless a field says "native".
import { db, logAction } from "./db.js";
import { ValidationError, validationErrorBody } from "./errors.js";
import { findAdminByPin } from "./tenantReset.js";

const EPOCH = "0000-01-01 00:00:00";
const FAR_FUTURE = "9999-12-31 23:59:59";
const METHODS = ["cash", "card", "credit", "store_credit"] as const;
const TYPES = [
  ["sale", "sales"],
  ["refund", "refunds"],
  ["purchase", "purchases"],
] as const;
const DIFF_TOLERANCE = 0.005;

// ---------------------------------------------------------------------------------------------
// The open register window
// ---------------------------------------------------------------------------------------------

// The cash-flow register stays open across any number of calendar days until the owner closes it
// (a routine Cash Out or the full End-of-Day Settlement, whichever happened last). This finds that
// boundary and the cash counted at it (the next period's opening balance). A counted-cash
// CORRECTION on the latest close makes the corrected count the opening balance (COALESCE below).
export function lastRegisterClose(tenantId: number): { actualBalance: number; since: string } {
  const lastClose = db.prepare(`
    SELECT actual_balance, created_at FROM (
      SELECT COALESCE(corrected_actual_balance, actual_balance) as actual_balance, created_at FROM daily_reports WHERE tenant_id = ?
      UNION ALL
      SELECT actual_cash as actual_balance, created_at FROM cashier_shifts WHERE tenant_id = ?
    )
    ORDER BY created_at DESC LIMIT 1
  `).get(tenantId, tenantId) as any;
  return {
    actualBalance: lastClose ? lastClose.actual_balance : 0,
    since: lastClose ? lastClose.created_at : EPOCH,
  };
}

// Where the rows of a breakdown come from: the tenant's LIVE tables (at settlement time) or the
// ARCHIVED rows of one settlement (the rebuild).
interface Source {
  tx: string; pay: string; cf: string;
  txWhere: string; txParams: any[];
  cfWhere: string; cfParams: any[];
}
function liveSource(tenantId: number): Source {
  return {
    tx: "transactions", pay: "payments", cf: "cash_flow",
    txWhere: "t.tenant_id = ?", txParams: [tenantId],
    cfWhere: "tenant_id = ?", cfParams: [tenantId],
  };
}
function archivedSource(tenantId: number, reportId: number): Source {
  return {
    tx: "archived_transactions", pay: "archived_payments", cf: "archived_cash_flow",
    txWhere: "t.tenant_id = ? AND t.settlement_id = ?", txParams: [tenantId, reportId],
    cfWhere: "tenant_id = ? AND settlement_id = ?", cfParams: [tenantId, reportId],
  };
}

// Cash register movements since `since` (exclusive) up to `until` (inclusive) — the exact formula
// /api/cash-flow/summary has always used.
function registerMovements(src: Source, since: string, until: string) {
  const cashOf = (type: string) => (db.prepare(`
    SELECT IFNULL(SUM(p.amount / p.exchange_rate), 0) as total
    FROM ${src.pay} p JOIN ${src.tx} t ON p.transaction_id = t.id
    WHERE ${src.txWhere} AND t.type = ? AND p.method = 'cash' AND p.created_at > ? AND p.created_at <= ?
  `).get(...src.txParams, type, since, until) as any).total as number;
  const flow = db.prepare(`
    SELECT
      IFNULL(SUM(CASE WHEN type = 'in' THEN amount / exchange_rate ELSE 0 END), 0) as total_in,
      IFNULL(SUM(CASE WHEN type = 'out' THEN amount / exchange_rate ELSE 0 END), 0) as total_out
    FROM ${src.cf} WHERE ${src.cfWhere} AND created_at > ? AND created_at <= ?
  `).get(...src.cfParams, since, until) as any;
  return {
    cashSales: cashOf("sale"),
    cashRefunds: cashOf("refund"),
    cashPurchases: cashOf("purchase"),
    cashIn: flow.total_in as number,
    cashOut: flow.total_out as number,
  };
}

// GET /api/cash-flow/summary — the live open register. Same numbers as before the refactor.
export function computeRegisterSummary(tenantId: number) {
  const { actualBalance: openingBalance, since } = lastRegisterClose(tenantId);
  const m = registerMovements(liveSource(tenantId), since, FAR_FUTURE);
  const expectedBalance = openingBalance + m.cashSales - m.cashRefunds - m.cashPurchases + m.cashIn - m.cashOut;
  return {
    openingBalance,
    totalSales: m.cashSales,
    totalRefunds: m.cashRefunds,
    totalPurchases: m.cashPurchases,
    totalIn: m.cashIn,
    totalOut: m.cashOut,
    expectedBalance,
  };
}

// ---------------------------------------------------------------------------------------------
// The breakdown (used for BOTH the snapshot at closing and the rebuild)
// ---------------------------------------------------------------------------------------------

const emptyMethods = () => ({ cash: 0, card: 0, credit: 0, store_credit: 0 } as Record<string, number>);

function typeSection(src: Source, type: string, until: string) {
  const head = db.prepare(`
    SELECT COUNT(*) as c, IFNULL(SUM(t.total_amount), 0) as total FROM ${src.tx} t WHERE ${src.txWhere} AND t.type = ?
  `).get(...src.txParams, type) as any;
  const by_method = emptyMethods();
  const methodRows = db.prepare(`
    SELECT p.method as method, IFNULL(SUM(p.amount / p.exchange_rate), 0) as v
    FROM ${src.pay} p JOIN ${src.tx} t ON p.transaction_id = t.id
    WHERE ${src.txWhere} AND t.type = ? AND p.created_at <= ? GROUP BY p.method
  `).all(...src.txParams, type, until) as any[];
  for (const r of methodRows) by_method[r.method] = (by_method[r.method] || 0) + r.v;
  const cash_by_currency: Record<string, number> = {};
  const curRows = db.prepare(`
    SELECT p.currency as currency, IFNULL(SUM(p.amount), 0) as v
    FROM ${src.pay} p JOIN ${src.tx} t ON p.transaction_id = t.id
    WHERE ${src.txWhere} AND t.type = ? AND p.method = 'cash' AND p.created_at <= ? GROUP BY p.currency
  `).all(...src.txParams, type, until) as any[];
  for (const r of curRows) cash_by_currency[r.currency || "USD"] = (cash_by_currency[r.currency || "USD"] || 0) + r.v;
  return { count: head.c as number, total: head.total as number, by_method, cash_by_currency };
}

function flowSection(src: Source, type: "in" | "out", since: string, until: string) {
  const rows = db.prepare(`
    SELECT currency, IFNULL(SUM(amount), 0) as native, IFNULL(SUM(amount / exchange_rate), 0) as usd, COUNT(*) as c
    FROM ${src.cf} WHERE ${src.cfWhere} AND type = ? AND created_at > ? AND created_at <= ? GROUP BY currency
  `).all(...src.cfParams, type, since, until) as any[];
  const by_currency: Record<string, number> = {};
  let total = 0;
  let count = 0;
  for (const r of rows) {
    by_currency[r.currency || "USD"] = (by_currency[r.currency || "USD"] || 0) + r.native;
    total += r.usd;
    count += r.c;
  }
  return { total, by_currency, count };
}

export interface Breakdown {
  period_start: string;
  period_end: string;
  sales: ReturnType<typeof typeSection>;
  refunds: ReturnType<typeof typeSection>;
  purchases: ReturnType<typeof typeSection>;
  cash_in: ReturnType<typeof flowSection>;
  cash_out: ReturnType<typeof flowSection>;
  register: {
    opening: number; cash_sales: number; cash_refunds: number; cash_purchases: number;
    cash_in: number; cash_out: number; expected: number;
  };
  shifts: { user_name: string | null; expected_cash: number; actual_cash: number; difference: number; created_at: string }[];
}

function buildBreakdown(
  src: Source,
  o: { periodStart: string; periodEnd: string; until: string; opening: number; shifts: Breakdown["shifts"] },
): Breakdown {
  const m = registerMovements(src, o.periodStart, o.until);
  const expected = o.opening + m.cashSales - m.cashRefunds - m.cashPurchases + m.cashIn - m.cashOut;
  const sec: any = {};
  for (const [type, key] of TYPES) sec[key] = typeSection(src, type, o.until);
  return {
    period_start: o.periodStart,
    period_end: o.periodEnd,
    sales: sec.sales,
    refunds: sec.refunds,
    purchases: sec.purchases,
    cash_in: flowSection(src, "in", o.periodStart, o.until),
    cash_out: flowSection(src, "out", o.periodStart, o.until),
    register: {
      opening: o.opening, cash_sales: m.cashSales, cash_refunds: m.cashRefunds, cash_purchases: m.cashPurchases,
      cash_in: m.cashIn, cash_out: m.cashOut, expected,
    },
    shifts: o.shifts,
  };
}

function liveShifts(tenantId: number): Breakdown["shifts"] {
  return db.prepare(`
    SELECT u.name as user_name, cs.expected_cash, cs.actual_cash, cs.difference, cs.created_at
    FROM cashier_shifts cs LEFT JOIN users u ON cs.user_id = u.id
    WHERE cs.tenant_id = ? ORDER BY cs.created_at ASC, cs.id ASC
  `).all(tenantId) as any[];
}

// ---------------------------------------------------------------------------------------------
// Settlement (called from POST /api/tenant/settlement, INSIDE its db.transaction)
// ---------------------------------------------------------------------------------------------

export interface CountedLine { currency: string; amount: number; rate: number }
export interface SettlementInput { counted: CountedLine[]; notes: string }

function currencyRate(tenantId: number, code: string): number | null {
  if (code === "USD") return 1;
  const row = db.prepare("SELECT rate FROM currencies WHERE tenant_id = ? AND code = ?").get(tenantId, code) as any;
  return row && Number(row.rate) > 0 ? Number(row.rate) : null;
}

// Validates + normalizes a `counted` array ([{currency, amount, rate}], rate = units per USD).
function normalizeCounted(tenantId: number, raw: any, fieldPrefix: string, errorCode: string): CountedLine[] {
  if (!Array.isArray(raw)) throw new ValidationError("Counted cash must be a list.", 400, { code: errorCode, field: fieldPrefix });
  const seen = new Set<string>();
  return raw.map((line: any, i: number) => {
    const currency = typeof line?.currency === "string" ? line.currency.trim().toUpperCase() : "";
    if (!currency) throw new ValidationError("Currency is required.", 400, { code: errorCode, field: `${fieldPrefix}.${i}.currency` });
    if (seen.has(currency)) throw new ValidationError(`Duplicate currency ${currency}.`, 400, { code: errorCode, field: `${fieldPrefix}.${i}.currency` });
    seen.add(currency);
    const amount = Number(line?.amount);
    if (line?.amount === null || line?.amount === undefined || line?.amount === "" || !Number.isFinite(amount) || amount < 0) {
      throw new ValidationError("Counted amount must be zero or more.", 400, { code: errorCode, field: `${fieldPrefix}.${i}.amount` });
    }
    let rate = Number(line?.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      const looked = currencyRate(tenantId, currency);
      if (looked === null) throw new ValidationError("Exchange rate is required.", 400, { code: errorCode, field: `${fieldPrefix}.${i}.rate` });
      rate = looked;
    }
    return { currency, amount, rate };
  });
}

export function parseSettlementBody(tenantId: number, body: any): SettlementInput | null {
  if (!body || body.counted === undefined || body.counted === null) return null; // legacy flow
  return {
    counted: normalizeCounted(tenantId, body.counted, "counted", "SETTLEMENT_COUNTED_INVALID"),
    notes: typeof body.notes === "string" ? body.notes : "",
  };
}

export interface SettlementContext {
  reportId: number | null;
  txIds: number[];
  cashIds: number[];
}

const nowStamp = () => (db.prepare("SELECT datetime('now') as n").get() as any).n as string;

// Latest close BEFORE a given daily report (the start of the register window it closed).
function closeBefore(tenantId: number, report: any): { since: string } {
  const row = db.prepare(`
    SELECT MAX(created_at) as at FROM (
      SELECT created_at FROM daily_reports WHERE tenant_id = ? AND id < ?
      UNION ALL
      SELECT created_at FROM cashier_shifts WHERE tenant_id = ? AND created_at <= ?
    )
  `).get(tenantId, report.id, tenantId, report.created_at) as any;
  return { since: row?.at || EPOCH };
}

// Call after the id-offset fix and BEFORE any row is moved/deleted. With `input` (new flow) it
// snapshots the live breakdown and inserts the daily report; without it (legacy client that posted
// /api/reports/daily first) it finds that report and completes it. Returns what to stamp with
// `settlement_id` once the archive copies exist (see finishSettlement).
export function beginSettlement(tenantId: number, userId: number | null, date: string, input: SettlementInput | null): SettlementContext {
  const txIds = (db.prepare("SELECT id FROM transactions WHERE tenant_id = ?").all(tenantId) as any[]).map((r) => r.id);
  const cashIds = (db.prepare("SELECT id FROM cash_flow WHERE tenant_id = ?").all(tenantId) as any[]).map((r) => r.id);
  const now = nowStamp();

  if (input) {
    const { actualBalance: opening, since } = lastRegisterClose(tenantId);
    const snap = buildBreakdown(liveSource(tenantId), {
      periodStart: since, periodEnd: now, until: FAR_FUTURE, opening, shifts: liveShifts(tenantId),
    });
    const r = snap.register;
    const counted = input.counted;
    const actual = counted.reduce((s, c) => s + c.amount / c.rate, 0);
    const res = db.prepare(`
      INSERT INTO daily_reports
      (tenant_id, user_id, date, opening_balance, total_sales, total_refunds, total_purchases, total_cash_in, total_cash_out,
       closing_balance, actual_balance, difference, notes, created_at, settled_at, period_start, counted_json, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId, userId, date, r.opening, r.cash_sales, r.cash_refunds, r.cash_purchases, r.cash_in, r.cash_out,
      r.expected, actual, actual - r.expected, input.notes, now, now, since,
      JSON.stringify(counted), JSON.stringify(snap),
    );
    return { reportId: Number(res.lastInsertRowid), txIds, cashIds };
  }

  // Legacy: the old client POSTed /api/reports/daily seconds before calling settlement.
  const recent = db.prepare(`
    SELECT * FROM daily_reports
    WHERE tenant_id = ? AND settled_at IS NULL AND created_at >= datetime('now', '-10 minutes')
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(tenantId) as any;
  if (!recent) return { reportId: null, txIds, cashIds };
  const { since } = closeBefore(tenantId, recent);
  const snap = buildBreakdown(liveSource(tenantId), {
    periodStart: since, periodEnd: now, until: FAR_FUTURE, opening: recent.opening_balance || 0, shifts: liveShifts(tenantId),
  });
  db.prepare("UPDATE daily_reports SET settled_at = ?, period_start = ?, total_refunds = ?, snapshot_json = ? WHERE id = ?")
    .run(now, since, snap.register.cash_refunds, JSON.stringify(snap), recent.id);
  return { reportId: recent.id, txIds, cashIds };
}

// Call once the archive copies exist: stamps the rows this settlement moved.
export function finishSettlement(tenantId: number, ctx: SettlementContext) {
  if (ctx.reportId === null) return;
  const tx = db.prepare("UPDATE archived_transactions SET settlement_id = ? WHERE id = ? AND tenant_id = ?");
  for (const id of ctx.txIds) tx.run(ctx.reportId, id, tenantId);
  const cf = db.prepare("UPDATE archived_cash_flow SET settlement_id = ? WHERE id = ? AND tenant_id = ?");
  for (const id of ctx.cashIds) cf.run(ctx.reportId, id, tenantId);
}

// ---------------------------------------------------------------------------------------------
// Reading a settlement back
// ---------------------------------------------------------------------------------------------

function parseJson<T>(text: any): T | null {
  if (!text || typeof text !== "string") return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

// Counted cash of a report as originally recorded. Reports closed before counted_json existed only
// have the text "[Breakdown: 120 USD, 500000 LBP]" in their notes (and one USD total).
function originalCounted(tenantId: number, report: any): { lines: CountedLine[]; legacy: boolean } {
  const stored = parseJson<CountedLine[]>(report.counted_json);
  if (stored) return { lines: stored, legacy: false };
  const m = /\[Breakdown:\s*([^\]]+)\]/i.exec(report.notes || "");
  const lines: CountedLine[] = [];
  if (m) {
    for (const part of m[1].split(",")) {
      const mm = /^\s*(-?[\d.]+)\s+([A-Za-z]{2,6})\s*$/.exec(part.replace(/(\d),(?=\d{3}\b)/g, "$1"));
      if (!mm) continue;
      const currency = mm[2].toUpperCase();
      const rate = currencyRate(tenantId, currency) ?? 1;
      lines.push({ currency, amount: Number(mm[1]), rate });
    }
  }
  if (!lines.length) lines.push({ currency: "USD", amount: report.actual_balance || 0, rate: 1 });
  return { lines, legacy: true };
}

const withUsd = (l: CountedLine) => ({ currency: l.currency, amount: l.amount, rate: l.rate, amount_usd: l.amount / l.rate });

function correctionRows(reportId: number): any[] {
  return db.prepare(`
    SELECT c.id, c.kind, c.currency, c.old_value, c.new_value, c.amount_usd, c.reason, c.created_at, u.name as user_name
    FROM settlement_corrections c LEFT JOIN users u ON c.user_id = u.id
    WHERE c.report_id = ? ORDER BY c.id ASC
  `).all(reportId) as any[];
}

// Original count with every 'counted' correction applied in order.
function effectiveCounted(original: CountedLine[], corrections: any[]): CountedLine[] {
  const map = new Map<string, CountedLine>(original.map((l) => [l.currency, { ...l }]));
  for (const c of corrections) {
    if (c.kind !== "counted") continue;
    const line = map.get(c.currency);
    if (line) line.amount = c.new_value;
    else {
      const delta = c.new_value - (c.old_value || 0);
      const rate = c.amount_usd ? delta / c.amount_usd : 1;
      map.set(c.currency, { currency: c.currency, amount: c.new_value, rate: rate > 0 ? rate : 1 });
    }
  }
  return [...map.values()];
}

function effectiveFigures(report: any) {
  const effective_actual = report.corrected_actual_balance ?? report.actual_balance ?? 0;
  const effective_expected = (report.closing_balance || 0) + (report.adjustments_total || 0);
  return { effective_actual, effective_expected, effective_difference: effective_actual - effective_expected };
}

function getPath(obj: any, path: string): number {
  let cur = obj;
  for (const k of path.split(".")) cur = cur?.[k];
  return Number(cur) || 0;
}
const DIFF_PATHS = [
  "sales.total", "sales.by_method.cash", "sales.by_method.card", "sales.by_method.credit", "sales.by_method.store_credit",
  "refunds.total", "purchases.total", "register.expected",
];

function hasLinkedRows(tenantId: number, reportId: number): boolean {
  return !!db.prepare("SELECT 1 FROM archived_transactions WHERE tenant_id = ? AND settlement_id = ? LIMIT 1").get(tenantId, reportId)
    || !!db.prepare("SELECT 1 FROM archived_cash_flow WHERE tenant_id = ? AND settlement_id = ? LIMIT 1").get(tenantId, reportId);
}

function legacyRecorded(report: any): any {
  return {
    legacy: true,
    period_start: report.period_start || null,
    period_end: report.settled_at || report.created_at,
    sales: null, refunds: null, purchases: null, cash_in: null, cash_out: null,
    register: {
      opening: report.opening_balance || 0,
      cash_sales: report.total_sales || 0,
      cash_refunds: report.total_refunds || 0,
      cash_purchases: report.total_purchases || 0,
      cash_in: report.total_cash_in || 0,
      cash_out: report.total_cash_out || 0,
      expected: report.closing_balance || 0,
    },
    shifts: [],
  };
}

function computeChanges(tenantId: number, report: any) {
  const snapshot = parseJson<Breakdown>(report.snapshot_json);
  const linked = hasLinkedRows(tenantId, report.id);
  const empty = { changed: false, diffs: [] as any[], edited_invoices: [] as any[], late_payments: [] as any[] };
  if (!linked) return { rebuilt: null as Breakdown | null, recorded: snapshot, changes: empty };

  const settledAt: string = report.settled_at || FAR_FUTURE;
  let periodStart: string = report.period_start || snapshot?.period_start || "";
  if (!periodStart) {
    const prev = db.prepare("SELECT MAX(created_at) as at FROM daily_reports WHERE tenant_id = ? AND id < ?").get(tenantId, report.id) as any;
    periodStart = prev?.at || EPOCH;
  }
  const opening = snapshot ? snapshot.register.opening : report.opening_balance || 0;
  const rebuilt = buildBreakdown(archivedSource(tenantId, report.id), {
    periodStart, periodEnd: report.settled_at || report.created_at, until: settledAt, opening, shifts: snapshot?.shifts || [],
  });

  const diffs: any[] = [];
  if (snapshot) {
    for (const path of DIFF_PATHS) {
      const rec = getPath(snapshot, path);
      const now = getPath(rebuilt, path);
      if (Math.abs(rec - now) > DIFF_TOLERANCE) diffs.push({ path, recorded: rec, rebuilt: now });
    }
  }

  // Archived invoices of this settlement edited afterwards. (An archived=1 edit row can only exist
  // once the invoice was already archived, so it post-dates the close.)
  const edited = db.prepare(`
    SELECT e.transaction_id, e.created_at as edited_at, e.reason, e.before_json, e.after_json, u.name as user_name
    FROM transaction_edits e
    LEFT JOIN users u ON e.user_id = u.id
    WHERE e.tenant_id = ? AND e.archived = 1
      AND e.transaction_id IN (SELECT id FROM archived_transactions WHERE tenant_id = ? AND settlement_id = ?)
      ${report.settled_at ? "AND e.created_at >= ?" : ""}
    ORDER BY e.id ASC
  `).all(...[tenantId, tenantId, report.id, ...(report.settled_at ? [report.settled_at] : [])]) as any[];
  const edited_invoices = edited.map((e) => ({
    transaction_id: e.transaction_id,
    edited_at: e.edited_at,
    user_name: e.user_name || null,
    reason: e.reason || null,
    before_total: parseJson<any>(e.before_json)?.total_amount ?? null,
    after_total: parseJson<any>(e.after_json)?.total_amount ?? null,
  }));

  const late_payments = report.settled_at
    ? (db.prepare(`
        SELECT p.transaction_id, p.amount / p.exchange_rate as amount_usd, p.method, p.created_at
        FROM archived_payments p JOIN archived_transactions t ON p.transaction_id = t.id
        WHERE t.tenant_id = ? AND t.settlement_id = ? AND p.created_at > ?
        ORDER BY p.created_at ASC, p.id ASC
      `).all(tenantId, report.id, report.settled_at) as any[])
    : [];

  return {
    rebuilt,
    recorded: snapshot,
    changes: { changed: edited_invoices.length > 0 || diffs.length > 0, diffs, edited_invoices, late_payments },
  };
}

export function getSettlementDetail(tenantId: number, reportId: number) {
  const report = db.prepare(`
    SELECT r.*, u.name as user_name FROM daily_reports r LEFT JOIN users u ON r.user_id = u.id
    WHERE r.id = ? AND r.tenant_id = ?
  `).get(reportId, tenantId) as any;
  if (!report) throw new ValidationError("Settlement not found.", 404, { code: "SETTLEMENT_NOT_FOUND" });

  const corrections = correctionRows(report.id);
  const { rebuilt, recorded: snapshot, changes } = computeChanges(tenantId, report);
  const original = originalCounted(tenantId, report);
  const countedCorrections = corrections.filter((c) => c.kind === "counted");
  return {
    report: {
      ...report,
      ...effectiveFigures(report),
      corrections_count: corrections.length,
      changed_after_close: changes.changed,
    },
    recorded: snapshot ? { ...snapshot, legacy: false } : legacyRecorded(report),
    rebuilt,
    counted: original.lines.map(withUsd),
    corrected_counted: countedCorrections.length ? effectiveCounted(original.lines, corrections).map(withUsd) : null,
    changes,
    corrections,
  };
}

// GET /api/reports/daily — every existing column plus the effective figures and flags.
export function listDailyReports(tenantId: number) {
  const reports = db.prepare(`
    SELECT r.*, u.name as user_name FROM daily_reports r LEFT JOIN users u ON r.user_id = u.id
    WHERE r.tenant_id = ? ORDER BY r.date DESC, r.id DESC
  `).all(tenantId) as any[];
  const counts = new Map<number, number>(
    (db.prepare("SELECT report_id, COUNT(*) as c FROM settlement_corrections WHERE tenant_id = ? GROUP BY report_id").all(tenantId) as any[])
      .map((r) => [r.report_id, r.c]),
  );
  return reports.map((r) => ({
    ...r,
    ...effectiveFigures(r),
    corrections_count: counts.get(r.id) || 0,
    changed_after_close: computeChanges(tenantId, r).changes.changed,
  }));
}

// ---------------------------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------------------------

export function addCorrection(tenantId: number, reportId: number, body: any) {
  const report = db.prepare("SELECT * FROM daily_reports WHERE id = ? AND tenant_id = ?").get(reportId, tenantId) as any;
  if (!report) throw new ValidationError("Settlement not found.", 404, { code: "SETTLEMENT_NOT_FOUND" });

  const kind = body?.kind;
  if (kind !== "counted" && kind !== "adjustment") {
    throw new ValidationError("Correction kind must be 'counted' or 'adjustment'.", 400, { code: "CORRECTION_KIND_INVALID", field: "kind" });
  }
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 3) {
    throw new ValidationError("A reason (at least 3 characters) is required.", 400, { code: "CORRECTION_REASON_REQUIRED", field: "reason" });
  }

  // Validate the payload before the PIN so field errors surface while the form is being filled in.
  let newCounted: CountedLine[] = [];
  let adjustment: { currency: string; amount: number; rate: number } | null = null;
  if (kind === "counted") {
    newCounted = normalizeCounted(tenantId, body.counted, "counted", "CORRECTION_AMOUNT_INVALID");
    if (!newCounted.length) {
      throw new ValidationError("Enter the corrected counted cash.", 400, { code: "CORRECTION_AMOUNT_INVALID", field: "counted" });
    }
  } else {
    const amount = Number(body.amount);
    if (body.amount === null || body.amount === undefined || body.amount === "" || !Number.isFinite(amount) || amount === 0) {
      throw new ValidationError("Adjustment amount must be a non-zero number.", 400, { code: "CORRECTION_AMOUNT_INVALID", field: "amount" });
    }
    const currency = typeof body.currency === "string" && body.currency.trim() ? body.currency.trim().toUpperCase() : "USD";
    let rate = Number(body.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      const looked = currencyRate(tenantId, currency);
      if (looked === null) throw new ValidationError("Exchange rate is required.", 400, { code: "CORRECTION_AMOUNT_INVALID", field: "rate" });
      rate = looked;
    }
    adjustment = { currency, amount, rate };
  }

  const admin = findAdminByPin(tenantId, body?.admin_pin);
  if (!admin) throw new ValidationError("Incorrect admin PIN.", 403, { code: "CORRECTION_PIN_INVALID", field: "admin_pin" });

  const created: number[] = [];
  db.transaction(() => {
    const insert = db.prepare(`
      INSERT INTO settlement_corrections (tenant_id, report_id, user_id, kind, currency, old_value, new_value, amount_usd, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    if (kind === "counted") {
      const original = originalCounted(tenantId, report).lines;
      const current = effectiveCounted(original, correctionRows(report.id));
      const rateOf = new Map(current.map((l) => [l.currency, l.rate]));
      const oldOf = new Map(current.map((l) => [l.currency, l.amount]));
      let changed = 0;
      const finalMap = new Map(current.map((l) => [l.currency, { ...l }]));
      newCounted.forEach((n) => {
        const oldAmount = oldOf.get(n.currency) ?? 0;
        if (Math.abs(oldAmount - n.amount) < 1e-9) return;
        const rate = rateOf.get(n.currency) ?? n.rate;
        changed++;
        created.push(Number(insert.run(tenantId, report.id, admin.id, "counted", n.currency, oldAmount, n.amount, (n.amount - oldAmount) / rate, reason).lastInsertRowid));
        finalMap.set(n.currency, { currency: n.currency, amount: n.amount, rate });
      });
      if (!changed) {
        throw new ValidationError("The corrected count is the same as the current count.", 400, { code: "CORRECTION_AMOUNT_INVALID", field: "counted" });
      }
      const corrected = [...finalMap.values()].reduce((s, l) => s + l.amount / l.rate, 0);
      db.prepare("UPDATE daily_reports SET corrected_actual_balance = ? WHERE id = ? AND tenant_id = ?").run(corrected, report.id, tenantId);
    } else {
      const a = adjustment!;
      const usd = a.amount / a.rate;
      created.push(Number(insert.run(tenantId, report.id, admin.id, "adjustment", a.currency, 0, a.amount, usd, reason).lastInsertRowid));
      db.prepare("UPDATE daily_reports SET adjustments_total = IFNULL(adjustments_total, 0) + ? WHERE id = ? AND tenant_id = ?").run(usd, report.id, tenantId);
    }
  })();

  const fresh = db.prepare("SELECT * FROM daily_reports WHERE id = ?").get(report.id) as any;
  const detail = kind === "counted"
    ? `counted cash on report #${report.id}`
    : `adjustment ${adjustment!.amount} ${adjustment!.currency} on report #${report.id}`;
  logAction(tenantId, admin.id, "Settlement Corrected", `${detail}. Reason: ${reason}`);
  return {
    success: true,
    report_id: report.id,
    corrections: correctionRows(report.id).filter((c) => created.includes(c.id)),
    ...effectiveFigures(fresh),
    corrected_actual_balance: fresh.corrected_actual_balance ?? null,
    adjustments_total: fresh.adjustments_total || 0,
  };
}

export function setupSettlementRoutes(app: any, authenticate: any, broadcast: Function) {
  app.get("/api/settlements/:reportId", authenticate, (req: any, res: any) => {
    try {
      res.json(getSettlementDetail(req.session.tenantId, Number(req.params.reportId)));
    } catch (err: any) {
      if (err instanceof ValidationError) return res.status(err.status).json(validationErrorBody(err));
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/settlements/:reportId/corrections", authenticate, (req: any, res: any) => {
    const tenantId = req.session.tenantId;
    try {
      const result = addCorrection(tenantId, Number(req.params.reportId), req.body || {});
      broadcast({ type: "CASH_FLOW_UPDATED" }, tenantId);
      broadcast({ type: "SETTLEMENT_UPDATED" }, tenantId);
      res.json(result);
    } catch (err: any) {
      if (err instanceof ValidationError) return res.status(err.status).json(validationErrorBody(err));
      res.status(500).json({ error: err.message });
    }
  });
}
