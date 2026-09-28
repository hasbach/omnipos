import React from 'react';

export interface ToolbarProps {
  /** Left-aligned filter/search controls. */
  children?: React.ReactNode;
  /** Right-aligned controls (e.g. export, add-new). */
  actions?: React.ReactNode;
  className?: string;
}

export function Toolbar({ children, actions, className = '' }: ToolbarProps) {
  return (
    <div
      className={['flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-card)] border border-border bg-surface p-3', className].join(' ')}
    >
      <div className="flex flex-1 flex-wrap items-center gap-2">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export default Toolbar;
