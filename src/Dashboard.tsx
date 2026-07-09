import React, { useState, useEffect, useCallback } from 'react';

import { 
  LayoutDashboard, 
  Package, 
  Users, 
  FileText, 
  BarChart3, 
  Settings as SettingsIcon,
  Plus,
  Edit2,
  Trash2,
  Save,
  X,
  Search,
  ArrowLeft,
  ShoppingCart,
  Sun,
  Moon,
  Globe,
  Coins,
  ClipboardList,
  Activity,
  Zap,
  Wallet,
  CalendarCheck,
  RotateCcw,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Printer,
  Download,
  Upload,
  Shield,
  Monitor,
  RefreshCw,
  Clock,
  ArrowRight
} from 'lucide-react';

import { motion, AnimatePresence } from 'motion/react';

import { Product, Stakeholder, Currency, Tenant } from './types';

import { Link, Routes, Route, useNavigate, useLocation } from 'react-router-dom';

import WindowFrame from './components/WindowFrame';

import { useTheme } from './hooks/useTheme';

import { translations, Language } from './i18n';

import * as XLSX from 'xlsx';

import { jsPDF } from 'jspdf';

import 'jspdf-autotable';


export const CURRENCIES = [
  { code: 'USD', symbol: '$', rate: 1 },
  { code: 'EUR', symbol: '€', rate: 0.92 },
  { code: 'LBP', symbol: 'LL', rate: 89500 },
];
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


