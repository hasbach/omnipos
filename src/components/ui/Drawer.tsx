import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useFocusTrap } from './useFocusTrap';
// NB: 'src/i18n.ts' (legacy translations file) and 'src/intl/index.tsx' (I18nProvider) share a
// specifier — bare './i18n' always resolves to the .ts file, so this must import the explicit path.
import { useI18n } from '../../intl/index';
import { IconButton } from './IconButton';

export type DrawerSize = 'sm' | 'md' | 'lg';

const WIDTH_CLASSES: Record<DrawerSize, string> = {
  sm: 'w-[420px] max-w-[90vw]',
  md: 'w-[560px] max-w-[90vw]',
  lg: 'w-[720px] max-w-[90vw]',
};

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  size?: DrawerSize;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

/** Side panel, always opens from the end (right in LTR, left in RTL). */
export function Drawer({ open, onClose, title, size = 'md', footer, children, className = '' }: DrawerProps) {
  const ref = useFocusTrap<HTMLDivElement>(open, onClose);
  let dir: 'ltr' | 'rtl' = 'ltr';
  try {
    // Drawer can be used outside I18nProvider in rare cases; fall back to document direction.
    dir = useI18n().dir;
  } catch {
    dir = (typeof document !== 'undefined' && document.documentElement.dir === 'rtl') ? 'rtl' : 'ltr';
  }
  const offscreen = dir === 'rtl' ? '-100%' : '100%';

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[200]" role="presentation">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-black/50"
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            ref={ref}
            initial={{ x: offscreen }}
            animate={{ x: 0 }}
            exit={{ x: offscreen }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === 'string' ? title : undefined}
            tabIndex={-1}
            className={[
              'absolute inset-y-0 end-0 flex flex-col border-s border-border bg-surface shadow-[var(--shadow-modal)] outline-none',
              WIDTH_CLASSES[size],
              className,
            ].join(' ')}
          >
            {title && (
              <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
                <h2 className="text-base font-semibold text-text">{title}</h2>
                <IconButton aria-label="Close" size="sm" onClick={onClose}>
                  <X size={16} />
                </IconButton>
              </div>
            )}
            <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer && (
              <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">{footer}</div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export default Drawer;
