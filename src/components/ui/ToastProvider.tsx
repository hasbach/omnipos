import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastOptions {
  title?: string;
  description?: string;
  duration?: number; // ms, default 4000
}

interface ToastEntry extends ToastOptions {
  id: number;
  variant: ToastVariant;
}

interface ToastContextValue {
  success: (description: string, opts?: ToastOptions) => void;
  error: (description: string, opts?: ToastOptions) => void;
  info: (description: string, opts?: ToastOptions) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS: Record<ToastVariant, React.ComponentType<{ size?: number }>> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  success: 'border-success/30 text-success',
  error: 'border-danger/30 text-danger',
  info: 'border-info/30 text-info',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (variant: ToastVariant, description: string, opts: ToastOptions = {}) => {
      const id = ++idRef.current;
      const duration = opts.duration ?? 4000;
      setToasts((prev) => [...prev, { id, variant, description, ...opts }]);
      if (duration > 0) {
        setTimeout(() => dismiss(id), duration);
      }
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      success: (d, o) => push('success', d, o),
      error: (d, o) => push('error', d, o),
      info: (d, o) => push('info', d, o),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed bottom-4 end-4 z-[300] flex w-[360px] max-w-[90vw] flex-col gap-2" aria-live="polite">
            <AnimatePresence>
              {toasts.map((t) => {
                const Icon = ICONS[t.variant];
                return (
                  <motion.div
                    key={t.id}
                    initial={{ opacity: 0, y: 12, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    transition={{ duration: 0.15 }}
                    role="status"
                    className={[
                      'flex items-start gap-2.5 rounded-[var(--radius-card)] border bg-surface px-3.5 py-3',
                      'shadow-[var(--shadow-modal)]',
                      VARIANT_CLASSES[t.variant],
                    ].join(' ')}
                  >
                    <Icon size={18} />
                    <div className="min-w-0 flex-1">
                      {t.title && <p className="text-sm font-semibold text-text">{t.title}</p>}
                      {t.description && <p className="text-sm text-text-2">{t.description}</p>}
                    </div>
                    <button
                      type="button"
                      aria-label="Dismiss"
                      onClick={() => dismiss(t.id)}
                      className="shrink-0 cursor-pointer text-text-3 hover:text-text"
                    >
                      <X size={14} />
                    </button>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}

export default ToastProvider;
