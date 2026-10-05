// Data import wizard backend (docs/plans/2026-09-28-import-wizard.md). One route,
// POST /api/import/:entity, shared by products/customers/suppliers. The client (xlsx-parsed sheet
// -> canonical column keys) always calls with dry_run:true first for a full preview, then again
// with dry_run:false to actually write. Both calls return the exact same body shape so the UI can
// reuse one renderer; a real run with any row error writes nothing (422, all-or-nothing).
//
// Error/warning `code`s are stable, English-free identifiers — the UI is responsible for
// translating them for display. `message` is a plain-English fallback for logs/CSV export.
import { db, logAction } from "./db.js";
import { recomputeStakeholderBalance, writeBalanceLog } from "./balance.js";

type Entity = "products" | "customers" | "suppliers";
type Mode = "create_only" | "upsert";
type Action = "create" | "update" | "skip" | "error";

interface RowError { row: number; field?: string; message: string; code: string; }
interface RowWarning { row: number; field?: string; message: string; code: string; }
interface RowResult { row: number; action: Action; id?: number; key?: string; }

interface ImportBody {
  entity: Entity;
  dry_run: boolean;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: RowError[];
  warnings: RowWarning[];
  results: RowResult[];
}

const MAX_ROWS = 20000;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

const INVALID = Symbol("invalid-number");

// Accepts "1,234.50", "1234,5" (single comma, no dot -> decimal), "$ 3.00", "LL 90,000",
// "ل.ل 90,000". Returns null for an empty cell, a finite number for a valid one, or the INVALID
// sentinel when the cell has content that isn't a usable number.
function parseNumber(raw: any): number | null | typeof INVALID {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : INVALID;
  let s = String(raw).trim();
  if (s === "") return null;

  // Strip known currency markers first (before generic stripping) so an embedded "." inside
  // "ل.ل" doesn't get mistaken for a decimal point.
  s = s.replace(/ل\.?ل\.?/g, "");
  s = s.replace(/USD|LBP|LL/gi, "");
  s = s.replace(/\$/g, "");
  // Drop any remaining letters (Latin or Arabic) and whitespace.
  s = s.replace(/[a-zA-Z؀-ۿ]/g, "").replace(/\s+/g, "");
  if (s === "") return null;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    s = s.replace(/,/g, ""); // comma = thousands separator, dot = decimal
  } else if (hasComma && !hasDot) {
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length !== 3) {
      // single comma, not a 3-digit group -> decimal separator (e.g. "12,5" -> 12.5)
      s = parts.join(".");
    } else {
      // multiple commas, or a 3-digit group -> thousands separators (e.g. "90,000" -> 90000)
      s = s.replace(/,/g, "");
    }
  }
  if (s === "" || s === "-" || s === ".") return INVALID;
  const n = Number(s);
  return Number.isFinite(n) ? n : INVALID;
}

const YES_WORDS = new Set(["yes", "y", "1", "true", "نعم", "oui"]);
const NO_WORDS = new Set(["no", "n", "0", "false", "لا", "non"]);

// Returns `def` for an empty cell, true/false for a recognized alias, or INVALID for garbage.
function parseBoolean(raw: any, def: boolean): boolean | typeof INVALID {
  if (raw === undefined || raw === null) return def;
  const s = String(raw).trim().toLowerCase();
  if (s === "") return def;
  if (YES_WORDS.has(s)) return true;
  if (NO_WORDS.has(s)) return false;
  return INVALID;
}

type PriceLevelValue = "retail" | "wholesale" | "super_wholesale";
const PRICE_LEVEL_ALIASES: Record<string, PriceLevelValue> = {
  retail: "retail", "مفرق": "retail", "détail": "retail", "detail": "retail",
  wholesale: "wholesale", "جملة": "wholesale", "gros": "wholesale",
  super_wholesale: "super_wholesale", "super wholesale": "super_wholesale", "superwholesale": "super_wholesale",
  "جملة الجملة": "super_wholesale", "super gros": "super_wholesale",
};

