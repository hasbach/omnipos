import React, { forwardRef } from 'react';
import type { ButtonSize, ButtonVariant } from './Button';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Required — icon-only buttons must be labelled for screen readers. */
  'aria-label': string;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-primary hover:bg-primary-hover',
  secondary: 'bg-surface text-text-2 border border-border hover:bg-surface-2 hover:text-text',
  ghost: 'bg-transparent text-text-2 hover:bg-surface-2 hover:text-text',
  danger: 'bg-danger-soft text-danger hover:opacity-80',
  success: 'bg-success-soft text-success hover:opacity-80',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-[30px] w-[30px]',
  md: 'h-9 w-9',
  lg: 'h-11 w-11',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', size = 'md', className = '', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={[
        'inline-flex items-center justify-center rounded-[var(--radius-input)]',
        'transition-colors duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
});

export default IconButton;
