import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Lock, User, CheckCircle2, X, Delete } from 'lucide-react';
import { Tenant } from '../types';
import { useI18n } from '../intl/index';

interface LockScreenProps {
  tenant: Tenant;
  users: any[];
  isLoading?: boolean;
  onUnlock: (user: any) => void;
  onLogout: () => void;
}

export default function LockScreen({ tenant, users, isLoading = false, onUnlock, onLogout }: LockScreenProps) {
  const { t } = useI18n();
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleNumber = (num: string) => {
    // Functional update (with the length guard inside) so this stays correct when called from
    // the global keydown listener below, whose closure would otherwise capture a stale `pin`.
    setPin(prev => (prev.length < 4 ? prev + num : prev));
    setError('');
  };

  const handleDelete = () => {
    setPin(prev => prev.slice(0, -1));
    setError('');
  };

  const handleUnlock = async () => {
    if (pin.length !== 4 || !selectedUser) return;

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: selectedUser.id, pin })
      });

      if (res.ok) {
        const data = await res.json();
        onUnlock(data.user);
      } else {
        const err = await res.json();
        setError(err.error || 'Invalid PIN');
        setPin(''); // Reset PIN on error
      }
    } catch (err) {
      setError(t('pos_connection_error', 'Connection error'));
      setPin('');
    } finally {
      setLoading(false);
    }
  };

  // Auto-submit when 4 digits are entered
  React.useEffect(() => {
    if (pin.length === 4) {
      handleUnlock();
    }
  }, [pin]);

  // Physical-keyboard entry: once a user is selected, digits type the PIN, Backspace deletes,
  // and Escape goes back to the user list — so the PIN can be entered without the mouse.
  React.useEffect(() => {
    if (!selectedUser || loading) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        handleNumber(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleDelete();
      } else if (e.key === 'Escape') {
        setSelectedUser(null);
        setPin('');
        setError('');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedUser, loading]);

  return (
    <div className="fixed inset-0 z-[100] bg-bg flex flex-col">
      {/* Header */}
      <header className="p-6 flex justify-between items-center bg-surface border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary text-on-primary rounded-xl flex items-center justify-center">
            <Lock size={20} />
          </div>
          <div>
            <h1 className="font-bold text-sm text-text">{tenant.name}</h1>
            <p className="text-[10px] uppercase font-semibold tracking-wide text-text-3">{t('pos_terminal_locked', 'Terminal Locked')}</p>
          </div>
        </div>
        <button
          onClick={onLogout}
          className="px-4 py-2.5 text-sm font-medium text-text-3 hover:text-danger transition-all cursor-pointer rounded-[var(--radius-input)] hover:bg-danger-soft"
        >
          {t('pos_logout_tenant', 'Logout Tenant')}
        </button>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* User Selection */}
        <div className="flex-1 p-8 overflow-y-auto border-e border-border bg-surface">
          <h2 className="text-2xl font-bold text-text mb-6">{t('pos_select_user', 'Select User')}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {isLoading ? (
              [1, 2, 3].map(i => (
                <div key={i} className="animate-pulse bg-surface border border-border rounded-2xl p-6 flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-surface-2" />
                  <div className="space-y-2">
                    <div className="h-4 w-24 bg-surface-2 rounded" />
                    <div className="h-3 w-16 bg-surface-2 rounded" />
                  </div>
                </div>
              ))
            ) : users.length === 0 ? (
              <div className="col-span-full py-12 text-center text-sm font-medium text-text-3">
                {t('pos_no_users_found', 'No users found. Please contact an administrator.')}
              </div>
            ) : (
              users.map(u => (
                <button
                  key={u.id}
                  onClick={() => {
                    setSelectedUser(u);
                    setPin('');
                    setError('');
                  }}
                  className={`p-6 rounded-2xl text-start transition-all border-2 cursor-pointer min-h-[88px] ${
                    selectedUser?.id === u.id
                      ? 'border-primary bg-primary text-on-primary shadow-lg scale-[1.02]'
                      : 'border-transparent bg-bg hover:border-border-strong hover:shadow-md'
                  }`}
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-xl shrink-0 ${
                      selectedUser?.id === u.id ? 'bg-on-primary text-primary' : 'bg-surface-2 text-text'
                    }`}>
                      {u.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="font-bold text-lg truncate">{u.name}</p>
                      <p className={`text-[10px] font-bold uppercase tracking-wide ${selectedUser?.id === u.id ? 'opacity-90' : 'text-text-3'}`}>
                        {u.role}
                      </p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* PIN Pad */}
        <div className="w-[420px] bg-bg p-10 flex flex-col items-center justify-center relative">
          <AnimatePresence mode="wait">
            {!selectedUser ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-center text-text-3 flex flex-col items-center gap-4"
              >
                <User size={56} />
                <p className="font-semibold text-sm">{t('pos_select_user_prompt', 'Select a user to continue')}</p>
              </motion.div>
            ) : (
              <motion.div
                key="pinpad"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="w-full max-w-[320px] flex flex-col items-center"
              >
                <div className="mb-8 text-center space-y-1">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-text-3">{t('pos_enter_pin_for', 'Enter PIN for')}</p>
                  <h3 className="text-xl font-bold text-text">{selectedUser.name}</h3>
                </div>

                {/* PIN Dots */}
                <div className="flex gap-4 mb-6">
                  {[0, 1, 2, 3].map(i => (
                    <div
                      key={i}
                      className={`w-4 h-4 rounded-full transition-all duration-200 ${
                        i < pin.length ? 'bg-primary scale-125' : 'bg-border-strong'
                      }`}
                    />
                  ))}
                </div>

                {error && (
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 p-3 bg-danger-soft text-danger rounded-xl text-xs font-semibold w-full text-center">
                    {error}
                  </motion.div>
                )}

                {loading ? (
                  <div className="py-12">
                    <div className="w-8 h-8 border-4 border-border border-t-primary rounded-full animate-spin" />
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-3 w-full">
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(num => (
                      <button
                        key={num}
                        onClick={() => handleNumber(num.toString())}
                        className="aspect-square min-h-[56px] bg-surface rounded-xl text-2xl font-bold text-text hover:bg-primary hover:text-on-primary transition-colors active:scale-95 shadow-sm border border-border cursor-pointer"
                      >
                        {num}
                      </button>
                    ))}
                    <button
                      onClick={() => { setSelectedUser(null); setPin(''); setError(''); }}
                      className="aspect-square min-h-[56px] flex items-center justify-center bg-surface rounded-xl hover:bg-danger hover:text-white transition-colors active:scale-95 shadow-sm border border-border cursor-pointer text-text"
                    >
                      <X size={22} />
                    </button>
                    <button
                      onClick={() => handleNumber('0')}
                      className="aspect-square min-h-[56px] bg-surface rounded-xl text-2xl font-bold text-text hover:bg-primary hover:text-on-primary transition-colors active:scale-95 shadow-sm border border-border cursor-pointer"
                    >
                      0
                    </button>
                    <button
                      onClick={handleDelete}
                      className="aspect-square min-h-[56px] flex items-center justify-center bg-surface rounded-xl hover:bg-primary hover:text-on-primary transition-colors active:scale-95 shadow-sm border border-border cursor-pointer text-text"
                    >
                      <Delete size={20} />
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
