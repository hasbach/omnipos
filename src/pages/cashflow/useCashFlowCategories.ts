import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { CATEGORIES, CATEGORY_TYPES, builtinCategoryLabel, type Category } from './common';

export type CategoryDirection = 'in' | 'out' | 'both';

export interface CustomCashFlowCategory {
  id: number;
  key: string;
  name: string;
  direction: CategoryDirection;
  active: boolean;
  sort_order: number;
}

interface CategoriesPayload {
  builtin: { key: string; direction: CategoryDirection }[];
  custom: CustomCashFlowCategory[];
}

// One shared copy for every page and picker: fetched once, refetched when the server (or another
// register through sync) says the list changed.
let cache: CategoriesPayload | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function reloadCashFlowCategories(): Promise<void> {
  if (!inflight) {
    inflight = api.get<CategoriesPayload>('/api/cash-flow/categories')
      .then((res) => { if (res && Array.isArray(res.custom)) cache = res; })
      .catch(() => { /* no permission / offline: built-ins still work */ })
      .finally(() => { inflight = null; notify(); });
  }
  return inflight;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pos-sync', (e: any) => {
    if (e.detail?.type === 'CASH_FLOW_CATEGORIES_UPDATED') reloadCashFlowCategories();
  });
}

export interface CategoryOptionsOpts {
  /** Also offer this key even when it is hidden (the category an existing row already has). */
  include?: string | null;
  /** Offer every category, hidden ones too (filters over history). */
  all?: boolean;
}

/**
 * Cash-flow category list + label resolver. Built-ins keep their fixed keys and translated labels;
 * custom ones come from Settings and are identified by their key (what cash_flow.category stores).
 */
export function useCashFlowCategories() {
  const { t } = useI18n();
  const [, setTick] = useState(0);

  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    reloadCashFlowCategories(); // cheap + deduped; also picks up a tenant switch
    return () => { listeners.delete(l); };
  }, []);

  const custom = cache?.custom;
  const sorted = useMemo(
    () => [...(custom || [])].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [custom],
  );

  const label = useCallback((key: string | null | undefined): string => {
    const k = key || 'other';
    if ((CATEGORIES as readonly string[]).includes(k)) return builtinCategoryLabel(k as Category, t);
    const c = sorted.find((x) => x.key === k);
    if (c) return c.active ? c.name : `${c.name} ${t('cf_cat_hidden_suffix', '(hidden)')}`;
    return k;
  }, [sorted, t]);

  const allows = useCallback((key: string, type: 'in' | 'out'): boolean => {
    if ((CATEGORIES as readonly string[]).includes(key)) return CATEGORY_TYPES[key as Category].includes(type);
    const c = sorted.find((x) => x.key === key);
    return !!c && (c.direction === 'both' || c.direction === type);
  }, [sorted]);

  const options = useCallback((type?: 'in' | 'out', opts: CategoryOptionsOpts = {}) => {
    const built = CATEGORIES.filter((c) => !type || CATEGORY_TYPES[c].includes(type)).map((c) => c as string);
    const extra = sorted
      .filter((c) => (opts.all || c.active || c.key === opts.include) && (!type || c.direction === 'both' || c.direction === type))
      .map((c) => c.key);
    return [...built, ...extra].map((value) => ({ value, label: label(value) }));
  }, [sorted, label]);

  return { options, label, allows, all: cache, custom: sorted, loaded: cache !== null, reload: reloadCashFlowCategories };
}
