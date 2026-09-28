// Canonical field definitions for the data import wizard (products / customers / suppliers).
// Shared by MappingStep (auto-map + manual override), ReviewStep (labels) and template.ts
// (template header/instructions generation). Keep in sync with the server contract described in
// docs/plans/2026-09-28-import-wizard.md — these are display/mapping helpers only; the server is
// the source of truth for validation.

import importLocale from '../../intl/locales/import';

export type ImportEntity = 'products' | 'customers' | 'suppliers';
export type FieldType = 'string' | 'number' | 'boolean' | 'enum';

export interface FieldDef {
  key: string;
  required: boolean;
  type: FieldType;
  /** i18n key (src/intl/locales/import.ts, prefix imp_field_) + English fallback. */
  labelKey: string;
  labelFallback: string;
  /** Short format hint shown in Instructions / mapping step (i18n key + fallback). */
  hintKey?: string;
  hintFallback?: string;
  /** Alias list (English + Arabic + French + common variants) used for auto-mapping headers. */
  aliases: string[];
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export const PRODUCT_FIELDS: FieldDef[] = [
  {
    key: 'name',
    required: true,
    type: 'string',
    labelKey: 'imp_field_name',
    labelFallback: 'Name',
    aliases: [
      'name', 'product name', 'item', 'item name', 'product', 'description', 'title',
      'اسم', 'الاسم', 'اسم المنتج', 'اسم الصنف', 'الصنف', 'اسم السلعة',
      'nom', 'nom du produit', 'désignation', 'designation', 'produit', 'article',
    ],
  },
  {
    key: 'barcode',
    required: false,
    type: 'string',
    labelKey: 'imp_field_barcode',
    labelFallback: 'Barcode',
    aliases: [
      'barcode', 'code', 'sku', 'ean', 'upc', 'item code', 'product code',
      'باركود', 'الباركود', 'الرمز', 'رمز', 'رمز المنتج', 'الرمز الشريطي',
      'code-barres', 'code barre', 'code-barre', 'code produit',
    ],
  },
  {
    key: 'barcodes',
    required: false,
    type: 'string',
    labelKey: 'imp_field_barcodes',
    labelFallback: 'Extra barcodes',
    hintKey: 'imp_hint_barcodes',
    hintFallback: "Separate multiple barcodes with , ; or |",
    aliases: [
      'barcodes', 'extra barcodes', 'additional barcodes', 'other barcodes',
      'باركودات', 'باركودات إضافية', 'رموز إضافية', 'الباركودات الإضافية',
      'codes-barres', 'codes barres supplémentaires', 'autres codes-barres',
    ],
  },
  {
    key: 'category',
    required: false,
    type: 'string',
    labelKey: 'imp_field_category',
    labelFallback: 'Category',
    aliases: ['category', 'cat', 'الفئة', 'فئة', 'التصنيف', 'تصنيف', 'catégorie', 'categorie'],
  },
  {
    key: 'unit',
    required: false,
    type: 'string',
    labelKey: 'imp_field_unit',
    labelFallback: 'Unit',
    aliases: ['unit', 'uom', 'unit of measure', 'الوحدة', 'وحدة', 'وحدة القياس', 'unité', 'unite'],
  },
  {
    key: 'cost',
    required: false,
    type: 'number',
    labelKey: 'imp_field_cost',
    labelFallback: 'Cost (USD)',
    hintKey: 'imp_hint_usd',
    hintFallback: 'USD',
    aliases: [
      'cost', 'cost price', 'purchase price', 'buy price', 'buying price',
      'التكلفة', 'سعر التكلفة', 'سعر الشراء', 'تكلفة الشراء',
      'coût', 'cout', "prix d'achat", 'prix coûtant', 'prix cout',
    ],
  },
  {
    key: 'price',
    required: true,
    type: 'number',
    labelKey: 'imp_field_price',
    labelFallback: 'Retail price (USD)',
    hintKey: 'imp_hint_usd',
    hintFallback: 'USD',
    aliases: [
      'price', 'retail price', 'selling price', 'sale price', 'unit price', 'sell price',
      'السعر', 'سعر البيع', 'سعر المفرق', 'سعر التجزئة', 'سعر المبيع', 'سعر الوحدة',
      'prix', 'prix de vente', 'prix unitaire', 'prix détail', 'prix detail', 'prix vente',
    ],
  },
  {
    key: 'price_lbp',
    required: false,
    type: 'number',
    labelKey: 'imp_field_price_lbp',
    labelFallback: 'Retail price (LBP)',
    hintKey: 'imp_hint_lbp',
    hintFallback: 'LBP (local currency)',
    aliases: [
      'price lbp', 'price (lbp)', 'retail price lbp', 'السعر بالليرة', 'السعر ل.ل', 'سعر البيع بالليرة',
      'prix lbp', 'prix (lbp)', 'prix en livres',
    ],
  },
  {
    key: 'price_wholesale',
    required: false,
    type: 'number',
    labelKey: 'imp_field_price_wholesale',
    labelFallback: 'Wholesale price (USD)',
    aliases: [
      'wholesale price', 'price wholesale', 'wholesale', 'سعر الجملة', 'الجملة',
      'prix de gros', 'prix gros', 'gros',
    ],
  },
  {
    key: 'price_wholesale_lbp',
    required: false,
    type: 'number',
    labelKey: 'imp_field_price_wholesale_lbp',
    labelFallback: 'Wholesale price (LBP)',
    aliases: [
      'wholesale price lbp', 'price wholesale lbp', 'سعر الجملة بالليرة',
      'prix de gros lbp', 'prix gros lbp',
    ],
  },
  {
    key: 'price_super_wholesale',
    required: false,
    type: 'number',
    labelKey: 'imp_field_price_super_wholesale',
    labelFallback: 'Super wholesale price (USD)',
    aliases: [
      'super wholesale price', 'price super wholesale', 'super wholesale',
      'سعر جملة الجملة', 'سعر الجملة الفائقة', 'جملة الجملة',
      'prix super gros', 'super gros',
    ],
  },
  {
    key: 'price_super_wholesale_lbp',
    required: false,
    type: 'number',
    labelKey: 'imp_field_price_super_wholesale_lbp',
    labelFallback: 'Super wholesale price (LBP)',
    aliases: [
      'super wholesale price lbp', 'سعر جملة الجملة بالليرة', 'prix super gros lbp',
    ],
  },
  {
    key: 'package_price',
    required: false,
    type: 'number',
    labelKey: 'imp_field_package_price',
    labelFallback: 'Package price (USD)',
    aliases: [
      'package price', 'carton price', 'box price', 'bulk price', 'pack price',
      'سعر الكرتون', 'سعر الباكيت', 'سعر العبوة', 'سعر الصندوق',
      'prix du carton', 'prix colis', 'prix caisse', 'prix paquet',
    ],
  },
  {
    key: 'package_price_lbp',
    required: false,
    type: 'number',
    labelKey: 'imp_field_package_price_lbp',
    labelFallback: 'Package price (LBP)',
    aliases: [
      'package price lbp', 'carton price lbp', 'سعر الكرتون بالليرة',
      'prix du carton lbp', 'prix colis lbp',
    ],
  },
  {
    key: 'units_per_package',
    required: false,
    type: 'number',
    labelKey: 'imp_field_units_per_package',
    labelFallback: 'Units per package',
    aliases: [
      'units per package', 'units/pkg', 'pieces per package', 'pcs per carton', 'qty per package',
      'عدد الوحدات في الكرتون', 'الوحدات لكل عبوة', 'عدد القطع في الكرتون',
      'unités par colis', 'unites par colis', 'unités par carton',
    ],
  },
  {
    key: 'package_barcode',
    required: false,
    type: 'string',
    labelKey: 'imp_field_package_barcode',
    labelFallback: 'Package barcode',
    aliases: [
      'package barcode', 'carton barcode', 'box barcode', 'pack barcode',
      'باركود الكرتون', 'باركود العبوة', 'باركود الصندوق',
      'code-barres du carton', 'code barre carton', 'code-barres colis',
    ],
  },
  {
    key: 'min_price',
    required: false,
    type: 'number',
    labelKey: 'imp_field_min_price',
    labelFallback: 'Minimum price (USD)',
    aliases: [
      'min price', 'minimum price', 'lowest price', 'floor price',
      'الحد الأدنى للسعر', 'أقل سعر', 'الحد الأدنى للبيع',
      'prix minimum', 'prix min',
    ],
  },
  {
    key: 'stock',
    required: false,
    type: 'number',
    labelKey: 'imp_field_stock',
    labelFallback: 'Opening stock',
    aliases: [
      'stock', 'quantity', 'qty', 'opening stock', 'stock quantity', 'current stock',
      'الكمية', 'المخزون', 'الرصيد الافتتاحي', 'رصيد المخزون', 'كمية المخزون',
      'stock', 'quantité', 'quantite', 'quantité initiale', 'stock initial',
    ],
  },
  {
    key: 'reorder_point',
    required: false,
    type: 'number',
    labelKey: 'imp_field_reorder_point',
    labelFallback: 'Reorder point',
    aliases: [
      'reorder point', 'reorder level', 'min stock', 'minimum stock', 'low stock threshold',
      'حد إعادة الطلب', 'الحد الأدنى للمخزون', 'نقطة إعادة الطلب',
      'seuil de réapprovisionnement', 'stock minimum', 'seuil de reappro',
    ],
  },
  {
    key: 'track_inventory',
    required: false,
    type: 'boolean',
    labelKey: 'imp_field_track_inventory',
    labelFallback: 'Track inventory?',
    hintKey: 'imp_hint_yes_no',
    hintFallback: 'Yes/No',
    aliases: [
      'track inventory', 'is stocked', 'physical product', 'is service', 'service item',
      'تتبع المخزون', 'منتج مخزون', 'صنف خدمي', 'خدمة',
      'suivre le stock', 'article de service', 'produit physique',
    ],
  },
  {
    key: 'active',
    required: false,
    type: 'boolean',
    labelKey: 'imp_field_active',
    labelFallback: 'Active?',
    hintKey: 'imp_hint_yes_no',
    hintFallback: 'Yes/No',
    aliases: [
      'active', 'enabled', 'status', 'is active', 'is enabled',
      'نشط', 'فعال', 'مفعل', 'الحالة', 'مفعّل',
      'actif', 'activé', 'statut',
    ],
  },
];

// ---------------------------------------------------------------------------
// Customers / Suppliers
// ---------------------------------------------------------------------------

const PARTY_BASE_FIELDS: FieldDef[] = [
  {
    key: 'name',
    required: true,
    type: 'string',
    labelKey: 'imp_field_name',
    labelFallback: 'Name',
    aliases: [
      'customer name', 'supplier name', 'client name', 'customer', 'supplier', 'client', 'vendor',
      'اسم الزبون', 'اسم العميل', 'اسم المورد', 'الزبون', 'العميل', 'المورد', 'الاسم التجاري',
      'nom du client', 'nom du fournisseur', 'fournisseur', 'raison sociale',
      'name', 'full name', 'company name', 'customer name', 'supplier name', 'account name',
      'اسم', 'الاسم', 'اسم العميل', 'اسم المورد', 'اسم الشركة', 'اسم الحساب',
      'nom', 'nom complet', "nom de l'entreprise", 'nom du client', 'nom du fournisseur',
    ],
  },
  {
    key: 'phone',
    required: false,
    type: 'string',
    labelKey: 'imp_field_phone',
    labelFallback: 'Phone',
    aliases: [
      'phone', 'mobile', 'tel', 'telephone', 'phone number', 'contact number', 'whatsapp',
      'الهاتف', 'رقم الهاتف', 'جوال', 'رقم الجوال', 'موبايل',
      'téléphone', 'telephone', "numéro de téléphone", 'tél',
    ],
  },
  {
    key: 'email',
    required: false,
    type: 'string',
    labelKey: 'imp_field_email',
    labelFallback: 'Email',
    aliases: ['email', 'e-mail', 'email address', 'بريد إلكتروني', 'البريد الإلكتروني', 'ايميل', 'courriel', 'e-mail', 'adresse e-mail'],
  },
  {
    key: 'address',
    required: false,
    type: 'string',
    labelKey: 'imp_field_address',
    labelFallback: 'Address',
    aliases: ['address', 'location', 'العنوان', 'عنوان', 'الموقع', 'adresse', 'localisation'],
  },
  {
    key: 'credit_limit',
    required: false,
    type: 'number',
    labelKey: 'imp_field_credit_limit',
    labelFallback: 'Credit limit (USD)',
    aliases: [
      'credit limit', 'credit ceiling', 'max credit',
      'حد الائتمان', 'سقف الائتمان', 'الحد الائتماني', 'سقف الدين', 'حد الدين', 'الحد الأقصى للدين',
      'limite de crédit', 'limite de credit', 'plafond de crédit',
    ],
  },
  {
    key: 'opening_balance',
    required: false,
    type: 'number',
    labelKey: 'imp_field_opening_balance',
    labelFallback: 'Opening balance (USD)',
    hintKey: 'imp_hint_opening_balance',
    hintFallback: 'Positive = they owe you (supplier: you owe them). Negative = credit in their favour.',
    aliases: [
      'opening balance', 'balance', 'starting balance', 'initial balance', 'current balance',
      'الرصيد الافتتاحي', 'الرصيد', 'الرصيد الحالي', 'رصيد افتتاحي',
      'solde initial', 'solde', 'solde de départ', 'solde actuel',
    ],
  },
  {
    key: 'notes',
    required: false,
    type: 'string',
    labelKey: 'imp_field_notes',
    labelFallback: 'Notes',
    aliases: ['notes', 'remarks', 'comment', 'comments', 'ملاحظات', 'ملاحظة', 'remarques', 'commentaire', 'commentaires'],
  },
];

const PRICE_LEVEL_FIELD: FieldDef = {
  key: 'price_level',
  required: false,
  type: 'enum',
  labelKey: 'imp_field_price_level',
  labelFallback: 'Price level',
  hintKey: 'imp_hint_price_level',
  hintFallback: 'retail / wholesale / super_wholesale',
  aliases: [
    'price level', 'tier', 'level', 'pricing tier', 'customer level',
    'مستوى السعر', 'فئة السعر', 'مستوى التسعير', 'مستوى العميل',
    'niveau de prix', 'niveau', 'palier de prix',
  ],
};

// Customers get the price_level field (right after address); suppliers don't.
export const CUSTOMER_FIELDS: FieldDef[] = (() => {
  const idx = PARTY_BASE_FIELDS.findIndex((f) => f.key === 'address');
  const out = [...PARTY_BASE_FIELDS];
  out.splice(idx + 1, 0, PRICE_LEVEL_FIELD);
  return out;
})();

export const SUPPLIER_FIELDS: FieldDef[] = PARTY_BASE_FIELDS;

export function fieldsForEntity(entity: ImportEntity): FieldDef[] {
  if (entity === 'products') return PRODUCT_FIELDS;
  if (entity === 'customers') return CUSTOMER_FIELDS;
  return SUPPLIER_FIELDS;
}

/** price_level cell-value aliases -> canonical value, sent as-is to the server (which also
 * accepts these aliases per spec) — used only for the mapping preview, not required. */
export const PRICE_LEVEL_VALUE_ALIASES: Record<string, string> = {
  retail: 'retail', 'مفرق': 'retail', 'detail': 'retail', 'détail': 'retail',
  wholesale: 'wholesale', 'جملة': 'wholesale', gros: 'wholesale',
  super_wholesale: 'super_wholesale', 'جملة الجملة': 'super_wholesale', 'super gros': 'super_wholesale',
};

// ---------------------------------------------------------------------------
// Header normalization + auto-mapping
// ---------------------------------------------------------------------------

/** Lowercase, trim, strip punctuation/diacritics/tatweel, normalize Arabic alef/ya/ta-marbuta
 * variants, collapse whitespace. Used to compare sheet headers against the alias lists above. */
export function normalizeHeader(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).trim().toLowerCase();
  // Arabic diacritics (tashkeel) + tatweel
  s = s.replace(/[ً-ٰٟـ]/g, '');
  // Alef variants -> bare alef; ya/alef-maqsura -> ya; ta-marbuta -> ha
  s = s.replace(/[آأإٱ]/g, 'ا'); // آ أ إ ٱ -> ا
  s = s.replace(/[ىئ]/g, 'ي'); // ى ئ -> ي
  s = s.replace(/ة/g, 'ه'); // ة -> ه
  // Strip punctuation/symbols (keep letters/numbers/spaces across scripts), collapse whitespace
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // Arabic definite article: "سعر بالليرة" / "السعر بالليرة", "الباركود" / "باركود" must match the same
  // alias. Drop a leading "ال" (also after the prefixes ب / و / ل: "بال…", "وال…", "لل…") from words
  // long enough that it can't be part of the root.
  s = s.split(' ').map((w) => {
    if (w.length > 3 && w.startsWith('ال')) return w.slice(2);
    if (w.length > 4 && (w.startsWith('بال') || w.startsWith('وال'))) return w[0] + w.slice(3);
    return w;
  }).join(' ');
  return s;
}

