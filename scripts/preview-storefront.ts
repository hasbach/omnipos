// Dev only (scripts/preview-server.ts): the storefront rendered from the desktop's local demo database, so the
// whole flow — publish in the back office, look at the store — works on one PC without the cloud.
// Mirrors the cloud public catalog (supabase/migrations/2026-10-19_storefront.sql): same gates (open,
// retail/hybrid, commerce on), same visible-listing rule and the same field allow-list.
import { isCommerceEnabled, listListings, listStores } from '../server/commerce.js';
import type { DataSource, ListingPage, ListingQuery, PublicListing, PublicStore } from '../storefront/src/data.js';

type LocalListing = PublicListing & { barcode: string | null; sort_order: number };

export class LocalDbSource implements DataSource {
  constructor(private db: any, private tenantId: number,
    /** Is `token` a valid owner preview token for the store with this global id? */
    private previewOk: (storeGlobalId: string, token: string) => boolean = () => false) {}

  private openStore(address: string, preview?: string | null) {
    const store = listStores(this.tenantId).find((s: any) => s.slug && s.slug === address.toLowerCase());
    if (!store || !isCommerceEnabled(this.tenantId)) return null;
    const previewing = !!preview && this.previewOk(store.global_id, preview);
    if (!previewing && (store.status !== 'active' || store.mode === 'wholesale')) return null;
    return { ...store, previewing };
  }

  private visible(store: any): LocalListing[] {
    const out: LocalListing[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = listListings(this.tenantId, store.id, { published: '1', limit: 500, offset });
      for (const v of page.rows as any[]) {
        // Same rule as the cloud's visible-listing query: the store gate (open / preview) is checked separately.
        if (!v.visible && v.unavailable_reason !== 'store_not_active') continue;
        if (store.settings.hide_out_of_stock === 1 && v.stock_state === 'out_of_stock') continue;
        out.push({
          listing_id: v.global_id, title: v.display_title, description: v.description, images: v.images || [],
          category: v.category, price: Number(v.price) || 0, price_lbp: v.price_lbp ?? null, unit: v.unit || 'pcs',
          units: (v.units || []).map((u: any) => ({ unit_id: String(u.id), name: u.name, factor: u.factor, price: u.price, price_lbp: u.price_lbp ?? null })),
          stock_state: v.stock_state, stock: store.settings.show_exact_stock === 1 ? (v.product?.stock ?? null) : null,
          min_quantity: v.min_quantity ?? null, barcode: v.product?.barcode ?? null, sort_order: v.sort_order ?? 0,
        });
      }
      if (offset + 500 >= page.total) break;
    }
    return out;
  }

  private strip(l: LocalListing): PublicListing {
    const { barcode: _b, sort_order: _s, ...pub } = l;
    return pub;
  }

  async getStore(address: string, preview?: string | null): Promise<PublicStore | null> {
    const s = this.openStore(address, preview);
    if (!s) return null;
    const order: string[] = Array.isArray(s.settings.category_order) ? s.settings.category_order : [];
    const counts = new Map<string, number>();
    for (const l of this.visible(s)) if (l.category) counts.set(l.category, (counts.get(l.category) || 0) + 1);
    const categories = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => {
      const pa = order.indexOf(a.name), pb = order.indexOf(b.name);
      if (pa !== pb) return (pa < 0 ? Infinity : pa) - (pb < 0 ? Infinity : pb);
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    const cur = this.db.prepare("SELECT code, symbol, rate FROM currencies WHERE tenant_id = ? AND deleted_at IS NULL AND upper(code) <> 'USD' ORDER BY id LIMIT 1").get(this.tenantId) as any;
    return {
      slug: s.slug, name: s.name, description: s.description, mode: s.mode, logo_path: s.logo_path, cover_path: s.cover_path,
      primary_color: s.primary_color, contact_phone: s.contact_phone, contact_whatsapp: s.contact_whatsapp, contact_email: s.contact_email,
      address: s.address, default_language: s.default_language,
      show_local_price: s.settings.show_local_price === 1, hide_out_of_stock: s.settings.hide_out_of_stock === 1, show_exact_stock: s.settings.show_exact_stock === 1,
      local_currency_code: cur?.code ?? null, local_currency_symbol: cur?.symbol ?? null, local_rate: cur ? Number(cur.rate) : null,
      categories, is_preview: s.previewing,
    };
  }

  async listListings(address: string, q: ListingQuery, preview?: string | null): Promise<ListingPage> {
    const s = this.openStore(address, preview);
    if (!s) return { rows: [], total: 0 };
    const search = (q.search || '').trim().toLowerCase().slice(0, 60);
    const rows = this.visible(s)
      .filter((l) => !q.category || l.category === q.category)
      .filter((l) => !search || l.title.toLowerCase().includes(search) || (l.barcode || '').toLowerCase().includes(search))
      .sort((a, b) => a.sort_order - b.sort_order || a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
    return { rows: rows.slice(q.offset, q.offset + q.limit).map((l) => this.strip(l)), total: rows.length };
  }

  async getListing(address: string, listingId: string, preview?: string | null): Promise<PublicListing | null> {
    const s = this.openStore(address, preview);
    if (!s) return null;
    const l = this.visible(s).find((x) => x.listing_id === listingId);
    return l ? this.strip(l) : null;
  }
}
