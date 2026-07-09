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

import { Product, Stakeholder, Currency, Tenant } from '../types';

import { Link, Routes, Route, useNavigate, useLocation } from 'react-router-dom';

import WindowFrame from '../components/WindowFrame';

import { useTheme } from '../hooks/useTheme';

import { translations, Language } from '../i18n';

import * as XLSX from 'xlsx';

import { jsPDF } from 'jspdf';

import 'jspdf-autotable';


export const CURRENCIES = [
  { code: 'USD', symbol: '$', rate: 1 },
  { code: 'EUR', symbol: '€', rate: 0.92 },
  { code: 'LBP', symbol: 'LL', rate: 89500 },
];

export default function LiveMonitor() {
  const [activities, setActivities] = useState<any[]>([]);
  const [activeTerminals, setActiveTerminals] = useState<Record<string, any>>({});
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [stats, setStats] = useState({
    todayTotal: 0,
    todayCount: 0,
    activeUsers: new Set(),
  });

  useEffect(() => {
    fetch('/api/auth/me').then(res => res.json()).then(setTenant);
    // Initial load of today's transactions
    fetch('/api/reports/daily-sales')
      .then(res => res.json())
      .then(data => {
        setActivities(data);
        const total = data.reduce((acc: number, t: any) => acc + t.total_amount, 0);
        const users = new Set(data.map((t: any) => t.user_name));
        setStats({
          todayTotal: total,
          todayCount: data.length,
          activeUsers: users
        });
      });

    const handleSync = (e: any) => {
      const data = e.detail;
      if (data.type === 'TRANSACTIONS_UPDATED' && data.transaction) {
        const newTx = data.transaction;
        setActivities(prev => [newTx, ...prev].slice(0, 50));
        setStats(prev => ({
          todayTotal: prev.todayTotal + newTx.total_amount,
          todayCount: prev.todayCount + 1,
          activeUsers: new Set([...Array.from(prev.activeUsers), newTx.user_name])
        }));
        // Clear active cart for this terminal
        setActiveTerminals(prev => {
          const next = { ...prev };
          delete next[data.terminalId];
          return next;
        });
      }

      if (data.type === 'REMOTE_CART_UPDATE') {
        setActiveTerminals(prev => ({
          ...prev,
          [data.terminalId]: {
            user: data.user,
            cart: data.cart,
            total: data.total,
            lastUpdate: new Date()
          }
        }));
      }

      if (data.type === 'TERMINAL_OFFLINE') {
        setActiveTerminals(prev => {
          const next = { ...prev };
          delete next[data.terminalId];
          return next;
        });
      }
    };

    window.addEventListener('pos-sync', handleSync);
    return () => window.removeEventListener('pos-sync', handleSync);
  }, []);

  const isOnlineExpired = tenant && tenant.email !== 'hasbach' && (tenant.online_license_type !== 'lifetime' && (!tenant.online_license_expiry || new Date(tenant.online_license_expiry) < new Date()));

  if (isOnlineExpired) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-12 text-center space-y-6">
        <div className="w-20 h-20 bg-orange-500/10 text-orange-500 rounded-full flex items-center justify-center">
          <Globe size={40} />
        </div>
        <div className="max-w-md space-y-2">
          <h2 className="text-2xl font-black uppercase tracking-tight">Online Monitor Expired</h2>
          <p className="opacity-50 text-sm">Your online monitoring subscription has expired. Please renew to access real-time terminal tracking.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="flex justify-between items-end">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-3 h-3 bg-emerald-500 rounded-full animate-pulse" />
            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-500">Live Remote Feed</span>
          </div>
          <h1 className="text-5xl font-black tracking-tighter uppercase">Store Monitor</h1>
          <p className="opacity-50 font-medium">Real-time activity from all POS terminals.</p>
        </div>
      </header>

      {/* Real-time Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="p-8 bg-app-surface border border-app-border rounded-3xl shadow-sm">
          <p className="text-[10px] font-black uppercase opacity-50 tracking-widest mb-1">Sales Today</p>
          <p className="text-4xl font-black font-mono">${stats.todayTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
        </div>
        <div className="p-8 bg-app-surface border border-app-border rounded-3xl shadow-sm">
          <p className="text-[10px] font-black uppercase opacity-50 tracking-widest mb-1">Transactions</p>
          <p className="text-4xl font-black font-mono">{stats.todayCount}</p>
        </div>
        <div className="p-8 bg-app-surface border border-app-border rounded-3xl shadow-sm">
          <p className="text-[10px] font-black uppercase opacity-50 tracking-widest mb-1">Active Staff</p>
          <p className="text-4xl font-black font-mono">{stats.activeUsers.size}</p>
        </div>
        <div className="p-8 bg-app-surface border border-app-border rounded-3xl shadow-sm">
          <p className="text-[10px] font-black uppercase opacity-50 tracking-widest mb-1">Active Terminals</p>
          <p className="text-4xl font-black font-mono">{Object.keys(activeTerminals).length}</p>
        </div>
      </div>

      {/* Active Terminals / Live Carts */}
      {Object.keys(activeTerminals).length > 0 && (
        <div className="space-y-4">
          <h2 className="font-black uppercase tracking-widest text-xs opacity-50">Live Terminals (Current Carts)</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <AnimatePresence>
              {Object.entries(activeTerminals).map(([id, data]: [string, any]) => (
                <motion.div 
                  key={id}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="bg-app-surface border-2 border-app-ink rounded-3xl overflow-hidden shadow-xl"
                >
                  <div className="p-4 bg-app-ink text-app-bg flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                      <span className="font-black uppercase text-[10px] tracking-widest">{id}</span>
                    </div>
                    <span className="text-[10px] font-mono opacity-50">{data.user}</span>
                  </div>
                  <div className="p-6 space-y-4">
                    <div className="space-y-2 max-h-40 overflow-y-auto">
                      {data.cart.length > 0 ? (
                        data.cart.map((item: any, i: number) => (
                          <div key={i} className="flex justify-between text-xs font-bold">
                            <span className="opacity-50">{item.quantity}x {item.name}</span>
                            <span className="font-mono">${(item.price * item.quantity).toFixed(2)}</span>
                          </div>
                        ))
                      ) : (
                        <p className="text-center py-4 text-[10px] font-black uppercase opacity-20 italic tracking-widest">Empty Cart</p>
                      )}
                    </div>
                    <div className="pt-4 border-t border-app-border/10 flex justify-between items-end">
                      <span className="text-[10px] font-black uppercase opacity-50">Current Total</span>
                      <span className="text-2xl font-black font-mono">${data.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}

      {/* Activity Feed */}
      <div className="bg-app-surface border border-app-border rounded-[40px] overflow-hidden shadow-xl">
        <div className="p-8 border-b border-app-border flex items-center justify-between bg-app-bg/10">
          <h2 className="font-black uppercase tracking-widest text-xs">Activity Stream</h2>
          <span className="text-[10px] font-bold opacity-30 uppercase">Showing last 50 events</span>
        </div>
        <div className="divide-y divide-app-border/5">
          <AnimatePresence initial={false}>
            {activities.length > 0 ? (
              activities.map((activity, idx) => (
                <motion.div 
                  key={activity.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="p-6 flex items-center justify-between hover:bg-app-bg/20 transition-colors group"
                >
                  <div className="flex items-center gap-6">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black text-xl ${
                      activity.type === 'sale' ? 'bg-emerald-500/10 text-emerald-600' : 
                      activity.type === 'refund' ? 'bg-red-500/10 text-red-600' : 'bg-blue-500/10 text-blue-600'
                    }`}>
                      {activity.type === 'sale' ? '$' : activity.type === 'refund' ? 'R' : 'P'}
                    </div>
                    <div>
                      <div className="flex items-center gap-3">
                        <p className="font-black uppercase tracking-tight">{activity.type} #{activity.id}</p>
                        <span className="text-[10px] font-bold opacity-30">{new Date(activity.created_at).toLocaleTimeString()}</span>
                      </div>
                      <p className="text-xs font-bold opacity-50">
                        Processed by <span className="text-app-ink">{activity.user_name}</span> 
                        {activity.stakeholder_name && <> for <span className="text-app-ink">{activity.stakeholder_name}</span></>}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`text-xl font-black font-mono ${activity.type === 'refund' ? 'text-red-500' : 'text-app-ink'}`}>
                      {activity.type === 'refund' ? '-' : ''}${activity.total_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </p>
                    <p className="text-[10px] font-black uppercase opacity-30 tracking-widest">{activity.currency}</p>
                  </div>
                </motion.div>
              ))
            ) : (
              <div className="p-20 text-center opacity-20">
                <Zap size={48} className="mx-auto mb-4" strokeWidth={1} />
                <p className="font-black uppercase tracking-widest">Waiting for activity...</p>
              </div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}