// Number formatting shared by the statement HTML and ESC/POS renderers.
import type { StatementLabels } from './printing/statementLabels.js';
import type { StatementItem } from './statement.js';

export function usd(n: number): string {
  const v = Math.abs(n) < 0.005 ? 0 : n;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** USD amount in the local currency at its current rate, e.g. "4,072,250 LL"; null for USD-only tenants. */
export function localAmount(usdAmount: number, cur: { code: string; symbol: string; rate: number } | null): string | null {
  if (!cur || !(cur.rate > 0)) return null;
  return `${Math.round(usdAmount * cur.rate).toLocaleString('en-US')} ${cur.symbol || cur.code}`;
}

/** "$12.00 Due" / "$12.00 We owe" (supplier) / "$3.00 Credit" / "$0.00 Settled". */
export function balanceText(balance: number, partyType: string, L: StatementLabels): string {
  if (Math.abs(balance) < 0.005) return `${usd(0)} ${L.balanceSettled}`;
  const word = balance < 0 ? (partyType === 'supplier' ? L.balanceWeOwe : L.balanceDue) : L.balanceCredit;
  return `${usd(Math.abs(balance))} ${word}`;
}

export function qtyText(q: number): string {
  return String(Math.round(q * 1000) / 1000);
}

/** "Water 0.5L - Carton x24" for a unit-of-measure line, else the product name. */
export function itemName(it: StatementItem): string {
  return it.unit ? `${it.name} - ${it.unit} x${it.factor}` : it.name;
}
