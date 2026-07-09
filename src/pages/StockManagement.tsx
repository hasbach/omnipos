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

export default function StockManagement() {
  const [products, setProducts] = useState<Product[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [editingStock, setEditingStock] = useState<Product | null>(null);
  const [newStock, setNewStock] = useState<number>(0);
  const [newReorderPoint, setNewReorderPoint] = useState<number>(0);
  const [language, setLanguage] = useState<Language>('en');

  useEffect(() => {
    fetchProducts();
    fetch('/api/settings')
      .then(res => res.ok ? res.json() : null)
      .then(s => s && s.language && setLanguage(s.language as Language))
      .catch(err => console.error('Settings fetch error:', err));

    const handleSync = (e: any) => {
      if (e.detail.type === 'PRODUCTS_UPDATED') {
        fetchProducts();
      }
    };
    window.addEventListener('pos-sync', handleSync);
    return () => window.removeEventListener('pos-sync', handleSync);
  }, []);

  const t = translations[language];

  const fetchProducts = () => {
    fetch('/api/products').then(res => res.json()).then(setProducts);
  };

  const handleUpdateStock = async () => {
    if (!editingStock) return;
    
    const res = await fetch(`/api/products/${editingStock.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...editingStock,
        stock: newStock,
        reorder_point: newReorderPoint
      })
    });
    
    if (res.ok) {
      setEditingStock(null);
      fetchProducts();
    }
  };

  const trackedProducts = products.filter(p => p.track_inventory !== 0);

  const categories = ['All', ...new Set(trackedProducts.map(p => p.category))];

  const filtered = trackedProducts.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         (p.barcode || '').includes(searchTerm);
    const matchesCategory = selectedCategory === 'All' || p.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-4xl font-black tracking-tighter uppercase">Stock Management</h1>
        <p className="opacity-50 font-medium">Monitor levels and manage reorder points.</p>
      </header>

      <div className="flex gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 opacity-30" size={18} />
          <input 
            type="text"
            placeholder="Search by name or barcode..."
            className="w-full pl-12 pr-4 py-4 bg-app-surface border border-app-border rounded-xl outline-none focus:border-app-ink transition-all"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <select 
          className="px-6 py-4 bg-app-surface border border-app-border rounded-xl outline-none font-bold"
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
        >
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="bg-app-surface border border-app-border rounded-2xl overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-app-bg/50 text-[10px] uppercase tracking-widest font-black opacity-50">
              <th className="p-4 border-b border-app-border">Product</th>
              <th className="p-4 border-b border-app-border">Category</th>
              <th className="p-4 border-b border-app-border text-right">Current Stock</th>
              <th className="p-4 border-b border-app-border text-right">Reorder Point</th>
              <th className="p-4 border-b border-app-border">Status</th>
              <th className="p-4 border-b border-app-border text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {filtered.map(p => {
              const isLowStock = p.stock <= (p.reorder_point || 0);
              return (
                <tr key={p.id} className="hover:bg-app-bg/30 transition-colors group">
                  <td className="p-4 border-b border-app-border">
                    <div className="font-bold">{p.name}</div>
                    <div className="text-[10px] font-mono opacity-50">{p.barcode}</div>
                  </td>
                  <td className="p-4 border-b border-app-border uppercase text-[10px] font-black opacity-50">{p.category}</td>
                  <td className={`p-4 border-b border-app-border text-right font-mono font-bold ${isLowStock ? 'text-red-500' : ''}`}>
                    {p.stock} {p.unit}
                  </td>
                  <td className="p-4 border-b border-app-border text-right font-mono opacity-50">
                    {p.reorder_point || 0}
                  </td>
                  <td className="p-4 border-b border-app-border">
                    {isLowStock ? (
                      <span className="px-2 py-1 bg-red-500/10 text-red-500 text-[10px] font-black uppercase rounded">Low Stock</span>
                    ) : (
                      <span className="px-2 py-1 bg-emerald-500/10 text-emerald-500 text-[10px] font-black uppercase rounded">In Stock</span>
                    )}
                  </td>
                  <td className="p-4 border-b border-app-border text-right">
                    <button 
                      onClick={() => {
                        setEditingStock(p);
                        setNewStock(p.stock);
                        setNewReorderPoint(p.reorder_point || 0);
                      }}
                      className="px-4 py-2 bg-app-ink text-app-bg rounded-lg font-black uppercase text-[10px] hover:opacity-90 transition-all"
                    >
                      Adjust
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <AnimatePresence>
        {editingStock && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setEditingStock(null)} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <motion.div initial={{ scale: 0.9, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.9, opacity: 0, y: 20 }} className="relative bg-app-surface w-full max-w-md rounded-2xl overflow-hidden shadow-2xl border border-app-border p-8 space-y-6">
              <h2 className="text-2xl font-black uppercase tracking-tighter">Adjust Stock: {editingStock.name}</h2>
              
              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Current Quantity ({editingStock.unit})</label>
                  <input 
                    type="number" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-bold"
                    value={newStock} onChange={e => setNewStock(parseFloat(e.target.value))}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Reorder Point</label>
                  <input 
                    type="number" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-bold"
                    value={newReorderPoint} onChange={e => setNewReorderPoint(parseInt(e.target.value))}
                  />
                </div>
              </div>

              <div className="flex gap-4 pt-4">
                <button onClick={handleUpdateStock} className="flex-1 py-4 bg-app-ink text-app-bg rounded-xl font-black uppercase text-xs flex items-center justify-center gap-2">
                  <Save size={18} /> Update Stock
                </button>
                <button onClick={() => setEditingStock(null)} className="px-6 py-4 border-2 border-app-border rounded-xl font-black uppercase text-xs">
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}