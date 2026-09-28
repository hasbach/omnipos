// Formatting helpers shared across the back-office UI.
// Kept dependency-free (Intl only) so it works offline in Electron.

export interface CurrencyLike {
  code: string;
  symbol: string;
  rate?: number;
}

export interface FormatMoneyOpts {
  /** Force a specific decimal count instead of the rate-based heuristic. */
  decimals?: number;
  /** Show the currency code instead of the symbol (e.g. "1,234.50 USD"). */
  showCode?: boolean;
  /** Hide the currency marker entirely, just format the number. */
  hideCurrency?: boolean;
  /** Locale for digit grouping. Defaults to 'en-US' (Western digits everywhere, incl. Arabic UI). */
  locale?: string;
}

/**
 * LBP-like currencies (rate > 100 vs USD) are conventionally shown with 0 decimals;
 * "hard" currencies (USD, EUR-like, rate <= 100) use 2 decimals.
 */
function decimalsFor(currency?: CurrencyLike, override?: number): number {
  if (typeof override === 'number') return override;
  const rate = currency?.rate ?? 1;
  return rate > 100 ? 0 : 2;
}

export function formatNumber(value: number, opts: { decimals?: number; locale?: string } = {}): string {
  const { decimals = 2, locale = 'en-US' } = opts;
  const n = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

export function formatMoney(amount: number, currency?: CurrencyLike, opts: FormatMoneyOpts = {}): string {
  const { showCode, hideCurrency, locale = 'en-US' } = opts;
  const decimals = decimalsFor(currency, opts.decimals);
  const n = Number.isFinite(amount) ? amount : 0;
  const numStr = formatNumber(Math.abs(n), { decimals, locale });
  const sign = n < 0 ? '-' : '';

  if (hideCurrency || !currency) return `${sign}${numStr}`;

  const marker = showCode ? currency.code : (currency.symbol || currency.code);
  return `${sign}${marker} ${numStr}`;
}

export type Translate = (key: string, fallback?: string) => string;

/**
 * Balance sign convention (shared across POS, invoice editor, stakeholder pages): negative = the
 * party owes us / we owe the supplier ("Due"); positive = credit in their favour ("Credit").
 * Returns the formatted absolute amount plus a human label and a color variant to apply.
 */
export function formatBalance(
  balance: number,
  currency: CurrencyLike | undefined,
  t: Translate,
): { amount: string; label: string; variant: 'danger' | 'success' | 'neutral' } {
  const n = Number.isFinite(balance) ? balance : 0;
  if (n < -0.005) {
    return { amount: formatMoney(Math.abs(n), currency), label: t('bal_due', 'Due'), variant: 'danger' };
  }
  if (n > 0.005) {
    return { amount: formatMoney(n, currency), label: t('bal_credit', 'Credit'), variant: 'success' };
  }
  return { amount: formatMoney(0, currency), label: t('bal_settled', 'Settled'), variant: 'neutral' };
}

/** Human label for a payment method, including the new `store_credit` ("From account balance"). */
export function paymentMethodLabel(method: string, t: Translate): string {
  switch (method) {
    case 'cash':
      return t('pm_cash', 'Cash');
    case 'card':
      return t('pm_card', 'Card');
    case 'credit':
      return t('pm_credit', 'Credit');
    case 'store_credit':
      return t('pm_store_credit', 'From account balance');
    default:
      return method;
  }
}

/** Human label for a transaction type (sale/refund/purchase), used wherever `.type` is rendered raw. */
export function transactionTypeLabel(type: string, t: Translate): string {
  switch (type) {
    case 'sale':
      return t('tx_type_sale', 'Sale');
    case 'refund':
      return t('tx_type_refund', 'Refund');
    case 'purchase':
      return t('tx_type_purchase', 'Purchase');
    default:
      return type;
  }
}

/** Human label for a transaction/invoice payment status (paid/partial/unpaid/completed…). */
export function transactionStatusLabel(status: string, t: Translate): string {
  switch (status) {
    case 'paid':
      return t('tx_status_paid', 'Paid');
    case 'partial':
      return t('tx_status_partial', 'Partial');
    case 'unpaid':
      return t('tx_status_unpaid', 'Unpaid');
    case 'completed':
      return t('tx_status_completed', 'Completed');
    default:
      return status;
  }
}

/** Human label for a user role (admin/manager/staff/cashier/accountant…), used on the lock screen,
 * the users page and the top bar. Shares the `usr_role_*` keys src/pages/UserManagement.tsx already
 * defines (see src/intl/locales/admin.ts) so a role is translated the same way everywhere. */
export function userRoleLabel(role: string, t: Translate): string {
  if (!role) return role;
  return t(`usr_role_${role}`, role.charAt(0).toUpperCase() + role.slice(1));
}

// Fixed English `action` strings server/routes.ts writes via logAction(...) (see the user-logs
// endpoint) — the raw text is stored as-is in the DB, so the Logs page (src/pages/UserLogs.tsx)
// translates it for display only; filtering still happens against the raw stored value.
const LOG_ACTION_KEYS: Record<string, string> = {
  'Stakeholder Deleted': 'log_action_stakeholder_deleted',
  'Stakeholder Created': 'log_action_stakeholder_created',
  'Stakeholder Updated': 'log_action_stakeholder_updated',
  'Bulk Import': 'log_action_bulk_import',
  'Bulk Price Update': 'log_action_bulk_price_update',
  'Debt Payment Received': 'log_action_debt_payment_received',
  'Printer Added': 'log_action_printer_added',
  'Printer Deleted': 'log_action_printer_deleted',
  'Printer Updated': 'log_action_printer_updated',
  'Product Created': 'log_action_product_created',
  'Product Deleted': 'log_action_product_deleted',
  'Product Updated': 'log_action_product_updated',
  'Purchase Received': 'log_action_purchase_received',
  'Settings Updated': 'log_action_settings_updated',
  'Transaction Deleted': 'log_action_transaction_deleted',
  'Transaction Edited': 'log_action_transaction_edited',
  'Cashier Cash Out': 'log_action_cashier_cash_out',
  'Daily Report Created': 'log_action_daily_report_created',
  'Stock Adjusted': 'log_action_stock_adjusted',
  'Yearly Report Created': 'log_action_yearly_report_created',
  'End of Day Settlement': 'log_action_end_of_day_settlement',
  'Cash In': 'log_action_cash_in',
  'Cash Out': 'log_action_cash_out',
  'Balance Collection': 'log_action_balance_collection',
  'Balance Payment': 'log_action_balance_payment',
};

/** Human label for a stakeholder's type (customer/supplier), used in inline parenthetical labels
 * like a dropdown option "{name} ({type})". */
export function stakeholderTypeLabel(type: string, t: Translate): string {
  if (type === 'customer') return t('stk_type_customer', 'Customer');
  if (type === 'supplier') return t('stk_type_supplier', 'Supplier');
  return type;
}

export function logActionLabel(action: string, t: Translate): string {
  if (!action) return action;
  if (action.startsWith('Transaction: ')) {
    const type = action.slice('Transaction: '.length);
    return `${t('log_action_transaction', 'Transaction')}: ${transactionTypeLabel(type, t)}`;
  }
  const key = LOG_ACTION_KEYS[action];
  return key ? t(key, action) : action;
}

export function formatPercent(value: number, opts: { decimals?: number; locale?: string } = {}): string {
  const { decimals = 1, locale = 'en-US' } = opts;
  const n = Number.isFinite(value) ? value : 0;
  return `${formatNumber(n, { decimals, locale })}%`;
}

const DATE_LOCALE: Record<string, string> = { en: 'en-US', ar: 'ar-LB', fr: 'fr-FR' };

// Arabic locales (ar-LB included, depending on the host's ICU data) can render Eastern Arabic-Indic
// digits (٠١٢٣…) by default. Money/quantities/dates stay in Western digits everywhere in this app
// (see MASTER.md), so every date/time formatter below forces `numberingSystem: 'latn'` — this only
// affects the digits, not the (correctly localized) month names / ص-م day period / weekday names.
function dateLocaleFor(lang: string): string {
  return DATE_LOCALE[lang] || 'en-US';
}

export function formatDate(value: string | Date, lang: string = 'en'): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(dateLocaleFor(lang), {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    numberingSystem: 'latn',
  }).format(d);
}

