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
  cost?: number;
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
    case 'BELOW_COST':
      return t('err_below_cost', 'The price is below the product cost.');
    case 'INSUFFICIENT_STOCK':
      return interpolate(t('err_insufficient_stock', 'Only {n} pcs in stock.'), {
        n: String(Math.max(0, Math.floor((e.available ?? 0) * 1000) / 1000)),
      });
    case 'PRODUCT_DISABLED':
      return t('err_product_disabled', 'This product is disabled.');
    case 'RESET_SCOPE_INVALID':
      return t('err_reset_scope_invalid', 'Choose at least one kind of data to delete.');
    case 'RESET_SCOPE_DEPENDENCY':
      return t('err_reset_scope_dependency', 'Deleting products or customers and suppliers also requires deleting all transactions.');
    case 'RESET_CONFIRM_REQUIRED':
      return t('err_reset_confirm_required', 'Type DELETE (in capitals) to confirm.');
    case 'RESET_PIN_INVALID':
      return t('err_reset_pin_invalid', 'Incorrect admin PIN.');
    case 'RESET_BACKUP_FAILED':
      return t('err_reset_backup_failed', 'The safety backup could not be created, so nothing was deleted.');
    case 'RESET_NEEDS_CLOUD':
      return t('err_reset_needs_cloud', 'Connect to the internet and log in, then retry. The cloud copy must be deleted too.');
    case 'RESET_CLOUD_FAILED':
      return t('err_reset_cloud_failed', 'The cloud copy could not be deleted. Nothing was deleted on this computer. Check the connection and retry.');
    case 'RESET_IN_PROGRESS':
      return t('err_reset_in_progress', 'A reset is already running.');
    case 'CORRECTION_REASON_REQUIRED':
      return t('err_correction_reason_required', 'Enter a reason of at least 3 characters.');
    case 'CORRECTION_PIN_INVALID':
      return t('err_correction_pin_invalid', 'Incorrect admin PIN.');
    case 'CORRECTION_KIND_INVALID':
      return t('err_correction_kind_invalid', 'Choose what kind of correction to make.');
    case 'CORRECTION_AMOUNT_INVALID':
      return t('err_correction_amount_invalid', 'Enter a valid amount.');
    case 'CASHFLOW_CATEGORY_NAME_TAKEN':
      return t('cf_err_cat_name_taken', 'A category with this name already exists.');
    case 'CASHFLOW_CATEGORY_NAME_INVALID':
      return t('cf_err_cat_name_invalid', 'The name must be 1 to 40 characters.');
    case 'CASHFLOW_CATEGORY_DIRECTION_INVALID':
      return t('cf_err_cat_direction_invalid', 'Choose cash in, cash out or both.');
    case 'CASHFLOW_CATEGORY_DIRECTION_IN_USE':
      return t('cf_err_cat_direction_in_use', 'Movements of the opposite type already use this category, so its direction cannot be narrowed.');
    case 'CASHFLOW_CATEGORY_NOT_FOUND':
      return t('cf_err_cat_not_found', 'This category no longer exists.');
    case 'INVALID_RATE':
      return t('err_invalid_rate', 'The exchange rate must be a number greater than zero.');
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
