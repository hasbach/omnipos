// Fixed receipt strings, translated for the store's own language (settings key `language`:
// 'en' | 'ar' | 'fr', default 'en' — see server/routes.ts getSettingsMap and /api/print/receipt).
// An Arabic label is plain data: the Arabic text/RTL layout (raster image, or printer code page
// when the printer has one configured) is handled entirely by server/printing/escpos.ts's
// text()/kv()/labeled(), which already detect embedded Arabic in whatever string they're given —
// this module only needs to hand them the right string for the language.
export type ReceiptLanguage = 'en' | 'ar' | 'fr';

export interface ReceiptLabels {
  receiptTitle: string;      // "Receipt:" prefix before the receipt/invoice number
  refundTitle: string;       // same, for a refund transaction
  date: string;
  cashier: string;
  customer: string;
  walkIn: string;             // display name for the tenant's built-in walk-in customer record
  address: string;
  itemQty: string;           // item table column headers (not currently printed, kept for completeness)
  itemPrice: string;
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  totalLocal: string;        // prefix of the local-currency total line, followed by the currency symbol ("Total LL")
  paid: string;
  change: string;
  due: string;
  currency: string;
  previousBalance: string;
  thisInvoice: string;
  newBalance: string;
  balanceDue: string;        // the balance word itself: negative balance ("$12.00 Due")
  balanceCredit: string;     // positive balance ("$12.00 Credit")
  balanceSettled: string;    // exactly zero ("$0.00 Settled")
  footerDefault: string;
  unnamedBusiness: string;
  paymentMethods: {
    cash: string;
    card: string;
    credit: string;          // "on account" — settlesInvoice() === false, server/paymentMethods.ts
    store_credit: string;    // paid from the stakeholder's own positive balance
  };
}

const LABELS: Record<ReceiptLanguage, ReceiptLabels> = {
  en: {
    receiptTitle: 'Receipt',
    refundTitle: 'Refund',
    date: 'Date',
    cashier: 'Cashier',
    customer: 'Customer',
    walkIn: 'Walk-in Customer',
    address: 'Address',
    itemQty: 'Qty',
    itemPrice: 'Price',
    subtotal: 'Subtotal',
    discount: 'Discount',
    tax: 'Tax',
    total: 'TOTAL',
    totalLocal: 'Total',
    paid: 'Paid',
    change: 'Change',
    due: 'Due',
    currency: 'Currency',
    previousBalance: 'Previous Balance',
    thisInvoice: 'This Invoice',
    newBalance: 'New Balance',
    balanceDue: 'Due',
    balanceCredit: 'Credit',
    balanceSettled: 'Settled',
    footerDefault: 'Thank you for shopping with us!',
    unnamedBusiness: 'Unnamed Business',
    // Kept as the raw method name uppercased, exactly like the receipt printed before language
    // support existed, so an English (default) receipt stays byte-identical.
    paymentMethods: { cash: 'CASH', card: 'CARD', credit: 'ON ACCOUNT', store_credit: 'FROM BALANCE' },
  },
  ar: {
    receiptTitle: 'إيصال',
    refundTitle: 'مرتجع',
    date: 'التاريخ',
    cashier: 'الكاشير',
    customer: 'الزبون',
    walkIn: 'زبون عابر',
    address: 'العنوان',
    itemQty: 'الكمية',
    itemPrice: 'السعر',
    subtotal: 'المجموع الفرعي',
    discount: 'الخصم',
    tax: 'الضريبة',
    total: 'المجموع',
    totalLocal: 'المجموع بـ',
    paid: 'المدفوع',
    change: 'الباقي',
    due: 'المستحق',
    currency: 'العملة',
    previousBalance: 'الرصيد السابق',
    thisInvoice: 'هذه الفاتورة',
    newBalance: 'الرصيد الجديد',
    balanceDue: 'مستحق',
    balanceCredit: 'رصيد دائن',
    balanceSettled: 'مسدد',
    footerDefault: 'شكراً لزيارتكم',
    unnamedBusiness: 'نشاط تجاري بدون اسم',
    paymentMethods: { cash: 'نقدي', card: 'بطاقة', credit: 'على الحساب', store_credit: 'من الرصيد' },
  },
  fr: {
    receiptTitle: 'Reçu',
    refundTitle: 'Remboursement',
    date: 'Date',
    cashier: 'Caissier',
    customer: 'Client',
    walkIn: 'Client de passage',
    address: 'Adresse',
    itemQty: 'Qté',
    itemPrice: 'Prix',
    subtotal: 'Sous-total',
    discount: 'Remise',
    tax: 'Taxe',
    total: 'TOTAL',
    totalLocal: 'Total en',
    paid: 'Payé',
    change: 'Monnaie',
    due: 'Solde dû',
    currency: 'Devise',
    previousBalance: 'Solde précédent',
    thisInvoice: 'Cette facture',
    newBalance: 'Nouveau solde',
    balanceDue: 'Dû',
    balanceCredit: 'Crédit',
    balanceSettled: 'Soldé',
    footerDefault: 'Merci pour votre achat !',
    unnamedBusiness: 'Entreprise sans nom',
    paymentMethods: { cash: 'ESPÈCES', card: 'CARTE', credit: 'COMPTE CLIENT', store_credit: 'SOLDE CLIENT' },
  },
};

export function receiptLabels(language?: string | null): ReceiptLabels {
  return LABELS[language === 'ar' || language === 'fr' ? language : 'en'];
}

// The label shown for a payment row (`pay.method` from the `payments`/`archived_payments` table:
// cash | card | credit | store_credit — server/paymentMethods.ts). An unrecognized/legacy method
// name is shown as-is, uppercased, same as the pre-i18n fallback.
export function paymentMethodLabel(language: string | null | undefined, method: string): string {
  const labels = receiptLabels(language);
  const known = (labels.paymentMethods as Record<string, string>)[method];
  return known ?? method.toUpperCase();
}
