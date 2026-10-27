// Online store (commerce) API client — specs/001-commerce-domain-foundation/contracts/backoffice-api.md.
// Errors carry `code` / `field` (src/lib/api.ts); translate them with translateServerError.
import { api } from './api';

export type StoreMode = 'retail' | 'wholesale' | 'hybrid';
export type StoreStatus = 'draft' | 'active' | 'paused';
export type StockState = 'in_stock' | 'low_stock' | 'out_of_stock';
export type NotPublicReason = 'commerce_off' | 'license' | 'draft' | 'paused' | 'wholesale';
export type UnavailableReason = 'not_published' | 'product_disabled' | 'product_deleted' | 'store_not_active' | 'commerce_off';

export interface StoreSettings {
  show_exact_stock: 0 | 1;
  hide_out_of_stock: 0 | 1;
  show_local_price: 0 | 1;
  category_order: string[];
  // 003 ordering (Slice 1: 'online' is refused by the server until Slice 2)
  ordering_mode: 'off' | 'whatsapp' | 'online';
  pickup_enabled: 0 | 1;
  pickup_note: string;
  delivery_enabled: 0 | 1;
  delivery_note: string;
  min_order_usd: number | null;
  order_expiry_hours: number;
}

export interface Store {
  id: number;
  global_id: string;
  name: string;
  slug: string | null;
  mode: StoreMode;
  status: StoreStatus;
  description: string | null;
  logo_path: string | null;
  cover_path: string | null;
  primary_color: string | null;
  contact_phone: string | null;
  contact_whatsapp: string | null;
  contact_email: string | null;
  address: string | null;
  default_language: 'en' | 'ar' | 'fr';
  settings: StoreSettings;
  public_url: string | null;
}

export interface CommerceStatus {
  enabled: boolean;
  online_license_valid: boolean;
  /** e.g. https://myomnipos.com */
  storefront_origin: string;
  /** Prefix for back-office photo thumbnails (public bucket URL). */
  image_base: string;
  store: (Pick<Store, 'id' | 'global_id' | 'name' | 'slug' | 'mode' | 'status' | 'public_url'> & {
    publicly_visible: boolean;
    not_public_reason: NotPublicReason | null;
  }) | null;
}

export interface ListingView {
  id: number;
  global_id: string;
  store_id: number;
  product_id: number;
  published: boolean;
  title: string | null;
  description: string | null;
  images: string[];
  store_category: string | null;
  sort_order: number;
  min_quantity: number | null;
  /** "base" or unit global ids; null = every unit is orderable. */
  orderable_unit_keys: string[] | null;
  base_orderable: boolean;
  display_title: string;
  category: string | null;
  visible: boolean;
  unavailable_reason: UnavailableReason | null;
  stock_state: StockState;
  price: number | null;
  price_lbp: number | null;
  unit: string;
  /** Orderable units (besides the base unit when base_orderable). */
  units: { id: number; key: string; name: string; factor: number; price: number; price_lbp: number | null }[];
  /** Every live unit with its key, base first (for the orderable-units choice). */
  unit_options: { key: string; name: string; factor: number; price: number }[];
  product: { id: number; name: string; barcode: string | null; active: number; stock: number } | null;
}

export type StoreInput = Partial<Omit<Store, 'id' | 'global_id' | 'slug' | 'status' | 'public_url' | 'settings'>> & { settings?: Partial<StoreSettings> };
export type ListingInput = Partial<Pick<ListingView, 'published' | 'title' | 'description' | 'store_category' | 'sort_order' | 'min_quantity' | 'orderable_unit_keys'>>;

/** Thumbnail URL for a stored photo path. */
export const photoUrl = (status: Pick<CommerceStatus, 'image_base'>, path: string) =>
  `${status.image_base}${path.split('/').map(encodeURIComponent).join('/')}`;

export const commerceApi = {
  status: () => api.get<CommerceStatus>('/api/commerce/status'),
  setEnabled: (enabled: boolean) => api.put<CommerceStatus>('/api/commerce/status', { enabled }),
  stores: () => api.get<Store[]>('/api/commerce/stores'),
  createStore: (body: StoreInput) => api.post<Store>('/api/commerce/stores', body),
  updateStore: (id: number, body: StoreInput) => api.put<Store>(`/api/commerce/stores/${id}`, body),
  claimSlug: (id: number, slug: string) => api.post<Store>(`/api/commerce/stores/${id}/slug`, { slug }),
  setStatus: (id: number, status: 'active' | 'paused') => api.post<Store>(`/api/commerce/stores/${id}/status`, { status }),
  deleteStore: (id: number) => api.del<{ ok: true }>(`/api/commerce/stores/${id}`),
  listings: (storeId: number, q?: { published?: '0' | '1'; category?: string; search?: string; limit?: number; offset?: number }) =>
    api.get<{ rows: ListingView[]; total: number }>(`/api/commerce/stores/${storeId}/listings`, q),
  productListings: (productId: number) => api.get<ListingView[]>(`/api/commerce/products/${productId}/listings`),
  upsertListing: (storeId: number, productId: number, body: ListingInput) => api.put<ListingView>(`/api/commerce/stores/${storeId}/listings/${productId}`, body),
  deleteListing: (storeId: number, productId: number) => api.del<{ ok: true }>(`/api/commerce/stores/${storeId}/listings/${productId}`),
  addPhoto: (storeId: number, productId: number, webp: Blob) =>
    api.postBinary<ListingView>(`/api/commerce/stores/${storeId}/listings/${productId}/photos`, webp, 'image/webp'),
  setPhotos: (storeId: number, productId: number, images: string[]) =>
    api.put<ListingView>(`/api/commerce/stores/${storeId}/listings/${productId}/photos`, { images }),
  setBranding: (storeId: number, kind: 'logo' | 'cover', webp: Blob) =>
    api.postBinary<Store>(`/api/commerce/stores/${storeId}/branding/${kind}`, webp, 'image/webp'),
  clearBranding: (storeId: number, kind: 'logo' | 'cover') => api.del<Store>(`/api/commerce/stores/${storeId}/branding/${kind}`),
  previewLink: (storeId: number) => api.post<{ url: string }>(`/api/commerce/stores/${storeId}/preview`),
  bulkPublish: (storeId: number, productIds: number[], published: boolean) =>
    api.post<{ created: number; updated: number }>(`/api/commerce/stores/${storeId}/listings/bulk`, { product_ids: productIds, published }),
};
