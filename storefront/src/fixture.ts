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
  ordering?: boolean;
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
      ordering_mode: opts.ordering ? 'whatsapp' : 'off',
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
