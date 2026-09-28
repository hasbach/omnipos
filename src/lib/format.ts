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

export function formatPercent(value: number, opts: { decimals?: number; locale?: string } = {}): string {
  const { decimals = 1, locale = 'en-US' } = opts;
  const n = Number.isFinite(value) ? value : 0;
  return `${formatNumber(n, { decimals, locale })}%`;
}

const DATE_LOCALE: Record<string, string> = { en: 'en-US', ar: 'ar-LB', fr: 'fr-FR' };

export function formatDate(value: string | Date, lang: string = 'en'): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(DATE_LOCALE[lang] || 'en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  }).format(d);
}

export function formatDateTime(value: string | Date, lang: string = 'en'): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(DATE_LOCALE[lang] || 'en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
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
