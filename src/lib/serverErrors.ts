// Translates a server error into the active UI language.
//
// The server (server/routes.ts, server/invoiceEdit.ts) returns JSON shaped `{ error, code?, field?,
// ...extra }` on failure (see server/errors.ts — ValidationError / validationErrorBody). Some errors
// carry a stable `code` (CREDIT_LIMIT, STORE_CREDIT_EXCEEDED, STORE_CREDIT_WALKIN) we can key off
// directly; most validation errors don't have a code at all, so we match their (fixed) English text
// against the patterns below and rebuild a translated message from the captured numbers/ids.
//
// Accepts anything error-shaped: an Error thrown by src/lib/api.ts or src/pages/invoices/types.ts's
// ApiFieldError (both now carry `.code`/`.field`/`.available`), or a raw parsed fetch body
// `{ error, code, field, available }`.
import { formatMoney } from './format';

export type Translate = (key: string, fallback?: string) => string;

export interface ServerErrorLike {
  message?: string;
  error?: string;
  code?: string;
  field?: string;
  available?: number;
}

const USD = { code: 'USD', symbol: '$' };

function interpolate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(v);
  }
  return out;
}

interface TextPattern {
  re: RegExp;
  key: string;
  fallback: string;
  vars?: (m: RegExpMatchArray) => Record<string, string>;
}

// Ordered list of English-text patterns for the common uncoded validations thrown by
// server/routes.ts and server/invoiceEdit.ts. Order matters where one prefix is a substring of
// another (e.g. the two "Invalid payment method" patterns).
const TEXT_PATTERNS: TextPattern[] = [
  {
    re: /^Invalid refund quantity for product (\d+)\.$/,
    key: 'err_invalid_refund_qty',
    fallback: 'Invalid refund quantity for product {id}.',
    vars: (m) => ({ id: m[1] }),
  },
  {
    re: /^Product (\d+) was not part of the original sale\.$/,
    key: 'err_not_in_original_sale',
    fallback: 'Product {id} was not part of the original sale.',
    vars: (m) => ({ id: m[1] }),
  },
  {
    re: /^Cannot refund ([\d.]+) of product (\d+) — only ([\d.]+) remain eligible for refund\.$/,
    key: 'err_cannot_refund_remaining',
    fallback: 'Cannot refund {qty} of product {id} — only {remaining} remain eligible for refund.',
    vars: (m) => ({ qty: m[1], id: m[2], remaining: m[3] }),
  },
  {
    re: /^Product (\d+) has ([\d.]+) already refunded — the invoice can't hold less than that\.$/,
    key: 'err_already_refunded',
    fallback: "Product {id} has {qty} already refunded — the invoice can't hold less than that.",
    vars: (m) => ({ id: m[1], qty: m[2] }),
  },
  {
    re: /^A refund can't be edited/,
    key: 'err_refund_not_editable',
    fallback: "A refund can't be edited — refund the delta instead.",
  },
  {
    re: /^Store credit can't be used on a refund/,
    key: 'err_store_credit_on_refund',
    fallback: "Store credit can't be used on a refund.",
  },
  {
    re: /^Invalid payment method: (.+)\.$/,
    key: 'err_invalid_payment_method_named',
    fallback: 'Invalid payment method: {method}.',
    vars: (m) => ({ method: m[1] }),
  },
  {
    re: /^Invalid payment method/,
    key: 'err_invalid_payment_method',
    fallback: 'Invalid payment method.',
  },
  {
    re: /^Invalid payment amount/,
    key: 'err_invalid_payment_amount',
    fallback: 'Invalid payment amount.',
  },
  {
    re: /^Price for product (\d+) is below its minimum price of ([\d.]+)\.$/,
    key: 'err_below_min_price',
    fallback: 'Price for product {id} is below its minimum price of {min}.',
    vars: (m) => ({ id: m[1], min: m[2] }),
  },
  {
    re: /^Unit price is required for product (\d+)\.$/,
    key: 'err_unit_price_required',
    fallback: 'Unit price is required for product {id}.',
    vars: (m) => ({ id: m[1] }),
  },
  {
    re: /^An invoice must have at least one line item\.?$/,
    key: 'err_invoice_no_lines',
    fallback: 'An invoice must have at least one line item.',
  },
  {
    re: /^Only a sale can be refunded\.?$/,
    key: 'err_only_sale_refundable',
    fallback: 'Only a sale can be refunded.',
  },
  {
    re: /^Transaction not found\.?$/,
    key: 'err_transaction_not_found',
    fallback: 'Transaction not found.',
  },
  {
    re: /^Invalid invoice date\.?$/,
    key: 'err_invalid_invoice_date',
    fallback: 'Invalid invoice date.',
  },
  {
    re: /^This would exceed the credit limit \(([\d.]+)\)\.$/,
    key: 'err_credit_limit_amount',
    fallback: 'This would exceed the credit limit ({limit}).',
    vars: (m) => ({ limit: formatMoney(Number(m[1]) || 0, USD) }),
  },
];

/** Translate a server error into the active UI language. Returns the raw server text (or '') when
 * neither the `code` nor the English text is recognized — never throws. */
export function translateServerError(err: unknown, t: Translate): string {
  const e = (err || {}) as ServerErrorLike;
  const rawMessage = (typeof err === 'string' ? err : e.message || e.error || '') || '';

  if (e.code === 'STORE_CREDIT_WALKIN') {
    return t('err_store_credit_walkin', 'Walk-in Customer has no account balance to use.');
  }
  if (e.code === 'STORE_CREDIT_EXCEEDED') {
    const amount = formatMoney(e.available || 0, USD);
    return interpolate(t('err_store_credit_exceeded', 'Exceeds the available account balance ({amount}).'), { amount });
  }
  switch (e.code) {
    case 'BARCODE_TAKEN':
      return t('err_barcode_taken', 'This barcode is already used by another product or unit.');
    case 'UOM_FACTOR_INVALID':
      return t('err_uom_factor_invalid', 'A unit must contain more than 1 piece.');
    case 'UOM_FACTOR_DUPLICATE':
      return t('err_uom_factor_duplicate', 'Two units have the same size. Each unit needs a different quantity.');
    case 'UOM_PRICE_REQUIRED':
      return t('err_uom_price_required', 'Enter a price for this unit.');
    case 'UOM_NAME_REQUIRED':
      return t('err_uom_name_required', 'Enter a name for this unit.');
    case 'UOM_INVALID':
      return t('err_uom_invalid', 'This unit is no longer available for the product. Reload and try again.');
  }

  if (e.code === 'CREDIT_LIMIT') {
    // The credit-limit amount isn't carried as a separate field — it's embedded in the server's
    // own message text, so fall through to the text-pattern match below to extract and reformat it.
    const match = rawMessage.match(/^This would exceed the credit limit \(([\d.]+)\)\.$/);
    if (match) {
      return interpolate(t('err_credit_limit_amount', 'This would exceed the credit limit ({limit}).'), {
        limit: formatMoney(Number(match[1]) || 0, USD),
      });
    }
    return t('err_credit_limit', "This would exceed the customer's credit limit.");
  }

  for (const pattern of TEXT_PATTERNS) {
    const match = rawMessage.match(pattern.re);
    if (match) {
      const vars = pattern.vars ? pattern.vars(match) : {};
      return interpolate(t(pattern.key, pattern.fallback), vars);
    }
  }

  return rawMessage;
}

export default translateServerError;
