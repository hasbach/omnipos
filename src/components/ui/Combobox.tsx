import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { useI18n } from '../../intl/index';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Right-aligned secondary text (phone, balance...). Also searched. */
  secondary?: string;
  /** Extra text matched by the search but not displayed. */
  keywords?: string;
  disabled?: boolean;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Optional pinned first item (e.g. "All customers") selected with `allOption.value`. */
  allOption?: { value: string; label: string };
  /** Show an X to reset (to allOption.value, or '' when there is no All item). */
  clearable?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
  /** Max rows rendered at once (search narrows the rest). Default 100. */
  maxVisible?: number;
  autoFocus?: boolean;
}

/**
 * Case-, diacritic- and Arabic-variant-insensitive normalisation (alef/hamza forms, ya/alef-maqsura,
 * taa marbuta, tashkeel, tatweel; Arabic-Indic digits -> ASCII). Same idea as import/fields.normalizeHeader
 * but keeps punctuation (phone numbers) and does not strip the definite article.
 */
export function normalizeSearch(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).toLowerCase();
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); // latin accents
  s = s.replace(/[ً-ٰٟـ]/g, ''); // tashkeel + tatweel
  s = s.replace(/[آأإٱ]/g, 'ا'); // alef variants -> alef
  s = s.replace(/[ىئ]/g, 'ي'); // alef maqsura / hamza-on-ya -> ya
  s = s.replace(/ة/g, 'ه'); // taa marbuta -> ha
  s = s.replace(/ؤ/g, 'و'); // hamza-on-waw -> waw
  s = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  return s.replace(/\s+/g, ' ').trim();
}

export function Combobox({
  options, value, onChange, placeholder, allOption, clearable, invalid, disabled,
  className = '', id, maxVisible = 100, autoFocus, ...rest
}: ComboboxProps) {
  const { t } = useI18n();
  const uid = useId();
  const listId = `${uid}-list`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const selected = useMemo(() => options.find((o) => o.value === value) || null, [options, value]);
  const allSelected = !!allOption && value === allOption.value;
  const displayLabel = selected ? selected.label : allSelected ? allOption!.label : '';

  // Pre-normalise once per options change so typing stays instant with thousands of rows.
  const indexed = useMemo(
    () => options.map((o) => ({ o, hay: normalizeSearch(`${o.label} ${o.secondary || ''} ${o.keywords || ''}`) })),
    [options],
  );

  const { items, total } = useMemo(() => {
    const q = normalizeSearch(query);
    const tokens = q ? q.split(' ') : [];
    const matched = tokens.length ? indexed.filter((x) => tokens.every((tok) => x.hay.includes(tok))).map((x) => x.o) : options;
    const all: ComboboxOption[] = allOption && !q ? [{ value: allOption.value, label: allOption.label }] : [];
    return { items: [...all, ...matched.slice(0, maxVisible)], total: matched.length };
  }, [query, indexed, options, allOption, maxVisible]);

  const close = useCallback(() => { setOpen(false); setQuery(''); }, []);

  const commit = useCallback((v: string) => {
    onChange(v);
    close();
  }, [onChange, close]);

  // Highlight the current selection when opening; reset on query change.
  useEffect(() => {
    if (!open) return;
    const idx = query ? 0 : Math.max(0, items.findIndex((i) => i.value === value));
    setActive(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  const move = (delta: number) => {
    if (!items.length) return;
    let i = active;
    for (let n = 0; n < items.length; n++) {
      i = (i + delta + items.length) % items.length;
      if (!items[i].disabled) break;
    }
    setActive(i);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); if (!open) setOpen(true); else move(1); break;
      case 'ArrowUp': e.preventDefault(); if (!open) setOpen(true); else move(-1); break;
      case 'Home': if (open) { e.preventDefault(); setActive(0); } break;
      case 'End': if (open) { e.preventDefault(); setActive(Math.max(0, items.length - 1)); } break;
      case 'Enter':
        if (open) {
          e.preventDefault();
          const it = items[active];
          if (it && !it.disabled) commit(it.value);
        }
        break;
      case 'Escape':
        if (open) { e.preventDefault(); e.stopPropagation(); close(); }
        break;
      case 'Tab': if (open) close(); break;
    }
  };

  const showClear = clearable && !disabled && !!value && !(allOption && value === allOption.value);
  const activeId = open && items[active] ? `${uid}-opt-${active}` : undefined;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-invalid={invalid || undefined}
        aria-label={rest['aria-label']}
        autoComplete="off"
        autoFocus={autoFocus}
        disabled={disabled}
        value={open ? query : displayLabel}
        placeholder={open && displayLabel ? displayLabel : placeholder}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); }}
        onKeyDown={onKeyDown}
        className={[
          'h-9 w-full rounded-[var(--radius-input)] border bg-surface ps-3 text-sm text-text outline-none',
          showClear ? 'pe-14' : 'pe-8',
          'transition-colors duration-150 placeholder:text-text-3',
          'focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed',
          invalid ? 'border-danger' : 'border-border',
        ].join(' ')}
      />
      {showClear && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('ui_clear', 'Clear')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onChange(allOption ? allOption.value : ''); close(); }}
          className="absolute end-7 top-1/2 -translate-y-1/2 rounded p-1 text-text-3 hover:text-text cursor-pointer"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
      <ChevronDown
        size={16}
        aria-hidden="true"
        className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-text-3"
      />
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-40 mt-1 max-h-60 min-w-full w-max max-w-[28rem] overflow-y-auto rounded-[var(--radius-card)] border border-border bg-surface py-1 shadow-[var(--shadow-modal)]"
        >
          {items.length === 0 && (
            <li role="presentation" className="px-3 py-2 text-sm text-text-3">{t('ui_no_results', 'No results')}</li>
          )}
          {items.map((it, idx) => {
            const isSel = it.value === value;
            return (
              <li
                key={`${it.value}-${idx}`}
                id={`${uid}-opt-${idx}`}
                data-idx={idx}
                role="option"
                aria-selected={isSel}
                aria-disabled={it.disabled || undefined}
                onMouseEnter={() => setActive(idx)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { if (!it.disabled) commit(it.value); }}
                className={[
                  'flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm',
                  idx === active ? 'bg-surface-2' : '',
                  isSel ? 'font-semibold text-primary' : 'text-text',
                  it.disabled ? 'opacity-40 cursor-not-allowed' : '',
                ].join(' ')}
              >
                <span className="truncate">{it.label}</span>
                {it.secondary && (
                  <span className="num shrink-0 text-xs text-text-3" dir="ltr">{it.secondary}</span>
                )}
              </li>
            );
          })}
          {total > maxVisible && (
            <li role="presentation" className="px-3 py-1.5 text-xs text-text-3 border-t border-border">
              {t('ui_more_results', '{n} more — keep typing to narrow').replace('{n}', String(total - maxVisible))}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export default Combobox;
