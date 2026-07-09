import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Lock, User, ChevronRight, CheckCircle2, X } from 'lucide-react';
import { Tenant } from '../types';

interface LockScreenProps {
  tenant: Tenant;
  users: any[];
  isLoading?: boolean;
  onUnlock: (user: any) => void;
  onLogout: () => void;
}

export default function LockScreen({ tenant, users, isLoading = false, onUnlock, onLogout }: LockScreenProps) {
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleNumber = (num: string) => {
    if (pin.length < 4) {
      setPin(prev => prev + num);
      setError('');
    }
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
      setError('Connection error');
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

  return (
    <div className="fixed inset-0 z-[100] bg-app-bg flex flex-col font-sans">
      {/* Header */}
      <header className="p-6 flex justify-between items-center bg-app-surface border-b border-app-border">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-app-ink text-app-bg rounded-xl flex items-center justify-center">
            <Lock size={20} />
          </div>
          <div>
            <h1 className="font-black uppercase tracking-widest text-sm">{tenant.name}</h1>
            <p className="text-[10px] uppercase font-bold opacity-50">Terminal Locked</p>
          </div>
        </div>
        <button 
          onClick={onLogout}
          className="px-4 py-2 text-xs font-black uppercase tracking-widest opacity-50 hover:opacity-100 hover:text-red-500 transition-all"
        >
          Logout Tenant
        </button>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* User Selection */}
        <div className="flex-1 p-12 overflow-y-auto border-r border-app-border bg-app-surface">
          <h2 className="text-3xl font-black uppercase tracking-tighter mb-8">Select User</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {isLoading ? (
              [1, 2, 3].map(i => (
                <div key={i} className="animate-pulse bg-app-surface border border-app-border rounded-3xl p-6 flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-app-border" />
                  <div className="space-y-2">
                    <div className="h-4 w-24 bg-app-border rounded" />
                    <div className="h-3 w-16 bg-app-border rounded" />
                  </div>
                </div>
              ))
            ) : users.length === 0 ? (
              <div className="col-span-full py-12 text-center text-sm font-bold uppercase tracking-widest opacity-50">
                No users found. Please contact an administrator.
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
                  className={`p-6 rounded-3xl text-left transition-all border-2 ${
                    selectedUser?.id === u.id 
                      ? 'border-app-ink bg-app-ink text-app-bg shadow-xl scale-105' 
                      : 'border-transparent bg-app-bg hover:border-app-border hover:shadow-md'
                  }`}
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center font-black text-xl ${
                      selectedUser?.id === u.id ? 'bg-app-bg text-app-ink' : 'bg-app-surface text-app-ink'
                    }`}>
                      {u.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="font-black text-lg">{u.name}</p>
                      <p className={`text-[10px] font-bold uppercase tracking-widest ${selectedUser?.id === u.id ? 'opacity-80' : 'opacity-40'}`}>
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
        <div className="w-[450px] bg-app-bg p-12 flex flex-col items-center justify-center relative">
          <AnimatePresence mode="wait">
            {!selectedUser ? (
              <motion.div 
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-center opacity-30 flex flex-col items-center gap-4"
              >
                <User size={64} />
                <p className="font-black uppercase tracking-widest text-sm">Select a user to continue</p>
              </motion.div>
            ) : (
              <motion.div 
                key="pinpad"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="w-full max-w-[320px] flex flex-col items-center"
              >
                <div className="mb-8 text-center space-y-2">
                  <p className="text-[10px] font-black uppercase tracking-widest opacity-50">Enter PIN for</p>
                  <h3 className="text-2xl font-black">{selectedUser.name}</h3>
                </div>

                {/* PIN Dots */}
                <div className="flex gap-4 mb-8">
                  {[0, 1, 2, 3].map(i => (
                    <div 
                      key={i} 
                      className={`w-4 h-4 rounded-full transition-all duration-300 ${
                        i < pin.length ? 'bg-app-ink scale-125' : 'bg-app-border'
                      }`}
                    />
                  ))}
                </div>

                {error && (
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 p-3 bg-red-500/10 text-red-500 rounded-xl text-xs font-bold uppercase tracking-widest w-full text-center">
                    {error}
                  </motion.div>
                )}

                {loading ? (
                  <div className="py-12">
                    <div className="w-8 h-8 border-4 border-app-border border-t-app-ink rounded-full animate-spin" />
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-4 w-full">
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(num => (
                      <button
                        key={num}
                        onClick={() => handleNumber(num.toString())}
                        className="aspect-square bg-app-surface rounded-2xl text-2xl font-black hover:bg-app-ink hover:text-app-bg transition-colors active:scale-95 shadow-sm border border-app-border"
                      >
                        {num}
                      </button>
                    ))}
                    <button
                      onClick={() => { setSelectedUser(null); setPin(''); setError(''); }}
                      className="aspect-square flex items-center justify-center bg-app-surface rounded-2xl hover:bg-rose-500 hover:text-white transition-colors active:scale-95 shadow-sm border border-app-border"
                    >
                      <X size={24} />
                    </button>
                    <button
                      onClick={() => handleNumber('0')}
                      className="aspect-square bg-app-surface rounded-2xl text-2xl font-black hover:bg-app-ink hover:text-app-bg transition-colors active:scale-95 shadow-sm border border-app-border"
                    >
                      0
                    </button>
                    <button
                      onClick={handleDelete}
                      className="aspect-square flex items-center justify-center bg-app-surface rounded-2xl text-lg font-black uppercase hover:bg-app-ink hover:text-app-bg transition-colors active:scale-95 shadow-sm border border-app-border"
                    >
                      DEL
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