// Returns null for an empty cell, a recognized level, or INVALID for garbage.
function parsePriceLevel(raw: any): PriceLevelValue | null | typeof INVALID {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  const key = s.toLowerCase();
  return PRICE_LEVEL_ALIASES[s] ?? PRICE_LEVEL_ALIASES[key] ?? INVALID;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A cell counts as "present" for the update-only-present-columns rule when the key exists on the
// row AND, once stringified/trimmed, isn't empty. Absent keys and blank cells both mean "leave
// this column alone" on an update.
function present(row: Record<string, any>, key: string): boolean {
  if (!(key in row)) return false;
  const v = row[key];
  if (v === undefined || v === null) return false;
  if (typeof v === "string" && v.trim() === "") return false;
  return true;
}

function splitBarcodes(raw: any): string[] {
  if (raw === undefined || raw === null) return [];
  return String(raw)
    .split(/[,;|]/)
    .map((b) => b.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function setupImportRoutes(app: any, authenticate: any, broadcast: Function) {
  app.post("/api/import/:entity", authenticate, (req: any, res: any) => {
    const tenantId = req.session.tenantId;
    const entity = req.params.entity as Entity;
    if (!["products", "customers", "suppliers"].includes(entity)) {
      return res.status(400).json({ error: "Unknown import entity.", code: "INVALID_ENTITY" });
    }
    const mode: Mode = req.body?.mode === "create_only" ? "create_only" : "upsert";
    const dryRun = req.body?.dry_run !== false;
    const rows = req.body?.rows;
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: "rows must be an array.", code: "INVALID_ROWS" });
    }
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ error: `Too many rows (max ${MAX_ROWS}).`, code: "TOO_MANY_ROWS" });
    }

    const userId = resolveUserId(tenantId, req.body?.user_id);

    const body: ImportBody =
      entity === "products"
        ? planProducts(tenantId, rows, mode)
        : planStakeholders(tenantId, rows, mode, entity === "customers" ? "customer" : "supplier");

    body.dry_run = dryRun;
    const hasErrors = body.errors.length > 0;

    if (dryRun) {
      delete (body as any).__plans;
      return res.json(body);
    }
    if (hasErrors) {
      delete (body as any).__plans;
      return res.status(422).json(body);
    }

    try {
      const run = db.transaction(() => {
        if (entity === "products") {
          executeProducts(tenantId, userId, body);
        } else {
          executeStakeholders(tenantId, userId, body);
        }
      });
      run();
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Import failed." });
    }

    logAction(
      tenantId,
      userId,
      "Data Import",
      `${entity}: +${body.created} created ~${body.updated} updated`
    );
    if (entity === "products") {
      broadcast({ type: "PRODUCTS_UPDATED" }, tenantId);
    } else {
      broadcast({ type: "STAKEHOLDERS_UPDATED" }, tenantId);
    }

    res.json(body);
  });
}

