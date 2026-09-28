import React, { forwardRef } from 'react';
import { Check, Minus } from 'lucide-react';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  indeterminate?: boolean;
  label?: React.ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { indeterminate, label, className = '', checked, id, ...rest },
  ref,
) {
  const innerRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);

  return (
    <label className={['inline-flex items-center gap-2 cursor-pointer select-none', className].join(' ')} htmlFor={id}>
      <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center">
        <input
          id={id}
          ref={(node) => {
            innerRef.current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = node;
          }}
          type="checkbox"
          checked={checked}
          className={[
            'peer h-4 w-4 shrink-0 appearance-none rounded border border-border-strong bg-surface cursor-pointer',
            'transition-colors duration-150 checked:bg-primary checked:border-primary',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          ].join(' ')}
          {...rest}
        />
        {(checked || indeterminate) && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-on-primary">
            {checked ? <Check size={12} strokeWidth={3} /> : <Minus size={12} strokeWidth={3} />}
          </span>
        )}
      </span>
      {label && <span className="text-sm text-text">{label}</span>}
    </label>
  );
});

export default Checkbox;
