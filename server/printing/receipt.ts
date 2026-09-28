import { EscPos, paperWidthToColumns, type ArabicTextMode } from "./escpos.js";
import { encodeArabicLine, type ArabicEncoding } from "./arabic.js";

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
  stakeholder_address?: string;
  items: ReceiptItem[];
  total_amount: number;
  discount?: { type: 'percentage' | 'fixed'; value: number };
  payments?: ReceiptPayment[];
  // Store credit / balance display (docs/plans/2026-09-28-store-credit-and-levels.md section 2):
  // the stakeholder's CURRENT (post-transaction) balance and this transaction's own effect on it,
  // in the derived-balance sign convention (server/balance.ts) — negative = customer owes us.
  // Both undefined/null for Walk-in or a transaction with no stakeholder.
  stakeholder_balance?: number | null;
  balance_effect?: number | null;
}

// "$12.00 Due / مستحق" (negative) or "$12.00 Credit / رصيد دائن" (positive/zero) — bilingual so the
// line reads on a receipt whether the shop's customers read English or Arabic. Routed through
// p.kv() below, which already renders any Arabic text as an image on printers without a working
// Arabic code page (see server/printing/escpos.ts / arabic.ts) — no separate Arabic path needed.
function formatBalance(balance: number): string {
  const abs = Math.abs(balance).toFixed(2);
  return balance < 0 ? `$${abs} Due / مستحق` : `$${abs} Credit / رصيد دائن`;
}

export function buildReceiptBuffer(opts: {
  storeName?: string;
  businessAddress?: string;
  businessPhone?: string;
  receiptFooter?: string;
  paperWidth?: number;
  transaction: ReceiptTransaction;
  openDrawer?: boolean;
  arabic?: ArabicTextMode | null;
}): Buffer {
  const width = paperWidthToColumns(opts.paperWidth);
  const p = new EscPos(width, opts.arabic);
  const tx = opts.transaction;

  p.init();
  p.feed(2);
  p.align('center').bold(true);
  p.text(opts.storeName || 'Unnamed Business').feed(1);
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
  if (tx.stakeholder_name) p.labeled('Customer:', tx.stakeholder_name);
  if (tx.stakeholder_address) p.labeled('Address:', tx.stakeholder_address);
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

  // Previous / this / new balance, for a non-Walk-in customer/supplier with a known balance.
  if (tx.stakeholder_name && tx.stakeholder_name !== 'Walk-in Customer' && tx.stakeholder_balance != null && tx.balance_effect != null) {
    p.hr();
    const newBalance = tx.stakeholder_balance;
    const prevBalance = newBalance - tx.balance_effect;
    p.kv('Previous Balance', formatBalance(prevBalance));
    p.kv('This Invoice', formatBalance(tx.balance_effect));
    p.kv('New Balance', formatBalance(newBalance));
  }

  p.feed(1).align('center');
  // Feed well past the printer's print-head-to-cutter gap before cutting — too little feed
  // here (previously 3 lines) let the cutter fire before this footer line had fully cleared
  // it, so the footer ended up attached to the top of the *next* receipt instead of the
  // bottom of this one. This also keeps short (few-item) receipts from feeling cut-off short.
  p.text(opts.receiptFooter || 'Thank you for shopping with us!').feed(6);

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
  p.feed(2);
  p.align('center').bold(true);
  p.text(opts.storeName || 'Unnamed Business').feed(1);
  p.bold(false);
  p.text('--- TEST PRINT ---').feed(1);
  p.text(new Date().toLocaleString()).feed(1);
  p.hr();
  p.align('left');
  p.text(`Printer: ${opts.printerName}`).feed(1);
  p.text(`Connection: ${opts.connection}`).feed(1);
  p.text(`Paper width: ${opts.paperWidth || 80}mm (${width} cols)`).feed(6);
  p.cut();

  return p.toBuffer();
}

// Arabic code page numbers (ESC t n) differ between printer brands and firmware, so this prints
// one sample line per likely table and encoding. The cashier picks the line that reads correctly
// (joined letters, right to left) and enters its number and encoding in the printer settings.
export const ARABIC_TEST_CODEPAGES = [22, 27, 28, 32, 37, 40, 41, 50, 63, 64, 92];
const ARABIC_SAMPLE = 'مرحبا بكم - شارع الحمرا 12';

export function buildArabicTestBuffer(opts: { paperWidth?: number; codepages?: number[] }): Buffer {
  const p = new EscPos(paperWidthToColumns(opts.paperWidth));
  p.init().feed(1).align('center').bold(true).text('ARABIC CODE PAGE TEST').feed(1).bold(false);
  p.text('Pick the line that reads correctly,').feed(1);
  p.text('then enter its number and encoding').feed(1);
  p.text('in Settings > Printers > Arabic.').feed(1);
  p.hr().align('left');
  p.text('Reference (image):').feed(1);
  p.text(ARABIC_SAMPLE).feed(1);
  p.hr();
  for (const n of opts.codepages ?? ARABIC_TEST_CODEPAGES) {
    for (const encoding of ['cp864', 'cp1256'] as ArabicEncoding[]) {
      const bytes = encodeArabicLine(ARABIC_SAMPLE, encoding);
      if (!bytes) continue;
      p.text(`${String(n).padStart(3)} ${encoding === 'cp864' ? '864 ' : '1256'}: `);
      p.raw(Buffer.from([0x1B, 0x74, n & 0xFF])).raw(bytes).raw(Buffer.from([0x1B, 0x74, 0]));
      p.feed(1);
    }
  }
  p.feed(6).cut();
  return p.toBuffer();
}