// Mirrors tenantUserId() in server/routes.ts (not exported from there) — resolves a user_id that
// is guaranteed to belong to this tenant, falling back to the tenant's first/admin user.
function resolveUserId(tenantId: number, requested: any): number | null {
  if (requested) {
    const u = db.prepare("SELECT id FROM users WHERE id = ? AND tenant_id = ?").get(requested, tenantId) as any;
    if (u) return u.id;
  }
  const first = db.prepare("SELECT id FROM users WHERE tenant_id = ? ORDER BY (role = 'admin') DESC, id LIMIT 1").get(tenantId) as any;
  return first ? first.id : null;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

interface ProductPlanRow {
  row: number;
  action: Action;
  key?: string;
  existingId?: number;
  data?: {
    name: string;
    barcode: string | null;
    extraBarcodes: string[];
    category: string;
    unit: string;
    cost: number | null;
    price: number;
    price_lbp: number | null;
    price_wholesale: number | null;
    price_wholesale_lbp: number | null;
    price_super_wholesale: number | null;
    price_super_wholesale_lbp: number | null;
    package_price: number | null;
    package_price_lbp: number | null;
    units_per_package: number;
    package_barcode: string | null;
    min_price: number | null;
    stock: number;
    reorder_point: number;
    track_inventory: boolean;
    active: boolean;
  };
  presentFields?: Set<string>;
}

function findProductByBarcode(tenantId: number, barcode: string): any {
  const byPrimary = db.prepare("SELECT * FROM products WHERE tenant_id = ? AND barcode = ?").get(tenantId, barcode);
  if (byPrimary) return byPrimary;
  return db
    .prepare(
      "SELECT p.* FROM product_barcodes pb JOIN products p ON p.id = pb.product_id WHERE pb.barcode = ? AND p.tenant_id = ?"
    )
    .get(barcode, tenantId);
}

// A live unit-of-measure (pack/carton) row holding this barcode in the tenant, or undefined.
function findUnitByBarcode(tenantId: number, barcode: string): any {
  return db
    .prepare("SELECT * FROM product_units WHERE tenant_id = ? AND barcode = ? AND deleted_at IS NULL")
    .get(tenantId, barcode);
}

// package_price / units_per_package also maintain a unit named "Pack" (a live unit of the same factor
// is updated, else one is inserted) on top of the legacy columns. Reads the product's CURRENT legacy
// values so an update that only touched some of the columns still resolves the right factor/price.
// `barcode` undefined leaves an existing unit's barcode untouched.
function upsertPackUnit(tenantId: number, productId: number, barcode: string | null | undefined) {
  const p = db.prepare("SELECT package_price, package_price_lbp, units_per_package FROM products WHERE id = ? AND tenant_id = ?").get(productId, tenantId) as any;
  if (!(p && p.package_price > 0 && p.units_per_package > 1)) return;
  const existing = db.prepare(
    "SELECT id FROM product_units WHERE tenant_id = ? AND product_id = ? AND deleted_at IS NULL AND ABS(factor - ?) < 0.000000001"
  ).get(tenantId, productId, p.units_per_package) as any;
  if (existing) {
    if (barcode !== undefined) {
      db.prepare("UPDATE product_units SET price = ?, price_lbp = ?, barcode = ? WHERE id = ?").run(p.package_price, p.package_price_lbp ?? null, barcode, existing.id);
    } else {
      db.prepare("UPDATE product_units SET price = ?, price_lbp = ? WHERE id = ?").run(p.package_price, p.package_price_lbp ?? null, existing.id);
    }
  } else {
    const count = (db.prepare("SELECT COUNT(*) as n FROM product_units WHERE tenant_id = ? AND product_id = ? AND deleted_at IS NULL").get(tenantId, productId) as any).n;
    db.prepare(
      "INSERT INTO product_units (tenant_id, product_id, name, factor, barcode, price, price_lbp, sort_order) VALUES (?, ?, 'Pack', ?, ?, ?, ?, ?)"
    ).run(tenantId, productId, p.units_per_package, barcode ?? null, p.package_price, p.package_price_lbp ?? null, count);
  }
}

function findProductByName(tenantId: number, name: string): any {
  return db
    .prepare("SELECT * FROM products WHERE tenant_id = ? AND LOWER(name) = LOWER(?)")
    .get(tenantId, name);
}

const NUMERIC_PRODUCT_FIELDS: Array<[string, string]> = [
  ["cost", "cost"],
  ["price", "price"],
  ["price_lbp", "price_lbp"],
  ["price_wholesale", "price_wholesale"],
  ["price_wholesale_lbp", "price_wholesale_lbp"],
  ["price_super_wholesale", "price_super_wholesale"],
  ["price_super_wholesale_lbp", "price_super_wholesale_lbp"],
  ["package_price", "package_price"],
  ["package_price_lbp", "package_price_lbp"],
  ["min_price", "min_price"],
];

function planProducts(tenantId: number, rows: any[], mode: Mode): ImportBody {
  const errors: RowError[] = [];
  const warnings: RowWarning[] = [];
  const results: RowResult[] = [];
  const plans: ProductPlanRow[] = [];

  const seenBarcodes = new Map<string, number>(); // barcode -> row #
  const seenNames = new Map<string, number>(); // lowercased name -> row # (only for barcode-less rows)

  let created = 0, updated = 0, skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 1;
    const raw = rows[i] || {};

    const errorOut = (message: string, code: string, field?: string) => {
      errors.push({ row: rowNum, field, message, code });
      results.push({ row: rowNum, action: "error" });
      plans.push({ row: rowNum, action: "error" });
    };

    // --- required fields -------------------------------------------------
    const name = typeof raw.name === "string" ? raw.name.trim() : (raw.name != null ? String(raw.name).trim() : "");
    const hasAnyBarcode = !!(raw.barcode != null && String(raw.barcode).trim()) || splitBarcodes(raw.barcodes).length > 0;
    if (!name && !hasAnyBarcode) { errorOut("Product name or barcode is required.", "MISSING_REQUIRED", "name"); continue; }
    if (name.length > 200) { errorOut("Product name is too long (max 200 characters).", "TOO_LONG", "name"); continue; }

    const priceParsed = parseNumber(raw.price);
    if (priceParsed === INVALID) { errorOut("Price is not a valid number.", "INVALID_NUMBER", "price"); continue; }
    if (priceParsed !== null && priceParsed < 0) { errorOut("Price cannot be negative.", "INVALID_NUMBER", "price"); continue; }

    // --- numeric fields ----------------------------------------------------
    const numericValues: Record<string, number | null> = { price: priceParsed };
    let numericFailed = false;
    for (const [field] of NUMERIC_PRODUCT_FIELDS) {
      if (field === "price") continue;
      const parsed = parseNumber(raw[field]);
      if (parsed === INVALID) { errorOut(`${field} is not a valid number.`, "INVALID_NUMBER", field); numericFailed = true; break; }
      if (parsed !== null && parsed < 0) { errorOut(`${field} cannot be negative.`, "INVALID_NUMBER", field); numericFailed = true; break; }
      numericValues[field] = parsed;
    }
    if (numericFailed) continue;

    const unitsPerPackageParsed = parseNumber(raw.units_per_package);
    if (unitsPerPackageParsed === INVALID) { errorOut("units_per_package is not a valid number.", "INVALID_NUMBER", "units_per_package"); continue; }
    if (unitsPerPackageParsed !== null && unitsPerPackageParsed < 1) { errorOut("units_per_package must be at least 1.", "INVALID_NUMBER", "units_per_package"); continue; }
    const unitsPerPackage = unitsPerPackageParsed ? Math.trunc(unitsPerPackageParsed) : 1;

    const stockParsed = parseNumber(raw.stock);
    if (stockParsed === INVALID) { errorOut("Stock is not a valid number.", "INVALID_NUMBER", "stock"); continue; }
    const stock = stockParsed ?? 0;

    const reorderParsed = parseNumber(raw.reorder_point);
    if (reorderParsed === INVALID) { errorOut("reorder_point is not a valid number.", "INVALID_NUMBER", "reorder_point"); continue; }
    if (reorderParsed !== null && reorderParsed < 0) { errorOut("reorder_point cannot be negative.", "INVALID_NUMBER", "reorder_point"); continue; }
    const reorderPoint = reorderParsed ?? 0;

    const trackInventoryParsed = parseBoolean(raw.track_inventory, true);
    if (trackInventoryParsed === INVALID) { errorOut("track_inventory must be yes/no.", "INVALID_VALUE", "track_inventory"); continue; }

    const activeParsed = parseBoolean(raw.active, true);
    if (activeParsed === INVALID) { errorOut("active must be yes/no.", "INVALID_VALUE", "active"); continue; }

    // --- barcodes ------------------------------------------------------
    const primaryBarcode = typeof raw.barcode === "string" ? raw.barcode.trim() : (raw.barcode != null ? String(raw.barcode).trim() : "");
    const extraBarcodesRaw = splitBarcodes(raw.barcodes);
    const allBarcodes = Array.from(new Set([primaryBarcode, ...extraBarcodesRaw].filter(Boolean)));

    // --- duplicate-in-file check ----------------------------------------
    let dup = false;
    for (const bc of allBarcodes) {
      const key = bc.toLowerCase();
      if (seenBarcodes.has(key)) { errorOut(`Barcode "${bc}" is duplicated in this file (row ${seenBarcodes.get(key)}).`, "DUPLICATE_IN_FILE", "barcode"); dup = true; break; }
    }
    if (dup) continue;
    if (allBarcodes.length === 0) {
      const nameKey = name.toLowerCase();
      if (seenNames.has(nameKey)) { errorOut(`Product name is duplicated in this file (row ${seenNames.get(nameKey)}).`, "DUPLICATE_IN_FILE", "name"); continue; }
    }

    // --- matching --------------------------------------------------------
    let existing: any = null;
    if (allBarcodes.length > 0) {
      for (const bc of allBarcodes) {
        const found = findProductByBarcode(tenantId, bc);
        if (found) { existing = found; break; }
      }
    } else {
      existing = findProductByName(tenantId, name);
    }

    // Creating a product needs a name and a retail price; updating one (matched above) needs neither.
    if (!existing) {
      if (!name) { errorOut("Product name is required for a new product.", "MISSING_REQUIRED", "name"); continue; }
      if (priceParsed === null) { errorOut("Price is required for a new product.", "MISSING_REQUIRED", "price"); continue; }
    }

    // --- barcode conflicts -------------------------------------------------
    let barcodeTaken = false;
    for (const bc of allBarcodes) {
      const owner = findProductByBarcode(tenantId, bc);
      if (owner && (!existing || owner.id !== existing.id)) {
        errorOut(`Barcode "${bc}" is already used by another product.`, "BARCODE_TAKEN", "barcode");
        barcodeTaken = true;
        break;
      }
      // A pack/carton barcode can never double as a product barcode.
      if (findUnitByBarcode(tenantId, bc)) {
        errorOut(`Barcode "${bc}" is already used by a pack/carton unit.`, "BARCODE_TAKEN", "barcode");
        barcodeTaken = true;
        break;
      }
    }
    if (barcodeTaken) continue;

    // --- pack barcode (the "Pack" unit created from package_price / units_per_package) --------------
    const packBarcode = present(raw, "package_barcode") ? String(raw.package_barcode).trim() : "";
    if (packBarcode) {
      const packKey = packBarcode.toLowerCase();
      if (seenBarcodes.has(packKey)) { errorOut(`Barcode "${packBarcode}" is duplicated in this file (row ${seenBarcodes.get(packKey)}).`, "DUPLICATE_IN_FILE", "package_barcode"); continue; }
      if (allBarcodes.some((b) => b.toLowerCase() === packKey) || findProductByBarcode(tenantId, packBarcode)) {
        errorOut(`Barcode "${packBarcode}" is already used by a product.`, "BARCODE_TAKEN", "package_barcode"); continue;
      }
      const unitOwner = findUnitByBarcode(tenantId, packBarcode);
      if (unitOwner && !(existing && unitOwner.product_id === existing.id && Math.abs(unitOwner.factor - unitsPerPackage) < 1e-9)) {
        errorOut(`Barcode "${packBarcode}" is already used by another pack/carton unit.`, "BARCODE_TAKEN", "package_barcode"); continue;
      }
      const effPackPrice = numericValues.package_price ?? existing?.package_price ?? null;
      const effPerPack = unitsPerPackageParsed ? unitsPerPackage : (existing?.units_per_package ?? 1);
      if (!(effPackPrice > 0 && effPerPack > 1)) {
        errorOut("package_barcode needs a package price and units per package greater than 1.", "MISSING_REQUIRED", "package_barcode"); continue;
      }
    }

    // register file-level keys now that this row is otherwise valid
    for (const bc of allBarcodes) seenBarcodes.set(bc.toLowerCase(), rowNum);
    if (packBarcode) seenBarcodes.set(packBarcode.toLowerCase(), rowNum);
    if (allBarcodes.length === 0 && name) seenNames.set(name.toLowerCase(), rowNum);

    const data = {
      name: name || existing?.name || "",
      barcode: primaryBarcode || null,
      extraBarcodes: extraBarcodesRaw.filter((b) => b !== primaryBarcode),
      category: present(raw, "category") ? String(raw.category).trim() : "General",
      unit: present(raw, "unit") ? String(raw.unit).trim() : "pcs",
      cost: numericValues.cost ?? null,
      price: (priceParsed ?? existing?.price ?? 0) as number,
      price_lbp: numericValues.price_lbp ?? null,
      price_wholesale: numericValues.price_wholesale ?? null,
      price_wholesale_lbp: numericValues.price_wholesale_lbp ?? null,
      price_super_wholesale: numericValues.price_super_wholesale ?? null,
      price_super_wholesale_lbp: numericValues.price_super_wholesale_lbp ?? null,
      package_price: numericValues.package_price ?? null,
      package_price_lbp: numericValues.package_price_lbp ?? null,
      units_per_package: unitsPerPackage,
      package_barcode: packBarcode || null,
      min_price: numericValues.min_price ?? null,
      stock,
      reorder_point: reorderPoint,
      track_inventory: trackInventoryParsed as boolean,
      active: activeParsed as boolean,
    };

    // --- warnings ----------------------------------------------------------
    const effCost = data.cost ?? existing?.cost ?? null;
    const effMin = data.min_price ?? existing?.min_price ?? null;
    if (effCost != null && data.price < effCost) {
      warnings.push({ row: rowNum, field: "price", message: "Price is below cost.", code: "BELOW_COST" });
    }
    if (data.price_wholesale != null && data.price_wholesale > data.price) {
      warnings.push({ row: rowNum, field: "price_wholesale", message: "Wholesale price is above retail price.", code: "TIER_ABOVE_RETAIL" });
    }
    if (data.price_super_wholesale != null && data.price_super_wholesale > data.price) {
      warnings.push({ row: rowNum, field: "price_super_wholesale", message: "Super-wholesale price is above retail price.", code: "TIER_ABOVE_RETAIL" });
    }
    if (effMin != null && data.price < effMin) {
      warnings.push({ row: rowNum, field: "price", message: "Price is below the minimum price.", code: "BELOW_MIN" });
    }

    const presentFields = new Set<string>();
    for (const [field] of NUMERIC_PRODUCT_FIELDS) if (present(raw, field)) presentFields.add(field);
    if (present(raw, "category")) presentFields.add("category");
    if (present(raw, "unit")) presentFields.add("unit");
    if (present(raw, "units_per_package")) presentFields.add("units_per_package");
    if (present(raw, "package_barcode")) presentFields.add("package_barcode");
    if (present(raw, "reorder_point")) presentFields.add("reorder_point");
    if (present(raw, "track_inventory")) presentFields.add("track_inventory");
    if (present(raw, "active")) presentFields.add("active");
    if (present(raw, "barcode")) presentFields.add("barcode");
    if (present(raw, "barcodes")) presentFields.add("barcodes");
    if (present(raw, "stock")) presentFields.add("stock");

    if (existing) {
      if (mode === "create_only") {
        warnings.push({ row: rowNum, message: "Product already exists — skipped.", code: "EXISTS" });
        results.push({ row: rowNum, action: "skip", id: existing.id, key: data.barcode || data.name });
        plans.push({ row: rowNum, action: "skip", existingId: existing.id, key: data.barcode || data.name });
        skipped++;
      } else {
        results.push({ row: rowNum, action: "update", id: existing.id, key: data.barcode || data.name });
        plans.push({ row: rowNum, action: "update", existingId: existing.id, data, presentFields, key: data.barcode || data.name });
        updated++;
      }
    } else {
      results.push({ row: rowNum, action: "create", key: data.barcode || data.name });
      plans.push({ row: rowNum, action: "create", data, presentFields, key: data.barcode || data.name });
      created++;
    }
  }

  return {
    entity: "products",
    dry_run: true,
    total: rows.length,
    created,
    updated,
    skipped,
    errors,
    warnings,
    results,
    // @ts-ignore internal, stripped before responding
    __plans: plans,
  } as any;
}

