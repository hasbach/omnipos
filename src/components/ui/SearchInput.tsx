import React, { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useI18n } from '../../intl/index';

export interface SearchInputProps {
  value?: string;
  defaultValue?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Debounce delay in ms, default 300. */
  debounce?: number;
  className?: string;
  /** Focuses the input on Ctrl/Cmd+K when true (default true). */
  hotkey?: boolean;
  'aria-label'?: string;
}

export function SearchInput({
  value,
  defaultValue = '',
  onChange,
  placeholder,
  debounce = 300,
  className = '',
  hotkey = true,
  'aria-label': ariaLabel,
}: SearchInputProps) {
  const { t } = useI18n();
  const resolvedPlaceholder = placeholder ?? t('ui_search_placeholder', 'Search…');
  const resolvedAriaLabel = ariaLabel ?? t('ui_search', 'Search');
  const [inner, setInner] = useState(value ?? defaultValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (value !== undefined) setInner(value);
  }, [value]);

  useEffect(() => {
    if (!hotkey) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hotkey]);

  const emit = (next: string) => {
    setInner(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onChange(next), debounce);
  };

  return (
    <div
      className={[
        'flex h-9 w-full items-center gap-2 rounded-[var(--radius-input)] border border-border bg-surface px-3',
        'transition-colors duration-150 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20',
        className,
      ].join(' ')}
    >
      <Search size={15} className="shrink-0 text-text-3" aria-hidden="true" />
      <input
        ref={inputRef}
        value={inner}
        onChange={(e) => emit(e.target.value)}
        placeholder={resolvedPlaceholder}
        aria-label={resolvedAriaLabel}
        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-text outline-none placeholder:text-text-3"
      />
      {inner && (
        <button
          type="button"
          aria-label={t('ui_clear_search', 'Clear search')}
          onClick={() => emit('')}
          className="shrink-0 cursor-pointer text-text-3 hover:text-text"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export default SearchInput;
