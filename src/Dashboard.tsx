import React, { useState, useEffect } from 'react';

import { AlertCircle, ArrowRight, Clock, RefreshCw } from 'lucide-react';

import { motion, AnimatePresence } from 'motion/react';

import { Tenant } from './types';

import { Link, Routes, Route } from 'react-router-dom';

import WindowFrame from './components/WindowFrame';

import { useTheme } from './hooks/useTheme';

import { I18nProvider, useI18n, type Language } from './intl/index';
import { ToastProvider } from './components/ui/ToastProvider';
import { ConfirmProvider } from './components/ui/ConfirmDialog';
import { Sidebar } from './components/shell/Sidebar';
import { TopBar } from './components/shell/TopBar';

import LiveMonitor from './pages/LiveMonitor';
import DailySales from './pages/DailySales';
import Overview from './pages/Overview';
import ProductManagement from './pages/ProductManagement';
import StockManagement from './pages/StockManagement';
import StakeholderManagement from './pages/StakeholderManagement';
import UserManagement from './pages/UserManagement';
import InvoiceManagement from './pages/InvoiceManagement';
import PurchaseManagement from './pages/PurchaseManagement';
import Reports from './pages/Reports';
import CashFlowRegister from './pages/CashFlowRegister';
import Settlement from './pages/Settlement';
import UserLogs from './pages/UserLogs';
import Settings from './pages/Settings';
import UiKit from './pages/UiKit';
import ImportWizard from './pages/ImportWizard';
import { RequirePermission, DashboardHome, refreshPermissions } from './lib/usePermissions';
import { pagePermissions } from './lib/permissions';

// Wraps a dashboard page in the role guard (see src/lib/permissions.ts PAGE_PERMISSIONS).
const guard = (page: string, element: React.ReactElement) => (
  <RequirePermission any={pagePermissions('/dashboard/' + page)}>{element}</RequirePermission>
);

