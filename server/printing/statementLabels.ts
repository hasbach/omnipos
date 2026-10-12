// Fixed strings printed on customer / supplier statements (A4 / PDF HTML and ESC/POS receipt), in the
// store's language (settings key `language`). Arabic layout/shaping is handled by the renderers.
export type StatementLanguage = 'en' | 'ar' | 'fr';

export interface StatementLabels {
  title: string; unpaidOrders: string; accountActivity: string; printed: string; period: string;
  customer: string; supplier: string; address: string; phone: string; walkIn: string; unnamedBusiness: string;
  previousBalance: string; unpaid: string; partial: string;
  product: string; unit: string; qty: string; price: string; total: string; discount: string;
  orderTotal: string; paid: string; remaining: string; totalDue: string; totalWeOwe: string;
  noUnpaid: string; creditBalance: string;
  date: string; ref: string; description: string; debit: string; credit: string; balance: string;
  openingBalance: string; closingBalance: string; totalDebit: string; totalCredit: string; noActivity: string;
  balanceDue: string; balanceWeOwe: string; balanceCredit: string; balanceSettled: string;
  signature: string;
  kinds: Record<string, string>;
  methods: Record<string, string>; // payment methods in sentence case (receipts print them in capitals)
}

const en: StatementLabels = {
  title: 'Statement of account', unpaidOrders: 'Unpaid orders', accountActivity: 'Account activity', printed: 'Printed', period: 'Period',
  customer: 'Customer', supplier: 'Supplier', address: 'Address', phone: 'Phone', walkIn: 'Walk-in customer', unnamedBusiness: 'Unnamed Business',
  previousBalance: 'Previous balance', unpaid: 'Unpaid', partial: 'Partially paid',
  product: 'Product', unit: 'Unit', qty: 'Qty', price: 'Price', total: 'Total', discount: 'Discount',
  orderTotal: 'Order total', paid: 'Paid', remaining: 'Remaining', totalDue: 'Total due', totalWeOwe: 'Total we owe',
  noUnpaid: 'No unpaid orders', creditBalance: 'Credit balance',
  date: 'Date', ref: 'Ref', description: 'Description', debit: 'Debit', credit: 'Credit', balance: 'Balance',
  openingBalance: 'Opening balance', closingBalance: 'Closing balance', totalDebit: 'Total debit', totalCredit: 'Total credit', noActivity: 'No activity in this period',
  balanceDue: 'Due', balanceWeOwe: 'We owe', balanceCredit: 'Credit', balanceSettled: 'Settled',
  signature: 'Signature',
  kinds: {
    opening: 'Opening balance & earlier adjustments', sale: 'Sale', refund: 'Refund', purchase: 'Purchase', payment: 'Payment',
    refund_payment: 'Refund paid out', on_account: 'On account', balance_collection: 'Balance collection',
    supplier_payment: 'Supplier payment', manual_edit: 'Manual edit', import: 'Import',
  },
  methods: { cash: 'Cash', card: 'Card', credit: 'On account', store_credit: 'From balance' },
};

const ar: StatementLabels = {
  title: 'كشف حساب', unpaidOrders: 'الطلبات غير المدفوعة', accountActivity: 'حركة الحساب', printed: 'تاريخ الطباعة', period: 'الفترة',
  customer: 'الزبون', supplier: 'المورد', address: 'العنوان', phone: 'الهاتف', walkIn: 'زبون عابر', unnamedBusiness: 'متجر بدون اسم',
  previousBalance: 'رصيد سابق', unpaid: 'غير مدفوع', partial: 'مدفوع جزئياً',
  product: 'المنتج', unit: 'الوحدة', qty: 'الكمية', price: 'السعر', total: 'المجموع', discount: 'خصم',
  orderTotal: 'مجموع الطلب', paid: 'المدفوع', remaining: 'المتبقي', totalDue: 'المبلغ المستحق', totalWeOwe: 'المبلغ المستحق علينا',
  noUnpaid: 'لا توجد طلبات غير مدفوعة', creditBalance: 'رصيد دائن',
  date: 'التاريخ', ref: 'المرجع', description: 'البيان', debit: 'مدين', credit: 'دائن', balance: 'الرصيد',
  openingBalance: 'الرصيد الافتتاحي', closingBalance: 'الرصيد الختامي', totalDebit: 'مجموع المدين', totalCredit: 'مجموع الدائن', noActivity: 'لا توجد حركة في هذه الفترة',
  balanceDue: 'مستحق', balanceWeOwe: 'علينا', balanceCredit: 'دائن', balanceSettled: 'مسدد',
  signature: 'التوقيع',
  kinds: {
    opening: 'رصيد افتتاحي وتعديلات سابقة', sale: 'بيع', refund: 'مرتجع', purchase: 'شراء', payment: 'دفعة',
    refund_payment: 'رد مبلغ مرتجع', on_account: 'على الحساب', balance_collection: 'تحصيل رصيد',
    supplier_payment: 'دفعة للمورد', manual_edit: 'تعديل يدوي', import: 'استيراد',
  },
  methods: { cash: 'نقداً', card: 'بطاقة', credit: 'على الحساب', store_credit: 'من الرصيد' },
};

const fr: StatementLabels = {
  title: 'Relevé de compte', unpaidOrders: 'Commandes impayées', accountActivity: 'Mouvements du compte', printed: 'Imprimé le', period: 'Période',
  customer: 'Client', supplier: 'Fournisseur', address: 'Adresse', phone: 'Téléphone', walkIn: 'Client de passage', unnamedBusiness: 'Commerce sans nom',
  previousBalance: 'Solde antérieur', unpaid: 'Impayée', partial: 'Partiellement payée',
  product: 'Produit', unit: 'Unité', qty: 'Qté', price: 'Prix', total: 'Total', discount: 'Remise',
  orderTotal: 'Total commande', paid: 'Payé', remaining: 'Reste', totalDue: 'Total dû', totalWeOwe: 'Total que nous devons',
  noUnpaid: 'Aucune commande impayée', creditBalance: 'Solde créditeur',
  date: 'Date', ref: 'Réf', description: 'Libellé', debit: 'Débit', credit: 'Crédit', balance: 'Solde',
  openingBalance: 'Solde d’ouverture', closingBalance: 'Solde de clôture', totalDebit: 'Total débit', totalCredit: 'Total crédit', noActivity: 'Aucun mouvement sur cette période',
  balanceDue: 'Dû', balanceWeOwe: 'Nous devons', balanceCredit: 'Crédit', balanceSettled: 'Soldé',
  signature: 'Signature',
  kinds: {
    opening: 'Solde d’ouverture et ajustements antérieurs', sale: 'Vente', refund: 'Remboursement', purchase: 'Achat', payment: 'Paiement',
    refund_payment: 'Remboursement versé', on_account: 'Sur compte', balance_collection: 'Encaissement de solde',
    supplier_payment: 'Paiement fournisseur', manual_edit: 'Modification manuelle', import: 'Import',
  },
  methods: { cash: 'Espèces', card: 'Carte', credit: 'Sur compte', store_credit: 'Depuis le solde' },
};

export function statementLabels(lang?: string | null): StatementLabels {
  return lang === 'ar' ? ar : lang === 'fr' ? fr : en;
}
