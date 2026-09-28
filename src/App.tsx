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
import { I18nProvider, useI18n } from './intl/index';
import { ToastProvider } from './components/ui/ToastProvider';
import { ConfirmProvider } from './components/ui/ConfirmDialog';
import { Button, Input, Field } from './components/ui';

// The POS terminal renders standalone (outside Dashboard's shell/providers), so it wraps its own
// tree in I18nProvider/ToastProvider/ConfirmProvider here. usePos() (called from PosProvider,
// itself rendered inside this tree) picks up the tenant's saved language via useI18n().setLang().
function AuthScreen({
  authMode, setAuthMode, authForm, setAuthForm, authError, isProcessing, handleAuth,
}: {
  authMode: 'login' | 'register';
  setAuthMode: (m: 'login' | 'register') => void;
  authForm: { name: string; email: string; password: string; tenantName: string };
  setAuthForm: React.Dispatch<React.SetStateAction<{ name: string; email: string; password: string; tenantName: string }>>;
  authError: string;
  isProcessing: boolean;
  handleAuth: (e: React.FormEvent) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="h-screen w-screen flex items-center justify-center bg-bg p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md bg-surface border border-border rounded-[var(--radius-card)] shadow-[var(--shadow-modal)] overflow-hidden"
      >
        <div className="p-8 border-b border-border bg-primary text-on-primary flex flex-col items-center gap-4">
          <div className="p-3 bg-on-primary text-primary rounded-xl">
            <ShoppingCart size={32} />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight">{t('pos_login_title', 'OmniPOS Terminal')}</h1>
            <p className="text-xs opacity-80 mt-1">{t('pos_login_subtitle', 'MULTI-TENANT RETAIL SYSTEM')}</p>
          </div>
        </div>

        <div className="p-8">
          <div className="flex gap-2 mb-8 bg-surface-2 p-1 rounded-lg">
            <button
              onClick={() => setAuthMode('login')}
              className={`flex-1 py-2.5 text-sm font-medium rounded-md transition-all cursor-pointer ${authMode === 'login' ? 'bg-primary text-on-primary' : 'text-text-2 hover:text-text'}`}
            >
              {t('pos_login', 'Login')}
            </button>
            <button
              onClick={() => setAuthMode('register')}
              className={`flex-1 py-2.5 text-sm font-medium rounded-md transition-all cursor-pointer ${authMode === 'register' ? 'bg-primary text-on-primary' : 'text-text-2 hover:text-text'}`}
            >
              {t('pos_register', 'Register')}
            </button>
          </div>

          <form onSubmit={handleAuth} className="flex flex-col gap-4">
            {authMode === 'register' && (
              <Field label={t('pos_business_name', 'Business Name')}>
                <Input
                  required
                  type="text"
                  placeholder={t('pos_business_name_placeholder', 'e.g. My Awesome Store')}
                  value={authForm.name}
                  onChange={e => setAuthForm({ ...authForm, name: e.target.value })}
                />
              </Field>
            )}
            <Field label={t('pos_email_or_username', 'Email or Username')}>
              <Input
                required
                type="text"
                placeholder={t('pos_email_placeholder', 'e.g. name@company.com')}
                value={authForm.email}
                onChange={e => setAuthForm({ ...authForm, email: e.target.value })}
              />
            </Field>
            <Field label={t('pos_password', 'Password')}>
              <Input
                required
                type="password"
                placeholder="••••••••"
                value={authForm.password}
                onChange={e => setAuthForm({ ...authForm, password: e.target.value })}
              />
            </Field>

            {authError && (
              <div className="p-3 bg-danger-soft border border-danger/20 rounded-lg text-danger text-xs text-center">
                {authError}
              </div>
            )}

            <Button
              disabled={isProcessing}
              loading={isProcessing}
              type="submit"
              variant="primary"
              size="lg"
              className="w-full mt-2 font-semibold"
            >
              {authMode === 'login' ? t('pos_access_terminal', 'Access Terminal') : t('pos_create_account', 'Create Account')}
            </Button>
          </form>
        </div>
      </motion.div>
    </div>
  );
}

