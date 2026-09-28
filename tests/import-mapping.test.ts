// Client-side column mapping of the import wizard (src/pages/import/fields.ts). The template writes
// each field's label (with its unit) in the language it was downloaded in, so a filled-in template
// must map every column back to the right field in every language — this is what broke silently
// before (e.g. "الرصيد الافتتاحي (دولار)" came back unmapped).
import { test } from "node:test";
import assert from "node:assert/strict";
import importLocale from "../src/intl/locales/import.js";
import { PRODUCT_FIELDS, CUSTOMER_FIELDS, SUPPLIER_FIELDS, autoMapHeaders, normalizeHeader } from "../src/pages/import/fields.js";

const locales = importLocale as unknown as Record<string, Record<string, string>>;
const entities = [["products", PRODUCT_FIELDS], ["customers", CUSTOMER_FIELDS], ["suppliers", SUPPLIER_FIELDS]] as const;

for (const lang of ["en", "ar", "fr"]) {
  test(`template headers (${lang}) map back to exactly their own fields`, () => {
    for (const [name, fields] of entities) {
      const headers = (fields as any[]).map((f) => locales[lang][f.labelKey] ?? f.labelFallback);
      const map = autoMapHeaders(headers, fields as any);
      (fields as any[]).forEach((f, i) => assert.equal(map[headers[i]], f.key, `${lang}/${name}: "${headers[i]}"`));
    }
  });
}

test("no alias of one field normalizes to another field's alias", () => {
  for (const [name, fields] of entities) {
    const seen = new Map<string, string>();
    for (const f of fields as any[]) {
      for (const a of [f.key, f.labelFallback, ...(f.aliases || []), ...Object.values(locales).map((l) => l[f.labelKey])]) {
        const n = normalizeHeader(a);
        if (!n) continue;
        const prev = seen.get(n);
        assert.ok(!prev || prev === f.key, `${name}: "${a}" is claimed by both ${prev} and ${f.key}`);
        seen.set(n, f.key);
      }
    }
  }
});

test("everyday Arabic, English and French headers map", () => {
  const products = autoMapHeaders(["الاسم", "باركود", "الفئة", "التكلفة", "سعر المبيع", "سعر بالليرة", "سعر الجملة", "المخزون"], PRODUCT_FIELDS as any);
  assert.deepEqual(Object.values(products), ["name", "barcode", "category", "cost", "price", "price_lbp", "price_wholesale", "stock"]);
  const en = autoMapHeaders(["Product Name", "Barcode", "Selling Price", "Cost Price", "Qty"], PRODUCT_FIELDS as any);
  assert.deepEqual(Object.values(en), ["name", "barcode", "price", "cost", "stock"]);
  const fr = autoMapHeaders(["Désignation", "Code-barres", "Prix de vente", "Quantité"], PRODUCT_FIELDS as any);
  assert.deepEqual(Object.values(fr), ["name", "barcode", "price", "stock"]);
  const customers = autoMapHeaders(["اسم الزبون", "الهاتف", "سقف الدين", "الرصيد الافتتاحي", "مستوى السعر"], CUSTOMER_FIELDS as any);
  assert.deepEqual(Object.values(customers), ["name", "phone", "credit_limit", "opening_balance", "price_level"]);
});
