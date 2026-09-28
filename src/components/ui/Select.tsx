import React, { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  options: SelectOption[];
  invalid?: boolean;
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, invalid, placeholder, className = '', ...rest },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={[
          'h-9 w-full appearance-none rounded-[var(--radius-input)] border bg-surface ps-3 pe-8 text-sm text-text',
          'transition-colors duration-150 outline-none cursor-pointer',
          'focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed',
          invalid ? 'border-danger' : 'border-border',
          className,
        ].join(' ')}
        aria-invalid={invalid || undefined}
        {...rest}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={16}
        className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-text-3"
        aria-hidden="true"
      />
    </div>
  );
});

export default Select;
