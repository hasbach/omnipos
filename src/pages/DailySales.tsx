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

export default function DailySales() {
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [language, setLanguage] = useState<Language>('en');

  useEffect(() => {
    fetch('/api/settings').then(res => res.json()).then(s => {
      if (s.language) setLanguage(s.language as Language);
    });
  }, []);

  const t = translations[language];

  const fetchDailySales = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/reports/daily-sales?date=${date}`);
      if (res.ok) {
        const data = await res.json();
        setTransactions(data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    fetchDailySales();
    
    const handleSync = (e: any) => {
      if (e.detail.type === 'TRANSACTIONS_UPDATED') {
        fetchDailySales();
      }
    };
    window.addEventListener('pos-sync', handleSync);
    return () => window.removeEventListener('pos-sync', handleSync);
  }, [fetchDailySales]);

  const totalSales = transactions.reduce((sum, t) => sum + (t.type === 'refund' ? -t.total_amount : t.total_amount), 0);

  return (
    <div className="space-y-8">
      <header className="flex justify-between items-end">
        <div>
          <h1 className="text-4xl font-black tracking-tighter uppercase">Daily Sales History</h1>
          <p className="opacity-50 font-medium">Review orders and performance by date.</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <p className="text-[10px] font-black uppercase opacity-50 tracking-widest">Total for Day</p>
            <p className="text-2xl font-black font-mono">${totalSales.toFixed(2)}</p>
          </div>
          <input 
            type="date" 
            className="p-3 bg-app-surface border border-app-border rounded-xl outline-none font-bold"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </header>

      <div className="bg-app-surface border border-app-border rounded-2xl overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-app-bg/50 text-[10px] uppercase tracking-widest font-black opacity-50">
              <th className="p-4 border-b border-app-border">ID</th>
              <th className="p-4 border-b border-app-border">Time</th>
              <th className="p-4 border-b border-app-border">Customer</th>
              <th className="p-4 border-b border-app-border">User/Cashier</th>
              <th className="p-4 border-b border-app-border text-right">Total</th>
              <th className="p-4 border-b border-app-border">Status</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {loading ? (
              <tr>
                <td colSpan={6} className="p-8 text-center opacity-50 italic">Loading transactions...</td>
              </tr>
            ) : transactions.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-8 text-center opacity-50 italic">No transactions found for this date.</td>
              </tr>
            ) : (
              transactions.map(tr => (
                <tr key={tr.id} className="hover:bg-app-bg/30 transition-colors border-b border-app-border/5">
                  <td className="p-4 font-mono">#{tr.id}</td>
                  <td className="p-4 opacity-50">{new Date(tr.created_at).toLocaleTimeString()}</td>
                  <td className="p-4 font-bold">{tr.stakeholder_name || 'Walk-in'}</td>
                  <td className="p-4">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-app-ink/10 flex items-center justify-center text-[10px] font-black">
                        {tr.user_name?.charAt(0)}
                      </div>
                      <span className="font-medium">{tr.user_name || 'System'}</span>
                    </div>
                  </td>
                  <td className="p-4 text-right font-mono font-bold">${tr.total_amount.toFixed(2)}</td>
                  <td className="p-4">
                    <span className="px-2 py-1 bg-emerald-500/10 text-emerald-500 text-[10px] font-black uppercase rounded">
                      {tr.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}