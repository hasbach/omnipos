import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card } from '../../components/ui';

export type Translate = (key: string, fallback?: string) => string;

export const CATEGORIES = [
  'top_up', 'loan_in', 'loan_repayment', 'owner_withdrawal', 'expense',
  'supplier_payment', 'customer_collection', 'other',
] as const;
export type Category = typeof CATEGORIES[number];

/** Which cash direction a category may take (mirrors server/cashFlow.ts). */
export const CATEGORY_TYPES: Record<Category, Array<'in' | 'out'>> = {
  top_up: ['in'], loan_in: ['in'], customer_collection: ['in'],
  loan_repayment: ['out'], owner_withdrawal: ['out'], expense: ['out'], supplier_payment: ['out'],
  other: ['in', 'out'],
};

const CATEGORY_FALLBACK: Record<Category, string> = {
  top_up: 'Top-up (owner adds float)', loan_in: 'Loan received', loan_repayment: 'Loan repayment',
  owner_withdrawal: 'Owner withdrawal', expense: 'Expense', supplier_payment: 'Supplier payment',
  customer_collection: 'Customer collection', other: 'Other',
};

export function categoryLabel(c: string | null | undefined, t: Translate): string {
  const key = (CATEGORIES as readonly string[]).includes(c || '') ? (c as Category) : 'other';
  return t(`cf_cat_${key}`, CATEGORY_FALLBACK[key]);
}

export function categoryOptions(t: Translate, type?: 'in' | 'out') {
  return CATEGORIES.filter((c) => !type || CATEGORY_TYPES[c].includes(type)).map((c) => ({ value: c, label: categoryLabel(c, t) }));
}

export interface CashFlowRow {
  id: number;
  type: 'in' | 'out';
  amount: number;
  currency: string;
  exchange_rate: number;
  category?: string | null;
  counterparty?: string | null;
  reason: string;
  created_at: string;
  edited?: boolean;
  archived?: boolean;
  user_name?: string | null;
  amount_usd?: number;
}

/** Server error code -> localized text; falls back to the server's own message. */
export function cashFlowErrorMessage(err: any, t: Translate): string {
  switch (err?.code) {
    case 'CASHFLOW_EDIT_REASON_REQUIRED': return t('cf_err_reason_required', 'Enter a reason for the edit (at least 3 characters).');
    case 'CASHFLOW_NO_CHANGES': return t('cf_err_no_changes', 'Nothing was changed.');
    case 'CASHFLOW_CATEGORY_INVALID': return t('cf_err_category_invalid', 'Choose a valid category.');
    case 'CASHFLOW_CATEGORY_TYPE_MISMATCH': return t('cf_err_category_type', 'This category does not match cash in / cash out.');
    case 'CASHFLOW_AMOUNT_INVALID': return t('cf_err_amount', 'Enter an amount greater than zero.');
    case 'CASHFLOW_RATE_INVALID': return t('cf_err_rate', 'Enter an exchange rate greater than zero.');
    case 'CASHFLOW_NOT_FOUND': return t('cf_err_not_found', 'This entry no longer exists.');
  }
  return err?.message || String(err);
}

/**
 * Shrinks a text (a money value) until it fits its box on one line — never truncated. The CSS
 * container-query size is only the starting point; this loop guarantees the fit for any width,
 * currency (LBP figures are 6+ digits longer than USD) and script (Arabic digits, RTL).
 */
export function useFitText<T extends HTMLElement>(dep: unknown, max = 28, min = 11) {
  const box = useRef<HTMLDivElement | null>(null);
  const text = useRef<T | null>(null);

  const fit = useCallback(() => {
    const b = box.current;
    const el = text.current;
    if (!b || !el || b.clientWidth === 0) return;
    el.style.whiteSpace = 'nowrap';
    el.style.wordBreak = 'normal';
    let size = max;
    el.style.fontSize = `${size}px`;
    while (size > min && el.scrollWidth > b.clientWidth) {
      size -= 1;
      el.style.fontSize = `${size}px`;
    }
    // Still too wide at the minimum: wrap rather than cut the number off.
    if (el.scrollWidth > b.clientWidth) {
      el.style.whiteSpace = 'normal';
      el.style.wordBreak = 'break-all';
    }
  }, [max, min]);

  useLayoutEffect(() => { fit(); }, [fit, dep]);
  useEffect(() => {
    const b = box.current;
    if (!b || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(b);
    (document as any).fonts?.ready?.then?.(fit);
    return () => ro.disconnect();
  }, [fit]);

  return { box, text };
}

interface FitStatProps {
  label: string;
  value: string;
  icon?: LucideIcon;
  sub?: string;
  tone?: 'default' | 'success' | 'danger' | 'accent';
  className?: string;
}

const TONE: Record<NonNullable<FitStatProps['tone']>, string> = {
  default: 'text-text', success: 'text-success', danger: 'text-danger', accent: 'text-accent',
};

/** Stat card whose figure auto-shrinks to its card width. Use inside a multi-row grid, never one long row. */
export function FitStat({ label, value, icon: Icon, sub, tone = 'default', className = '' }: FitStatProps) {
  const { box, text } = useFitText<HTMLSpanElement>(value);
  return (
    <Card className={['min-w-0 p-3.5', className].join(' ')}>
      <div className="flex items-start justify-between gap-2">
        {/* Labels may wrap to two lines; only the money figure is guaranteed single-line. */}
        <p className="min-w-0 text-xs font-medium uppercase leading-tight tracking-[0.04em] text-text-3">{label}</p>
        {Icon && (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
            <Icon size={14} aria-hidden="true" />
          </span>
        )}
      </div>
      <div ref={box} className="mt-2 w-full min-w-0" style={{ containerType: 'inline-size' }}>
        <span
          ref={text}
          dir="ltr"
          className={['num inline-block font-bold leading-tight', TONE[tone]].join(' ')}
          style={{ fontSize: 'clamp(0.75rem, 11cqi, 1.75rem)' }}
        >
          {value}
        </span>
      </div>
      {sub && <p className="mt-1 text-xs text-text-3">{sub}</p>}
    </Card>
  );
}

/** Two-row-friendly grid: 2 cols on phones, 3 on tablets, 4 on desktops (never a single long row). */
export const STAT_GRID = 'grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4';
