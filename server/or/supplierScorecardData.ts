import { db } from '../db.js';
import { loadOpenPayablesReceivables } from './payablesData.js';
import { buildSupplierScorecards, supplierComparisons, type SupplierProfile, type PurchasePrice, type PurchaseTotal, type Delivery } from './supplierScorecard.js';

export function loadSupplierScorecards(tenantId: number, now = new Date()) {
  const profiles = db.prepare(`SELECT s.id, s.name, p.fill_rate_score, p.payment_terms_days
    FROM stakeholders s LEFT JOIN or_supplier_profiles p ON p.tenant_id = s.tenant_id AND p.supplier_id = s.id AND p.deleted_at IS NULL
    WHERE s.tenant_id = ? AND s.type = 'supplier' AND s.deleted_at IS NULL ORDER BY s.name, s.id`).all(tenantId) as SupplierProfile[];
  const prices = db.prepare(`SELECT t.stakeholder_id AS supplier_id, ti.product_id AS product_id, p.name AS product_name,
      t.created_at AS date, ti.quantity AS quantity, COALESCE(ti.unit_cost, ti.unit_price) AS price
    FROM transactions t JOIN transaction_items ti ON ti.transaction_id = t.id
    JOIN products p ON p.id = ti.product_id AND p.tenant_id = t.tenant_id
    WHERE t.tenant_id = ? AND t.type = 'purchase' AND t.deleted_at IS NULL
    UNION ALL
    SELECT t.stakeholder_id, ti.product_id, p.name, t.created_at, ti.quantity, COALESCE(ti.unit_cost, ti.unit_price)
    FROM archived_transactions t JOIN archived_transaction_items ti ON ti.transaction_id = t.id
    JOIN products p ON p.id = ti.product_id AND p.tenant_id = t.tenant_id
    WHERE t.tenant_id = ? AND t.type = 'purchase' ORDER BY date, product_id`).all(tenantId, tenantId) as PurchasePrice[];
  const totals = db.prepare(`SELECT stakeholder_id AS supplier_id, created_at AS date, total_amount AS amount
    FROM transactions WHERE tenant_id = ? AND type = 'purchase' AND deleted_at IS NULL
    UNION ALL SELECT stakeholder_id, created_at, total_amount FROM archived_transactions WHERE tenant_id = ? AND type = 'purchase'`).all(tenantId, tenantId) as PurchaseTotal[];
  // settled_at records final receipt; otherwise use the recorded linked purchase receipt, including archived receipts.
  const deliveries = db.prepare(`SELECT c.supplier_id, c.expected_delivery_date AS expected,
      COALESCE(c.settled_at, t.created_at, a.created_at) AS received
    FROM or_po_commitments c
    LEFT JOIN transactions t ON t.id = c.core_transaction_id AND t.tenant_id = c.tenant_id AND t.deleted_at IS NULL
    LEFT JOIN archived_transactions a ON a.id = c.core_transaction_id AND a.tenant_id = c.tenant_id
    WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND c.status IN ('PARTIALLY_RECEIVED', 'SETTLED')
      AND COALESCE(c.settled_at, t.created_at, a.created_at) IS NOT NULL`).all(tenantId) as Delivery[];
  return buildSupplierScorecards(profiles, prices, totals, deliveries, loadOpenPayablesReceivables(tenantId).payables, now);
}
export function readSupplierScorecard(tenantId: number, supplierId?: number) {
  const suppliers = loadSupplierScorecards(tenantId);
  return { suppliers: supplierId === undefined ? suppliers : suppliers.filter(s => s.id === supplierId), comparisons: supplierComparisons(suppliers) };
}