export function formatDateTime(value: string | Date, lang: string = 'en'): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(dateLocaleFor(lang), {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    numberingSystem: 'latn',
  }).format(d);
}

/** Time-only formatter (e.g. POS daily-history time column, receipt timestamps) — same locale-aware
 * month/period naming as formatDate/formatDateTime, Western digits, optionally with seconds. */
export function formatTime(value: string | Date, lang: string = 'en', opts: { seconds?: boolean } = {}): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(dateLocaleFor(lang), {
    hour: '2-digit',
    minute: '2-digit',
    ...(opts.seconds ? { second: '2-digit' } : {}),
    numberingSystem: 'latn',
  }).format(d);
}

/** Today's date as a local (not UTC) YYYY-MM-DD string. */
export function localToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function toLocalYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface DateRange {
  from: string;
  to: string;
}

export type DateRangePreset =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'this_month'
  | 'last_month'
  | 'this_year'
  | 'custom';

/** Resolve a named preset into a local {from,to} YYYY-MM-DD range (inclusive). */
export function resolveDateRangePreset(preset: DateRangePreset, now: Date = new Date()): DateRange {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const startOfWeek = (d: Date) => {
    const day = d.getDay(); // 0 = Sunday
    const s = new Date(d);
    s.setDate(d.getDate() - day);
    return s;
  };

  switch (preset) {
    case 'today':
      return { from: toLocalYMD(today), to: toLocalYMD(today) };
    case 'yesterday': {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      return { from: toLocalYMD(y), to: toLocalYMD(y) };
    }
    case 'this_week': {
      const s = startOfWeek(today);
      return { from: toLocalYMD(s), to: toLocalYMD(today) };
    }
    case 'this_month': {
      const s = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: toLocalYMD(s), to: toLocalYMD(today) };
    }
    case 'last_month': {
      const s = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const e = new Date(today.getFullYear(), today.getMonth(), 0);
      return { from: toLocalYMD(s), to: toLocalYMD(e) };
    }
    case 'this_year': {
      const s = new Date(today.getFullYear(), 0, 1);
      return { from: toLocalYMD(s), to: toLocalYMD(today) };
    }
    case 'custom':
    default:
      return { from: toLocalYMD(today), to: toLocalYMD(today) };
  }
}
