// In-memory demo store for tests and `dev-server.ts --source=fixture`. Behaves like the cloud public catalog:
// gates (open, retail/hybrid, commerce on, licensed), hide-out-of-stock, exact stock only when enabled,
// category order, plain-text search by title or barcode, paging, preview tokens.
import type { DataSource, ListingPage, ListingQuery, PublicListing, PublicStore, StockState } from './data.js';

export interface FixtureStore {
  store: Omit<PublicStore, 'categories' | 'is_preview'> & { status: 'draft' | 'active' | 'paused'; commerce_on: boolean; licensed: boolean };
  listings: (PublicListing & { barcode: string | null; published: boolean; sort_order: number })[];
  previewTokens: string[];
}

const CATS: [string, string, number, StockState][] = [
  ['Dairy', 'Whole Milk 1L', 1.5, 'in_stock'], ['Dairy', 'Labneh 500g', 3.25, 'low_stock'], ['Dairy', 'Halloumi 250g', 4.5, 'in_stock'],
  ['Bakery', 'Arabic Bread', 0.75, 'in_stock'], ['Bakery', 'Manakish Zaatar', 1.25, 'out_of_stock'],
  ['Beverages', 'Mineral Water 1.5L', 0.5, 'in_stock'], ['Beverages', 'Orange Juice 1L', 2.1, 'in_stock'],
  ['Pantry', 'Olive Oil 1L', 9.5, 'in_stock'], ['Pantry', 'Hummus Can', 1.8, 'low_stock'], ['Cleaning', 'Dish Soap', 2.4, 'in_stock'],
];

export interface FixtureOptions {
  /** 003: a store that takes WhatsApp orders, with listings covering the ordering cases (see below). */
  ordering?: boolean | 'online';
}

export function demoFixture(count = 60, opts: FixtureOptions = {}): FixtureStore {
  const listings: FixtureStore['listings'] = [];
  for (let i = 0; i < count; i++) {
    const [category, name, price, stock_state] = CATS[i % CATS.length];
    const n = Math.floor(i / CATS.length);
    const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
    listings.push({
      listing_id: id, title: n ? `${name} #${n + 1}` : name, description: `${name} — fresh from our shelves.\nSecond line.`,
      images: [], category, price, price_lbp: null, unit: 'pcs',
      units: i % 4 === 0 ? [{ unit_id: `u-${i}`, name: 'Pack', factor: 6, price: +(price * 5.5).toFixed(2), price_lbp: null }] : [],
      stock_state, stock: stock_state === 'out_of_stock' ? 0 : stock_state === 'low_stock' ? 3 : 40, min_quantity: null,
      base_orderable: true,
      barcode: `622100000${String(i).padStart(4, '0')}`, published: true, sort_order: 0,
    });
  }
  if (opts.ordering) {
    // Labneh (#2) sold by the kg; Halloumi (#3) only by the pack of 6; Arabic Bread (#4) minimum 6 pieces;
    // Manakish (#5) is out of stock; Whole Milk (#1) piece or pack (the default "every 4th has a pack").
    if (listings[1]) Object.assign(listings[1], { unit: 'kg', price: 6.5 });
    if (listings[2]) Object.assign(listings[2], {
      base_orderable: false, units: [{ unit_id: '30000000-0000-4000-8000-000000000003', name: 'Pack of 6', factor: 6, price: 25, price_lbp: null }],
    });
    if (listings[3]) listings[3].min_quantity = 6;
  }
  return {
    store: {
      slug: 'beirut-market', name: 'Beirut Market', description: 'Fresh groceries in Hamra.\nOpen every day 8–22.', mode: 'retail',
      status: 'active', commerce_on: true, licensed: true,
      logo_path: null, cover_path: null, primary_color: '#0f766e',
      contact_phone: '+961 1 234 567', contact_whatsapp: '+961 70 123 456', contact_email: 'hello@beirut-market.test',
      address: 'Hamra Street, Beirut', default_language: 'en',
      show_local_price: true, hide_out_of_stock: false, show_exact_stock: false,
      local_currency_code: 'LBP', local_currency_symbol: 'LL', local_rate: 89500,
      ordering_mode: opts.ordering === 'online' ? 'online' : opts.ordering ? 'whatsapp' : 'off',
      pickup_enabled: true, pickup_note: opts.ordering ? 'Back door after 4 pm' : '',
      delivery_enabled: !!opts.ordering, delivery_note: opts.ordering ? 'Hamra and Ras Beirut only' : '',
      min_order_usd: opts.ordering ? 10 : null,
    },
    listings,
    previewTokens: [],
  };
}

