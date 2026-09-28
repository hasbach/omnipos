import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon = Inbox, title, description, action, className = '' }: EmptyStateProps) {
  return (
    <div className={['flex flex-col items-center justify-center gap-3 py-16 px-6 text-center', className].join(' ')}>
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-text-3">
        <Icon size={22} aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-text">{title}</p>
        {description && <p className="text-sm text-text-3 max-w-sm">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export default EmptyState;
