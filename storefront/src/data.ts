// Where storefront pages get their data. In production: the allow-listed public catalog RPCs in Supabase
// (store_public_get / store_public_listings / store_public_listing — contracts/cloud-api.md). Tests use the
// fixture source, the desktop preview server a local one. Pages never see anything outside these types.

export interface PublicCategory { name: string; count: number }

export interface PublicStore {
  slug: string;
  name: string;
  description: string | null;
  mode: string;
  logo_path: string | null;
  cover_path: string | null;
  primary_color: string | null;
  contact_phone: string | null;
  contact_whatsapp: string | null;
  contact_email: string | null;
  address: string | null;
  default_language: string | null;
  show_local_price: boolean;
  hide_out_of_stock: boolean;
  show_exact_stock: boolean;
  local_currency_code: string | null;
  local_currency_symbol: string | null;
  local_rate: number | null;
  categories: PublicCategory[];
  /** 003 ordering settings (missing in the catalog before migration 2026-10-21 → ordering off). */
  ordering_mode: OrderingMode;
  pickup_enabled: boolean;
  pickup_note: string;
  delivery_enabled: boolean;
  delivery_note: string;
  min_order_usd: number | null;
  is_preview: boolean;
}

export type OrderingMode = 'off' | 'whatsapp' | 'online';

export interface PublicUnit { unit_id: string; name: string; factor: number; price: number; price_lbp: number | null }

export type StockState = 'in_stock' | 'low_stock' | 'out_of_stock';

export interface PublicListing {
  listing_id: string;
  title: string;
  description: string | null;
  images: string[];
  category: string | null;
  price: number;
  price_lbp: number | null;
  unit: string;
  units: PublicUnit[];
  stock_state: StockState;
  /** Only when the store shows exact stock; null otherwise. */
  stock: number | null;
  min_quantity: number | null;
  /** The product's base unit can be ordered (003; `units` already holds only orderable units). */
  base_orderable: boolean;
}

export interface ListingQuery { category?: string | null; search?: string | null; limit: number; offset: number }
export interface ListingPage { rows: PublicListing[]; total: number }

export interface DataSource {
  /** null when the address is unknown or the store is not public (and no valid preview token). */
  getStore(address: string, preview?: string | null): Promise<PublicStore | null>;
  listListings(address: string, q: ListingQuery, preview?: string | null): Promise<ListingPage>;
  getListing(address: string, listingId: string, preview?: string | null): Promise<PublicListing | null>;
}

/** The cloud could not be reached or answered with an error (the page shows "temporarily unavailable"). */
export class UpstreamError extends Error {
  constructor(message: string, public status?: number) { super(message); this.name = 'UpstreamError'; }
}

const num = (v: any): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export function normalizeStore(r: any): PublicStore {
  return {
    slug: String(r.slug), name: String(r.name ?? ''), description: r.description ?? null, mode: String(r.mode ?? 'retail'),
    logo_path: r.logo_path ?? null, cover_path: r.cover_path ?? null, primary_color: r.primary_color ?? null,
    contact_phone: r.contact_phone ?? null, contact_whatsapp: r.contact_whatsapp ?? null, contact_email: r.contact_email ?? null,
    address: r.address ?? null, default_language: r.default_language ?? null,
    show_local_price: !!r.show_local_price, hide_out_of_stock: !!r.hide_out_of_stock, show_exact_stock: !!r.show_exact_stock,
    local_currency_code: r.local_currency_code ?? null, local_currency_symbol: r.local_currency_symbol ?? null, local_rate: num(r.local_rate),
    categories: Array.isArray(r.categories) ? r.categories.map((c: any) => ({ name: String(c.name), count: Number(c.count) || 0 })) : [],
    ordering_mode: (['off', 'whatsapp', 'online'].includes(r.ordering_mode) ? r.ordering_mode : 'off') as OrderingMode,
    pickup_enabled: r.pickup_enabled === undefined || r.pickup_enabled === null ? true : !!r.pickup_enabled,
    pickup_note: typeof r.pickup_note === 'string' ? r.pickup_note : '',
    delivery_enabled: !!r.delivery_enabled,
    delivery_note: typeof r.delivery_note === 'string' ? r.delivery_note : '',
    min_order_usd: num(r.min_order_usd) !== null && (num(r.min_order_usd) as number) > 0 ? num(r.min_order_usd) : null,
    is_preview: !!r.is_preview,
  };
}

export function normalizeListing(r: any): PublicListing {
  const images = Array.isArray(r.images) ? r.images.filter((p: any) => typeof p === 'string') : [];
  const units = Array.isArray(r.units) ? r.units : [];
  return {
    listing_id: String(r.listing_id), title: String(r.title ?? ''), description: r.description ?? null, images,
    category: r.category ?? null, price: Number(r.price) || 0, price_lbp: num(r.price_lbp), unit: String(r.unit || 'pcs'),
    units: units.map((u: any) => ({ unit_id: String(u.unit_id), name: String(u.name ?? ''), factor: Number(u.factor) || 1, price: Number(u.price) || 0, price_lbp: num(u.price_lbp) })),
    stock_state: (['in_stock', 'low_stock', 'out_of_stock'].includes(r.stock_state) ? r.stock_state : 'in_stock') as StockState,
    stock: num(r.stock), min_quantity: num(r.min_quantity),
    base_orderable: r.base_orderable === undefined || r.base_orderable === null ? true : !!r.base_orderable,
  };
}

type Fetch = typeof fetch;

/** Production source: PostgREST RPC calls with the public anon key. */
export class SupabaseRpcSource implements DataSource {
  constructor(private baseUrl: string, private anonKey: string, private fetchImpl: Fetch = fetch) {}

  private async rpc(fn: string, args: Record<string, unknown>): Promise<any[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: this.anonKey, Authorization: `Bearer ${this.anonKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(args),
      });
    } catch (e: any) {
      throw new UpstreamError(`${fn}: ${e?.message || e}`);
    }
    if (!res.ok) throw new UpstreamError(`${fn}: HTTP ${res.status}`, res.status);
    const body = await res.json().catch(() => null);
    return Array.isArray(body) ? body : [];
  }

  async getStore(address: string, preview?: string | null) {
    const rows = await this.rpc('store_public_get', { p_slug: address, p_preview: preview || null });
    return rows[0] ? normalizeStore(rows[0]) : null;
  }

  async listListings(address: string, q: ListingQuery, preview?: string | null) {
    const rows = await this.rpc('store_public_listings', {
      p_slug: address, p_category: q.category || null, p_search: q.search || null, p_limit: q.limit, p_offset: q.offset, p_preview: preview || null,
    });
    return { rows: rows.map(normalizeListing), total: rows[0] ? Number(rows[0].total_count) || 0 : 0 };
  }

  async getListing(address: string, listingId: string, preview?: string | null) {
    const rows = await this.rpc('store_public_listing', { p_slug: address, p_listing: listingId, p_preview: preview || null });
    return rows[0] ? normalizeListing(rows[0]) : null;
  }
}
