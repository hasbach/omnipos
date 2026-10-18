// Storefront strings (spec 002 FR-020): English, Arabic and French. tests/storefront-render.test.ts checks that
// all three have the same keys and placeholders. t() falls back to English, then to the key.
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
  language: 'Language',
};

const ar: Dict = {
  all_products: 'كل المنتجات',
  search_placeholder: 'ابحث عن منتج',
  search: 'بحث',
  no_products_yet: 'لا توجد منتجات بعد.',
  no_products_found: 'لم يتم العثور على منتجات.',
  back_to_first_page: 'العودة إلى الصفحة الأولى',
  previous: 'السابق',
  next: 'التالي',
  page_of: 'الصفحة {page} من {pages}',
  products_count: '{count} منتج',
  in_stock: 'متوفر',
  low_stock: 'كمية محدودة',
  out_of_stock: 'غير متوفر',
  stock_exact: '{count} متوفر',
  availability_note: 'التوفر تقريبي وقد يتغير.',
  store_unavailable_title: 'هذا المتجر غير متاح',
  store_unavailable_text: 'قد يكون المتجر مغلقاً حالياً، أو أن العنوان غير صحيح.',
  page_not_found_title: 'الصفحة غير موجودة',
  page_not_found_text: 'هذه الصفحة غير موجودة.',
  product_unavailable_title: 'هذا المنتج لم يعد متاحاً',
  product_unavailable_text: 'ربما تمت إزالته من المتجر.',
  temporarily_unavailable_title: 'غير متاح مؤقتاً',
  temporarily_unavailable_text: 'يرجى المحاولة بعد قليل.',
  visit_store: 'زيارة المتجر',
  powered_by: 'متجر إلكتروني من OmniPOS',
  omnipos_link: 'عن OmniPOS',
  preview_banner: 'معاينة — هذا المتجر غير منشور للعامة',
  sold_as: 'يُباع كـ',
  unit_contains: '{count} × {unit}',
  category: 'الفئة',
  contact_whatsapp: 'واتساب',
  contact_call: 'اتصال',
  contact_email: 'بريد إلكتروني',
  wa_product: 'مرحباً! أنا مهتم بـ {product}: {url}',
  wa_store: 'مرحباً {store}! وجدت متجركم الإلكتروني: {url}',
  back_to_store: 'العودة إلى المتجر',
  photo_of: 'الصورة {n} من {count}',
  language: 'اللغة',
};

const fr: Dict = {
  all_products: 'Tous les produits',
  search_placeholder: 'Rechercher un produit',
  search: 'Rechercher',
  no_products_yet: 'Aucun produit pour le moment.',
  no_products_found: 'Aucun produit trouvé.',
  back_to_first_page: 'Revenir à la première page',
  previous: 'Précédent',
  next: 'Suivant',
  page_of: 'Page {page} sur {pages}',
  products_count: '{count} produits',
  in_stock: 'En stock',
  low_stock: 'Stock faible',
  out_of_stock: 'Rupture de stock',
  stock_exact: '{count} en stock',
  availability_note: 'La disponibilité est indicative et peut changer.',
  store_unavailable_title: 'Cette boutique n’est pas disponible',
  store_unavailable_text: 'La boutique est peut-être fermée pour le moment, ou l’adresse est incorrecte.',
  page_not_found_title: 'Page introuvable',
  page_not_found_text: 'Cette page n’existe pas.',
  product_unavailable_title: 'Ce produit n’est plus disponible',
  product_unavailable_text: 'Il a peut-être été retiré de la boutique.',
  temporarily_unavailable_title: 'Temporairement indisponible',
  temporarily_unavailable_text: 'Veuillez réessayer dans un instant.',
  visit_store: 'Voir la boutique',
  powered_by: 'Boutique en ligne par OmniPOS',
  omnipos_link: 'À propos d’OmniPOS',
  preview_banner: 'Aperçu — cette boutique n’est pas publique',
  sold_as: 'Vendu par',
  unit_contains: '{count} × {unit}',
  category: 'Catégorie',
  contact_whatsapp: 'WhatsApp',
  contact_call: 'Appeler',
  contact_email: 'E-mail',
  wa_product: 'Bonjour ! Je suis intéressé(e) par {product} : {url}',
  wa_store: 'Bonjour {store} ! J’ai trouvé votre boutique en ligne : {url}',
  back_to_store: 'Retour à la boutique',
  photo_of: 'Photo {n} sur {count}',
  language: 'Langue',
};

const DICTS: Record<Lang, Dict> = { en, ar, fr };

/** Language names, each in its own language (switcher). */
export const LANG_NAMES: Record<Lang, string> = { en: 'English', ar: 'العربية', fr: 'Français' };

export function t(lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
  let s = DICTS[lang]?.[key] ?? en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export const isRtl = (lang: Lang) => lang === 'ar';

/** For tests: every key of every language. */
export const __dicts = DICTS;
