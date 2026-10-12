// Printable statement page (A4 / PDF, or an 80 mm receipt layout for printers driven through Windows).
// Self-contained HTML (no scripts, no external assets) so it can be previewed in a sandboxed iframe and
// printed from an off-screen Electron window. System fonts carry Arabic; Chromium does the shaping.
import type { StatementDocument } from './statementDocument.js';
import { usd, localAmount, balanceText, qtyText, itemName } from './statementFormat.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const num = (s: string) => `<span class="n" dir="ltr">${esc(s)}</span>`;

function css(receipt: boolean): string {
  return `
@page { ${receipt ? 'size: 80mm auto; margin: 0;' : 'size: A4; margin: 12mm;'} }
* { box-sizing: border-box; }
html, body { background: #fff; color: #000; }
body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; margin: 0; font-size: 12px; line-height: 1.35; }
body.receipt { width: 72mm; margin: 0 auto; padding: 2mm 0; font-size: 11px; }
.n { unicode-bidi: isolate; white-space: nowrap; font-variant-numeric: tabular-nums; }
.head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.receipt .head { display: block; text-align: center; }
.head .doc { text-align: end; }
.receipt .head .doc { text-align: center; margin-top: 6px; }
h1 { font-size: 18px; margin: 0; } .receipt h1 { font-size: 14px; }
h2 { font-size: 15px; margin: 0; } .receipt h2 { font-size: 12px; }
.muted { color: #444; }
.party { margin: 10px 0; padding: 6px 0; border-top: 1px solid #000; border-bottom: 1px solid #000; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 3px 4px; text-align: start; vertical-align: top; }
th { border-bottom: 1px solid #000; font-weight: 600; }
.end { text-align: end; }
.line { display: flex; justify-content: space-between; gap: 8px; }
.order { border-bottom: 1px dashed #777; padding: 6px 0; break-inside: avoid; }
.order-head { display: flex; justify-content: space-between; font-weight: 600; gap: 8px; }
.badge { border: 1px solid #000; border-radius: 3px; padding: 0 4px; font-size: 10px; font-weight: 600; }
.sums { margin-top: 4px; margin-inline-start: auto; width: 55%; } .receipt .sums { width: 100%; }
.total { border-top: 2px solid #000; margin-top: 10px; padding-top: 6px; font-size: 15px; font-weight: 700; }
.receipt .total { font-size: 13px; }
tr.items td { font-size: 10.5px; color: #333; padding-top: 0; }
tr.items td:first-child { padding-inline-start: 18px; }
.mv { border-bottom: 1px dashed #999; padding: 3px 0; }
.sign { margin-top: 48px; }
.receipt .sign { margin-top: 28px; }
`;
}

