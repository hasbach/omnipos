import React, { useState, useEffect } from 'react';
import { ShoppingCart } from 'lucide-react';
import { motion } from 'motion/react';
import bcrypt from 'bcryptjs';
import { supabase } from './lib/supabase';
import LiveMonitorWeb from './pages/LiveMonitorWeb';
import { Tenant } from './types';

export default function MonitorApp() {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [authForm, setAuthForm] = useState({ email: '', password: '' });
  const [authError, setAuthError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('monitor_tenant');
    if (saved) {
      setTenant(JSON.parse(saved));
    }
    setIsAuthLoading(false);
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setIsProcessing(true);

    try {
      const { data, error } = await supabase
        .from('tenants')
        .select('*')
        .eq('email', authForm.email)
        .single();

      if (error || !data) {
        setAuthError('Invalid email or password');
        setIsProcessing(false);
        return;
      }

      const isValid = await bcrypt.compare(authForm.password, data.password);
      if (isValid) {
        setTenant(data);
        localStorage.setItem('monitor_tenant', JSON.stringify(data));
      } else {
        setAuthError('Invalid email or password');
      }
    } catch (err) {
      setAuthError('Network error connecting to cloud');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('monitor_tenant');
    setTenant(null);
  };

  if (isAuthLoading) return <div className="h-screen bg-app-bg text-white flex items-center justify-center font-mono">LOADING SYSTEM...</div>;

  if (!tenant) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-app-bg p-4 text-white">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-md bg-app-surface border border-app-border rounded-2xl shadow-2xl overflow-hidden"
        >
          <div className="p-8 border-b border-app-border bg-app-ink text-app-bg flex flex-col items-center gap-4">
            <div className="p-3 bg-app-bg text-app-ink rounded-xl">
              <ShoppingCart size={32} />
            </div>
            <div className="text-center">
              <h1 className="text-2xl font-bold tracking-tight uppercase">OmniPOS Live Monitor</h1>
              <p className="text-xs opacity-50 font-mono mt-1">REMOTE DASHBOARD PWA</p>
            </div>
          </div>
          
          <div className="p-8">
            <form onSubmit={handleLogin} className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold uppercase opacity-50 ml-1">Business Email</label>
                <input 
                  required
                  type="text" 
                  placeholder="name@company.com"
                  className="w-full px-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all"
                  value={authForm.email}
                  onChange={e => setAuthForm({ ...authForm, email: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold uppercase opacity-50 ml-1">Password</label>
                <input 
                  required
                  type="password" 
                  placeholder="••••••••"
                  className="w-full px-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all"
                  value={authForm.password}
                  onChange={e => setAuthForm({ ...authForm, password: e.target.value })}
                />
              </div>

              {authError && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500 text-xs text-center">
                  {authError}
                </div>
              )}

              <button 
                disabled={isProcessing}
                type="submit"
                className="w-full bg-app-ink text-app-bg py-4 rounded-xl font-bold uppercase tracking-widest mt-4 hover:opacity-90 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isProcessing ? 'Connecting...' : 'Access Monitor'}
              </button>
            </form>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-app-bg text-app-ink flex flex-col overflow-hidden">
      <header className="flex justify-between items-center p-4 border-b border-app-border bg-app-surface">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-app-ink text-app-bg rounded-lg">
            <ShoppingCart size={16} />
          </div>
          <div>
            <h1 className="font-bold text-sm uppercase">{tenant.name}</h1>
            <p className="text-[10px] opacity-50 font-mono tracking-widest">LIVE MONITOR</p>
          </div>
        </div>
        <button onClick={handleLogout} className="text-xs font-bold uppercase opacity-50 hover:opacity-100 px-4 py-2 border border-app-border rounded-lg">
          Logout
        </button>
      </header>
      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        <LiveMonitorWeb tenant={tenant} />
      </main>
    </div>
  );
}