export class FixtureSource implements DataSource {
  calls = 0;
  constructor(public fx: FixtureStore = demoFixture()) {}

  private gate(address: string, preview?: string | null) {
    const s = this.fx.store;
    if (address.toLowerCase() !== s.slug || !s.commerce_on || !s.licensed) return null;
    const previewing = !!preview && this.fx.previewTokens.includes(preview);
    if (!previewing && (s.status !== 'active' || s.mode === 'wholesale')) return null;
    return { previewing };
  }

  private visible() {
    const s = this.fx.store;
    return this.fx.listings
      .filter((l) => l.published && !(s.hide_out_of_stock && l.stock_state === 'out_of_stock'))
      .map((l) => ({ ...l, stock: s.show_exact_stock ? l.stock : null }));
  }

  private strip(l: FixtureStore['listings'][number]): PublicListing {
    const { barcode: _b, published: _p, sort_order: _s, ...pub } = l;
    return pub;
  }

  async getStore(address: string, preview?: string | null): Promise<PublicStore | null> {
    this.calls++;
    const g = this.gate(address, preview);
    if (!g) return null;
    const counts = new Map<string, number>();
    for (const l of this.visible()) if (l.category) counts.set(l.category, (counts.get(l.category) || 0) + 1);
    const { status: _st, commerce_on: _c, licensed: _l, ...store } = this.fx.store;
    return { ...store, categories: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)), is_preview: g.previewing };
  }

  async listListings(address: string, q: ListingQuery, preview?: string | null): Promise<ListingPage> {
    this.calls++;
    if (!this.gate(address, preview)) return { rows: [], total: 0 };
    const search = (q.search || '').trim().toLowerCase().slice(0, 60);
    const rows = this.visible()
      .filter((l) => !q.category || l.category === q.category)
      .filter((l) => !search || l.title.toLowerCase().includes(search) || (l.barcode || '').toLowerCase().includes(search))
      .sort((a, b) => a.sort_order - b.sort_order || a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
    return { rows: rows.slice(q.offset, q.offset + q.limit).map((l) => this.strip(l)), total: rows.length };
  }

  async getListing(address: string, listingId: string, preview?: string | null): Promise<PublicListing | null> {
    this.calls++;
    if (!this.gate(address, preview)) return null;
    const l = this.visible().find((x) => x.listing_id === listingId);
    return l ? this.strip(l) : null;
  }
}

