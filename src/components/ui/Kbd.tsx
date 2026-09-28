import React from 'react';

export function Kbd({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={[
        'inline-flex items-center justify-center rounded border border-border-strong bg-surface-2',
        'px-1.5 py-0.5 text-[11px] font-medium text-text-2 font-mono leading-none',
        className,
      ].join(' ')}
    >
      {children}
    </kbd>
  );
}

export default Kbd;
