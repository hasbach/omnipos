import locales from '../../src/intl/locales/ownerSummary.js';
import { normalizeWhatsapp } from '../../storefront/src/phone.js';

export type SummaryLanguage = 'ar' | 'en' | 'fr';
export interface OwnerSummaryInput {
  date: string;
  licensed: boolean;
  sales: number;
  gross: number;
  net: number;
  saleCount: number;
  cash: number;
  local?: { code: string; rate: number } | null;
  free?: number;
  shortfall?: string | null;
  due?: number;
  reorder?: Array<{ name: string; days_of_supply: number }>;
  chase?: Array<{ name: string; amount_usd: number }>;
  alerts?: Partial<Record<'margin' | 'stale' | 'risk', { count: number; top: string }>>;
}

export function summaryLanguage(value: unknown): SummaryLanguage {
  return value === 'en' || value === 'fr' ? value : 'ar';
}

/** Plain data only; no database, clock, or side effects. One line per section keeps sharing brief. */
export function buildOwnerSummary(data: OwnerSummaryInput, language: SummaryLanguage = 'ar'): string {
  const t = (key: keyof typeof locales.ar) => locales[language][key];
  const clean = (value: string) => value.replace(/[\r\n\t]+/g, ' ').trim();
  const money = (amount: number) => `${amount < 0 ? '-' : ''}$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` + (data.local
    ? ` [${(amount * data.local.rate).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${data.local.code}]` : '');
  const lines = [
    `${t('os_title')} — ${data.date}`,
    `${t('os_sales')}: ${money(data.sales)}`,
    `${t('os_gross')}: ${money(data.gross)}`,
    `${t('os_net')}: ${money(data.net)}`,
    `${t('os_count')}: ${data.saleCount}`,
    `${t('os_cash')}: ${money(data.cash)}`,
  ];
  if (data.licensed) {
    if (data.free !== undefined) lines.push(`${t('os_free')}: ${money(data.free)}`);
    if (data.shortfall) lines.push(`${t('os_shortfall')}: ${data.shortfall}`);
    if (data.due && data.due > 0) lines.push(`${t('os_due')}: ${money(data.due)}`);
    if (data.reorder?.length) lines.push(`${t('os_reorder')}: ${data.reorder.slice(0, 3).map(p => `${clean(p.name)} (${p.days_of_supply > 0 ? `${p.days_of_supply.toFixed(1)} ${t('os_days')}` : t('os_out')})`).join(' • ')}`);
  }
  if (data.chase?.length) lines.push(`${t('os_chase')}: ${data.chase.slice(0, 3).map(p => `${clean(p.name)} ${money(p.amount_usd)}`).join(' • ')}`);
  if (data.licensed) for (const key of ['margin', 'stale', 'risk'] as const) {
    const alert = data.alerts?.[key];
    if (alert?.count) lines.push(`${t(`os_${key}`)}: ${alert.count} — ${clean(alert.top)}`);
  }
  return lines.join('\n');
}

export function ownerSummaryWhatsappUrl(text: string, phone?: string | null): string {
  const number = normalizeWhatsapp(phone)?.slice(1) || '';
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}