export default function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
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

  const t = translations[language];

  const isLicenseExpired = (type: string, expiry?: string) => {
    if (type === 'lifetime') return false;
    if (!expiry) return true;
    return new Date(expiry) < new Date();
  };

  if (tenant && tenant.email !== 'hasbach' && isLicenseExpired(tenant.local_license_type, tenant.local_license_expiry)) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-app-bg p-6">
        <div className="max-w-md w-full bg-app-surface border border-app-border rounded-2xl p-8 text-center space-y-6 shadow-xl">
          <div className="w-20 h-20 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto">
            <AlertCircle size={40} />
          </div>
          <h2 className="text-2xl font-black uppercase tracking-tight">Software License Expired</h2>
          <p className="opacity-50 text-sm">Your local software license has expired. Please contact the administrator to renew your subscription.</p>
          <Link to="/" className="block w-full py-4 bg-app-ink text-app-bg rounded-xl font-black uppercase tracking-widest hover:opacity-90 transition-all">
            Back to Terminal
          </Link>
        </div>
      </div>
    );
  }

  const navItems = [
    { name: t.dashboard, icon: LayoutDashboard, path: '/dashboard' },
    { name: 'Cash Flow', icon: Wallet, path: '/dashboard/cash-flow' },
    { name: t.invoices, icon: FileText, path: '/dashboard/invoices' },
    { name: 'Live Monitor', icon: Activity, path: '/dashboard/live' },
    { name: 'Daily Sales', icon: BarChart3, path: '/dashboard/daily-sales' },
    { name: 'Reports', icon: FileText, path: '/dashboard/reports' },
    { name: t.products, icon: Package, path: '/dashboard/products' },
    { name: 'Stock Management', icon: ClipboardList, path: '/dashboard/stock' },
    { name: 'Purchases', icon: ShoppingCart, path: '/dashboard/purchases' },
    { name: t.stakeholders, icon: Users, path: '/dashboard/stakeholders' },
    { name: 'Team', icon: Shield, path: '/dashboard/users' },
    { name: 'Settlement', icon: CalendarCheck, path: '/dashboard/settlement' },
    { name: 'User Logs', icon: ClipboardList, path: '/dashboard/logs' },
    { name: t.settings, icon: SettingsIcon, path: '/dashboard/settings' },
  ];

  return (
    <WindowFrame title="OmniPOS Admin Dashboard" icon={<LayoutDashboard size={14} />}>
      <div className="flex h-full bg-app-bg text-app-ink font-sans transition-colors duration-300">
        {/* Sidebar */}
      <aside className="w-64 bg-app-surface border-r border-app-border flex flex-col transition-colors duration-300">
        <div className="p-6 border-b border-app-border flex items-center gap-2">
            <div className="w-8 h-8 bg-app-ink text-app-bg rounded flex items-center justify-center font-black">Ω</div>
            <span className="font-black tracking-tighter text-xl">ADMIN</span>
        </div>

        <nav className="flex-1 p-4 space-y-2 overflow-y-auto min-h-0">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path || (item.path !== '/dashboard' && location.pathname.startsWith(item.path));
            return (
              <Link
                key={item.path}
                to={item.path}
                replace
                className={`flex items-center gap-3 px-4 py-3 rounded-xl font-bold text-sm transition-all ${
                  isActive 
                    ? 'bg-app-ink text-app-bg shadow-lg' 
                    : 'opacity-50 hover:opacity-100 hover:bg-app-bg'
                }`}
              >
                <item.icon size={18} />
                {item.name}
              </Link>
            );
          })}
        </nav>

        <div className="p-6 border-t border-app-border text-[10px] uppercase tracking-widest font-black opacity-30">
          OmniPOS v2.5.0
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto bg-app-bg/50 p-8 flex flex-col">
        <div className="flex-1 h-full">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/live" element={<LiveMonitor />} />
          <Route path="/daily-sales" element={<DailySales />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/products" element={<ProductManagement />} />
          <Route path="/stock" element={<StockManagement />} />
          <Route path="/purchases" element={<PurchaseManagement />} />
          <Route path="/stakeholders" element={<StakeholderManagement />} />
          <Route path="/users" element={<UserManagement />} />
          <Route path="/invoices" element={<InvoiceManagement />} />
          <Route path="/cash-flow" element={<CashFlowRegister />} />
          <Route path="/settlement" element={<Settlement />} />
          <Route path="/logs" element={<UserLogs />} />
          <Route path="/settings" element={<Settings onShowUpdate={() => setShowUpdateModal(true)} />} />
        </Routes>
        </div>
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
            className="absolute inset-0 bg-app-ink/80 backdrop-blur-sm"
            onClick={() => !isUpdating && setShowUpdateModal(false)}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="relative w-full max-w-md bg-app-surface border border-app-border rounded-3xl overflow-hidden shadow-2xl"
          >
            <div className="p-8 text-center space-y-6">
              <div className="w-20 h-20 bg-app-ink text-app-bg rounded-full flex items-center justify-center mx-auto">
                <RefreshCw size={40} className={isUpdating ? 'animate-spin' : ''} />
              </div>
              
              <div className="space-y-2">
                <h2 className="text-2xl font-black uppercase tracking-tight">Update Available</h2>
                <p className="opacity-50 text-sm">A new version of OmniPOS ({updateVersion}) is ready to be installed. Your current version is {tenant?.current_version}.</p>
              </div>

              {isUpdating ? (
                <div className="py-4 space-y-4">
                  <div className="h-2 w-full bg-app-bg rounded-full overflow-hidden">
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: '100%' }}
                      transition={{ duration: 2 }}
                      className="h-full bg-app-ink"
                    />
                  </div>
                  <p className="text-[10px] font-black uppercase tracking-widest animate-pulse">Installing updates... Please wait</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <button 
                    onClick={handleInstallUpdate}
                    className="w-full py-4 bg-app-ink text-app-bg rounded-xl font-black uppercase tracking-widest hover:opacity-90 transition-all flex items-center justify-center gap-2"
                  >
                    Install Now <ArrowRight size={18} />
                  </button>
                  
                  <div className="p-6 bg-app-bg rounded-2xl border border-app-border/10 space-y-4">
                    <div className="flex items-center gap-2 text-[10px] font-black uppercase opacity-40">
                      <Clock size={14} /> Schedule for later
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input 
                        type="date" 
                        className="bg-app-surface border border-app-border rounded-lg p-2 text-xs outline-none focus:border-app-ink transition-all"
                        value={scheduleForm.date}
                        onChange={e => setScheduleForm({...scheduleForm, date: e.target.value})}
                      />
                      <input 
                        type="time" 
                        className="bg-app-surface border border-app-border rounded-lg p-2 text-xs outline-none focus:border-app-ink transition-all"
                        value={scheduleForm.time}
                        onChange={e => setScheduleForm({...scheduleForm, time: e.target.value})}
                      />
                    </div>
                    <button 
                      onClick={handleScheduleUpdate}
                      className="w-full py-2 border border-app-border rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-app-ink hover:text-app-bg transition-all"
                    >
                      Confirm Schedule
                    </button>
                  </div>

                  <button 
                    onClick={() => setShowUpdateModal(false)}
                    className="text-[10px] font-black uppercase tracking-widest opacity-30 hover:opacity-100 transition-opacity"
                  >
                    Remind me later
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
    </WindowFrame>
  );
}