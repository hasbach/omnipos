import { db } from '../db.js';
import { matchLine, normalizeName } from './match.js';
import { scanInvoice, ScanError } from './claude.js';
export function saveMappings(tenantId: number, supplierId: number, lines: Array<{ name: string; product_id: number }>) {
  if (!db.prepare("SELECT id FROM stakeholders WHERE tenant_id = ? AND id = ? AND type = 'supplier' AND deleted_at IS NULL").get(tenantId, supplierId)) throw new ScanError('scan_invalid_mapping');
  if (!Array.isArray(lines) || !lines.length || lines.length > 500 || !lines.every(l => l && typeof l.name === 'string' && normalizeName(l.name) && db.prepare('SELECT id FROM products WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(tenantId, l.product_id))) throw new ScanError('scan_invalid_mapping');
  db.transaction(() => {
    const save = db.prepare(`INSERT INTO supplier_item_mappings (tenant_id, supplier_id, normalized_item_name, product_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(tenant_id, supplier_id, normalized_item_name) DO UPDATE SET product_id = excluded.product_id, updated_at = CURRENT_TIMESTAMP`);
    for (const l of lines) save.run(tenantId, supplierId, normalizeName(l.name), l.product_id);
  })();
}
export function setupPurchaseScanRoutes(app: any, authenticate: any) {
  app.get('/api/purchase-scan/key', authenticate, (req: any, res: any) => {
    const row = db.prepare("SELECT value FROM local_tenant_settings WHERE tenant_id = ? AND key = 'anthropic_api_key'").get(req.session.tenantId) as any;
    res.json({ set: !!row?.value });
  });
  app.post('/api/purchase-scan/key', authenticate, (req: any, res: any) => {
    if (typeof req.body.key !== 'string' || req.body.key.length > 500) return res.status(400).json({ error: 'scan_invalid_key' });
    db.prepare("INSERT OR REPLACE INTO local_tenant_settings (tenant_id, key, value) VALUES (?, 'anthropic_api_key', ?)").run(req.session.tenantId, req.body.key.trim());
    res.json({ set: !!req.body.key.trim() });
  });
  app.post('/api/purchase-scan/mappings', authenticate, (req: any, res: any) => {
    try { saveMappings(req.session.tenantId, req.body.supplier_id, req.body.lines); res.json({ ok: true }); }
    catch { res.status(400).json({ error: 'scan_invalid_mapping' }); }
  });
  app.post('/api/purchase-scan', authenticate, async (req: any, res: any) => {
    try {
      const tenant = req.session.tenantId;
      const key = db.prepare("SELECT value FROM local_tenant_settings WHERE tenant_id = ? AND key = 'anthropic_api_key'").get(tenant) as any;
      const invoice = await scanInvoice(key?.value || '', req.body.media_type, req.body.data);
      const suppliers = db.prepare("SELECT id, name FROM stakeholders WHERE tenant_id = ? AND type = 'supplier' AND deleted_at IS NULL").all(tenant) as any[];
      const supplier = suppliers.find(s => normalizeName(s.name) === normalizeName(invoice.supplier_name));
      const memory = Object.fromEntries((db.prepare('SELECT normalized_item_name, product_id FROM supplier_item_mappings WHERE tenant_id = ? AND supplier_id = ?').all(tenant, supplier?.id || 0) as any[]).map(m => [m.normalized_item_name, m.product_id]));
      const products = db.prepare('SELECT id, name, barcode FROM products WHERE tenant_id = ? AND deleted_at IS NULL AND COALESCE(is_bundle, 0) = 0').all(tenant) as any[];
      const barcodes = db.prepare('SELECT b.product_id, b.barcode FROM product_barcodes b JOIN products p ON p.id = b.product_id WHERE p.tenant_id = ? AND b.deleted_at IS NULL').all(tenant) as any[];
      products.forEach(p => { p.barcodes = barcodes.filter(b => b.product_id === p.id).map(b => b.barcode); });
      res.json({ ...invoice, supplier_id: supplier?.id || null, lines: invoice.lines.map(l => ({ ...l, candidates: matchLine(l, products, memory) })) });
    } catch (e) {
      if (!(e instanceof ScanError)) console.error('[purchase-scan]', e);
      const err = e instanceof ScanError ? e : new ScanError('scan_failed', 500);
      res.status(err.status).json({ error: err.code, code: err.code });
    }
  });
}