function executeProducts(tenantId: number, userId: number | null, body: ImportBody) {
  const plans: ProductPlanRow[] = (body as any).__plans;
  delete (body as any).__plans;

  const insertProduct = db.prepare(`
    INSERT INTO products (
      tenant_id, barcode, name, price, price_lbp, package_price, package_price_lbp, cost,
      units_per_package, stock, reorder_point, track_inventory, category, unit,
      price_wholesale, price_wholesale_lbp, price_super_wholesale, price_super_wholesale_lbp, min_price, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBarcode = db.prepare("INSERT INTO product_barcodes (product_id, barcode) VALUES (?, ?)");
  const insertAdjustment = db.prepare(
    "INSERT INTO stock_adjustments (tenant_id, product_id, user_id, qty_before, qty_after, delta, reason, unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const updateStock = db.prepare("UPDATE products SET stock = ? WHERE id = ? AND tenant_id = ?");
  const deleteBarcodes = db.prepare("DELETE FROM product_barcodes WHERE product_id = ?");

  for (const plan of plans) {
    if (plan.action === "create" && plan.data) {
      const d = plan.data;
      const result = insertProduct.run(
        tenantId, d.barcode, d.name, d.price, d.price_lbp, d.package_price, d.package_price_lbp, d.cost,
        d.units_per_package, d.stock, d.reorder_point, d.track_inventory ? 1 : 0, d.category, d.unit,
        d.price_wholesale, d.price_wholesale_lbp, d.price_super_wholesale, d.price_super_wholesale_lbp, d.min_price, d.active ? 1 : 0
      );
      const productId = Number(result.lastInsertRowid);
      for (const bc of d.extraBarcodes) {
        try { insertBarcode.run(productId, bc); } catch { /* stray duplicate within row — ignore */ }
      }
      if (d.stock > 0) {
        insertAdjustment.run(tenantId, productId, userId, 0, d.stock, d.stock, "Import: opening stock", d.cost ?? null);
      }
      upsertPackUnit(tenantId, productId, d.package_barcode);
      plan.existingId = productId;
      const rr = body.results.find((r) => r.row === plan.row);
      if (rr) rr.id = productId;
    } else if (plan.action === "update" && plan.data && plan.existingId) {
      const d = plan.data;
      const pf = plan.presentFields!;
      const sets: string[] = [];
      const params: any[] = [];
      const colFor: Record<string, string> = {
        cost: "cost", price: "price", price_lbp: "price_lbp",
        price_wholesale: "price_wholesale", price_wholesale_lbp: "price_wholesale_lbp",
        price_super_wholesale: "price_super_wholesale", price_super_wholesale_lbp: "price_super_wholesale_lbp",
        package_price: "package_price", package_price_lbp: "package_price_lbp",
        min_price: "min_price", category: "category", unit: "unit",
        units_per_package: "units_per_package", reorder_point: "reorder_point", track_inventory: "track_inventory", active: "active",
      };
      for (const field of Object.keys(colFor)) {
        if (pf.has(field)) {
          sets.push(`${colFor[field]} = ?`);
          params.push(field === "track_inventory" ? (d.track_inventory ? 1 : 0) : field === "active" ? (d.active ? 1 : 0) : (d as any)[field]);
        }
      }
      if (pf.has("barcode")) {
        sets.push("barcode = ?");
        params.push(d.barcode);
      }
      if (sets.length > 0) {
        params.push(plan.existingId, tenantId);
        db.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`).run(...params);
      }
      if (["package_price", "package_price_lbp", "units_per_package", "package_barcode"].some((f) => pf.has(f))) {
        upsertPackUnit(tenantId, plan.existingId, pf.has("package_barcode") ? d.package_barcode : undefined);
      }
      if (pf.has("barcodes")) {
        deleteBarcodes.run(plan.existingId);
        for (const bc of d.extraBarcodes) {
          try { insertBarcode.run(plan.existingId, bc); } catch { /* ignore */ }
        }
      }
      if (pf.has("stock")) {
        const current = db.prepare("SELECT stock FROM products WHERE id = ? AND tenant_id = ?").get(plan.existingId, tenantId) as any;
        const qtyBefore = current?.stock || 0;
        const qtyAfter = d.stock;
        if (qtyAfter !== qtyBefore) {
          updateStock.run(qtyAfter, plan.existingId, tenantId);
          const costRow = db.prepare("SELECT cost FROM products WHERE id = ? AND tenant_id = ?").get(plan.existingId, tenantId) as any;
          insertAdjustment.run(tenantId, plan.existingId, userId, qtyBefore, qtyAfter, qtyAfter - qtyBefore, "Import: stock count", d.cost ?? costRow?.cost ?? null);
        }
      }
    }
    // 'skip'/'error' rows: nothing to write.
  }
}

