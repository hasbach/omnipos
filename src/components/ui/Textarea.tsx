import React, { forwardRef } from 'react';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className = '', rows = 3, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={[
        'w-full rounded-[var(--radius-input)] border bg-surface px-3 py-2 text-sm text-text',
        'placeholder:text-text-3 transition-colors duration-150 outline-none resize-y',
        'focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed',
        invalid ? 'border-danger' : 'border-border',
        className,
      ].join(' ')}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

export default Textarea;
