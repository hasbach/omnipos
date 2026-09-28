import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';

export interface ConfirmOptions {
  title?: string;
  description?: React.ReactNode;
  /** Type this exact text to confirm — used for destructive actions on a named object. */
  confirmText?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'primary';
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [typed, setTyped] = useState('');
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setTyped('');
      setPending({ ...options, resolve });
    });
  }, []);

  const finish = useCallback((value: boolean) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setPending(null);
  }, []);

  const requiresTyping = !!pending?.confirmText;
  const canConfirm = !requiresTyping || typed === pending?.confirmText;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={!!pending}
        onClose={() => finish(false)}
        size="sm"
        title={pending?.title || 'Are you sure?'}
        footer={
          <>
            <Button variant="secondary" onClick={() => finish(false)}>
              {pending?.cancelLabel || 'Cancel'}
            </Button>
            <Button
              variant={pending?.variant === 'primary' ? 'primary' : 'danger'}
              disabled={!canConfirm}
              onClick={() => finish(true)}
            >
              {pending?.confirmLabel || 'Confirm'}
            </Button>
          </>
        }
      >
        {pending && (
          <div className="space-y-3">
            <div className="flex gap-3">
              {pending.variant !== 'primary' && (
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
                  <AlertTriangle size={18} />
                </span>
              )}
              {pending.description && <div className="text-sm text-text-2 pt-1.5">{pending.description}</div>}
            </div>
            {requiresTyping && (
              <div>
                <p className="mb-1.5 text-xs text-text-3">
                  Type <span className="font-semibold text-text">{pending.confirmText}</span> to confirm.
                </p>
                <input
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className="h-9 w-full rounded-[var(--radius-input)] border border-border bg-surface px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </div>
            )}
          </div>
        )}
      </Modal>
    </ConfirmContext.Provider>
  );
}

/** Promise-based replacement for window.confirm(): `if (await confirm({ title, description })) { ... }` */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider');
  return ctx;
}

export default ConfirmProvider;
