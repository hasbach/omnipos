import React from 'react';

export interface CardProps {
  dense?: boolean;
  className?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  id?: string;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}

export function Card({ dense, className = '', children, ...rest }: CardProps) {
  return (
    <div
      className={[
        'rounded-[var(--radius-card)] border border-border bg-surface',
        'shadow-[var(--shadow-card)]',
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface CardSectionProps {
  className?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export function CardHeader({ className = '', children, ...rest }: CardSectionProps) {
  return (
    <div
      className={['flex items-center justify-between gap-3 border-b border-border px-4 py-3', className].join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardBody({ dense, className = '', children, ...rest }: CardProps) {
  return (
    <div className={[dense ? 'p-3' : 'p-4', className].join(' ')} {...rest}>
      {children}
    </div>
  );
}

export default Card;