// ---------------------------------------------------------------------------
// Customers / Suppliers
// ---------------------------------------------------------------------------

interface StakeholderPlanRow {
  row: number;
  action: Action;
  key?: string;
  existingId?: number;
  data?: {
    name: string;
    phone: string | null;
    email: string | null;
    address: string | null;
    price_level: PriceLevelValue | null;
    credit_limit: number | null;
    opening_balance: number | null;
  };
  presentFields?: Set<string>;
}

const RESERVED_CUSTOMER_NAMES = new Set(["walk-in customer"]);

function findStakeholder(tenantId: number, type: "customer" | "supplier", name: string, phone: string | null): any {
  if (phone) {
    return db
      .prepare("SELECT * FROM stakeholders WHERE tenant_id = ? AND type = ? AND LOWER(name) = LOWER(?) AND phone = ?")
      .get(tenantId, type, name, phone);
  }
  return db
    .prepare("SELECT * FROM stakeholders WHERE tenant_id = ? AND type = ? AND LOWER(name) = LOWER(?)")
    .get(tenantId, type, name);
}

function hasTransactionHistory(tenantId: number, stakeholderId: number): boolean {
  const live = db.prepare("SELECT 1 FROM transactions WHERE tenant_id = ? AND stakeholder_id = ? LIMIT 1").get(tenantId, stakeholderId);
  if (live) return true;
  const archived = db.prepare("SELECT 1 FROM archived_transactions WHERE tenant_id = ? AND stakeholder_id = ? LIMIT 1").get(tenantId, stakeholderId);
  return !!archived;
}

