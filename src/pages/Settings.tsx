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
  Wifi,
  ScanLine
} from 'lucide-react';

import { motion, AnimatePresence } from 'motion/react';

import { Product, Stakeholder, Currency, Tenant } from '../types';

// Printer type defined locally to avoid Rollup module resolution issues
type Printer = {
  id?: number;
  name: string;
  type: 'receipt' | 'kitchen' | 'bar';
  connection: 'usb' | 'network' | 'bluetooth';
  address: string;
  is_default: number;
  paper_width: number;
  enabled: number;
};

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

export default function Settings({ onShowUpdate }: { onShowUpdate: () => void }) {
  const [isDarkMode, setIsDarkMode] = useTheme();
  const [language, setLanguage] = useState<Language>('en');
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [editingCurrency, setEditingCurrency] = useState<Partial<Currency> | null>(null);
  const [storeName, setStoreName] = useState('OmniPOS Retail');
  const [taxRate, setTaxRate] = useState('11');
  const [businessAddress, setBusinessAddress] = useState('');
  const [businessEmail, setBusinessEmail] = useState('');
  const [businessPhone, setBusinessPhone] = useState('');
  const [businessWebsite, setBusinessWebsite] = useState('');
  const [businessLogo, setBusinessLogo] = useState('');
  const [receiptFooter, setReceiptFooter] = useState('Thank you for your business!');
  const [showReceiptDialog, setShowReceiptDialog] = useState(true);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [editingPrinter, setEditingPrinter] = useState<Partial<Printer> | null>(null);
  const [scanResults, setScanResults] = useState<{ name: string; address: string }[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [showManualAddress, setShowManualAddress] = useState(false);

  // Manual "Check for Updates" (Electron auto-updater) state.
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'latest' | 'error'>('idle');
  const [updateInfo, setUpdateInfo] = useState<{ version?: string; percent?: number; message?: string }>({});

  const t = translations[language];

  // Reflect auto-updater events (broadcast from the main process) as inline status here.
  useEffect(() => {
    if (!window.electronAPI?.onUpdateStatus) return;
    const cleanup = window.electronAPI.onUpdateStatus((data: any) => {
      switch (data.event) {
        case 'checking':
          setUpdateState('checking'); setUpdateInfo({}); break;
        case 'available':
          setUpdateState('downloading'); setUpdateInfo({ version: data.version, percent: 0 });
          // autoDownload is off in the main process — kick off the download ourselves.
          window.electronAPI?.downloadUpdate?.();
          break;
        case 'progress':
          setUpdateState('downloading'); setUpdateInfo(prev => ({ ...prev, percent: data.percent })); break;
        case 'downloaded':
          setUpdateState('downloaded'); setUpdateInfo({ version: data.version }); break;
        case 'not-available':
          setUpdateState('latest'); setUpdateInfo({ version: data.version }); break;
        case 'error':
          setUpdateState('error'); setUpdateInfo({ message: data.message }); break;
      }
    });
    return cleanup;
  }, []);

  const handleCheckForUpdates = async () => {
    if (!window.electronAPI?.checkForUpdates) {
      setUpdateState('error');
      setUpdateInfo({ message: 'Updates are only available in the installed desktop app.' });
      return;
    }
    setUpdateState('checking');
    setUpdateInfo({});

    // Safety net: if no status event and no resolution arrive, don't hang on "checking".
    const timeout = setTimeout(() => {
      setUpdateState(prev => (prev === 'checking' ? 'error' : prev));
      setUpdateInfo(prev => (prev.message ? prev : { message: 'No response from the updater. Check your internet connection.' }));
    }, 20000);

    try {
      const res: any = await window.electronAPI.checkForUpdates();
      clearTimeout(timeout);
      if (res && res.ok === false) {
        setUpdateState('error');
        setUpdateInfo({ message: res.error || 'Update check failed.' });
      } else if (res && res.checked === false) {
        // Updater skipped the check — the normal case in an unpackaged/dev build.
        setUpdateState('error');
        setUpdateInfo({ message: 'Update checks only run in the installed app (dev build detected).' });
      }
      // Otherwise the 'available' / 'not-available' status events drive the UI.
    } catch (e: any) {
      clearTimeout(timeout);
      setUpdateState('error');
      setUpdateInfo({ message: e?.message || 'Update check failed.' });
    }
  };

  useEffect(() => {
    fetch('/api/auth/me').then(res => res.json()).then(setTenant);
    fetchSettings();
    fetchCurrencies();
    fetchPrinters();

    const handleSync = (e: any) => {
      if (e.detail.type === 'SETTINGS_UPDATED') {
        fetchSettings();
        fetchCurrencies();
        fetchPrinters();
      }
    };
    window.addEventListener('pos-sync', handleSync);
    return () => window.removeEventListener('pos-sync', handleSync);
  }, []);

  const fetchSettings = () => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        if (data.language) setLanguage(data.language as Language);
        if (data.store_name) setStoreName(data.store_name);
        if (data.tax_rate) setTaxRate(data.tax_rate);
        if (data.business_address) setBusinessAddress(data.business_address);
        if (data.business_email) setBusinessEmail(data.business_email);
        if (data.business_phone) setBusinessPhone(data.business_phone);
        if (data.business_website) setBusinessWebsite(data.business_website);
        if (data.business_logo) setBusinessLogo(data.business_logo);
        if (data.receipt_footer) setReceiptFooter(data.receipt_footer);
        setShowReceiptDialog(data.show_receipt_dialog !== '0');
      });
  };

  const fetchCurrencies = () => {
    fetch('/api/currencies')
      .then(res => res.json())
      .then(setCurrencies);
  };

  const fetchPrinters = () => {
    fetch('/api/printers')
      .then(res => res.json())
      .then(data => Array.isArray(data) ? setPrinters(data) : setPrinters([]));
  };

  const handlePrinterSave = async () => {
    if (!editingPrinter || !editingPrinter.name || !editingPrinter.type) return;
    const method = editingPrinter.id ? 'PUT' : 'POST';
    const url = editingPrinter.id ? `/api/printers/${editingPrinter.id}` : '/api/printers';
    await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingPrinter)
    });
    setEditingPrinter(null);
    fetchPrinters();
    setScanResults([]);
    setShowManualAddress(false);
  };

  const handlePrinterDelete = async (id: number) => {
    if (!confirm('Remove this printer?')) return;
    await fetch(`/api/printers/${id}`, { method: 'DELETE' });
    fetchPrinters();
  };

  const handlePrinterToggle = async (printer: Printer) => {
    await fetch(`/api/printers/${printer.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...printer, enabled: printer.enabled ? 0 : 1 })
    });
    fetchPrinters();
  };

  const [printerActionId, setPrinterActionId] = useState<number | null>(null);

  const handleTestPrint = async (printer: Printer) => {
    if (!printer.id) return;
    setPrinterActionId(printer.id);
    try {
      const res = await fetch('/api/print/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ printerId: printer.id })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        alert(`Test print failed: ${err.error}`);
      }
    } catch (err: any) {
      alert(`Test print failed: ${err.message}`);
    } finally {
      setPrinterActionId(null);
    }
  };

  const handleOpenDrawer = async (printer: Printer) => {
    if (!printer.id) return;
    setPrinterActionId(printer.id);
    try {
      const res = await fetch('/api/print/drawer-kick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ printerId: printer.id })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        alert(`Failed to open drawer: ${err.error}`);
      }
    } catch (err: any) {
      alert(`Failed to open drawer: ${err.message}`);
    } finally {
      setPrinterActionId(null);
    }
  };

  const handlePrinterScan = async () => {
    if (!editingPrinter?.connection || editingPrinter.connection === 'bluetooth') return;
    setIsScanning(true);
    setScanResults([]);
    try {
      const res = await fetch(`/api/printers/scan?type=${editingPrinter.connection}`);
      const data = await res.json();
      setScanResults(Array.isArray(data.printers) ? data.printers : []);
    } catch {
      setScanResults([]);
    } finally {
      setIsScanning(false);
    }
  };

  const PRINTER_TYPE_META: Record<string, { label: string; color: string; icon: string }> = {
    receipt: { label: 'Receipt', color: 'bg-blue-500', icon: '🧾' },
    kitchen: { label: 'Kitchen', color: 'bg-orange-500', icon: '👨‍🍳' },
    bar:     { label: 'Bar',     color: 'bg-purple-500', icon: '🍹' },
  };

  const saveSettings = (newSettings: any) => {
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSettings)
    }).then(fetchSettings);
  };

  const handleCurrencySave = async () => {
    if (!editingCurrency) return;
    const method = editingCurrency.id ? 'PUT' : 'POST';
    const url = editingCurrency.id ? `/api/currencies/${editingCurrency.id}` : '/api/currencies';
    
    await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingCurrency)
    });
    
    setEditingCurrency(null);
    fetchCurrencies();
  };

  const handleCurrencyDelete = async (id: number) => {
    if (!confirm('Are you sure?')) return;
    await fetch(`/api/currencies/${id}`, { method: 'DELETE' });
    fetchCurrencies();
  };

  return (
    <div className="space-y-8 pb-20">
      <header>
        <h1 className="text-4xl font-black tracking-tighter uppercase">{t.settings}</h1>
        <p className="opacity-50 font-medium">Configure your business and system preferences.</p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Business Profile */}
        <div className="p-8 bg-app-surface border border-app-border rounded-3xl space-y-6 shadow-sm">
          <div className="flex items-center gap-3 opacity-50">
            <SettingsIcon size={20} />
            <h3 className="font-black uppercase text-xs tracking-widest">{t.store_name}</h3>
          </div>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase opacity-50">{t.store_name}</label>
              <input 
                type="text" 
                className="w-full p-4 bg-app-bg border border-app-border rounded-2xl outline-none font-bold" 
                value={storeName}
                onChange={e => setStoreName(e.target.value)}
                onBlur={() => saveSettings({ store_name: storeName })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase opacity-50">{t.business_phone}</label>
                <input 
                  type="text" 
                  className="w-full p-4 bg-app-bg border border-app-border rounded-2xl outline-none" 
                  value={businessPhone}
                  onChange={e => setBusinessPhone(e.target.value)}
                  onBlur={() => saveSettings({ business_phone: businessPhone })}
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase opacity-50">{t.business_email}</label>
                <input 
                  type="email" 
                  className="w-full p-4 bg-app-bg border border-app-border rounded-2xl outline-none" 
                  value={businessEmail}
                  onChange={e => setBusinessEmail(e.target.value)}
                  onBlur={() => saveSettings({ business_email: businessEmail })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase opacity-50">{t.business_address}</label>
              <textarea 
                className="w-full p-4 bg-app-bg border border-app-border rounded-2xl outline-none resize-none h-24" 
                value={businessAddress}
                onChange={e => setBusinessAddress(e.target.value)}
                onBlur={() => saveSettings({ business_address: businessAddress })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase opacity-50">{t.business_website}</label>
                <input 
                  type="text" 
                  className="w-full p-4 bg-app-bg border border-app-border rounded-2xl outline-none" 
                  value={businessWebsite}
                  onChange={e => setBusinessWebsite(e.target.value)}
                  onBlur={() => saveSettings({ business_website: businessWebsite })}
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase opacity-50">{t.business_logo}</label>
                <input 
                  type="text" 
                  className="w-full p-4 bg-app-bg border border-app-border rounded-2xl outline-none" 
                  placeholder="https://..."
                  value={businessLogo}
                  onChange={e => setBusinessLogo(e.target.value)}
                  onBlur={() => saveSettings({ business_logo: businessLogo })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase opacity-50">{t.receipt_customization} (Footer)</label>
              <input 
                type="text" 
                className="w-full p-4 bg-app-bg border border-app-border rounded-2xl outline-none" 
                value={receiptFooter}
                onChange={e => setReceiptFooter(e.target.value)}
                onBlur={() => saveSettings({ receipt_footer: receiptFooter })}
              />
            </div>
            <div className="flex items-center justify-between p-4 bg-app-bg rounded-2xl border border-app-border/50">
              <div>
                <p className="text-[10px] font-black uppercase">Show Receipt Screen After Checkout</p>
                <p className="text-[10px] opacity-40">When off, checkout returns straight to a new sale instead of showing the print/confirmation screen.</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  const next = !showReceiptDialog;
                  setShowReceiptDialog(next);
                  saveSettings({ show_receipt_dialog: next ? '1' : '0' });
                }}
                className={`w-12 h-7 rounded-full transition-colors relative flex-shrink-0 ${showReceiptDialog ? 'bg-emerald-500' : 'bg-app-border'}`}
              >
                <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-transform ${showReceiptDialog ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase opacity-50">{t.tax_rate}</label>
              <input 
                type="number" 
                className="w-full p-4 bg-app-bg border border-app-border rounded-2xl outline-none font-mono font-bold" 
                value={taxRate}
                onChange={e => setTaxRate(e.target.value)}
                onBlur={() => saveSettings({ tax_rate: taxRate })}
              />
            </div>
          </div>
        </div>

        {/* Appearance & Language */}
        <div className="p-8 bg-app-surface border border-app-border rounded-3xl space-y-6 shadow-sm">
          <div className="flex items-center gap-3 opacity-50">
            <Globe size={20} />
            <h3 className="font-black uppercase text-xs tracking-widest">{t.language} & {t.appearance}</h3>
          </div>
          
          <div className="space-y-6">
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase opacity-50">{t.language}</label>
              <select 
                className="w-full p-4 bg-app-bg border border-app-border rounded-2xl outline-none font-bold appearance-none"
                value={language}
                onChange={e => {
                  const newLang = e.target.value as Language;
                  setLanguage(newLang);
                  saveSettings({ language: newLang });
                }}
              >
                <option value="en">English (US)</option>
                <option value="ar">العربية (Arabic)</option>
                <option value="fr">Français (French)</option>
              </select>
            </div>

            <div className="flex items-center justify-between p-4 bg-app-bg rounded-2xl border border-app-border/10">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-app-ink text-app-bg rounded-xl">
                  {isDarkMode ? <Moon size={20} /> : <Sun size={20} />}
                </div>
                <div>
                  <p className="text-sm font-black uppercase tracking-tight">{t.dark_mode}</p>
                  <p className="text-[10px] opacity-50 font-bold">Toggle system theme</p>
                </div>
              </div>
              <button 
                onClick={() => setIsDarkMode(!isDarkMode)}
                className={`w-14 h-7 rounded-full p-1 transition-all duration-500 ${isDarkMode ? 'bg-emerald-500' : 'bg-app-ink/20'}`}
              >
                <div className={`w-5 h-5 bg-white rounded-full shadow-lg transition-all duration-500 ${isDarkMode ? 'translate-x-7' : 'translate-x-0'}`} />
              </button>
            </div>
          </div>
        </div>

        {/* Currencies */}
        <div className="lg:col-span-2 p-8 bg-app-surface border border-app-border rounded-3xl space-y-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 opacity-50">
              <Coins size={20} />
              <h3 className="font-black uppercase text-xs tracking-widest">{t.currencies}</h3>
            </div>
            <button 
              onClick={() => setEditingCurrency({ code: '', symbol: '', rate: 1, is_default: 0 })}
              className="px-4 py-2 bg-app-ink text-app-bg rounded-xl text-[10px] font-black uppercase tracking-widest hover:opacity-90 transition-all flex items-center gap-2"
            >
              <Plus size={14} /> {t.add_currency}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {currencies.map(c => (
              <div key={c.id} className="p-6 bg-app-bg rounded-2xl border border-app-border/10 flex items-center justify-between group">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-app-surface border border-app-border rounded-xl flex items-center justify-center text-2xl font-black">
                    {c.symbol}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-black text-lg">{c.code}</p>
                      {c.is_default === 1 && <span className="px-2 py-0.5 bg-emerald-500 text-white text-[8px] font-black uppercase rounded-full">{t.default}</span>}
                    </div>
                    <p className="text-xs font-mono opacity-50">1 USD = {c.rate} {c.code}</p>
                  </div>
                </div>
                <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => setEditingCurrency(c)} className="p-2 hover:bg-app-surface rounded-lg transition-colors"><Edit2 size={16} /></button>
                  <button onClick={() => c.id && handleCurrencyDelete(c.id)} className="p-2 hover:bg-red-500 hover:text-white rounded-lg transition-colors"><Trash2 size={16} /></button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Printer Management */}
        <div className="lg:col-span-2 p-8 bg-app-surface border border-app-border rounded-3xl space-y-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 opacity-50">
              <Printer size={20} />
              <h3 className="font-black uppercase text-xs tracking-widest">Printers</h3>
            </div>
            <button
              onClick={() => setEditingPrinter({ name: '', type: 'receipt', connection: 'usb', address: '', paper_width: 80, is_default: 0, enabled: 1 })}
              className="px-4 py-2 bg-app-ink text-app-bg rounded-xl text-[10px] font-black uppercase tracking-widest hover:opacity-90 transition-all flex items-center gap-2"
            >
              <Plus size={14} /> Add Printer
            </button>
          </div>

          {printers.length === 0 ? (
            <div className="p-12 border-2 border-dashed border-app-border/20 rounded-2xl text-center space-y-3">
              <p className="text-4xl">🖨️</p>
              <p className="text-xs font-bold uppercase opacity-30">No printers configured</p>
              <p className="text-[10px] opacity-20">Add a receipt, kitchen, or bar printer to get started</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {printers.map(p => {
                const meta = PRINTER_TYPE_META[p.type] || { label: p.type, color: 'bg-gray-500', icon: '🖨️' };
                return (
                  <div key={p.id} className={`p-5 bg-app-bg rounded-2xl border border-app-border/10 space-y-4 group transition-all ${!p.enabled ? 'opacity-50' : ''}`}>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 ${meta.color} rounded-xl flex items-center justify-center text-xl shadow-md`}>
                          {meta.icon}
                        </div>
                        <div>
                          <p className="font-black text-sm leading-tight">{p.name}</p>
                          <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded-full text-white ${meta.color}`}>{meta.label}</span>
                        </div>
                      </div>
                      {/* Enable toggle */}
                      <button
                        onClick={() => handlePrinterToggle(p)}
                        className={`w-10 h-5 rounded-full p-0.5 transition-all duration-300 flex-shrink-0 ${p.enabled ? 'bg-emerald-500' : 'bg-app-ink/20'}`}
                      >
                        <div className={`w-4 h-4 bg-white rounded-full shadow transition-all duration-300 ${p.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                      </button>
                    </div>

                    <div className="space-y-1.5 text-[10px] font-mono opacity-60">
                      <div className="flex items-center gap-2">
                        <span className="uppercase font-black opacity-70">Conn:</span>
                        <span className="capitalize">{p.connection}</span>
                        {p.is_default === 1 && <span className="px-1.5 py-0.5 bg-emerald-500 text-white text-[8px] font-black uppercase rounded-full ml-auto">Default</span>}
                      </div>
                      {p.address && (
                        <div className="flex items-center gap-2 truncate">
                          <span className="uppercase font-black opacity-70">Addr:</span>
                          <span className="truncate">{p.address}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <span className="uppercase font-black opacity-70">Paper:</span>
                        <span>{p.paper_width}mm</span>
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => handleTestPrint(p)}
                        disabled={printerActionId === p.id}
                        className="flex-1 py-2 text-[10px] font-black uppercase bg-app-surface hover:bg-app-ink hover:text-app-bg rounded-lg transition-colors flex items-center justify-center gap-1 disabled:opacity-40"
                      >
                        <Printer size={12} /> {printerActionId === p.id ? 'Printing...' : 'Test Print'}
                      </button>
                      {p.type === 'receipt' && (
                        <button
                          onClick={() => handleOpenDrawer(p)}
                          disabled={printerActionId === p.id}
                          className="flex-1 py-2 text-[10px] font-black uppercase bg-app-surface hover:bg-app-ink hover:text-app-bg rounded-lg transition-colors flex items-center justify-center gap-1 disabled:opacity-40"
                        >
                          <Zap size={12} /> Open Drawer
                        </button>
                      )}
                    </div>

                    <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => setEditingPrinter({ ...p })}
                        className="flex-1 py-2 text-[10px] font-black uppercase bg-app-surface hover:bg-app-ink hover:text-app-bg rounded-lg transition-colors flex items-center justify-center gap-1"
                      >
                        <Edit2 size={12} /> Edit
                      </button>
                      <button
                        onClick={() => p.id && handlePrinterDelete(p.id)}
                        className="flex-1 py-2 text-[10px] font-black uppercase hover:bg-red-500 hover:text-white rounded-lg transition-colors flex items-center justify-center gap-1"
                      >
                        <Trash2 size={12} /> Remove
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* License Status */}
        {tenant && (
          <div className="lg:col-span-2 p-8 bg-app-surface border border-app-border rounded-3xl space-y-6 shadow-sm">
            <div className="flex items-center gap-3 opacity-50">
              <Shield size={20} />
              <h3 className="font-black uppercase text-xs tracking-widest">License & Subscription</h3>
            </div>
            
            <div className="grid md:grid-cols-2 gap-6">
              <div className="p-6 bg-app-bg rounded-2xl border border-app-border/10 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Monitor size={18} className="opacity-40" />
                    <span className="text-[10px] font-black uppercase opacity-40">Local Software</span>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[8px] font-black uppercase ${
                    tenant.local_license_type === 'lifetime' || (tenant.local_license_expiry && new Date(tenant.local_license_expiry) > new Date())
                      ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white'
                  }`}>
                    {tenant.local_license_type === 'lifetime' || (tenant.local_license_expiry && new Date(tenant.local_license_expiry) > new Date()) ? 'Active' : 'Expired'}
                  </span>
                </div>
                <div>
                  <p className="text-lg font-black uppercase">{tenant.local_license_type}</p>
                  {tenant.local_license_type === 'year' && (
                    <p className="text-[10px] opacity-50 font-bold">Expires: {tenant.local_license_expiry ? new Date(tenant.local_license_expiry).toLocaleDateString() : 'N/A'}</p>
                  )}
                </div>
              </div>

              <div className="p-6 bg-app-bg rounded-2xl border border-app-border/10 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Globe size={18} className="opacity-40" />
                    <span className="text-[10px] font-black uppercase opacity-40">Online Monitor</span>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[8px] font-black uppercase ${
                    tenant.online_license_type === 'lifetime' || (tenant.online_license_expiry && new Date(tenant.online_license_expiry) > new Date())
                      ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white'
                  }`}>
                    {tenant.online_license_type === 'lifetime' || (tenant.online_license_expiry && new Date(tenant.online_license_expiry) > new Date()) ? 'Active' : 'Expired'}
                  </span>
                </div>
                <div>
                  <p className="text-lg font-black uppercase">{tenant.online_license_type}</p>
                  {tenant.online_license_type === 'monthly' && (
                    <p className="text-[10px] opacity-50 font-bold">Expires: {tenant.online_license_expiry ? new Date(tenant.online_license_expiry).toLocaleDateString() : 'N/A'}</p>
                  )}
                </div>
              </div>
            </div>
            
            <div className="p-4 bg-app-bg rounded-2xl border border-app-border/10 space-y-3">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <RefreshCw size={18} className="opacity-40" />
                  <span className="text-[10px] font-black uppercase opacity-40">Software Version</span>
                </div>
                <div className="text-right">
                  <p className="text-sm font-black uppercase">v{tenant.current_version}</p>
                  {tenant.available_version && tenant.available_version !== tenant.current_version && (
                    <button
                      onClick={onShowUpdate}
                      className="text-[8px] font-black uppercase text-emerald-500 hover:underline"
                    >
                      Update Available: v{tenant.available_version}
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 pt-3 border-t border-app-border/10">
                <span className="text-[10px] font-bold uppercase tracking-widest opacity-50">
                  {updateState === 'checking' && 'Checking for updates…'}
                  {updateState === 'downloading' && `Downloading v${updateInfo.version || ''}… ${updateInfo.percent != null ? Math.round(updateInfo.percent) + '%' : ''}`}
                  {updateState === 'downloaded' && `v${updateInfo.version || ''} ready to install`}
                  {updateState === 'latest' && "You're on the latest version"}
                  {updateState === 'error' && <span className="text-rose-500 normal-case">{updateInfo.message || 'Update check failed'}</span>}
                  {updateState === 'idle' && 'Check for the newest version'}
                </span>

                {updateState === 'downloaded' ? (
                  <button
                    onClick={() => window.electronAPI?.installUpdate?.()}
                    className="px-4 py-2 rounded-xl bg-emerald-500 text-white text-[10px] font-black uppercase tracking-widest hover:bg-emerald-600 transition-all whitespace-nowrap"
                  >
                    Restart & Install
                  </button>
                ) : (
                  <button
                    onClick={handleCheckForUpdates}
                    disabled={updateState === 'checking' || updateState === 'downloading'}
                    className="px-4 py-2 rounded-xl bg-app-ink text-app-bg text-[10px] font-black uppercase tracking-widest hover:opacity-90 transition-all disabled:opacity-40 flex items-center gap-2 whitespace-nowrap"
                  >
                    <RefreshCw size={12} className={updateState === 'checking' || updateState === 'downloading' ? 'animate-spin' : ''} />
                    Check for Updates
                  </button>
                )}
              </div>
            </div>

            <p className="text-[10px] opacity-30 italic text-center">Contact support to renew or upgrade your licenses.</p>
          </div>
        )}
      </div>

      {/* Currency Modal */}
      <AnimatePresence>
        {editingCurrency && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setEditingCurrency(null)} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <motion.div initial={{ scale: 0.9, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.9, opacity: 0, y: 20 }} className="relative bg-app-surface w-full max-w-md rounded-3xl overflow-hidden shadow-2xl border border-app-border p-8 space-y-6">
              <h2 className="text-2xl font-black uppercase tracking-tighter">{editingCurrency.id ? 'Edit Currency' : 'New Currency'}</h2>
              
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase opacity-50">{t.code}</label>
                    <input 
                      type="text" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-bold"
                      value={editingCurrency.code} onChange={e => setEditingCurrency({...editingCurrency, code: e.target.value.toUpperCase()})}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase opacity-50">{t.symbol}</label>
                    <input 
                      type="text" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-bold"
                      value={editingCurrency.symbol} onChange={e => setEditingCurrency({...editingCurrency, symbol: e.target.value})}
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">{t.rate} (vs USD)</label>
                  <input 
                    type="number" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-mono font-bold"
                    value={editingCurrency.rate} onChange={e => setEditingCurrency({...editingCurrency, rate: parseFloat(e.target.value) || 0})}
                  />
                </div>
                <div className="flex items-center gap-3 p-3 bg-app-bg rounded-xl border border-app-border/10">
                  <input 
                    type="checkbox" id="is_default" className="w-5 h-5 rounded border-app-border"
                    checked={editingCurrency.is_default === 1} onChange={e => setEditingCurrency({...editingCurrency, is_default: e.target.checked ? 1 : 0})}
                  />
                  <label htmlFor="is_default" className="text-xs font-black uppercase tracking-tight cursor-pointer">{t.default} Currency</label>
                </div>
              </div>

              <div className="flex gap-4 pt-4">
                <button onClick={handleCurrencySave} className="flex-1 py-4 bg-app-ink text-app-bg rounded-2xl font-black uppercase text-xs flex items-center justify-center gap-2">
                  <Save size={18} /> {t.save}
                </button>
                <button onClick={() => setEditingCurrency(null)} className="px-6 py-4 border-2 border-app-border rounded-2xl font-black uppercase text-xs">
                  {t.cancel}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Printer Modal */}
      <AnimatePresence>
        {editingPrinter && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setEditingPrinter(null)} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <motion.div initial={{ scale: 0.9, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.9, opacity: 0, y: 20 }} className="relative bg-app-surface w-full max-w-lg rounded-3xl overflow-hidden shadow-2xl border border-app-border p-8 space-y-6">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-app-ink text-app-bg rounded-xl">
                  <Printer size={20} />
                </div>
                <h2 className="text-2xl font-black uppercase tracking-tighter">{editingPrinter.id ? 'Edit Printer' : 'New Printer'}</h2>
              </div>

              <div className="space-y-4">
                {/* Name */}
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Printer Name</label>
                  <input
                    type="text"
                    placeholder="e.g. Main Receipt, Kitchen Station 1"
                    className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-bold"
                    value={editingPrinter.name || ''}
                    onChange={e => setEditingPrinter({ ...editingPrinter, name: e.target.value })}
                  />
                </div>

                {/* Type + Connection row */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase opacity-50">Printer Type</label>
                    <select
                      className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-bold appearance-none"
                      value={editingPrinter.type || 'receipt'}
                      onChange={e => setEditingPrinter({ ...editingPrinter, type: e.target.value as any })}
                    >
                      <option value="receipt">🧾 Receipt</option>
                      <option value="kitchen">👨‍🍳 Kitchen</option>
                      <option value="bar">🍹 Bar</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase opacity-50">Connection</label>
                    <select
                      className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-bold appearance-none"
                      value={editingPrinter.connection || 'usb'}
                      onChange={e => { setEditingPrinter({ ...editingPrinter, connection: e.target.value as any, address: '' }); setScanResults([]); setShowManualAddress(false); }}
                    >
                      <option value="usb">🔌 USB</option>
                      <option value="network">🌐 Network (IP)</option>
                      <option value="bluetooth">📡 Bluetooth</option>
                    </select>
                  </div>
                </div>

                {/* Address / Scan */}
                {editingPrinter.connection === 'bluetooth' ? (
                  // Bluetooth: manual MAC entry only
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase opacity-50">BT Device Address (MAC)</label>
                    <input
                      type="text"
                      placeholder="AA:BB:CC:DD:EE:FF"
                      className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-mono"
                      value={editingPrinter.address || ''}
                      onChange={e => setEditingPrinter({ ...editingPrinter, address: e.target.value })}
                    />
                    <p className="text-[10px] opacity-40">Pair the printer in your system Bluetooth settings first, then enter its MAC address.</p>
                  </div>
                ) : (
                  // USB / Network: scan-first UX
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-black uppercase opacity-50">
                        {editingPrinter.connection === 'network' ? 'Select Network Printer' : 'Select USB Printer'}
                      </label>
                      {(editingPrinter.address) && (
                        <span className="text-[10px] font-mono opacity-40 truncate max-w-[180px]">{editingPrinter.address}</span>
                      )}
                    </div>

                    {/* Scan button */}
                    <button
                      onClick={handlePrinterScan}
                      disabled={isScanning}
                      className="w-full flex items-center justify-center gap-3 p-4 bg-app-ink text-app-bg rounded-2xl font-black uppercase text-xs tracking-widest hover:opacity-90 active:scale-95 transition-all disabled:opacity-50"
                    >
                      {isScanning ? (
                        <><RefreshCw size={16} className="animate-spin" /> Scanning{editingPrinter.connection === 'network' ? ' Network...' : ' for Printers...'}</>
                      ) : (
                        <><ScanLine size={16} /> {scanResults.length > 0 ? 'Scan Again' : `Scan for ${editingPrinter.connection === 'network' ? 'Network' : 'USB'} Printers`}</>
                      )}
                    </button>

                    {/* Scan results */}
                    {!isScanning && scanResults.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-[10px] font-black uppercase opacity-40">{scanResults.length} device{scanResults.length !== 1 ? 's' : ''} found — tap to select</p>
                        <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1">
                          {scanResults.map((r, i) => {
                            // For USB, raw printing needs the printer's exact Windows queue
                            // name (not its port), so that's what gets stored as the address.
                            const resultAddress = editingPrinter.connection === 'usb' ? r.name : r.address;
                            const isSelected = editingPrinter.address === resultAddress;
                            return (
                              <button
                                key={i}
                                onClick={() => setEditingPrinter({ ...editingPrinter, address: resultAddress, name: editingPrinter.name || r.name })}
                                className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 text-left transition-all ${
                                  isSelected
                                    ? 'border-emerald-500 bg-emerald-500/10'
                                    : 'border-app-border/20 bg-app-bg hover:border-app-ink/40'
                                }`}
                              >
                                <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                                  editingPrinter.connection === 'network' ? 'bg-blue-500/10 text-blue-500' : 'bg-orange-500/10 text-orange-500'
                                }`}>
                                  {editingPrinter.connection === 'network' ? <Wifi size={14} /> : <Printer size={14} />}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="font-black text-xs truncate">{r.name}</p>
                                  <p className="font-mono text-[10px] opacity-50 truncate">{r.address}</p>
                                </div>
                                {isSelected && (
                                  <CheckCircle2 size={16} className="text-emerald-500 flex-shrink-0" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {!isScanning && scanResults.length === 0 && editingPrinter.address === '' && (
                      <p className="text-[10px] opacity-30 text-center">No devices scanned yet. Click the button above to discover printers.</p>
                    )}

                    {/* Manual entry toggle */}
                    <button
                      onClick={() => setShowManualAddress(v => !v)}
                      className="text-[10px] font-black uppercase opacity-30 hover:opacity-60 transition-opacity w-full text-center"
                    >
                      {showManualAddress ? '▲ Hide manual entry' : '▼ Enter address manually'}
                    </button>
                    {showManualAddress && (
                      <div className="space-y-1">
                        <input
                          type="text"
                          placeholder={editingPrinter.connection === 'network' ? '192.168.1.100' : 'EPSON TM-T88V Receipt'}
                          className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-mono text-sm"
                          value={editingPrinter.address || ''}
                          onChange={e => setEditingPrinter({ ...editingPrinter, address: e.target.value })}
                        />
                        {editingPrinter.connection === 'usb' && (
                          <p className="text-[10px] opacity-40">Enter the printer's exact name as shown in Windows Settings &gt; Printers &amp; Scanners, not its port.</p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Paper width */}
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Paper Width</label>
                  <div className="grid grid-cols-2 gap-3">
                    {[58, 80].map(w => (
                      <button
                        key={w}
                        onClick={() => setEditingPrinter({ ...editingPrinter, paper_width: w })}
                        className={`p-3 rounded-xl border-2 font-black text-sm transition-all ${
                          editingPrinter.paper_width === w
                            ? 'border-app-ink bg-app-ink text-app-bg'
                            : 'border-app-border bg-app-bg hover:border-app-ink/40'
                        }`}
                      >
                        {w}mm
                      </button>
                    ))}
                  </div>
                </div>

                {/* Flags */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center gap-3 p-3 bg-app-bg rounded-xl border border-app-border/10">
                    <input
                      type="checkbox" id="printer_default" className="w-5 h-5"
                      checked={editingPrinter.is_default === 1}
                      onChange={e => setEditingPrinter({ ...editingPrinter, is_default: e.target.checked ? 1 : 0 })}
                    />
                    <label htmlFor="printer_default" className="text-xs font-black uppercase tracking-tight cursor-pointer">Default for type</label>
                  </div>
                  <div className="flex items-center gap-3 p-3 bg-app-bg rounded-xl border border-app-border/10">
                    <input
                      type="checkbox" id="printer_enabled" className="w-5 h-5"
                      checked={editingPrinter.enabled !== 0}
                      onChange={e => setEditingPrinter({ ...editingPrinter, enabled: e.target.checked ? 1 : 0 })}
                    />
                    <label htmlFor="printer_enabled" className="text-xs font-black uppercase tracking-tight cursor-pointer">Enabled</label>
                  </div>
                </div>
              </div>

              <div className="flex gap-4 pt-2">
                <button onClick={handlePrinterSave} className="flex-1 py-4 bg-app-ink text-app-bg rounded-2xl font-black uppercase text-xs flex items-center justify-center gap-2">
                  <Save size={18} /> Save Printer
                </button>
                <button onClick={() => setEditingPrinter(null)} className="px-6 py-4 border-2 border-app-border rounded-2xl font-black uppercase text-xs">
                  {t.cancel}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}