function DashboardShell({
  tenant,
  language,
  onLanguageChange,
  showUpdateModal,
  setShowUpdateModal,
  updateVersion,
  isUpdating,
  scheduleForm,
  setScheduleForm,
  handleInstallUpdate,
  handleScheduleUpdate,
}: {
  tenant: Tenant | null;
  language: Language;
  onLanguageChange: (lang: Language) => void;
  showUpdateModal: boolean;
  setShowUpdateModal: (v: boolean) => void;
  updateVersion: string;
  isUpdating: boolean;
  scheduleForm: { date: string; time: string };
  setScheduleForm: React.Dispatch<React.SetStateAction<{ date: string; time: string }>>;
  handleInstallUpdate: () => void;
  handleScheduleUpdate: () => void;
}) {
  const { t } = useI18n();
  const [isDarkMode, setIsDarkMode] = useTheme();

  const isLicenseExpired = (type: string, expiry?: string) => {
    if (type === 'lifetime') return false;
    if (!expiry) return true;
    return new Date(expiry) < new Date();
  };

  if (tenant && tenant.email !== 'hasbach' && isLicenseExpired(tenant.local_license_type, tenant.local_license_expiry)) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-bg p-6">
        <div className="max-w-md w-full bg-surface border border-border rounded-2xl p-8 text-center space-y-6 shadow-xl">
          <div className="w-20 h-20 bg-danger-soft text-danger rounded-full flex items-center justify-center mx-auto">
            <AlertCircle size={40} />
          </div>
          <h2 className="text-2xl font-bold">{t('shell_license_expired_title')}</h2>
          <p className="text-text-3 text-sm">{t('shell_license_expired_body')}</p>
          <Link to="/" className="block w-full py-3 bg-primary text-on-primary rounded-xl font-semibold hover:bg-primary-hover transition-colors">
            {t('shell_license_back_to_terminal')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-bg text-text font-sans transition-colors duration-300">
      <Sidebar />

      <div className="flex flex-1 flex-col min-w-0">
        <TopBar
          isDarkMode={isDarkMode}
          onToggleTheme={setIsDarkMode}
          onOpenPos={() => window.open('/', '_blank')}
        />

        <main className="flex-1 overflow-y-auto p-6">
          <Routes>
            <Route path="/" element={<DashboardHome><Overview /></DashboardHome>} />
            <Route path="/live" element={guard('live', <LiveMonitor />)} />
            <Route path="/daily-sales" element={guard('daily-sales', <DailySales />)} />
            <Route path="/reports" element={guard('reports', <Reports />)} />
            <Route path="/products" element={guard('products', <ProductManagement />)} />
            <Route path="/stock" element={guard('stock', <StockManagement />)} />
            <Route path="/purchases" element={guard('purchases', <PurchaseManagement />)} />
            <Route path="/stakeholders" element={guard('stakeholders', <StakeholderManagement />)} />
            <Route path="/users" element={guard('users', <UserManagement />)} />
            <Route path="/invoices" element={guard('invoices', <InvoiceManagement />)} />
            <Route path="/cash-flow" element={guard('cash-flow', <CashFlowRegister />)} />
            <Route path="/settlement" element={guard('settlement', <Settlement />)} />
            <Route path="/logs" element={guard('logs', <UserLogs />)} />
            <Route path="/settings" element={guard('settings', <Settings onShowUpdate={() => setShowUpdateModal(true)} />)} />
            <Route path="/ui-kit" element={guard('ui-kit', <UiKit />)} />
            <Route path="/import" element={guard('import', <ImportWizard />)} />
          </Routes>
        </main>
      </div>

      {/* Update Modal */}
      <AnimatePresence>
        {showUpdateModal && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
              onClick={() => !isUpdating && setShowUpdateModal(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-surface border border-border rounded-2xl overflow-hidden shadow-[var(--shadow-modal)]"
            >
              <div className="p-8 text-center space-y-6">
                <div className="w-20 h-20 bg-primary-soft text-primary rounded-full flex items-center justify-center mx-auto">
                  <RefreshCw size={40} className={isUpdating ? 'animate-spin' : ''} />
                </div>

                <div className="space-y-2">
                  <h2 className="text-xl font-bold">{t('shell_update_available_title')}</h2>
                  <p className="text-text-3 text-sm">
                    {t('shell_update_available_body')
                      .replace('{version}', updateVersion)
                      .replace('{current}', tenant?.current_version || '')}
                  </p>
                </div>

                {isUpdating ? (
                  <div className="py-4 space-y-4">
                    <div className="h-2 w-full bg-surface-2 rounded-full overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: '100%' }}
                        transition={{ duration: 2 }}
                        className="h-full bg-primary"
                      />
                    </div>
                    <p className="text-xs font-medium uppercase tracking-widest animate-pulse text-text-3">
                      {t('shell_update_installing')}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <button
                      onClick={handleInstallUpdate}
                      className="w-full py-3 bg-primary text-on-primary rounded-xl font-semibold hover:bg-primary-hover transition-colors flex items-center justify-center gap-2 cursor-pointer"
                    >
                      {t('shell_update_install_now')} <ArrowRight size={18} />
                    </button>

                    <div className="p-5 bg-surface-2 rounded-2xl border border-border space-y-4">
                      <div className="flex items-center gap-2 text-xs font-medium uppercase text-text-3">
                        <Clock size={14} /> {t('shell_update_schedule_for_later')}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="date"
                          className="bg-surface border border-border rounded-lg p-2 text-xs outline-none focus:border-primary transition-colors"
                          value={scheduleForm.date}
                          onChange={(e) => setScheduleForm({ ...scheduleForm, date: e.target.value })}
                        />
                        <input
                          type="time"
                          className="bg-surface border border-border rounded-lg p-2 text-xs outline-none focus:border-primary transition-colors"
                          value={scheduleForm.time}
                          onChange={(e) => setScheduleForm({ ...scheduleForm, time: e.target.value })}
                        />
                      </div>
                      <button
                        onClick={handleScheduleUpdate}
                        className="w-full py-2 border border-border rounded-lg text-xs font-semibold uppercase tracking-widest hover:bg-primary hover:text-on-primary hover:border-primary transition-colors cursor-pointer"
                      >
                        {t('shell_update_confirm_schedule')}
                      </button>
                    </div>

                    <button
                      onClick={() => setShowUpdateModal(false)}
                      className="text-xs font-medium uppercase tracking-widest text-text-3 hover:text-text transition-colors cursor-pointer"
                    >
                      {t('shell_update_remind_later')}
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Dashboard() {
  const [language, setLanguage] = useState<Language>('en');
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateVersion, setUpdateVersion] = useState('');
  const [isUpdating, setIsUpdating] = useState(false);
  const [scheduleForm, setScheduleForm] = useState({ date: new Date().toISOString().split('T')[0], time: '02:00' });

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const cashierId = urlParams.get('cashierId');
    if (cashierId) sessionStorage.setItem('currentCashierId', cashierId);

    fetch('/api/auth/me')
      .then(res => res.json())
      .then(data => {
        setTenant(data);
        if (data.available_version && data.current_version && data.available_version !== data.current_version) {
          setUpdateVersion(data.available_version);
          setShowUpdateModal(true);
        }
      })
      .catch(err => console.error('Auth check error:', err));

    const safeFetchSettings = () => {
      fetch('/api/settings')
        .then(res => {
          if (!res.ok) return null;
          const contentType = res.headers.get("content-type");
          if (!contentType || !contentType.includes("application/json")) return null;
          return res.json();
        })
        .then(settings => {
          if (settings && settings.language) setLanguage(settings.language as Language);
        })
        .catch(err => console.error('Settings fetch error:', err));
    };

    safeFetchSettings();

    // Real-time Sync
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}`);

    socket.onopen = () => {
      fetch('/api/auth/me')
        .then(res => res.json())
        .then(tenant => {
          socket.send(JSON.stringify({
            type: 'IDENTIFY',
            tenantId: tenant.tenantId,
            isMonitor: true
          }));
        });
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'SETTINGS_UPDATED') {
          safeFetchSettings();
        }
        if (data.type === 'PERMISSIONS_UPDATED') {
          refreshPermissions();
        }
        if (data.type === 'UPDATE_AVAILABLE') {
          setUpdateVersion(data.version);
          setShowUpdateModal(true);
        }
        // Other components handle their own sync or we could use a global event bus
        window.dispatchEvent(new CustomEvent('pos-sync', { detail: data }));
      } catch (err) {
        console.error('WS Error:', err);
      }
    };

    return () => socket.close();
  }, []);

  useEffect(() => {
    if (!tenant) return;

    const checkScheduledUpdate = () => {
      if (tenant.scheduled_update_at) {
        const scheduledTime = new Date(tenant.scheduled_update_at).getTime();
        const now = new Date().getTime();
        if (now >= scheduledTime) {
          handleInstallUpdate();
        }
      }
    };

    const interval = setInterval(checkScheduledUpdate, 60000);
    checkScheduledUpdate();

    return () => clearInterval(interval);
  }, [tenant]);

  const handleInstallUpdate = async () => {
    setIsUpdating(true);
    try {
      const res = await fetch('/api/tenant/install-update', { method: 'POST' });
      if (res.ok) {
        setTimeout(() => {
          window.location.reload();
        }, 2000);
      }
    } catch (err) {
      console.error('Update failed:', err);
      setIsUpdating(false);
    }
  };

  const handleScheduleUpdate = async () => {
    const scheduledAt = `${scheduleForm.date}T${scheduleForm.time}:00`;
    try {
      const res = await fetch('/api/tenant/schedule-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_at: scheduledAt })
      });
      if (res.ok) {
        setShowUpdateModal(false);
        fetch('/api/auth/me').then(res => res.json()).then(setTenant);
      }
    } catch (err) {
      console.error('Scheduling failed:', err);
    }
  };

  const handleLanguageChange = (next: Language) => {
    setLanguage(next);
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: next }),
    }).catch((err) => console.error('Language save error:', err));
  };

  const dashboardTitle = language === 'ar' ? 'لوحة تحكم OmniPOS' : language === 'fr' ? 'Tableau de bord OmniPOS' : 'OmniPOS Admin Dashboard';

  return (
    <WindowFrame title={dashboardTitle}>
      <I18nProvider language={language} onLanguageChange={handleLanguageChange}>
        <ToastProvider>
          <ConfirmProvider>
            <DashboardShell
              tenant={tenant}
              language={language}
              onLanguageChange={handleLanguageChange}
              showUpdateModal={showUpdateModal}
              setShowUpdateModal={setShowUpdateModal}
              updateVersion={updateVersion}
              isUpdating={isUpdating}
              scheduleForm={scheduleForm}
              setScheduleForm={setScheduleForm}
              handleInstallUpdate={handleInstallUpdate}
              handleScheduleUpdate={handleScheduleUpdate}
            />
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </WindowFrame>
  );
}
