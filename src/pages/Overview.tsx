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

export default function Overview() {
  const [stats, setStats] = useState<any>(null);
  const [language, setLanguage] = useState<Language>('en');

  useEffect(() => {
    const fetchStats = () => {
      fetch('/api/reports/sales')
        .then(res => res.ok ? res.json() : null)
        .then(data => data && setStats(data))
        .catch(err => console.error('Stats fetch error:', err));
    };

    fetchStats();
    
    fetch('/api/settings')
      .then(res => res.ok ? res.json() : null)
      .then(s => s && s.language && setLanguage(s.language as Language))
      .catch(err => console.error('Settings fetch error:', err));

    const handleSync = (e: any) => {
      if (e.detail.type === 'TRANSACTIONS_UPDATED') {
        fetchStats();
      }
    };
    window.addEventListener('pos-sync', handleSync);
    return () => window.removeEventListener('pos-sync', handleSync);
  }, []);

  const t = translations[language];

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-4xl font-black tracking-tighter uppercase">{t.dashboard}</h1>
        <p className="opacity-50 font-medium">Real-time business performance metrics.</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="p-6 bg-app-surface border border-app-border rounded-2xl shadow-sm">
          <p className="text-xs font-black uppercase opacity-30 tracking-widest mb-2">Today's Sales</p>
          <h2 className="text-3xl font-black font-mono">${stats?.[0]?.total?.toFixed(2) || '0.00'}</h2>
        </div>
        <div className="p-6 bg-app-surface border border-app-border rounded-2xl shadow-sm">
          <p className="text-xs font-black uppercase opacity-30 tracking-widest mb-2">Transactions</p>
          <h2 className="text-3xl font-black font-mono">{stats?.[0]?.count || 0}</h2>
        </div>
        <div className="p-6 bg-app-surface border border-app-border rounded-2xl shadow-sm">
          <p className="text-xs font-black uppercase opacity-30 tracking-widest mb-2">System Status</p>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
            <h2 className="text-xl font-black uppercase">Online</h2>
          </div>
        </div>
      </div>
    </div>
  );
}