export interface AutoMapResult {
  /** header (as given) -> field key, or null if no confident match / ignored. */
  mapping: Record<string, string | null>;
}

/**
 * Auto-map sheet headers to canonical field keys using the alias lists (case/diacritic/punctuation
 * -insensitive) plus any previously learned mapping (normalized header -> field key) from
 * localStorage. Exact normalized match only — avoids false positives from partial substrings.
 */
export function autoMapHeaders(
  headers: string[],
  fields: FieldDef[],
  learned?: Record<string, string>,
): Record<string, string | null> {
  const index = new Map<string, string>();
  // The template's own headers are each field's label (with its unit, e.g. "الرصيد الافتتاحي (دولار)")
  // in whatever language it was downloaded in — recognise those exact labels in EVERY language first,
  // so a filled-in template always maps completely, whichever language the importer now uses.
  const locales = importLocale as unknown as Record<string, Record<string, string>>;
  for (const f of fields) {
    for (const lang of Object.keys(locales)) {
      const label = locales[lang]?.[f.labelKey];
      const norm = normalizeHeader(label);
      if (norm && !index.has(norm)) index.set(norm, f.key);
    }
  }
  for (const f of fields) {
    const names = [f.key, f.labelFallback, ...f.aliases];
    for (const n of names) {
      const norm = normalizeHeader(n);
      if (norm && !index.has(norm)) index.set(norm, f.key);
    }
  }

  const result: Record<string, string | null> = {};
  const usedFields = new Set<string>();
  for (const header of headers) {
    const norm = normalizeHeader(header);
    let fieldKey: string | undefined = (learned && learned[norm]) || index.get(norm);
    if (fieldKey && usedFields.has(fieldKey)) fieldKey = undefined; // don't double-map a field
    result[header] = fieldKey || null;
    if (fieldKey) usedFields.add(fieldKey);
  }
  return result;
}

export const EXAMPLE_ROW_MARKERS: Record<string, string> = {
  en: 'e.g.',
  ar: 'مثال',
  fr: 'ex.',
};

/** True if a raw first-cell value marks the template's example row (any of the three languages,
 * so a file round-tripped between UI languages is still recognised). */
export function isExampleRowMarker(firstCell: unknown): boolean {
  if (firstCell === null || firstCell === undefined) return false;
  const s = String(firstCell).trim();
  return Object.values(EXAMPLE_ROW_MARKERS).some((m) => s.startsWith(m));
}

export const MAPPING_STORAGE_PREFIX = 'omnipos_import_mapping_';

export function loadLearnedMapping(entity: ImportEntity): Record<string, string> {
  try {
    const raw = localStorage.getItem(MAPPING_STORAGE_PREFIX + entity);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveLearnedMapping(entity: ImportEntity, mapping: Record<string, string>) {
  try {
    localStorage.setItem(MAPPING_STORAGE_PREFIX + entity, JSON.stringify(mapping));
  } catch {
    /* ignore (private mode / storage full) */
  }
}
