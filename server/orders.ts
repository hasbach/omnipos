import { orderSaleExists } from './orderSale.js';
import { db } from './db.js';
import { getActiveSession } from './session.js';
import { callRpc } from './cloudCall.js';
import { applyCloudRows, getSyncTimes } from './sync.js';
import { permissionsForRole } from './permissions.js';
import { ValidationError, validationErrorBody } from './errors.js';
import { whatsappDigits } from '../storefront/src/phone.js';

const states = ['submitted', 'confirmed', 'ready', 'completed', 'rejected', 'cancelled', 'expired'];
const reasons = ['out_of_stock', 'damaged', 'customer_request', 'other'];
const fail = (code: string, status = 400, field?: string, extra = {}) => new ValidationError(code, status, { code, field, ...extra });
const effectiveState = (o: any) => o.state === 'submitted' && Date.parse(o.expires_at) < Date.now() ? 'expired' : o.state;
const online = (tenantId: number) => getActiveSession()?.localId === tenantId && !getSyncTimes().recentError;
function user(req: any) {
  return db.prepare('SELECT id, name, role FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(req.session.userId ?? null, req.session.tenantId) as any;
}
function can(req: any, permission: string) {
  const u = user(req);
  return u ? permissionsForRole(req.session.tenantId, u.role).includes(permission) : !req.session.locked;
}
function load(tenantId: number, id: any) {
  const o = db.prepare('SELECT * FROM orders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(tenantId, id) as any;
  if (!o) throw fail('ORDER_NOT_FOUND', 404);
  return o;
}
function linesFor(tenantId: number, id: number) {
  return db.prepare('SELECT * FROM order_lines WHERE tenant_id = ? AND order_id = ? AND deleted_at IS NULL ORDER BY line_no').all(tenantId, id) as any[];
}
function saleFor(tenantId: number, globalId: string) {
  return db.prepare('SELECT id, total_amount FROM transactions WHERE tenant_id = ? AND order_global_id = ? UNION ALL SELECT id, total_amount FROM archived_transactions WHERE tenant_id = ? AND order_global_id = ? LIMIT 1').get(tenantId, globalId, tenantId, globalId) || null;
}
export function applyResult(tenantId: number, result: any) {
  const tenant = db.prepare('SELECT global_id FROM tenants WHERE id = ?').get(tenantId) as any;
  db.transaction(() => {
    if (result.order && result.order.tenant_id === tenant.global_id) {
      applyCloudRows(tenantId, 'orders', [result.order]);
      // The cloud's reply omits tenant_id on lines (_order_lines_json): they belong to the order checked above.
      const lines = (result.lines || []).filter((l: any) => l.order_id === result.order.global_id)
        .map((l: any) => ({ ...l, tenant_id: tenant.global_id }));
      applyCloudRows(tenantId, 'order_lines', lines);
    }
  })();
}

export function setupOrderRoutes(app: any, authenticate: any, broadcast: Function) {
  const route = (fn: Function) => async (req: any, res: any) => {
    try { await fn(req, res); }
    catch (e: any) {
      if (e instanceof ValidationError) return res.status(e.status).json(validationErrorBody(e));
      res.status(500).json({ error: e.message });
    }
  };
  app.get('/api/orders', authenticate, route((req: any, res: any) => {
    const tenantId = req.session.tenantId;
    let rows = (db.prepare(`SELECT o.*, s.name store_name, date(o.submitted_at, 'localtime') submitted_date,
      (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id AND l.tenant_id = o.tenant_id AND l.deleted_at IS NULL) line_count
      FROM orders o LEFT JOIN stores s ON s.id = o.store_id AND s.tenant_id = o.tenant_id
      WHERE o.tenant_id = ? AND o.deleted_at IS NULL`).all(tenantId) as any[]).map(o => ({ ...o, effective_state: effectiveState(o) }));
    const { state, store, from, to, q } = req.query;
    rows = rows.filter(o => (!state || o.effective_state === state) && (!store || String(o.store_id) === store)
      && (!from || o.submitted_date >= from) && (!to || o.submitted_date <= to)
      && (!q || [`W-${o.number}`, o.customer_name, o.customer_phone].some(v => String(v || '').toLowerCase().includes(String(q).toLowerCase()))));
    rows.sort((a, b) => (a.effective_state === 'submitted' ? 0 : 1) - (b.effective_state === 'submitted' ? 0 : 1)
      || (a.effective_state === 'submitted' ? Date.parse(a.submitted_at) - Date.parse(b.submitted_at) : Date.parse(b.submitted_at) - Date.parse(a.submitted_at)) || a.id - b.id);
    res.json({ rows: rows.map(o => ({ id: o.id, global_id: o.global_id, store: { id: o.store_id, name: o.store_name }, number: `W-${o.number}`, state: o.state, effective_state: o.effective_state,
      submitted_at: o.submitted_at, customer_name: o.customer_name, customer_phone: o.customer_phone, fulfilment: o.fulfilment, total_usd: o.total_usd, total_local: o.total_local,
      confirmed_total_usd: o.confirmed_total_usd, local_currency: o.local_currency, line_count: o.line_count })), online: online(tenantId), last_pull_at: getSyncTimes().lastPullAt });
  }));
  app.get('/api/orders/summary', authenticate, route((req: any, res: any) => {
    const rows = db.prepare('SELECT state, expires_at FROM orders WHERE tenant_id = ? AND deleted_at IS NULL').all(req.session.tenantId) as any[];
    res.json({ submitted: rows.filter(o => effectiveState(o) === 'submitted').length, open: rows.filter(o => ['submitted', 'confirmed', 'ready'].includes(effectiveState(o))).length });
  }));
  app.get('/api/orders/:id/sale-draft', authenticate, route((req: any, res: any) => {
    const tenantId = req.session.tenantId;
    const order = load(tenantId, req.params.id);
    if (orderSaleExists(tenantId, order.global_id)) throw fail('ORDER_ALREADY_COMPLETED', 409);
    if (!['confirmed', 'ready'].includes(effectiveState(order))) throw fail('ORDER_NOT_COMPLETABLE', 409);
    const lines: any[] = [], skipped: any[] = [], converted: any[] = [];
    for (const line of linesFor(tenantId, order.id)) {
      if (!(line.confirmed_qty > 0)) continue;
      const product = db.prepare('SELECT id FROM products WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
        .get(tenantId, line.product_id);
      if (!product) {
        skipped.push({ line_no: line.line_no, product_name: line.product_name, reason: 'product_deleted' });
        continue;
      }
      const unit = line.unit_key === 'base' ? null : db.prepare('SELECT id FROM product_units WHERE tenant_id = ? AND product_id = ? AND global_id = ? AND deleted_at IS NULL')
        .get(tenantId, line.product_id, line.unit_key) as any;
      const removed = line.unit_key !== 'base' && !unit;
      if (removed) converted.push({ line_no: line.line_no, reason: 'unit_removed' });
      lines.push({ product_id: line.product_id, uom_id: unit?.id ?? null,
        quantity: line.confirmed_qty * (removed ? line.unit_factor : 1),
        unit_price: line.unit_price_usd / (removed ? line.unit_factor : 1) });
    }
    const digits = whatsappDigits(order.customer_phone);
    const customers = db.prepare("SELECT id, name, phone FROM stakeholders WHERE tenant_id = ? AND type = 'customer' AND deleted_at IS NULL ORDER BY id")
      .all(tenantId) as any[];
    const matches = customers.filter(c => digits && whatsappDigits(c.phone) === digits);
    const stakeholderId = matches.length === 1 ? matches[0].id
      : customers.find(c => c.name === 'Walk-in Customer')?.id ?? null;
    res.json({ order_global_id: order.global_id, number: 'W-' + order.number, stakeholder_id: stakeholderId,
      lines, skipped, converted });
  }));
  app.get('/api/orders/:id', authenticate, route((req: any, res: any) => {
    const tenantId = req.session.tenantId, o = load(tenantId, req.params.id), state = effectiveState(o);
    const store = db.prepare('SELECT id, name, default_language, settings FROM stores WHERE id = ? AND tenant_id = ?').get(o.store_id, tenantId) as any;
    let settings: any = {}; try { settings = JSON.parse(store?.settings || '{}'); } catch {}
    const digits = whatsappDigits(o.customer_phone);
    const matches = (db.prepare("SELECT id, name, phone FROM stakeholders WHERE tenant_id = ? AND type = 'customer' AND deleted_at IS NULL").all(tenantId) as any[]).filter(c => digits && whatsappDigits(c.phone) === digits);
    const isOnline = online(tenantId), manage = can(req, 'orders.manage') && isOnline;
    const sale = saleFor(tenantId, o.global_id);
    res.json({ order: { ...o, number: `W-${o.number}`, effective_state: state }, online: isOnline, customer_wa_digits: digits,
      store: store ? { id: store.id, name: store.name, default_language: store.default_language, pickup_note: settings.pickup_note || '' } : null,
      lines: linesFor(tenantId, o.id).map(l => ({ ...l,
        local_product: db.prepare('SELECT id, name, stock, unit FROM products WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(l.product_id, tenantId) || null,
        local_unit: l.unit_key === 'base' ? 'base' : db.prepare('SELECT id, name, factor FROM product_units WHERE global_id = ? AND product_id = ? AND tenant_id = ? AND deleted_at IS NULL').get(l.unit_key, l.product_id, tenantId) || null })),
      events: db.prepare('SELECT * FROM order_events WHERE tenant_id = ? AND order_id = ? AND deleted_at IS NULL ORDER BY at, id').all(tenantId, o.id), sale,
      matched_customer: matches.length === 1 ? { id: matches[0].id, name: matches[0].name } : null,
      actions: { accept: manage && state === 'submitted', reject: manage && state === 'submitted', ready: manage && state === 'confirmed', cancel: manage && ['confirmed', 'ready'].includes(state), complete: isOnline && can(req, 'orders.view') && ['confirmed', 'ready'].includes(state) && !sale } });
  }));
  for (const action of ['accept', 'reject', 'ready', 'cancel']) app.post(`/api/orders/:id/${action}`, authenticate, route(async (req: any, res: any) => {
    const tenantId = req.session.tenantId, o = load(tenantId, req.params.id), body = req.body || {};
    if (!states.includes(body.expected_state)) throw fail('ORDER_INVALID_TRANSITION', 409, 'expected_state');
    const args: any = { p_order: o.global_id, p_expected_state: body.expected_state, p_actor: { name: user(req)?.name || req.session.userName || '', terminal: req.body?.terminalId || req.headers['x-terminal-id'] || '' } };
    if (action === 'reject' || action === 'cancel') {
      if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 300) throw fail('ORDER_REASON_REQUIRED', 400, 'reason');
      args.p_reason = body.reason.trim();
    }
    if (action === 'accept') {
      if (!Array.isArray(body.lines) || body.lines.length > 50) throw fail('ORDER_CONFIRM_EXCEEDS', 400, 'lines');
      const lines = linesFor(tenantId, o.id), seen = new Set();
      args.p_lines = body.lines.map((l: any, i: number) => {
        const line = lines.find(x => x.line_no === l?.line_no), field = `lines[${i}]`;
        if (!line || seen.has(l.line_no) || typeof l.confirmed_qty !== 'number' || !Number.isFinite(l.confirmed_qty) || l.confirmed_qty < 0 || l.confirmed_qty > line.ordered_qty) throw fail('ORDER_CONFIRM_EXCEEDS', 400, field);
        seen.add(l.line_no);
        if ((l.confirmed_qty < line.ordered_qty && !reasons.includes(l.reason)) || (l.reason != null && !reasons.includes(l.reason))) throw fail('ORDER_REASON_REQUIRED', 400, field);
        return { line_no: l.line_no, confirmed_qty: l.confirmed_qty, ...(l.reason ? { reason: l.reason } : {}) };
      });
      if (lines.length && lines.every(l => (args.p_lines.find((x: any) => x.line_no === l.line_no)?.confirmed_qty ?? l.ordered_qty) === 0)) throw fail('ORDER_ALL_ZERO');
    }
    const result = await callRpc<any>(tenantId, action === 'cancel' ? 'order_cancel_by_shop' : `order_${action}`, args, { timeoutMs: 10000 });
    if (result.ok === false) throw fail(result.reason === 'offline' ? 'ORDER_NEEDS_ONLINE' : 'ORDER_CLOUD_FAILED', result.reason === 'offline' ? 503 : 502);
    const value = result.value;
    // Every reply that carries the order (ok, handled, expired, …) is the cloud's current truth: show it now
    // rather than after the next pull.
    if (value?.order) applyResult(tenantId, value);
    if (!value?.ok) {
      const codes: Record<string, [string, number]> = { handled: ['ORDER_ALREADY_HANDLED', 409], expired: ['ORDER_EXPIRED', 409], invalid_transition: ['ORDER_INVALID_TRANSITION', 409], confirm_exceeds: ['ORDER_CONFIRM_EXCEEDS', 400], reason_required: ['ORDER_REASON_REQUIRED', 400], all_zero: ['ORDER_ALL_ZERO', 400], not_found: ['ORDER_NOT_FOUND', 404] };
      const [code, status] = codes[value?.code] || ['ORDER_CLOUD_FAILED', 502];
      const index = Array.isArray(body.lines) ? body.lines.findIndex((l: any) => l.line_no === value?.line_no) : -1;
      throw fail(code, status, ['confirm_exceeds', 'reason_required'].includes(value?.code) ? index >= 0 ? `lines[${index}]` : 'reason' : undefined, value?.code === 'handled' ? { state: value.order?.state } : {});
    }
    broadcast({ type: 'ORDERS_UPDATED', newSubmitted: 0, changed: 1 }, tenantId);
    res.json({ order: load(tenantId, o.id), lines: linesFor(tenantId, o.id) });
  }));
}
