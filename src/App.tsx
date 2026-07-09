import React, { useState, useEffect } from 'react';
import { Shield, ShoppingCart, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Tenant } from './types';
import WindowFrame from './components/WindowFrame';
import SuperAdminDashboard from './components/SuperAdminDashboard';
import { PosProvider } from './context/PosContext';
import CartPanel from './components/CartPanel';
import ProductGrid from './components/ProductGrid';
import PosHeader from './components/PosHeader';
import PaymentModal from './components/PaymentModal';
import LockScreen from './components/LockScreen';

export default function App() {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '', tenantName: '' });
  const [authError, setAuthError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [users, setUsers] = useState<any[]>([]);
  const [currentUser, setCurrentUser] = useState<any>(null);

  useEffect(() => {
    checkAuth();
  }, []);

  const [isUsersLoading, setIsUsersLoading] = useState(false);

  useEffect(() => {
    if (tenant && tenant.email !== 'hasbach') {
      setIsUsersLoading(true);
      fetch('/api/users')
        .then(res => res.json())
        .then(data => setUsers(data))
        .catch(console.error)
        .finally(() => setIsUsersLoading(false));
    }
  }, [tenant]);

  const checkAuth = async () => {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        setTenant(data);
      }
    } catch (err) {
      console.error('Auth error:', err);
    } finally {
      setIsAuthLoading(false);
    }
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setIsProcessing(true);
    try {
      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authForm)
      });
      if (res.ok) {
        const data = await res.json();
        setTenant(data);
      } else {
        const err = await res.json();
        setAuthError(err.error || 'Authentication failed');
      }
    } catch (err) {
      setAuthError('Network error. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setTenant(null);
  };

  if (isAuthLoading) {
    return (
      <div className="h-screen bg-app-bg text-app-ink flex items-center justify-center font-mono">
        <motion.div animate={{ opacity: [0.5, 1, 0.5] }} transition={{ repeat: Infinity, duration: 1.5 }}>
          LOADING SYSTEM...
        </motion.div>
      </div>
    );
  }

  if (!tenant) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-app-bg p-4">
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
              <h1 className="text-2xl font-bold tracking-tight uppercase">OmniPOS Terminal</h1>
              <p className="text-xs opacity-50 font-mono mt-1">MULTI-TENANT RETAIL SYSTEM</p>
            </div>
          </div>
          
          <div className="p-8">
            <div className="flex gap-4 mb-8">
              <button 
                onClick={() => setAuthMode('login')}
                className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${authMode === 'login' ? 'bg-app-ink text-app-bg' : 'bg-app-bg text-app-ink opacity-50 hover:opacity-100'}`}
              >
                Login
              </button>
              <button 
                onClick={() => setAuthMode('register')}
                className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${authMode === 'register' ? 'bg-app-ink text-app-bg' : 'bg-app-bg text-app-ink opacity-50 hover:opacity-100'}`}
              >
                Register
              </button>
            </div>

            <form onSubmit={handleAuth} className="space-box flex flex-col gap-4">
              {authMode === 'register' && (
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold uppercase opacity-50 ml-1">Business Name</label>
                  <input 
                    required
                    type="text" 
                    placeholder="e.g. My Awesome Store"
                    className="w-full px-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all"
                    value={authForm.name}
                    onChange={e => setAuthForm({ ...authForm, name: e.target.value })}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold uppercase opacity-50 ml-1">Email or Username</label>
                <input 
                  required
                  type="text" 
                  placeholder="e.g. name@company.com"
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
                {isProcessing ? (
                  <div className="w-4 h-4 border-2 border-app-bg border-t-transparent rounded-full animate-spin"></div>
                ) : (
                  authMode === 'login' ? 'Access Terminal' : 'Create Account'
                )}
              </button>
            </form>
          </div>
        </motion.div>
      </div>
    );
  }

  if (tenant.email === 'hasbach') {
    return (
      <WindowFrame title="Super Admin Control" icon={<Shield size={14} />}>
        <div className="flex justify-end p-4 border-b border-app-border bg-app-surface">
           <button onClick={handleLogout} className="text-xs font-bold uppercase opacity-50 hover:text-red-500 transition-colors">Logout</button>
        </div>
        <SuperAdminDashboard />
      </WindowFrame>
    );
  }

  const isLicenseExpired = (type: string, expiry?: string) => {
    if (type === 'lifetime') return false;
    if (!expiry) return true;
    return new Date(expiry) < new Date();
  };

  const localExpired = isLicenseExpired(tenant.local_license_type, tenant.local_license_expiry);

  if (localExpired) {
    return (
      <WindowFrame title="License Expired" icon={<AlertTriangle size={14} />}>
        <div className="h-full flex items-center justify-center bg-app-bg p-6">
          <div className="max-w-md w-full bg-app-surface border border-app-border rounded-2xl p-8 text-center space-y-6 shadow-xl">
            <div className="w-20 h-20 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto">
              <AlertTriangle size={40} />
            </div>
            <div className="space-y-2">
              <h2 className="text-2xl font-black uppercase tracking-tight">Software License Expired</h2>
              <p className="opacity-50 text-sm">Your local software license has expired. Please contact the administrator to renew your subscription.</p>
            </div>
            <div className="p-4 bg-app-bg rounded-xl border border-app-border text-left">
              <p className="text-[10px] font-black uppercase opacity-40 mb-1">Business</p>
              <p className="font-bold">{tenant.name}</p>
              <p className="text-xs opacity-50">{tenant.email}</p>
            </div>
            <button 
              onClick={handleLogout}
              className="w-full py-4 bg-app-ink text-app-bg rounded-xl font-black uppercase tracking-widest hover:opacity-90 transition-all"
            >
              Logout
            </button>
          </div>
        </div>
      </WindowFrame>
    );
  }



  if (!currentUser) {
    return (
      <LockScreen 
        tenant={tenant}
        users={users}
        isLoading={isUsersLoading}
        onUnlock={setCurrentUser}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <PosProvider tenant={tenant} setTenant={setTenant} currentUser={currentUser} setCurrentUser={setCurrentUser} users={users} setUsers={setUsers} handleLogout={handleLogout}>
      <WindowFrame title="OmniPOS Terminal" icon={<ShoppingCart size={14} />}>
        <PosHeader />
        <main className="flex-1 flex overflow-hidden">
          <CartPanel />
          <ProductGrid />
        </main>
        <PaymentModal />
      </WindowFrame>
    </PosProvider>
  );
}
