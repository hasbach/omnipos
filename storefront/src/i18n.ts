// Storefront strings (spec 002 FR-020). English is the base; Arabic and French are added with US3.
// t() falls back to English, then to the key, so a missing translation never breaks a page.
import type { Lang } from './router.js';

type Dict = Record<string, string>;

const en: Dict = {
  all_products: 'All products',
  search_placeholder: 'Search products',
  search: 'Search',
  no_products_yet: 'No products available yet.',
  no_products_found: 'No products found.',
  back_to_first_page: 'Back to the first page',
  previous: 'Previous',
  next: 'Next',
  page_of: 'Page {page} of {pages}',
  products_count: '{count} products',
  in_stock: 'In stock',
  low_stock: 'Low stock',
  out_of_stock: 'Out of stock',
  stock_exact: '{count} in stock',
  availability_note: 'Availability is indicative and may change.',
  store_unavailable_title: 'This store isn’t available',
  store_unavailable_text: 'The store may be closed for now, or the address may be wrong.',
  page_not_found_title: 'Page not found',
  page_not_found_text: 'This page doesn’t exist.',
  product_unavailable_title: 'This product is no longer available',
  product_unavailable_text: 'It may have been removed from the store.',
  temporarily_unavailable_title: 'Temporarily unavailable',
  temporarily_unavailable_text: 'Please try again in a moment.',
  visit_store: 'Visit the store',
  powered_by: 'Online store by OmniPOS',
  omnipos_link: 'About OmniPOS',
  preview_banner: 'Preview — this store is not public',
  sold_as: 'Sold as',
  unit_contains: '{count} × {unit}',
  category: 'Category',
  contact_whatsapp: 'WhatsApp',
  contact_call: 'Call',
  contact_email: 'Email',
  wa_product: 'Hello! I’m interested in {product}: {url}',
  wa_store: 'Hello {store}! I found your online store: {url}',
  back_to_store: 'Back to the store',
  photo_of: 'Photo {n} of {count}',
};

const DICTS: Record<Lang, Dict> = { en, ar: {}, fr: {} };

export function t(lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
  let s = DICTS[lang]?.[key] ?? en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export const isRtl = (lang: Lang) => lang === 'ar';

/** For tests: every key of every language. */
export const __dicts = DICTS;
