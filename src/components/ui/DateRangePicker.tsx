import React, { useEffect, useRef, useState } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';
import { resolveDateRangePreset, type DateRange, type DateRangePreset } from '../../lib/format';
import { Button } from './Button';

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange, preset: DateRangePreset) => void;
  className?: string;
}

const PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This week' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_year', label: 'This year' },
  { value: 'custom', label: 'Custom' },
];

export function DateRangePicker({ value, onChange, className = '' }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState<DateRange>(value);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const pick = (preset: DateRangePreset) => {
    if (preset === 'custom') {
      setCustom(value);
      return; // keep open, show custom fields
    }
    const range = resolveDateRangePreset(preset);
    onChange(range, preset);
    setOpen(false);
  };

  const applyCustom = () => {
    onChange(custom, 'custom');
    setOpen(false);
  };

  return (
    <div className={['relative', className].join(' ')} ref={rootRef}>
      <Button variant="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Calendar size={15} />
        <span className="num">
          {value.from === value.to ? value.from : `${value.from} – ${value.to}`}
        </span>
        <ChevronDown size={14} className="text-text-3" />
      </Button>

      {open && (
        <div className="absolute end-0 z-50 mt-1.5 w-64 rounded-[var(--radius-card)] border border-border bg-surface p-2 shadow-[var(--shadow-modal)]">
          <div className="flex flex-col">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => pick(p.value)}
                className="cursor-pointer rounded-md px-2.5 py-1.5 text-start text-sm text-text hover:bg-surface-2"
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="mt-2 space-y-2 border-t border-border pt-2">
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={custom.from}
                onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                className="h-8 w-full rounded-md border border-border bg-surface px-2 text-xs outline-none focus:border-primary"
              />
              <span className="text-text-3">–</span>
              <input
                type="date"
                value={custom.to}
                onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                className="h-8 w-full rounded-md border border-border bg-surface px-2 text-xs outline-none focus:border-primary"
              />
            </div>
            <Button variant="primary" size="sm" className="w-full" onClick={applyCustom}>
              Apply
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default DateRangePicker;