function LicenseExpiredScreen({ tenant, handleLogout }: { tenant: Tenant; handleLogout: () => void }) {
  const { t } = useI18n();
  return (
    <WindowFrame title={t('pos_license_expired_title', 'Software License Expired')} icon={<AlertTriangle size={14} />}>
      <div className="h-full flex items-center justify-center bg-bg p-6">
        <div className="max-w-md w-full bg-surface border border-border rounded-[var(--radius-card)] p-8 text-center space-y-6 shadow-[var(--shadow-modal)]">
          <div className="w-20 h-20 bg-danger-soft text-danger rounded-full flex items-center justify-center mx-auto">
            <AlertTriangle size={40} />
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl font-bold">{t('pos_license_expired_title', 'Software License Expired')}</h2>
            <p className="text-text-3 text-sm">{t('pos_license_expired_body', 'Your local software license has expired. Please contact the administrator to renew your subscription.')}</p>
          </div>
          <div className="p-4 bg-surface-2 rounded-xl border border-border text-start">
            <p className="text-[10px] font-bold uppercase text-text-3 mb-1">{t('pos_business_label', 'Business')}</p>
            <p className="font-semibold text-text">{tenant.name}</p>
            <p className="text-xs text-text-3">{tenant.email}</p>
          </div>
          <Button variant="primary" size="lg" className="w-full font-semibold" onClick={handleLogout}>
            {t('logout', 'Logout')}
          </Button>
        </div>
      </div>
    </WindowFrame>
  );
}

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

  return (
    <I18nProvider>
      <ToastProvider>
        <ConfirmProvider>
          <AppBody
            tenant={tenant}
            setTenant={setTenant}
            isAuthLoading={isAuthLoading}
            authMode={authMode}
            setAuthMode={setAuthMode}
            authForm={authForm}
            setAuthForm={setAuthForm}
            authError={authError}
            isProcessing={isProcessing}
            handleAuth={handleAuth}
            handleLogout={handleLogout}
            users={users}
            setUsers={setUsers}
            isUsersLoading={isUsersLoading}
            currentUser={currentUser}
            setCurrentUser={setCurrentUser}
          />
        </ConfirmProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

function AppBody({
  tenant, setTenant, isAuthLoading, authMode, setAuthMode, authForm, setAuthForm, authError,
  isProcessing, handleAuth, handleLogout, users, setUsers, isUsersLoading, currentUser, setCurrentUser,
}: any) {
  const { t } = useI18n();

  if (isAuthLoading) {
    return (
      <div className="h-screen bg-bg text-text flex items-center justify-center font-mono">
        <motion.div animate={{ opacity: [0.5, 1, 0.5] }} transition={{ repeat: Infinity, duration: 1.5 }}>
          {t('pos_loading_system', 'LOADING SYSTEM...')}
        </motion.div>
      </div>
    );
  }

  if (!tenant) {
    return (
      <AuthScreen
        authMode={authMode}
        setAuthMode={setAuthMode}
        authForm={authForm}
        setAuthForm={setAuthForm}
        authError={authError}
        isProcessing={isProcessing}
        handleAuth={handleAuth}
      />
    );
  }

  if (tenant.email === 'hasbach') {
    return (
      <WindowFrame title={t('sa_control', 'Super Admin Control')} icon={<Shield size={14} />}>
        <div className="flex justify-end p-4 border-b border-border bg-surface">
           <button onClick={handleLogout} className="text-xs font-bold uppercase text-text-3 hover:text-danger transition-colors cursor-pointer">{t('logout', 'Logout')}</button>
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
    return <LicenseExpiredScreen tenant={tenant} handleLogout={handleLogout} />;
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
      <WindowFrame title={`OmniPOS ${t('pos_terminal_title', 'Terminal')}`} icon={<ShoppingCart size={14} />}>
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
