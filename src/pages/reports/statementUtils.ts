import { formatMoney, formatBalance } from '../../lib/format';

interface CurrencyInfo { code: string; symbol: string; rate?: number }

/**
 * For a statement payment row paid in a non-USD currency, the original amount in its own currency
 * (e.g. "895,000 LL"); null for USD / rows without an original amount. `credit` is always USD.
 */
export function originalAmountLabel(
  row: { currency?: string | null; amount_original?: number | null },
  currencies: CurrencyInfo[],
): string | null {
  const code = row.currency;
  if (!code || code === 'USD' || row.amount_original == null) return null;
  const cur = currencies.find((c) => c.code === code);
  return formatMoney(row.amount_original, { code, symbol: cur?.symbol || code, rate: cur?.rate });
}

type Tr = (key: string, fallback?: string) => string;

const KIND_KEYS: Record<string, [string, string]> = {
  opening: ['rep_kind_opening', 'Opening balance & earlier adjustments'],
  sale: ['rep_kind_sale', 'Sale'],
  refund: ['rep_kind_refund', 'Refund'],
  purchase: ['rep_kind_purchase', 'Purchase'],
  payment: ['rep_kind_payment', 'Payment'],
  refund_payment: ['rep_kind_refund_payment', 'Refund payment'],
  on_account: ['rep_kind_on_account', 'On account'],
  balance_collection: ['rep_kind_balance_collection', 'Balance collection'],
  supplier_payment: ['rep_kind_supplier_payment', 'Supplier payment'],
  manual_edit: ['rep_kind_manual_edit', 'Manual edit'],
  import: ['rep_kind_import', 'Import'],
};

/** Localised label for a statement row type. */
export function statementKindLabel(type: string, t: Tr): string {
  const e = KIND_KEYS[type];
  return e ? t(e[0], e[1]) : type;
}

/** Localised description: the reconciling opening row is translated; others keep the server text. */
export function statementDescription(row: { type: string; description: string }, t: Tr): string {
  if (row.type === 'opening') return t('rep_kind_opening', row.description);
  return row.description;
}

/** Balance as plain text, e.g. "$12.00 Due" / "$3.00 Credit" / "$0.00 Settled" (for Excel/PDF exports). */
export function balanceText(balance: number, t: Tr): string {
  const b = formatBalance(balance, { code: 'USD', symbol: '$' }, t);
  return `${b.amount} ${b.label}`;
}

export function balanceColorClass(balance: number): string {
  if (balance < -0.005) return 'text-danger';
  if (balance > 0.005) return 'text-success';
  return 'text-text-2';
}
