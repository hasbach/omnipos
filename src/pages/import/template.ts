// Client-side Excel template generator ("OmniPOS-import-template.xlsx") for the data import wizard.
// Sheets: Products, Customers, Suppliers, Instructions. Header row + one example row per entity
// sheet, in the current UI language; price-level columns omitted from Products/Customers when
// price levels are disabled (src/lib/useSettings.ts priceLevelsEnabled).
import * as XLSX from 'xlsx';
import type { Translate } from '../../lib/format';
import type { Language } from '../../intl/index';
import {
  PRODUCT_FIELDS,
  CUSTOMER_FIELDS,
  SUPPLIER_FIELDS,
  EXAMPLE_ROW_MARKERS,
  type FieldDef,
} from './fields';

const PRICE_LEVEL_ONLY_KEYS = new Set([
  'price_wholesale',
  'price_wholesale_lbp',
  'price_super_wholesale',
  'price_super_wholesale_lbp',
  'price_level',
]);

function visibleFields(fields: FieldDef[], priceLevelsEnabled: boolean): FieldDef[] {
  if (priceLevelsEnabled) return fields;
  return fields.filter((f) => !PRICE_LEVEL_ONLY_KEYS.has(f.key));
}

// Example values shown in the template's second row, per field key. Kept in English/neutral form —
// the goal is just to show the expected shape, not to be translated per se.
const EXAMPLE_VALUES: Record<string, string | number> = {
  name: 'Coca Cola 330ml',
  barcode: '6001234567890',
  barcodes: '6001234567891, 6001234567892',
  category: 'Beverages',
  unit: 'pcs',
  cost: 0.4,
  price: 0.75,
  price_lbp: 67000,
  price_wholesale: 0.65,
  price_wholesale_lbp: 58000,
  price_super_wholesale: 0.6,
  price_super_wholesale_lbp: 54000,
  package_price: 18,
  package_price_lbp: 1620000,
  units_per_package: 24,
  package_barcode: '6001234567899',
  min_price: 0.55,
  stock: 100,
  reorder_point: 20,
  track_inventory: 'yes',
  phone: '+961 70 123 456',
  email: 'contact@example.com',
  address: 'Beirut, Lebanon',
  price_level: 'retail',
  credit_limit: 500,
  opening_balance: 120,
  notes: 'Preferred customer',
};

function marker(lang: Language): string {
  return EXAMPLE_ROW_MARKERS[lang] || EXAMPLE_ROW_MARKERS.en;
}

function buildSheet(
  fields: FieldDef[],
  t: Translate,
  lang: Language,
): XLSX.WorkSheet {
  const headers = fields.map((f) => t(f.labelKey, f.labelFallback));
  const exampleRow = fields.map((f, i) => {
    const v = EXAMPLE_VALUES[f.key] ?? '';
    if (i === 0) return `${marker(lang)} ${v}`.trim();
    return v;
  });

  const ws = XLSX.utils.aoa_to_sheet([headers, exampleRow]);
  ws['!cols'] = fields.map((f) => ({ wch: Math.max(14, t(f.labelKey, f.labelFallback).length + 4) }));
  return ws;
}

function buildInstructionsSheet(
  entities: { titleKey: string; titleFallback: string; fields: FieldDef[] }[],
  t: Translate,
): XLSX.WorkSheet {
  const rows: (string | number)[][] = [];
  rows.push([t('imp_instr_title', 'Import instructions')]);
  rows.push([]);
  rows.push([
    t('imp_instr_col_sheet', 'Sheet'),
    t('imp_instr_col_column', 'Column'),
    t('imp_instr_col_required', 'Required'),
    t('imp_instr_col_format', 'Format / notes'),
  ]);

  for (const { titleKey, titleFallback, fields } of entities) {
    const sheetName = t(titleKey, titleFallback);
    for (const f of fields) {
      const required = f.required ? t('imp_instr_required_yes', 'Required') : t('imp_instr_required_no', 'Optional');
      const format = f.hintKey ? t(f.hintKey, f.hintFallback || '') : '';
      rows.push([sheetName, t(f.labelKey, f.labelFallback), required, format]);
    }
  }

  rows.push([]);
  rows.push([t('imp_instr_general_title', 'General notes')]);
  rows.push([t('imp_instr_note_currency', 'Money amounts marked USD are US dollars; amounts marked LBP are the local currency. Leave a column empty if you do not use it.')]);
  rows.push([t('imp_instr_note_barcodes', 'Separate multiple barcodes in the "Extra barcodes" column with a comma (,), semicolon (;) or pipe (|).')]);
  rows.push([t('imp_instr_note_yesno', 'Yes/No columns accept: yes, no, 1, 0, true, false, نعم, لا, oui, non.')]);
  rows.push([t('imp_instr_note_balance', 'Opening balance: a positive number means the customer owes you (for suppliers: you owe them). A negative number is a credit in their favour.')]);
  rows.push([t('imp_instr_note_example_row', 'The second row of each sheet is an example — replace it with your own data (or delete it) before importing. Do not delete the header row.')]);
  rows.push([t('imp_instr_note_update', 'When updating existing records, leave a cell empty to keep the current value — only cells you fill in are changed.')]);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 14 }, { wch: 26 }, { wch: 12 }, { wch: 70 }];
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
  return ws;
}

export function downloadImportTemplate(t: Translate, lang: Language, priceLevelsEnabled: boolean) {
  const productFields = visibleFields(PRODUCT_FIELDS, priceLevelsEnabled);
  const customerFields = visibleFields(CUSTOMER_FIELDS, priceLevelsEnabled);
  const supplierFields = SUPPLIER_FIELDS; // no price-level columns regardless

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildSheet(productFields, t, lang), t('imp_sheet_products', 'Products'));
  XLSX.utils.book_append_sheet(wb, buildSheet(customerFields, t, lang), t('imp_sheet_customers', 'Customers'));
  XLSX.utils.book_append_sheet(wb, buildSheet(supplierFields, t, lang), t('imp_sheet_suppliers', 'Suppliers'));
  XLSX.utils.book_append_sheet(
    wb,
    buildInstructionsSheet(
      [
        { titleKey: 'imp_sheet_products', titleFallback: 'Products', fields: productFields },
        { titleKey: 'imp_sheet_customers', titleFallback: 'Customers', fields: customerFields },
        { titleKey: 'imp_sheet_suppliers', titleFallback: 'Suppliers', fields: supplierFields },
      ],
      t,
    ),
    t('imp_sheet_instructions', 'Instructions'),
  );

  XLSX.writeFile(wb, 'OmniPOS-import-template.xlsx');
}
