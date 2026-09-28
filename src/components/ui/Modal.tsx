import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useFocusTrap } from './useFocusTrap';
import { IconButton } from './IconButton';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[calc(100vw-48px)] h-[calc(100vh-48px)]',
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  size?: ModalSize;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, size = 'md', footer, children, className = '' }: ModalProps) {
  const ref = useFocusTrap<HTMLDivElement>(open, onClose);

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-6" role="presentation">
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
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.15 }}
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === 'string' ? title : undefined}
            tabIndex={-1}
            className={[
              'relative flex w-full flex-col rounded-[var(--radius-card)] border border-border bg-surface',
              'shadow-[var(--shadow-modal)] outline-none',
              SIZE_CLASSES[size],
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
            {footer && <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export default Modal;
