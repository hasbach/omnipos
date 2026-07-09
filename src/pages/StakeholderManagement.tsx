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

export default function StakeholderManagement() {
  const [stakeholders, setStakeholders] = useState<Stakeholder[]>([]);
  const [editing, setEditing] = useState<Partial<Stakeholder> | null>(null);

  useEffect(() => { fetchStakeholders(); }, []);
  const fetchStakeholders = () => fetch('/api/stakeholders').then(res => res.json()).then(setStakeholders);

  const handleSave = async () => {
    if (!editing) return;
    const method = editing.id ? 'PUT' : 'POST';
    const url = editing.id ? `/api/stakeholders/${editing.id}` : '/api/stakeholders';
    await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editing) });
    setEditing(null);
    fetchStakeholders();
  };

  return (
    <div className="space-y-6">
      <header className="flex justify-between items-end">
        <div>
          <h1 className="text-4xl font-black tracking-tighter uppercase">Stakeholders</h1>
          <p className="opacity-50 font-medium">Manage customers and suppliers.</p>
        </div>
        <button 
          onClick={() => setEditing({ name: '', type: 'customer', balance: 0 })}
          className="px-6 py-3 bg-app-ink text-app-bg rounded-xl font-black uppercase text-xs flex items-center gap-2 hover:opacity-90 transition-all"
        >
          <Plus size={18} /> Add Stakeholder
        </button>
      </header>

      <div className="bg-app-surface border border-app-border rounded-2xl overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-app-bg/50 text-[10px] uppercase tracking-widest font-black opacity-50">
              <th className="p-4 border-b border-app-border">Name</th>
              <th className="p-4 border-b border-app-border">Type</th>
              <th className="p-4 border-b border-app-border">Contact</th>
              <th className="p-4 border-b border-app-border text-right">Balance</th>
              <th className="p-4 border-b border-app-border text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {stakeholders.map(s => (
              <tr key={s.id} className="hover:bg-app-bg/30 transition-colors group">
                <td className="p-4 border-b border-app-border font-bold">{s.name}</td>
                <td className="p-4 border-b border-app-border uppercase text-[10px] font-black opacity-50">{s.type}</td>
                <td className="p-4 border-b border-app-border opacity-50">{s.email || s.phone || 'N/A'}</td>
                <td className="p-4 border-b border-app-border text-right font-mono font-bold">${s.balance.toFixed(2)}</td>
                <td className="p-4 border-b border-app-border text-right">
                  <button onClick={() => setEditing(s)} className="p-2 hover:bg-app-bg rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"><Edit2 size={16} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AnimatePresence>
        {editing && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setEditing(null)} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <motion.div initial={{ scale: 0.9, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.9, opacity: 0, y: 20 }} className="relative bg-app-surface w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl border border-app-border p-8 space-y-6">
              <h2 className="text-2xl font-black uppercase tracking-tighter">{editing.id ? 'Edit Stakeholder' : 'New Stakeholder'}</h2>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1 col-span-2">
                  <label className="text-[10px] font-black uppercase opacity-50">Name</label>
                  <input autoFocus type="text" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none" value={editing.name || ''} onChange={e => setEditing({...editing, name: e.target.value})} />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Type</label>
                  <select className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none" value={editing.type} onChange={e => setEditing({...editing, type: e.target.value as any})}>
                    <option value="customer">Customer</option>
                    <option value="supplier">Supplier</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Balance ($)</label>
                  <input type="number" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none" value={editing.balance} onChange={e => setEditing({...editing, balance: parseFloat(e.target.value)})} />
                </div>
              </div>
              <div className="flex gap-4 pt-4">
                <button onClick={handleSave} className="flex-1 py-4 bg-app-ink text-app-bg rounded-xl font-black uppercase text-xs flex items-center justify-center gap-2"><Save size={18} /> Save</button>
                <button onClick={() => setEditing(null)} className="px-6 py-4 border-2 border-app-border rounded-xl font-black uppercase text-xs">Cancel</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}