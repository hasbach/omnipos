// Customer / supplier statement on a thermal receipt printer. Same EscPos helpers as sale receipts, so
// Arabic names, addresses and products go through the same raster-image / code-page path.
import { EscPos, needsRaster, paperWidthToColumns, type ArabicTextMode } from "./escpos.js";
import type { StatementDocument } from "../statementDocument.js";
import { usd, localAmount, balanceText, itemName } from "../statementFormat.js";

// EscPos.text falls back to latin1, so anything above U+00FF would print as a control byte, and C0/C1
// control characters (ESC, GS, ...) in a party name or address would reach the printer as commands.
// Line breaks / tabs become a space (plain spaces are kept: EscPos pads kv / item columns with them).
// RTL text keeps its letters (EscPos rasterizes / code-pages it); everything else gets ASCII look-alikes,
// then '?'. Escapes only: the source must stay plain ASCII.
const LOOKALIKES: Record<string, string> = {
  '\u2014': '-', '\u2013': '-', '\u2019': "'", '\u2018': "'", '\u00b4': "'",
  '\u201c': '"', '\u201d': '"', '\u00ab': '"', '\u00bb': '"', '\u00d7': 'x', '\u2026': '...', '\u2248': '~',
};
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
export function latinSafe(s: string): string {
  const flat = String(s ?? '').replace(/[^\S ]+/g, ' ');
  if (needsRaster(flat)) return flat.replace(CONTROL, '?');
  return flat.replace(/[^\x20-\x7e\xa0-\xff]|[\xab\xbb\xb4\xd7]/g, (c) => LOOKALIKES[c] ?? '?');
}

class SafeEscPos extends EscPos {
  text(str: string) { return super.text(latinSafe(str)); }
  kv(label: string, value: string) { return super.kv(latinSafe(label), latinSafe(value)); }
  labeled(label: string, value: string) { return super.labeled(latinSafe(label), latinSafe(value)); }
  itemLine(name: string, qty: number, total: string) { return super.itemLine(latinSafe(name), qty, latinSafe(total)); }
}

export function buildStatementBuffer(opts: { doc: StatementDocument; paperWidth?: number; arabic?: ArabicTextMode | null }): Buffer {
  const { doc } = opts;
  const L = doc.labels;
  const p = new SafeEscPos(paperWidthToColumns(opts.paperWidth), opts.arabic);

  p.init();
  p.feed(2);
  p.align('center').bold(true);
  p.text(doc.business.name || L.unnamedBusiness).feed(1);
  p.bold(false);
  if (doc.business.address) p.text(doc.business.address).feed(1);
  if (doc.business.phone) p.text(doc.business.phone).feed(1);
  p.bold(true).text(L.title).feed(1).bold(false);
  p.text(doc.mode === 'open' ? L.unpaidOrders : L.accountActivity).feed(1);
  if (doc.activity) p.text(`${doc.activity.from_label} - ${doc.activity.to_label}`).feed(1);
  p.text(`${L.printed}: ${doc.printed_at}`).feed(1);
  p.hr();

  p.align('left');
  p.labeled(`${doc.party.type === 'supplier' ? L.supplier : L.customer}:`, doc.party.name);
  if (doc.party.address) p.labeled(`${L.address}:`, doc.party.address);
  if (doc.party.phone) p.labeled(`${L.phone}:`, doc.party.phone);
  p.hr();

  if (doc.open) {
    const o = doc.open;
    if (!o.orders.length && o.previous_balance <= 0.005) {
      p.text(L.noUnpaid).feed(1);
      if (o.credit > 0.005) p.kv(L.creditBalance, usd(o.credit));
    } else {
      if (o.previous_balance > 0.005) { p.kv(L.previousBalance, usd(o.previous_balance)); p.hr(); }
      for (const ord of o.orders) {
        p.bold(true);
        p.kv(`${ord.reference} ${ord.date_label.slice(0, 10)}`, ord.status === 'partial' ? L.partial : L.unpaid);
        p.bold(false);
        for (const it of ord.items) p.itemLine(itemName(it), it.qty, usd(it.line_total));
        p.kv(`  ${L.orderTotal}`, usd(ord.total));
        if (ord.returned > 0.005) p.kv(`  ${L.returned}`, usd(ord.returned));
        if (ord.paid > 0.005) p.kv(`  ${L.paid}`, usd(ord.paid));
        p.kv(`  ${L.remaining}`, usd(ord.remaining));
        p.hr();
      }
      p.bold(true);
      p.kv(doc.party.type === 'supplier' ? L.totalWeOwe : L.totalDue, usd(o.total_due));
      p.bold(false);
      const lc = localAmount(o.total_due, doc.local_currency);
      if (lc) p.kv('', `~ ${lc}`);
    }
  }

  if (doc.activity) {
    const a = doc.activity;
    p.kv(L.openingBalance, balanceText(a.opening, doc.party.type, L));
    p.hr();
    if (!a.rows.length) p.text(L.noActivity).feed(1);
    for (const r of a.rows) {
      p.kv(`${r.date_label.slice(0, 10)} ${r.reference}`, balanceText(r.balance, doc.party.type, L));
      const amount = r.debit ? `${L.debit} ${usd(r.debit)}` : r.credit ? `${L.credit} ${usd(r.credit)}` : '';
      p.kv(`  ${r.label}${r.original_label ? ` (${r.original_label})` : ''}`, amount);
      for (const it of r.items || []) p.itemLine(`  ${itemName(it)}`, it.qty, usd(it.line_total));
    }
    p.hr();
    p.bold(true);
    p.kv(L.closingBalance, balanceText(a.closing, doc.party.type, L));
    p.bold(false);
    const lc = Math.abs(a.closing) >= 0.005 ? localAmount(Math.abs(a.closing), doc.local_currency) : null;
    if (lc) p.kv('', `~ ${lc}`);
  }

  p.feed(1);
  p.text(`${L.signature}: ______________`).feed(6);
  p.cut();
  return p.toBuffer();
}
