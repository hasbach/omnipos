import { EscPos, paperWidthToColumns } from "./escpos.js";

interface ReceiptItem {
  name?: string;
  product_name?: string;
  price?: number;
  unit_price?: number;
  quantity: number;
  discount?: { type: 'percentage' | 'fixed'; value: number };
}

interface ReceiptPayment {
  method: string;
  amount: number;
  currency: string;
}

interface ReceiptTransaction {
  id?: number;
  terminal_id?: string;
  terminal_sequence?: number;
  created_at?: string;
  stakeholder_name?: string;
  items: ReceiptItem[];
  total_amount: number;
  discount?: { type: 'percentage' | 'fixed'; value: number };
  payments?: ReceiptPayment[];
}

export function buildReceiptBuffer(opts: {
  storeName?: string;
  businessAddress?: string;
  businessPhone?: string;
  receiptFooter?: string;
  paperWidth?: number;
  transaction: ReceiptTransaction;
  openDrawer?: boolean;
}): Buffer {
  const width = paperWidthToColumns(opts.paperWidth);
  const p = new EscPos(width);
  const tx = opts.transaction;

  p.init();
  p.align('center').bold(true);
  p.text(opts.storeName || 'OmniPOS Retail').feed(1);
  p.bold(false);
  if (opts.businessAddress) p.text(opts.businessAddress).feed(1);
  if (opts.businessPhone) p.text(opts.businessPhone).feed(1);
  p.hr();

  const receiptNo = tx.terminal_id && tx.terminal_sequence
    ? `${tx.terminal_id}-${String(tx.terminal_sequence).padStart(4, '0')}`
    : `#${tx.id ?? 'N/A'}`;

  p.align('left');
  p.text(`Receipt: ${receiptNo}`).feed(1);
  p.text(`Date: ${tx.created_at ? new Date(tx.created_at).toLocaleString() : new Date().toLocaleString()}`).feed(1);
  if (tx.stakeholder_name) p.text(`Customer: ${tx.stakeholder_name}`).feed(1);
  p.hr();

  for (const item of tx.items || []) {
    const name = item.name || item.product_name || 'Item';
    const qty = item.quantity;
    const unitPrice = item.price ?? item.unit_price ?? 0;
    const lineTotal = (unitPrice * qty).toFixed(2);
    p.itemLine(name, qty, lineTotal);
    if (item.discount && item.discount.value > 0) {
      const disc = item.discount.type === 'percentage' ? `-${item.discount.value}%` : `-$${item.discount.value}`;
      p.text(`  Discount: ${disc}`).feed(1);
    }
  }

  p.hr();
  p.bold(true);
  p.kv('TOTAL', `$${Number(tx.total_amount || 0).toFixed(2)}`);
  p.bold(false);

  if (tx.discount && tx.discount.value > 0) {
    const disc = tx.discount.type === 'percentage' ? `${tx.discount.value}%` : `$${tx.discount.value}`;
    p.kv('Discount', disc);
  }

  if (Array.isArray(tx.payments) && tx.payments.length > 0) {
    p.hr();
    for (const pay of tx.payments) {
      p.kv(pay.method.toUpperCase(), `${Number(pay.amount).toFixed(2)} ${pay.currency}`);
    }
  }

  p.feed(1).align('center');
  p.text(opts.receiptFooter || 'Thank you for shopping with us!').feed(3);

  if (opts.openDrawer) {
    p.openDrawer(0);
  }

  p.cut();

  return p.toBuffer();
}

export function buildTestPrintBuffer(opts: { storeName?: string; printerName: string; connection: string; paperWidth?: number }): Buffer {
  const width = paperWidthToColumns(opts.paperWidth);
  const p = new EscPos(width);

  p.init();
  p.align('center').bold(true);
  p.text(opts.storeName || 'OmniPOS').feed(1);
  p.bold(false);
  p.text('--- TEST PRINT ---').feed(1);
  p.text(new Date().toLocaleString()).feed(1);
  p.hr();
  p.align('left');
  p.text(`Printer: ${opts.printerName}`).feed(1);
  p.text(`Connection: ${opts.connection}`).feed(1);
  p.text(`Paper width: ${opts.paperWidth || 80}mm (${width} cols)`).feed(3);
  p.cut();

  return p.toBuffer();
}