function planStakeholders(tenantId: number, rows: any[], mode: Mode, type: "customer" | "supplier"): ImportBody {
  const errors: RowError[] = [];
  const warnings: RowWarning[] = [];
  const results: RowResult[] = [];
  const plans: StakeholderPlanRow[] = [];

  const seenNamePhone = new Map<string, number>();
  const seenNameOnly = new Map<string, number>();

  let created = 0, updated = 0, skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 1;
    const raw = rows[i] || {};

    const errorOut = (message: string, code: string, field?: string) => {
      errors.push({ row: rowNum, field, message, code });
      results.push({ row: rowNum, action: "error" });
      plans.push({ row: rowNum, action: "error" });
    };

    const name = typeof raw.name === "string" ? raw.name.trim() : (raw.name != null ? String(raw.name).trim() : "");
    if (!name) { errorOut("Name is required.", "MISSING_REQUIRED", "name"); continue; }
    if (name.length > 200) { errorOut("Name is too long (max 200 characters).", "TOO_LONG", "name"); continue; }

    if (type === "customer" && RESERVED_CUSTOMER_NAMES.has(name.toLowerCase())) {
      errorOut('"Walk-in Customer" is a reserved record and cannot be imported.', "RESERVED_NAME", "name");
      continue;
    }

    const phone = present(raw, "phone") ? String(raw.phone).trim() : null;
    const address = present(raw, "address") ? String(raw.address).trim() : null;
    const email = present(raw, "email") ? String(raw.email).trim() : null;
    if (email && !EMAIL_RE.test(email)) {
      warnings.push({ row: rowNum, field: "email", message: "Email address doesn't look valid.", code: "EMAIL_FORMAT" });
    }

    let priceLevel: PriceLevelValue | null = null;
    if (type === "customer" && present(raw, "price_level")) {
      const parsed = parsePriceLevel(raw.price_level);
      if (parsed === INVALID) { errorOut("price_level is not recognized.", "INVALID_VALUE", "price_level"); continue; }
      priceLevel = parsed;
    }

    const creditLimitParsed = present(raw, "credit_limit") ? parseNumber(raw.credit_limit) : null;
    if (creditLimitParsed === INVALID) { errorOut("credit_limit is not a valid number.", "INVALID_NUMBER", "credit_limit"); continue; }
    if (typeof creditLimitParsed === "number" && creditLimitParsed < 0) { errorOut("credit_limit cannot be negative.", "INVALID_NUMBER", "credit_limit"); continue; }

    const openingBalanceParsed = present(raw, "opening_balance") ? parseNumber(raw.opening_balance) : null;
    if (openingBalanceParsed === INVALID) { errorOut("opening_balance is not a valid number.", "INVALID_NUMBER", "opening_balance"); continue; }

    // --- duplicate-in-file --------------------------------------------------
    const nameKey = name.toLowerCase();
    if (phone) {
      const key = `${nameKey}|${phone}`;
      if (seenNamePhone.has(key)) { errorOut(`This name + phone is duplicated in this file (row ${seenNamePhone.get(key)}).`, "DUPLICATE_IN_FILE"); continue; }
    } else {
      if (seenNameOnly.has(nameKey)) { errorOut(`This name is duplicated in this file (row ${seenNameOnly.get(nameKey)}).`, "DUPLICATE_IN_FILE"); continue; }
    }

    // --- matching ------------------------------------------------------------
    const existing = findStakeholder(tenantId, type, name, phone);

    if (existing && type === "customer" && RESERVED_CUSTOMER_NAMES.has(String(existing.name).toLowerCase())) {
      errorOut('"Walk-in Customer" is a reserved record and cannot be imported.', "RESERVED_NAME", "name");
      continue;
    }

    if (phone) seenNamePhone.set(`${nameKey}|${phone}`, rowNum);
    else seenNameOnly.set(nameKey, rowNum);

    const data = {
      name, phone, email, address,
      price_level: priceLevel,
      credit_limit: creditLimitParsed ?? null,
      opening_balance: openingBalanceParsed ?? null,
    };

    const presentFields = new Set<string>();
    if (present(raw, "phone")) presentFields.add("phone");
    if (present(raw, "email")) presentFields.add("email");
    if (present(raw, "address")) presentFields.add("address");
    if (present(raw, "price_level")) presentFields.add("price_level");
    if (present(raw, "credit_limit")) presentFields.add("credit_limit");
    if (present(raw, "opening_balance")) presentFields.add("opening_balance");

    if (existing) {
      if (mode === "create_only") {
        warnings.push({ row: rowNum, message: "Record already exists — skipped.", code: "EXISTS" });
        results.push({ row: rowNum, action: "skip", id: existing.id, key: name });
        plans.push({ row: rowNum, action: "skip", existingId: existing.id, key: name });
        skipped++;
        continue;
      }
      if (presentFields.has("opening_balance") && hasTransactionHistory(tenantId, existing.id)) {
        errorOut(
          "This party already has transaction history — its balance can't be set from an opening balance. Use a balance payment instead.",
          "HAS_HISTORY",
          "opening_balance"
        );
        continue;
      }
      results.push({ row: rowNum, action: "update", id: existing.id, key: name });
      plans.push({ row: rowNum, action: "update", existingId: existing.id, data, presentFields, key: name });
      updated++;
    } else {
      results.push({ row: rowNum, action: "create", key: name });
      plans.push({ row: rowNum, action: "create", data, presentFields, key: name });
      created++;
    }
  }

  return {
    entity: type === "customer" ? "customers" : "suppliers",
    dry_run: true,
    total: rows.length,
    created,
    updated,
    skipped,
    errors,
    warnings,
    results,
    // @ts-ignore internal, stripped before responding
    __plans: plans,
  } as any;
}