export function renderStatementHtml(doc: StatementDocument, format: 'a4' | 'receipt'): string {
  const L = doc.labels;
  const receipt = format === 'receipt';
  const supplier = doc.party.type === 'supplier';
  const out: string[] = [];

  // Header
  out.push(`<div class="head"><div>
    <h1>${esc(doc.business.name || L.unnamedBusiness)}</h1>
    ${doc.business.address ? `<div class="muted">${esc(doc.business.address)}</div>` : ''}
    ${doc.business.phone ? `<div class="muted">${num(doc.business.phone)}</div>` : ''}
  </div><div class="doc">
    <h2>${esc(L.title)}</h2>
    <div>${esc(doc.mode === 'open' ? L.unpaidOrders : L.accountActivity)}</div>
    ${doc.activity ? `<div>${esc(L.period)}: ${num(`${doc.activity.from_label} – ${doc.activity.to_label}`)}</div>` : ''}
    <div class="muted">${esc(L.printed)}: ${num(doc.printed_at)}</div>
  </div></div>`);
  out.push(`<div class="party">
    <div><b>${esc(supplier ? L.supplier : L.customer)}:</b> ${esc(doc.party.name)}</div>
    ${doc.party.address ? `<div>${esc(L.address)}: ${esc(doc.party.address)}</div>` : ''}
    ${doc.party.phone ? `<div>${esc(L.phone)}: ${num(doc.party.phone)}</div>` : ''}
  </div>`);

  const local = (amount: number) => localAmount(amount, doc.local_currency);

  if (doc.open) {
    const o = doc.open;
    if (!o.orders.length && o.previous_balance <= 0.005) {
      out.push(`<p><b>${esc(L.noUnpaid)}</b></p>`);
      if (o.credit > 0.005) out.push(`<div class="line"><span>${esc(L.creditBalance)}</span>${num(usd(o.credit))}</div>`);
    } else {
      if (o.previous_balance > 0.005) {
        out.push(`<div class="line order"><b>${esc(L.previousBalance)}</b>${num(usd(o.previous_balance))}</div>`);
      }
      for (const ord of o.orders) {
        const head = receipt
          ? `<tr><th>${esc(L.product)}</th><th class="end">${esc(L.qty)}</th><th class="end">${esc(L.total)}</th></tr>`
          : `<tr><th>${esc(L.product)}</th><th>${esc(L.unit)}</th><th class="end">${esc(L.qty)}</th><th class="end">${esc(L.price)}</th><th class="end">${esc(L.total)}</th></tr>`;
        const lines = ord.items.map((it) => {
          const disc = it.discount ? ` <span class="muted">(${esc(L.discount)} ${num(it.discount.type === 'percentage' ? `${it.discount.value}%` : usd(it.discount.value))})</span>` : '';
          return receipt
            ? `<tr><td>${esc(itemName(it))}${disc}</td><td class="end">${num(qtyText(it.qty))}</td><td class="end">${num(usd(it.line_total))}</td></tr>`
            : `<tr><td>${esc(it.name)}${disc}</td><td>${esc(it.unit ? `${it.unit} x${it.factor}` : '')}</td><td class="end">${num(qtyText(it.qty))}</td><td class="end">${num(usd(it.unit_price))}</td><td class="end">${num(usd(it.line_total))}</td></tr>`;
        }).join('');
        out.push(`<div class="order">
          <div class="order-head"><span>${num(ord.reference)} · ${num(ord.date_label)}</span><span class="badge">${esc(ord.status === 'partial' ? L.partial : L.unpaid)}</span></div>
          <table>${head}${lines}</table>
          <table class="sums">
            <tr><td>${esc(L.orderTotal)}</td><td class="end">${num(usd(ord.total))}</td></tr>
            ${ord.discount ? `<tr><td>${esc(L.discount)}</td><td class="end">${num(ord.discount.type === 'percentage' ? `${ord.discount.value}%` : usd(ord.discount.value))}</td></tr>` : ''}
            ${ord.paid > 0.005 ? `<tr><td>${esc(L.paid)}</td><td class="end">${num(usd(ord.paid))}</td></tr>` : ''}
            <tr><td><b>${esc(L.remaining)}</b></td><td class="end"><b>${num(usd(ord.remaining))}</b></td></tr>
          </table>
        </div>`);
      }
      const lc = local(o.total_due);
      out.push(`<div class="total"><div class="line"><span>${esc(supplier ? L.totalWeOwe : L.totalDue)}</span>${num(usd(o.total_due))}</div>
        ${lc ? `<div class="line"><span></span>${num(`≈ ${lc}`)}</div>` : ''}</div>`);
    }
  }

  if (doc.activity) {
    const a = doc.activity;
    const amt = (r: { debit: number; credit: number }) => (r.debit ? usd(r.debit) : r.credit ? usd(r.credit) : '');
    if (receipt) {
      out.push(`<div class="line mv"><b>${esc(L.openingBalance)}</b>${num(balanceText(a.opening, doc.party.type, L))}</div>`);
      if (!a.rows.length) out.push(`<p>${esc(L.noActivity)}</p>`);
      for (const r of a.rows) {
        const items = (r.items || []).map((it) => `<div class="line muted"><span>&nbsp;&nbsp;${esc(itemName(it))} × ${num(qtyText(it.qty))}</span>${num(usd(it.line_total))}</div>`).join('');
        out.push(`<div class="mv">
          <div class="line"><span>${num(r.date_label.slice(0, 10))} ${num(r.reference)}</span>${num(balanceText(r.balance, doc.party.type, L))}</div>
          <div class="line"><span>${esc(r.label)}${r.original_label ? ` (${num(r.original_label)})` : ''}</span><span>${esc(r.debit ? L.debit : r.credit ? L.credit : '')} ${num(amt(r))}</span></div>
          ${items}</div>`);
      }
    } else {
      const rows = a.rows.map((r) => {
        const items = (r.items || []).map((it) => `<tr class="items"><td colspan="3">${esc(itemName(it))} — ${num(qtyText(it.qty))} × ${num(usd(it.unit_price))}</td><td class="end" colspan="2">${num(usd(it.line_total))}</td><td></td></tr>`).join('');
        return `<tr><td>${num(r.date_label)}</td><td>${num(r.reference)}</td><td>${esc(r.label)}${r.original_label ? ` <span class="muted">(${num(r.original_label)})</span>` : ''}</td>
          <td class="end">${r.debit ? num(usd(r.debit)) : ''}</td><td class="end">${r.credit ? num(usd(r.credit)) : ''}</td><td class="end">${num(balanceText(r.balance, doc.party.type, L))}</td></tr>${items}`;
      }).join('');
      out.push(`<table>
        <tr><th>${esc(L.date)}</th><th>${esc(L.ref)}</th><th>${esc(L.description)}</th><th class="end">${esc(L.debit)}</th><th class="end">${esc(L.credit)}</th><th class="end">${esc(L.balance)}</th></tr>
        <tr><td colspan="5"><b>${esc(L.openingBalance)}</b></td><td class="end"><b>${num(balanceText(a.opening, doc.party.type, L))}</b></td></tr>
        ${rows || `<tr><td colspan="6">${esc(L.noActivity)}</td></tr>`}
        <tr><td colspan="3"><b>${esc(L.totalDebit)} / ${esc(L.totalCredit)}</b></td><td class="end"><b>${num(usd(a.total_debit))}</b></td><td class="end"><b>${num(usd(a.total_credit))}</b></td><td></td></tr>
      </table>`);
    }
    const lc = local(Math.abs(a.closing));
    out.push(`<div class="total"><div class="line"><span>${esc(L.closingBalance)}</span>${num(balanceText(a.closing, doc.party.type, L))}</div>
      ${lc && Math.abs(a.closing) >= 0.005 ? `<div class="line"><span></span>${num(`≈ ${lc}`)}</div>` : ''}</div>`);
  }

  out.push(`<div class="sign">${esc(L.signature)}: ____________________</div>`);

  const rtl = doc.business.language === 'ar';
  return `<!doctype html><html lang="${doc.business.language}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${esc(L.title)} - ${esc(doc.party.name)}</title><style>${css(receipt)}</style></head><body class="${receipt ? 'receipt' : 'a4'}">${out.join('\n')}</body></html>`;
}