import { createHash } from 'node:crypto';
import { type OrderGateway, type OrderLine, type OrderSubmitPayload, type OrderResult, UpstreamError } from './data.js';
import { isMeasuredUnit, orderableUnits } from './ordering.js';
import { whatsappDigits } from './phone.js';
const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
export class FixtureOrderGateway implements OrderGateway {
  blockedPhones = new Set<string>();
  unavailable = false;
  dropNextResponse = false;
  orders: { slug: string; attempt: string; hash: string; phone: string; network: string; at: number; expires: number; order: any }[] = [];
  constructor(public source: FixtureSource = new FixtureSource(demoFixture(60, { ordering: 'online' })), private now: () => number = Date.now) {}
  private check() { if (this.unavailable) throw new UpstreamError('fixture unavailable'); }
  private expire() { for (const o of this.orders) if (o.order.state === 'submitted' && o.expires < this.now()) o.order.state = 'expired'; }
  async quote(slug: string, lines: OrderLine[]): Promise<OrderResult> {
    this.check();
    const store = await this.source.getStore(slug);
    if (!store || store.ordering_mode !== 'online' || !(store.pickup_enabled || store.delivery_enabled)) return { ok: false, code: 'store_unavailable' };
    const problems: any[] = []; const rows: any[] = []; const quantities = new Map<string, number>();
    if (!Array.isArray(lines)) lines = [];
    lines = lines.map(l => l && typeof l === 'object' ? l : { listing: '', unit: '', qty: 0 });
    if (!lines.length) problems.push({ code: 'empty' });
    if (lines.length > 50) problems.push({ code: 'too_many_lines' });
    for (const [i, line] of lines.slice(0, 50).entries()) {
      const l = await this.source.getListing(slug, line?.listing);
      const u = l && orderableUnits(l).find(u => u.key === line.unit);
      let code = !l ? 'listing_unavailable' : !u ? 'unit_not_orderable' : l.stock_state === 'out_of_stock' ? 'out_of_stock' : '';
      const qty = line?.qty;
      if (!code && (!Number.isFinite(qty) || qty <= 0 || qty > 999 || (line.unit === 'base' && isMeasuredUnit(l!.unit) ? Math.abs(qty * 1000 - Math.round(qty * 1000)) > 1e-6 : !Number.isInteger(qty)))) code = 'invalid_quantity';
      if (code) { problems.push({ line: i + 1, code }); rows.push({ line: i + 1, ok: false, problem: code, listing: line.listing, unit: line.unit, qty, product_name: l?.title || '', unit_name: u?.name || '', unit_price_usd: u?.price ?? null, unit_price_local: null, line_total_usd: null, line_total_local: null }); continue; }
      const local = u!.price_lbp && u!.price_lbp > 0 ? u!.price_lbp : Math.round(u!.price * (store.local_rate || 0));
      rows.push({ line: i + 1, ok: true, problem: null, unit_factor: u!.factor, listing: line.listing, unit: line.unit, qty, price: u!.price, product_name: l!.title, unit_name: u!.name, ordered_qty: qty, confirmed_qty: null, unit_price_usd: u!.price, unit_price_local: local, line_total_usd: Math.round(u!.price * qty * 100) / 100, line_total_local: Math.round(local * qty) });
      quantities.set(line.listing, (quantities.get(line.listing) || 0) + qty * u!.factor);
      if (line.price !== undefined && line.price !== u!.price) problems.push({ line: i + 1, code: 'price_changed' });
    }
    for (const [i, line] of lines.entries()) { const l = await this.source.getListing(slug, line?.listing); if (l?.min_quantity && (quantities.get(line.listing) || 0) < l.min_quantity) problems.push({ line: i + 1, code: 'below_listing_minimum', min: l.min_quantity }); }
    const total_usd = Math.round(rows.reduce((n, l) => n + l.line_total_usd, 0) * 100) / 100;
    if (store.min_order_usd && total_usd < store.min_order_usd) problems.push({ code: 'below_store_minimum', min: store.min_order_usd });
    return { ok: true, code: 'ok', quote: { lines: rows, total_usd, total_local: rows.reduce((n, l) => n + l.line_total_local, 0), local: { code: store.local_currency_code, rate: store.local_rate }, problems } };
  }
  async submit(slug: string, p: OrderSubmitPayload): Promise<OrderResult> {
    this.check(); this.expire();
    const store = await this.source.getStore(slug);
    if (!store || store.ordering_mode !== 'online' || !(store.pickup_enabled || store.delivery_enabled)) return { ok: false, code: 'store_unavailable' };
    const existing = this.orders.find(o => o.slug === slug && o.attempt === p.attempt);
    if (existing) return existing.hash === hashKey(String(p.status_key)) ? { ok: true, code: 'existing', number: existing.order.number, order: existing.order } : { ok: false, code: 'refused' };
    if (p.website) return { ok: false, code: 'refused' };
    const invalid = (field: string) => ({ ok: false, code: 'invalid', field });
    if (!/^[A-Za-z0-9_-]{32}$/.test(p.status_key || '')) return invalid('status_key');
    if (!p.attempt || typeof p.attempt !== 'string') return invalid('attempt');
    const c = p.customer; if (!c || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80) return invalid('name');
    const phone = typeof c.phone === 'string' ? whatsappDigits(c.phone) : null;
    if (!phone || phone.length < 8 || phone.length > 15) return invalid('phone');
    if (!['pickup','delivery'].includes(c.fulfilment) || !(c.fulfilment === 'pickup' ? store.pickup_enabled : store.delivery_enabled)) return invalid('fulfilment');
    if ((c.address && (typeof c.address !== 'string' || c.address.length > 300)) || (c.fulfilment === 'delivery' && (typeof c.address !== 'string' || !c.address.trim()))) return invalid('address');
    if (c.note && (typeof c.note !== 'string' || c.note.length > 300)) return invalid('note');
    if (this.blockedPhones.has(phone) || this.blockedPhones.has('+' + phone)) return { ok: false, code: 'refused' };
    const own = this.orders.filter(o => o.slug === slug && o.phone === phone);
    if (own.filter(o => o.at > this.now() - 3600000).length >= 5 || own.filter(o => o.order.state === 'submitted').length >= 3) return { ok: false, code: 'phone_limit' };
    const network = this.orders.filter(o => o.network === p.network && o.at > this.now() - 3600000);
    if (network.length >= 30 || network.filter(o => o.slug === slug).length >= 10) return { ok: false, code: 'network_limit' };
    const result = await this.quote(slug, p.lines); const q = result.quote;
    if (q.problems.length || q.total_usd !== p.expected_total_usd || q.lines.some((l: any, i: number) => l.price !== p.lines[i]?.price)) return { ok: false, code: 'changed', quote: q };
    const at = this.now();
    const order = { number: `W-${1001 + this.orders.filter(o => o.slug === slug).length}`, state: 'submitted', first_name: c.name.trim().split(/\s+/)[0], fulfilment: c.fulfilment, address: c.fulfilment === 'delivery' ? c.address : null, submitted_at: new Date(at).toISOString(), lines: q.lines.map((l: any) => ({ product_name: l.product_name, unit_name: l.unit_name, ordered_qty: l.qty, confirmed_qty: null, shortfall_reason: null, unit_price_usd: l.unit_price_usd, unit_price_local: l.unit_price_local, line_total_usd: l.line_total_usd, line_total_local: l.line_total_local })), total_usd: q.total_usd, total_local: q.total_local, confirmed_total_usd: null, confirmed_total_local: null, confirmed_at: null, ready_at: null, closed_at: null, reason: null, cancelled_by: null, local_currency: store.local_currency_code, store: { slug, name: store.name, contact_whatsapp: store.contact_whatsapp, contact_phone: store.contact_phone, contact_email: store.contact_email } };
    this.orders.push({ slug, attempt: p.attempt, hash: hashKey(p.status_key), phone, network: p.network || '', at, expires: at + 86400000, order });
    if (this.dropNextResponse) { this.dropNextResponse = false; throw new UpstreamError('fixture dropped response'); }
    return { ok: true, code: 'created', number: order.number, order };
  }
  async status(key: string): Promise<OrderResult> { this.check(); this.expire(); const o = this.orders.find(o => o.hash === hashKey(key)); return o ? { ok: true, order: o.order } : { ok: false, code: 'not_found' }; }
  async cancel(key: string): Promise<OrderResult> { const r = await this.status(key); if (!r.ok) return r; if (r.order.state !== 'submitted') return { ...r, ok: false, code: 'not_cancellable' }; r.order.state = 'cancelled'; r.order.cancelled_by = 'customer'; r.order.closed_at = new Date(this.now()).toISOString(); return { ...r, code: 'cancelled' }; }
}
