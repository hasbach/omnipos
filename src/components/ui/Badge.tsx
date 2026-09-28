import React from 'react';

export type BadgeVariant = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: 'bg-surface-2 text-text-2 border-border',
  primary: 'bg-primary-soft text-primary border-transparent',
  success: 'bg-success-soft text-success border-transparent',
  warning: 'bg-accent-soft text-accent border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  info: 'bg-info-soft text-info border-transparent',
};

export interface BadgeProps {
  variant?: BadgeVariant;
  className?: string;
  children?: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLSpanElement>;
  title?: string;
}

export function Badge({ variant = 'neutral', className = '', children, ...rest }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-[var(--radius-chip)] border px-2 py-0.5',
        'text-xs font-medium leading-5 whitespace-nowrap',
        VARIANT_CLASSES[variant],
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </span>
  );
}

export default Badge;
