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
  ArrowRight,
  Tag
} from 'lucide-react';

import { motion, AnimatePresence } from 'motion/react';

import { Product, Stakeholder, Currency, Tenant } from '../types';

import { Link, Routes, Route, useNavigate, useLocation } from 'react-router-dom';

import WindowFrame from '../components/WindowFrame';

import LabelPrinter from '../components/LabelPrinter';

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

export default function ProductManagement() {
  const [products, setProducts] = useState<Product[]>([]);
  const [editingProduct, setEditingProduct] = useState<Partial<Product> & { stockEntryMode?: 'units' | 'packages', stockInput?: number } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [language, setLanguage] = useState<Language>('en');
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [showLabelPrinter, setShowLabelPrinter] = useState(false);
  const [labelPreSelected, setLabelPreSelected] = useState<number[]>([]);

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

  const categories = Array.from(new Set(products.map(p => p.category).filter(Boolean)));

  const handleSave = async () => {
    if (!editingProduct) return;
    const method = editingProduct.id ? 'PUT' : 'POST';
    const url = editingProduct.id ? `/api/products/${editingProduct.id}` : '/api/products';
    
    const isService = editingProduct.track_inventory === 0;

    let finalStock = editingProduct.stock || 0;
    if (editingProduct.stockEntryMode === 'packages' && editingProduct.stockInput !== undefined) {
      finalStock = (editingProduct.stockInput * (editingProduct.units_per_package || 1));
    } else if (editingProduct.stockInput !== undefined) {
      finalStock = editingProduct.stockInput;
    }

    const payload = {
      ...editingProduct,
      track_inventory: isService ? 0 : 1,
      stock: isService ? 0 : finalStock,
      barcodes: editingProduct.barcodes || [editingProduct.barcode].filter(Boolean),
      price: editingProduct.price || 0,
      price_lbp: editingProduct.price_lbp || 0,
      package_price: editingProduct.package_price || 0,
      package_price_lbp: editingProduct.package_price_lbp || 0,
      cost: editingProduct.cost || 0,
      cost_lbp: editingProduct.cost_lbp || 0
    };
    
    await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    setEditingProduct(null);
    fetchProducts();
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure?')) return;
    await fetch(`/api/products/${id}`, { method: 'DELETE' });
    fetchProducts();
  };

  const filtered = products.filter(p => 
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    (p.barcode || '').includes(searchTerm) ||
    p.barcodes?.some(b => b.includes(searchTerm))
  );

  const handleExport = async (format: 'json' | 'csv' | 'xlsx' | 'pdf') => {
    try {
      const res = await fetch('/api/products/export');
      const data = await res.json();
      const date = new Date().toISOString().split('T')[0];
      const filename = `products_export_${date}`;

      if (format === 'json') {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else if (format === 'csv' || format === 'xlsx') {
        const worksheet = XLSX.utils.json_to_sheet(data.map((p: any) => ({
          ID: p.id,
          Barcode: p.barcode,
          Barcodes: p.barcodes?.join(', '),
          Name: p.name,
          Price: p.price,
          'Package Price': p.package_price,
          'Units/Pkg': p.units_per_package,
          Stock: p.stock,
          Category: p.category,
          Unit: p.unit
        })));
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Products");
        XLSX.writeFile(workbook, `${filename}.${format}`);
      } else if (format === 'pdf') {
        const doc = new jsPDF();
        doc.text("Product Inventory Report", 14, 15);
        (doc as any).autoTable({
          startY: 20,
          head: [['Barcode', 'Name', 'Price', 'Stock', 'Category']],
          body: data.map((p: any) => [p.barcode, p.name, `$${p.price.toFixed(2)}`, p.stock, p.category]),
          theme: 'striped',
          headStyles: { fillStyle: 'black' }
        });
        doc.save(`${filename}.pdf`);
      }
      setShowExportMenu(false);
    } catch (err) {
      console.error('Export error:', err);
      alert('Failed to export products');
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    const extension = file.name.split('.').pop()?.toLowerCase();

    reader.onload = async (event) => {
      try {
        let jsonData: any[] = [];
        
        if (extension === 'json') {
          jsonData = JSON.parse(event.target?.result as string);
        } else if (extension === 'csv' || extension === 'xlsx' || extension === 'xls') {
          const data = new Uint8Array(event.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: 'array' });
          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];
          const rawData = XLSX.utils.sheet_to_json(worksheet);
          
          // Map friendly names back to keys
          jsonData = rawData.map((row: any) => {
            const barcode = String(row.Barcode || row.barcode || '');
            const rawBarcodes = row.Barcodes || row.barcodes;
            const barcodes = rawBarcodes ? String(rawBarcodes).split(',').map((s: string) => s.trim()) : [barcode].filter(Boolean);
            
            return {
              barcode: barcode,
              barcodes: barcodes,
              name: String(row.Name || row.name || 'Unnamed Product'),
              price: parseFloat(String(row.Price || row.price || 0)),
              package_price: parseFloat(String(row['Package Price'] || row.package_price || 0)),
              units_per_package: parseInt(String(row['Units/Pkg'] || row.units_per_package || 1)),
              stock: parseInt(String(row.Stock || row.stock || 0)),
              category: String(row.Category || row.category || 'General'),
              unit: String(row.Unit || row.unit || 'pcs')
            };
          });
        } else {
          throw new Error('Unsupported file format');
        }

        const res = await fetch('/api/products/bulk-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(jsonData)
        });
        
        if (res.ok) {
          alert('Products imported successfully');
          fetchProducts();
        } else {
          const err = await res.json();
          alert(`Import failed: ${err.error}`);
        }
      } catch (err: any) {
        console.error('Import error:', err);
        alert(`Import error: ${err.message}`);
      }
    };

    if (extension === 'json') {
      reader.readAsText(file);
    } else {
      reader.readAsArrayBuffer(file);
    }
    
    e.target.value = ''; // Reset input
    setShowImportMenu(false);
  };

  const handleDownloadTemplate = () => {
    const templateData = [
      {
        Barcode: "1001",
        Name: "Sample Product",
        Price: 10.50,
        "Package Price": 100.00,
        "Units/Pkg": 10,
        Stock: 50,
        Category: "General",
        Unit: "pcs",
        Barcodes: "1001, 1002"
      }
    ];
    const worksheet = XLSX.utils.json_to_sheet(templateData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Template");
    XLSX.writeFile(workbook, "product_import_template.xlsx");
    setShowImportMenu(false);
  };

  return (
    <div className="h-full flex flex-col space-y-6">
      <header className="flex justify-between items-end flex-shrink-0">
        <div>
          <h1 className="text-4xl font-black tracking-tighter uppercase">{t.products}</h1>
          <p className="opacity-50 font-medium">Manage your inventory and pricing.</p>
        </div>
        <div className="flex gap-2 items-center">
          {/* Print Labels */}
          <button
            onClick={() => { setLabelPreSelected([]); setShowLabelPrinter(true); }}
            className="px-4 py-3 bg-app-surface border border-app-border rounded-xl font-black uppercase text-[10px] flex items-center gap-2 hover:bg-app-bg transition-all"
          >
            <Tag size={16} /> Labels
          </button>

          {/* Export Menu */}
          <div className="relative">
            <button 
              onClick={() => setShowExportMenu(!showExportMenu)}
              className="px-4 py-3 bg-app-surface border border-app-border rounded-xl font-black uppercase text-[10px] flex items-center gap-2 hover:bg-app-bg transition-all"
            >
              <Download size={16} /> Export
            </button>
            <AnimatePresence>
              {showExportMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowExportMenu(false)} />
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}
                    className="absolute right-0 mt-2 w-40 bg-app-surface border border-app-border rounded-xl shadow-xl z-20 overflow-hidden"
                  >
                    {(['json', 'csv', 'xlsx', 'pdf'] as const).map(format => (
                      <button
                        key={format}
                        onClick={() => handleExport(format)}
                        className="w-full px-4 py-3 text-left text-[10px] font-black uppercase hover:bg-app-bg transition-colors border-b border-app-border last:border-0"
                      >
                        {format.toUpperCase()}
                      </button>
                    ))}
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>

          {/* Import Menu */}
          <div className="relative">
            <button 
              onClick={() => setShowImportMenu(!showImportMenu)}
              className="px-4 py-3 bg-app-surface border border-app-border rounded-xl font-black uppercase text-[10px] flex items-center gap-2 hover:bg-app-bg transition-all"
            >
              <Upload size={16} /> Import
            </button>
            <AnimatePresence>
              {showImportMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowImportMenu(false)} />
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}
                    className="absolute right-0 mt-2 w-48 bg-app-surface border border-app-border rounded-xl shadow-xl z-20 overflow-hidden p-2 space-y-1"
                  >
                    <p className="px-2 py-1 text-[8px] font-black uppercase opacity-30">Select File</p>
                    <label className="block w-full px-4 py-3 text-left text-[10px] font-black uppercase hover:bg-app-bg transition-colors rounded-lg cursor-pointer">
                      JSON / CSV / EXCEL
                      <input type="file" accept=".json,.csv,.xlsx,.xls" className="hidden" onChange={handleImport} />
                    </label>
                    <div className="h-px bg-app-border mx-2 my-1" />
                    <button 
                      onClick={handleDownloadTemplate}
                      className="w-full px-4 py-3 text-left text-[10px] font-black uppercase hover:bg-app-bg transition-colors rounded-lg flex items-center gap-2"
                    >
                      <Download size={14} /> Template
                    </button>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>

          <button 
            onClick={() => setEditingProduct({ name: '', barcode: '', price: 0, package_price: 0, units_per_package: 1, stock: 0, stockInput: 0, stockEntryMode: 'units', track_inventory: 1, category: 'General', unit: 'pcs' })}
            className="px-6 py-3 bg-app-ink text-app-bg rounded-xl font-black uppercase text-[10px] flex items-center gap-2 hover:opacity-90 transition-all shadow-lg"
          >
            <Plus size={18} /> {t.add_product}
          </button>
        </div>
      </header>

      <div className="relative flex-shrink-0">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 opacity-30" size={18} />
        <input 
          type="text"
          placeholder={t.search_placeholder}
          className="w-full pl-12 pr-4 py-4 bg-app-surface border border-app-border rounded-xl outline-none focus:border-app-ink transition-all"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      <div className="flex-1 min-h-0 bg-app-surface border border-app-border rounded-2xl overflow-hidden shadow-sm flex flex-col">
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left border-collapse min-w-[1200px]">
            <thead className="sticky top-0 z-10 bg-app-bg">
              <tr className="text-[10px] uppercase tracking-widest font-black opacity-50">
                <th className="p-4 border-b border-app-border">{t.barcode}</th>
                <th className="p-4 border-b border-app-border">{t.name}</th>
                <th className="p-4 border-b border-app-border">{t.unit}</th>
                <th className="p-4 border-b border-app-border text-right">Price (USD)</th>
                <th className="p-4 border-b border-app-border text-right">Price (LBP)</th>
                <th className="p-4 border-b border-app-border text-right">Pkg Price</th>
                <th className="p-4 border-b border-app-border text-right">Units/Pkg</th>
                <th className="p-4 border-b border-app-border text-right">{t.stock}</th>
                <th className="p-4 border-b border-app-border">{t.category}</th>
                <th className="p-4 border-b border-app-border text-right">{t.actions}</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {filtered.map(p => (
                <tr key={p.id} className="hover:bg-app-bg/30 transition-colors group">
                  <td className="p-4 border-b border-app-border font-mono">{p.barcode}</td>
                  <td className="p-4 border-b border-app-border font-bold">{p.name}</td>
                  <td className="p-4 border-b border-app-border opacity-50">{p.unit}</td>
                  <td className="p-4 border-b border-app-border text-right font-mono">${(p.price || 0).toFixed(2)}</td>
                  <td className="p-4 border-b border-app-border text-right font-mono text-emerald-600 font-bold">{(p.price_lbp || 0).toLocaleString()} LL</td>
                  <td className="p-4 border-b border-app-border text-right font-mono opacity-50">
                    {p.package_price ? `$${p.package_price.toFixed(2)}` : '-'}
                  </td>
                  <td className="p-4 border-b border-app-border text-right font-mono opacity-50">
                    {p.units_per_package || 1}
                  </td>
                  <td className={`p-4 border-b border-app-border text-right font-mono font-bold ${p.track_inventory === 0 ? '' : (p.stock < 10 ? 'text-red-500' : '')}`}>
                    {p.track_inventory === 0 ? (
                      <span className="px-2 py-1 bg-violet-500/10 text-violet-500 text-[10px] font-black uppercase rounded">Service</span>
                    ) : p.stock}
                  </td>
                  <td className="p-4 border-b border-app-border uppercase text-[10px] font-black opacity-50">{p.category}</td>
                  <td className="p-4 border-b border-app-border text-right">
                    <div className="flex justify-end gap-2 items-center">
                      <button
                        onClick={() => { setLabelPreSelected([p.id]); setShowLabelPrinter(true); }}
                        className="p-2 bg-violet-500/10 hover:bg-violet-500 text-violet-500 hover:text-white rounded-lg transition-colors"
                        title="Print label for this product"
                      >
                        <Tag size={14} />
                      </button>
                      <button 
                        onClick={() => setEditingProduct({ ...p, stockInput: p.stock, stockEntryMode: 'units' })} 
                        className="p-2 bg-blue-500/10 hover:bg-blue-500 text-blue-500 hover:text-white rounded-lg transition-colors flex items-center gap-1 text-[10px] font-black uppercase"
                        title="Edit product"
                      >
                        <Edit2 size={14} /> Edit
                      </button>
                      <button 
                        onClick={() => handleDelete(p.id)} 
                        className="p-2 hover:bg-red-500 hover:text-white rounded-lg transition-colors text-app-ink/40 hover:text-white"
                        title="Delete product"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <AnimatePresence>
        {editingProduct && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setEditingProduct(null)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-app-surface w-full max-w-2xl rounded-2xl shadow-2xl border border-app-border p-8 space-y-6 max-h-[90vh] overflow-y-auto"
            >
              <h2 className="text-2xl font-black uppercase tracking-tighter">{editingProduct.id ? t.edit_product : t.new_product}</h2>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 flex items-center justify-between p-3 bg-app-bg/50 rounded-xl border border-app-border/50">
                  <div>
                    <div className="text-[10px] font-black uppercase">Service (no inventory)</div>
                    <div className="text-[10px] opacity-50">Turn off stock tracking for time/labor-based items.</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingProduct({ ...editingProduct, track_inventory: editingProduct.track_inventory === 0 ? 1 : 0 })}
                    className={`w-12 h-7 rounded-full transition-colors relative flex-shrink-0 ${editingProduct.track_inventory === 0 ? 'bg-violet-500' : 'bg-app-border'}`}
                  >
                    <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-transform ${editingProduct.track_inventory === 0 ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>

                <div className="space-y-1 col-span-2">
                  <label className="text-[10px] font-black uppercase opacity-50">{t.barcodes_label}</label>
                  <input
                    type="text" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-mono"
                    placeholder="1001, 1002, ..."
                    value={editingProduct.barcodes?.join(', ') || editingProduct.barcode || ''}
                    onChange={e => {
                      const codes = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                      setEditingProduct({...editingProduct, barcodes: codes, barcode: codes[0] || ''});
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">{t.name}</label>
                  <input
                    type="text" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none"
                    value={editingProduct.name} onChange={e => setEditingProduct({...editingProduct, name: e.target.value})}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">{t.unit_label}</label>
                  <input 
                    type="text" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none"
                    placeholder="pcs, kg, box..."
                    value={editingProduct.unit || ''} onChange={e => setEditingProduct({...editingProduct, unit: e.target.value})}
                  />
                </div>

                {/* Pricing Section */}
                <div className="col-span-2 grid grid-cols-2 gap-4 p-4 bg-app-bg/50 rounded-2xl border border-app-border/50">
                  <div className="col-span-2 flex items-center justify-between mb-2">
                    <h3 className="text-[10px] font-black uppercase tracking-widest opacity-50">Pricing & Cost (Auto-Calculate)</h3>
                    <div className="text-[8px] font-bold opacity-30 italic">Rate: 1 USD = 89,500 LBP</div>
                  </div>
                  
                  {/* Unit Price */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase opacity-50">Unit Price (USD)</label>
                    <input 
                      type="number" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-mono"
                      value={editingProduct.price || 0} 
                      onChange={e => {
                        const usd = parseFloat(e.target.value) || 0;
                        setEditingProduct({...editingProduct, price: usd, price_lbp: Math.round(usd * 89500)});
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase opacity-50">Unit Price (LBP)</label>
                    <input 
                      type="number" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-mono"
                      value={editingProduct.price_lbp || 0} 
                      onChange={e => {
                        const lbp = parseFloat(e.target.value) || 0;
                        setEditingProduct({...editingProduct, price_lbp: lbp, price: parseFloat((lbp / 89500).toFixed(2))});
                      }}
                    />
                  </div>

                  {/* Package Price */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase opacity-50">Package Price (USD)</label>
                    <input 
                      type="number" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-mono"
                      value={editingProduct.package_price || 0} 
                      onChange={e => {
                        const usd = parseFloat(e.target.value) || 0;
                        setEditingProduct({...editingProduct, package_price: usd, package_price_lbp: Math.round(usd * 89500)});
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase opacity-50">Package Price (LBP)</label>
                    <input 
                      type="number" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-mono"
                      value={editingProduct.package_price_lbp || 0} 
                      onChange={e => {
                        const lbp = parseFloat(e.target.value) || 0;
                        setEditingProduct({...editingProduct, package_price_lbp: lbp, package_price: parseFloat((lbp / 89500).toFixed(2))});
                      }}
                    />
                  </div>

                  {/* Cost Price */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase opacity-50">Cost Price (USD)</label>
                    <input 
                      type="number" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-mono"
                      value={editingProduct.cost || 0} 
                      onChange={e => {
                        const usd = parseFloat(e.target.value) || 0;
                        setEditingProduct({...editingProduct, cost: usd, cost_lbp: Math.round(usd * 89500)});
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase opacity-50">Cost Price (LBP)</label>
                    <input 
                      type="number" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-mono"
                      value={editingProduct.cost_lbp || 0} 
                      onChange={e => {
                        const lbp = parseFloat(e.target.value) || 0;
                        setEditingProduct({...editingProduct, cost_lbp: lbp, cost: parseFloat((lbp / 89500).toFixed(2))});
                      }}
                    />
                  </div>
                </div>

                {editingProduct.track_inventory !== 0 && (
                  <>
                    <div className="space-y-1">
                      <label className="text-[10px] font-black uppercase opacity-50">Units per Package</label>
                      <input
                        type="number" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none"
                        value={editingProduct.units_per_package || 1} onChange={e => setEditingProduct({...editingProduct, units_per_package: parseInt(e.target.value)})}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between items-center">
                        <label className="text-[10px] font-black uppercase opacity-50">{t.stock_label}</label>
                        <select
                          className="text-[8px] font-black uppercase bg-transparent outline-none"
                          value={editingProduct.stockEntryMode}
                          onChange={e => setEditingProduct({ ...editingProduct, stockEntryMode: e.target.value as any })}
                        >
                          <option value="units">Base Units</option>
                          <option value="packages">Packages</option>
                        </select>
                      </div>
                      <input
                        type="number" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none"
                        value={editingProduct.stockInput}
                        onChange={e => setEditingProduct({...editingProduct, stockInput: parseFloat(e.target.value)})}
                      />
                      {editingProduct.stockEntryMode === 'packages' && (
                        <p className="text-[8px] font-mono opacity-50 mt-1">
                          = {(editingProduct.stockInput || 0) * (editingProduct.units_per_package || 1)} Total Units
                        </p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-black uppercase opacity-50">Reorder Point</label>
                      <input
                        type="number" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none"
                        value={editingProduct.reorder_point || 0} onChange={e => setEditingProduct({...editingProduct, reorder_point: parseInt(e.target.value)})}
                      />
                    </div>
                  </>
                )}
                <div className="space-y-1 col-span-2">
                  <label className="text-[10px] font-black uppercase opacity-50">{t.category_label}</label>
                  <input 
                    type="text" 
                    list="category-list"
                    className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none"
                    value={editingProduct.category} 
                    onChange={e => setEditingProduct({...editingProduct, category: e.target.value})}
                  />
                  <datalist id="category-list">
                    {categories.map(cat => (
                      <option key={cat} value={cat} />
                    ))}
                  </datalist>
                </div>
              </div>

              <div className="flex gap-4 pt-4">
                <button onClick={handleSave} className="flex-1 py-4 bg-app-ink text-app-bg rounded-xl font-black uppercase text-xs flex items-center justify-center gap-2">
                  <Save size={18} /> {t.save}
                </button>
                <button onClick={() => setEditingProduct(null)} className="px-6 py-4 border-2 border-app-border rounded-xl font-black uppercase text-xs">
                  {t.cancel}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Label Printer */}
      <AnimatePresence>
        {showLabelPrinter && (
          <LabelPrinter
            products={products}
            preSelected={labelPreSelected}
            onClose={() => setShowLabelPrinter(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}