function executeStakeholders(tenantId: number, userId: number | null, body: ImportBody) {
  const plans: StakeholderPlanRow[] = (body as any).__plans;
  delete (body as any).__plans;
  const type: "customer" | "supplier" = body.entity === "customers" ? "customer" : "supplier";

  for (const plan of plans) {
    if (plan.action === "create" && plan.data) {
      const d = plan.data;
      const baseline = d.opening_balance != null ? -d.opening_balance : 0;
      const result = db
        .prepare(
          "INSERT INTO stakeholders (tenant_id, name, type, email, phone, address, balance, balance_baseline, price_level, credit_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(tenantId, d.name, type, d.email, d.phone, d.address, baseline, baseline, d.price_level || "retail", d.credit_limit);
      const id = Number(result.lastInsertRowid);
      plan.existingId = id;
      if (Math.abs(baseline) > 0.0000001) writeBalanceLog(id, tenantId, 0, baseline, { source: 'import', user_id: userId, note: 'Opening balance' });
      const rr = body.results.find((r) => r.row === plan.row);
      if (rr) rr.id = id;
    } else if (plan.action === "update" && plan.data && plan.existingId) {
      const d = plan.data;
      const pf = plan.presentFields!;
      const sets: string[] = [];
      const params: any[] = [];
      if (pf.has("phone")) { sets.push("phone = ?"); params.push(d.phone); }
      if (pf.has("email")) { sets.push("email = ?"); params.push(d.email); }
      if (pf.has("address")) { sets.push("address = ?"); params.push(d.address); }
      if (pf.has("price_level") && d.price_level) { sets.push("price_level = ?"); params.push(d.price_level); }
      if (pf.has("credit_limit")) { sets.push("credit_limit = ?"); params.push(d.credit_limit); }
      if (sets.length > 0) {
        params.push(plan.existingId, tenantId);
        db.prepare(`UPDATE stakeholders SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`).run(...params);
      }
      if (pf.has("opening_balance") && d.opening_balance != null) {
        const baseline = -d.opening_balance;
        db.prepare("UPDATE stakeholders SET balance_baseline = ? WHERE id = ? AND tenant_id = ?").run(baseline, plan.existingId, tenantId);
      }
      recomputeStakeholderBalance(plan.existingId, tenantId, { source: 'import', user_id: userId, note: 'Opening balance import' });
    }
  }
}
