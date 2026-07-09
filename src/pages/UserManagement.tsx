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

export default function UserManagement() {
  const [users, setUsers] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>(null);

  useEffect(() => { fetchUsers(); }, []);
  const fetchUsers = () => fetch('/api/users').then(res => res.json()).then(setUsers);

  const handleSave = async () => {
    if (!editing) return;
    const method = editing.id ? 'PUT' : 'POST';
    const url = editing.id ? `/api/users/${editing.id}` : '/api/users';
    await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editing) });
    setEditing(null);
    fetchUsers();
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure?')) return;
    await fetch(`/api/users/${id}`, { method: 'DELETE' });
    fetchUsers();
  };

  return (
    <div className="space-y-6">
      <header className="flex justify-between items-end">
        <div>
          <h1 className="text-4xl font-black tracking-tighter uppercase">Team Management</h1>
          <p className="opacity-50 font-medium">Manage cashiers, managers, and accountants.</p>
        </div>
        <button 
          onClick={() => setEditing({ name: '', role: 'cashier' })}
          className="px-6 py-3 bg-app-ink text-app-bg rounded-xl font-black uppercase text-xs flex items-center gap-2 hover:opacity-90 transition-all shadow-lg"
        >
          <Plus size={18} /> Add User
        </button>
      </header>

      <div className="bg-app-surface border border-app-border rounded-2xl overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-app-bg/50 text-[10px] uppercase tracking-widest font-black opacity-50">
              <th className="p-4 border-b border-app-border">Name</th>
              <th className="p-4 border-b border-app-border">Role</th>
              <th className="p-4 border-b border-app-border text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {users.map(u => (
              <tr key={u.id} className="hover:bg-app-bg/30 transition-colors group">
                <td className="p-4 border-b border-app-border font-bold">{u.name}</td>
                <td className="p-4 border-b border-app-border uppercase text-[10px] font-black opacity-50">{u.role}</td>
                <td className="p-4 border-b border-app-border text-right">
                  <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => setEditing(u)} className="p-2 hover:bg-app-bg rounded-lg"><Edit2 size={16} /></button>
                    <button onClick={() => handleDelete(u.id)} className="p-2 hover:bg-red-500 hover:text-white rounded-lg"><Trash2 size={16} /></button>
                  </div>
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
            <motion.div initial={{ scale: 0.9, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.9, opacity: 0, y: 20 }} className="relative bg-app-surface w-full max-w-md rounded-2xl overflow-hidden shadow-2xl border border-app-border p-8 space-y-6">
              <h2 className="text-2xl font-black uppercase tracking-tighter">{editing.id ? 'Edit User' : 'New User'}</h2>
              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Name</label>
                  <input autoFocus type="text" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none" value={editing.name} onChange={e => setEditing({...editing, name: e.target.value})} />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Role</label>
                  <select className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none" value={editing.role} onChange={e => setEditing({...editing, role: e.target.value})}>
                    <option value="cashier">Cashier</option>
                    <option value="manager">Manager</option>
                    <option value="accountant">Accountant</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">4-Digit PIN</label>
                  <input 
                    type="password" 
                    maxLength={4} 
                    placeholder="0000"
                    className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none text-center font-mono tracking-[1em]" 
                    value={editing.pin || ''} 
                    onChange={e => {
                      const val = e.target.value.replace(/[^0-9]/g, '');
                      setEditing({...editing, pin: val});
                    }} 
                  />
                  <p className="text-[8px] opacity-40 uppercase tracking-widest text-center mt-1">Default is 0000. Numbers only.</p>
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