import React, { forwardRef } from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  startAdornment?: React.ReactNode;
  endAdornment?: React.ReactNode;
}

const baseClasses =
  'h-9 w-full rounded-[var(--radius-input)] border bg-surface px-3 text-sm text-text ' +
  'placeholder:text-text-3 transition-colors duration-150 outline-none ' +
  'focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed';

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, startAdornment, endAdornment, className = '', ...rest },
  ref,
) {
  if (!startAdornment && !endAdornment) {
    return (
      <input
        ref={ref}
        className={[baseClasses, invalid ? 'border-danger' : 'border-border', className].join(' ')}
        aria-invalid={invalid || undefined}
        {...rest}
      />
    );
  }

  return (
    <div
      className={[
        'flex h-9 w-full items-center gap-1.5 rounded-[var(--radius-input)] border bg-surface px-3',
        'transition-colors duration-150 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20',
        invalid ? 'border-danger' : 'border-border',
        rest.disabled ? 'opacity-50' : '',
        className,
      ].join(' ')}
    >
      {startAdornment && <span className="text-text-3 text-sm shrink-0">{startAdornment}</span>}
      <input
        ref={ref}
        className="h-full w-full min-w-0 border-0 bg-transparent p-0 text-sm text-text outline-none placeholder:text-text-3 disabled:cursor-not-allowed"
        aria-invalid={invalid || undefined}
        {...rest}
      />
      {endAdornment && <span className="text-text-3 text-sm shrink-0">{endAdornment}</span>}
    </div>
  );
});

export default Input;
