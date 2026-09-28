import React from 'react';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: React.ReactNode;
  'aria-label'?: string;
  id?: string;
}

export function Switch({ checked, onChange, disabled, label, id, ...rest }: SwitchProps) {
  return (
    <label
      htmlFor={id}
      className={['inline-flex items-center gap-2 select-none', disabled ? 'opacity-50' : 'cursor-pointer'].join(' ')}
    >
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={[
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]',
          checked ? 'bg-primary' : 'bg-border-strong',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        ].join(' ')}
        {...rest}
      >
        <span
          className={[
            'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-150',
            checked ? 'translate-x-4 rtl:-translate-x-4' : 'translate-x-0.5 rtl:-translate-x-0.5',
          ].join(' ')}
        />
      </button>
      {label && <span className="text-sm text-text">{label}</span>}
    </label>
  );
}

export default Switch;
