import React, { useId } from 'react';

export interface TabItem {
  value: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function Tabs({ items, value, onChange, className = '' }: TabsProps) {
  const name = useId();

  return (
    <div role="tablist" aria-label="Tabs" className={['flex items-center gap-1 border-b border-border', className].join(' ')}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={`${name}-${item.value}`}
            aria-selected={active}
            disabled={item.disabled}
            onClick={() => onChange(item.value)}
            className={[
              'relative flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors duration-150',
              'cursor-pointer disabled:cursor-not-allowed disabled:opacity-40',
              active ? 'text-primary' : 'text-text-3 hover:text-text',
            ].join(' ')}
          >
            {item.icon}
            {item.label}
            {active && <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary" />}
          </button>
        );
      })}
    </div>
  );
}

export default Tabs;
