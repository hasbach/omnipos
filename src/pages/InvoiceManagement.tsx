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

export default function InvoiceManagement() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [stakeholders, setStakeholders] = useState<Stakeholder[]>([]);
  
  // Form state
  const [selectedStakeholder, setSelectedStakeholder] = useState<number>(1);
  const [invoiceType, setInvoiceType] = useState<'sale' | 'purchase'>('sale');
  const [invoiceItems, setInvoiceItems] = useState<{
    product_id: number, 
    quantity: number, 
    price: number,
    price_lbp: number,
    discount: { type: 'percentage' | 'fixed', value: number },
    tax: { type: 'percentage' | 'fixed', value: number }
  }[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'credit'>('cash');
  const [paidAmount, setPaidAmount] = useState<number>(0);
  const [invoiceCurrency, setInvoiceCurrency] = useState(CURRENCIES[0]);
  const [paymentCurrency, setPaymentCurrency] = useState(CURRENCIES[0]);
  const [globalDiscount, setGlobalDiscount] = useState<{ type: 'percentage' | 'fixed', value: number }>({ type: 'percentage', value: 0 });
  const [globalTax, setGlobalTax] = useState<{ type: 'percentage' | 'fixed', value: number }>({ type: 'percentage', value: 0 });
  const [itemSearch, setItemSearch] = useState('');
  
  // Filter state
  const [filterType, setFilterType] = useState('all');
  const [filterStakeholder, setFilterStakeholder] = useState('all');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');

  useEffect(() => { 
    fetchInvoices();
    fetch('/api/products').then(res => res.json()).then(setProducts);
    fetch('/api/stakeholders').then(res => res.json()).then(setStakeholders);
  }, []);

  useEffect(() => { fetchInvoices(); }, [filterType, filterStakeholder, filterDateFrom, filterDateTo]);

  const fetchInvoices = () => {
    const params = new URLSearchParams();
    if (filterType !== 'all') params.set('type', filterType);
    if (filterStakeholder !== 'all') params.set('stakeholder_id', filterStakeholder);
    if (filterDateFrom) params.set('date_from', filterDateFrom);
    if (filterDateTo) params.set('date_to', filterDateTo);
    fetch(`/api/transactions/recent?${params}`).then(res => res.json()).then(setInvoices);
  };

  const handleDeleteInvoice = async (id: number) => {
    if (!confirm(`Are you sure you want to delete transaction #${id}? This will restore stock levels.`)) return;
    try {
      const res = await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
      if (res.ok) fetchInvoices();
      else alert('Failed to delete transaction');
    } catch (err) { console.error(err); }
  };

  const handleEditInvoice = async (id: number) => {
    try {
      const res = await fetch(`/api/transactions/${id}`);
      if (!res.ok) return;
      const tx = await res.json();
      setEditingId(id);
      setInvoiceType(tx.type || 'sale');
      setSelectedStakeholder(tx.stakeholder_id || 1);
      setInvoiceCurrency(CURRENCIES.find(c => c.code === tx.currency) || CURRENCIES[0]);
      setGlobalDiscount(tx.discount || { type: 'percentage', value: 0 });
      setGlobalTax({ type: tx.tax_type || 'percentage', value: tx.tax_value || 0 });
      setInvoiceItems(tx.items.map((item: any) => ({
        product_id: item.product_id,
        quantity: item.quantity,
        price: item.unit_price,
        price_lbp: Math.round(item.unit_price * 89500),
        discount: { type: item.discount_type || 'percentage', value: item.discount_value || 0 },
        tax: { type: item.tax_type || 'percentage', value: item.tax_value || 0 },
      })));
      // Load paid amount from existing payments
      const totalPaidUSD = tx.paid_amount || 0;
      setPaidAmount(totalPaidUSD);
      // Set payment currency/method from first payment if exists
      if (tx.payments && tx.payments.length > 0) {
        const firstPay = tx.payments[0];
        setPaymentMethod(firstPay.method || 'cash');
        setPaymentCurrency(CURRENCIES.find(c => c.code === firstPay.currency) || CURRENCIES[0]);
      }
      setIsAdding(true);
    } catch (err) { console.error(err); }
  };

  const calculateItemTotal = (item: any) => {
    const product = products.find(p => p.id === item.product_id);
    let baseTotal = item.price * item.quantity;
    
    // Bulk pricing logic
    if (invoiceType === 'sale' && product && product.package_price && product.units_per_package && product.units_per_package > 1) {
      const numPackages = Math.floor(item.quantity / product.units_per_package);
      const remainder = item.quantity % product.units_per_package;
      baseTotal = (numPackages * product.package_price) + (remainder * product.price);
    }

    let total = baseTotal;
    
    // Apply item discount
    if (item.discount.type === 'percentage') {
      total *= (1 - item.discount.value / 100);
    } else {
      total = Math.max(0, total - item.discount.value);
    }
    
    // Apply item tax
    if (item.tax.type === 'percentage') {
      total *= (1 + item.tax.value / 100);
    } else {
      total += item.tax.value;
    }
    
    return total;
  };

  const subtotal = invoiceItems.reduce((sum, item) => sum + calculateItemTotal(item), 0);
  
  const calculateFinalTotal = () => {
    let total = subtotal;
    
    // Apply global discount
    if (globalDiscount.type === 'percentage') {
      total *= (1 - globalDiscount.value / 100);
    } else {
      total = Math.max(0, total - globalDiscount.value);
    }
    
    // Apply global tax
    if (globalTax.type === 'percentage') {
      total *= (1 + globalTax.value / 100);
    } else {
      total += globalTax.value;
    }
    
    return total;
  };

  const finalTotal = calculateFinalTotal();

  const handleAddInvoice = async () => {
    if (invoiceItems.length === 0) return alert('Add at least one item');

    // If editing, delete the old transaction first
    if (editingId) {
      const delRes = await fetch(`/api/transactions/${editingId}`, { method: 'DELETE' });
      if (!delRes.ok) return alert('Failed to update — could not remove old transaction');
    }
    
    // Build the payments so the chosen method is always recorded:
    // - credit: log a 'credit' payment for the full total (like the POS) so it's tagged as a
    //   credit sale and the whole amount lands on the customer's balance — regardless of Paid.
    // - cash/card: log the paid amount (if any); any unpaid remainder still goes to the balance.
    let payments: any[] = [];
    if (paymentMethod === 'credit') {
      payments = [{
        amount: finalTotal,
        method: 'credit',
        currency: invoiceCurrency.code,
        exchange_rate: invoiceCurrency.rate
      }];
    } else if (paidAmount > 0) {
      payments = [{
        amount: paidAmount,
        method: paymentMethod,
        currency: paymentCurrency.code,
        exchange_rate: paymentCurrency.rate
      }];
    }

    const transaction = {
      stakeholder_id: selectedStakeholder,
      type: invoiceType,
      items: invoiceItems.map(i => ({
        id: i.product_id,
        quantity: i.quantity,
        price: i.price,
        discount: i.discount,
        tax: i.tax
      })),
      total_amount: finalTotal,
      currency: invoiceCurrency.code,
      exchange_rate: invoiceCurrency.rate,
      discount: globalDiscount,
      tax: globalTax,
      payments
    };

    const res = await fetch('/api/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(transaction)
    });

    if (res.ok) {
      setIsAdding(false);
      setEditingId(null);
      setInvoiceItems([]);
      setPaidAmount(0);
      fetchInvoices();
    }
  };

  const addItem = () => {
    if (products.length > 0) {
      const p = products[0];
      const initialPrice = invoiceType === 'purchase' ? (p.cost || 0) : p.price;
      setInvoiceItems([...invoiceItems, { 
        product_id: p.id, 
        quantity: 1, 
        price: initialPrice,
        price_lbp: Math.round(initialPrice * 89500),
        discount: { type: 'percentage', value: 0 },
        tax: { type: 'percentage', value: 0 }
      }]);
    }
  };

  const updateItem = (index: number, field: string, value: any) => {
    const newItems = [...invoiceItems];
    if (field === 'product_id') {
      const p = products.find(prod => prod.id === parseInt(value));
      if (p) {
        const initialPrice = invoiceType === 'purchase' ? (p.cost || 0) : p.price;
        newItems[index] = { 
          ...newItems[index], 
          product_id: p.id, 
          price: initialPrice,
          price_lbp: Math.round(initialPrice * 89500)
        };
      }
    } else if (field === 'price') {
      const usd = parseFloat(value) || 0;
      newItems[index] = { ...newItems[index], price: usd, price_lbp: Math.round(usd * 89500) };
    } else if (field === 'price_lbp') {
      const lbp = parseFloat(value) || 0;
      newItems[index] = { ...newItems[index], price_lbp: lbp, price: parseFloat((lbp / 89500).toFixed(2)) };
    } else if (field === 'line_total') {
      const total = parseFloat(value) || 0;
      const qty = newItems[index].quantity || 1;
      const usd = total / qty;
      newItems[index] = { ...newItems[index], price: usd, price_lbp: Math.round(usd * 89500) };
    } else if (field === 'quantity') {
      const qty = parseInt(value) || 0;
      newItems[index] = { ...newItems[index], quantity: qty };
    } else {
      newItems[index] = { ...newItems[index], [field]: value };
    }
    setInvoiceItems(newItems);
  };

  const removeItem = (index: number) => {
    setInvoiceItems(invoiceItems.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-6">
      <header className="flex justify-between items-end">
        <div>
          <h1 className="text-4xl font-black tracking-tighter uppercase">Invoices</h1>
          <p className="opacity-50 font-medium">Recent sales and transaction records.</p>
        </div>
        <button 
          onClick={() => setIsAdding(true)}
          className="px-6 py-3 bg-app-ink text-app-bg rounded-xl font-black uppercase text-xs flex items-center gap-2 hover:opacity-90 transition-all"
        >
          <Plus size={18} /> Create Invoice
        </button>
      </header>

      {/* Filters */}
      <div className="flex gap-3 items-end flex-wrap">
        <div className="space-y-1">
          <label className="text-[8px] font-black uppercase opacity-30 ml-1">Type</label>
          <select value={filterType} onChange={e => setFilterType(e.target.value)}
            className="p-2.5 bg-app-surface border border-app-border rounded-xl text-xs font-bold outline-none">
            <option value="all">All Types</option>
            <option value="sale">Sales</option>
            <option value="purchase">Purchases</option>
            <option value="refund">Refunds</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-[8px] font-black uppercase opacity-30 ml-1">Stakeholder</label>
          <select value={filterStakeholder} onChange={e => setFilterStakeholder(e.target.value)}
            className="p-2.5 bg-app-surface border border-app-border rounded-xl text-xs font-bold outline-none">
            <option value="all">All Stakeholders</option>
            {stakeholders.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-[8px] font-black uppercase opacity-30 ml-1">From</label>
          <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)}
            className="p-2.5 bg-app-surface border border-app-border rounded-xl text-xs font-bold outline-none" />
        </div>
        <div className="space-y-1">
          <label className="text-[8px] font-black uppercase opacity-30 ml-1">To</label>
          <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)}
            className="p-2.5 bg-app-surface border border-app-border rounded-xl text-xs font-bold outline-none" />
        </div>
        {(filterType !== 'all' || filterStakeholder !== 'all' || filterDateFrom || filterDateTo) && (
          <button onClick={() => { setFilterType('all'); setFilterStakeholder('all'); setFilterDateFrom(''); setFilterDateTo(''); }}
            className="p-2.5 text-[10px] font-black uppercase hover:text-red-500 transition-colors flex items-center gap-1">
            <X size={12} /> Clear
          </button>
        )}
      </div>

      <div className="bg-app-surface border border-app-border rounded-2xl overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-app-bg/50 text-[10px] uppercase tracking-widest font-black opacity-50">
              <th className="p-4 border-b border-app-border">ID</th>
              <th className="p-4 border-b border-app-border">Type</th>
              <th className="p-4 border-b border-app-border">Stakeholder</th>
              <th className="p-4 border-b border-app-border">Date</th>
              <th className="p-4 border-b border-app-border text-right">Total</th>
              <th className="p-4 border-b border-app-border text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {invoices.map(i => (
              <tr key={i.id} className="hover:bg-app-bg/30 transition-colors group">
                <td className="p-4 border-b border-app-border font-mono">#{i.id}</td>
                <td className="p-4 border-b border-app-border">
                  <span className={`px-2 py-1 rounded text-[8px] font-black uppercase tracking-widest ${
                    i.type === 'refund' ? 'bg-red-500 text-white' :
                    i.type === 'purchase' ? 'bg-blue-500 text-white' : 'bg-emerald-500 text-white'
                  }`}>{i.type}</span>
                </td>
                <td className="p-4 border-b border-app-border font-bold">{i.stakeholder_name}</td>
                <td className="p-4 border-b border-app-border opacity-50">{new Date(i.created_at).toLocaleString()}</td>
                <td className="p-4 border-b border-app-border text-right font-mono font-bold">${i.total_amount.toFixed(2)}</td>
                <td className="p-4 border-b border-app-border text-right">
                  <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => handleEditInvoice(i.id)} className="p-2 hover:bg-app-ink hover:text-app-bg rounded-lg transition-all" title="Edit"><Edit2 size={14} /></button>
                    <button onClick={() => handleDeleteInvoice(i.id)} className="p-2 hover:bg-red-500 hover:text-white rounded-lg transition-all" title="Delete"><Trash2 size={14} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AnimatePresence>
        {isAdding && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => { setIsAdding(false); setEditingId(null); }} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <motion.div initial={{ scale: 0.9, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.9, opacity: 0, y: 20 }} className="relative bg-app-surface w-full max-w-5xl rounded-2xl shadow-2xl border border-app-border p-8 space-y-6 max-h-[90vh] overflow-y-auto">
              <h2 className="text-2xl font-black uppercase tracking-tighter">{editingId ? `Edit Invoice #${editingId}` : 'Manual Invoice Entry'}</h2>
              
              <div className="grid grid-cols-4 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Invoice Type</label>
                  <select 
                    className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none font-bold"
                    value={invoiceType}
                    onChange={e => setInvoiceType(e.target.value as any)}
                  >
                    <option value="sale">Sale Invoice</option>
                    <option value="purchase">Purchase Invoice</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Stakeholder</label>
                  <select 
                    className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none"
                    value={selectedStakeholder}
                    onChange={e => setSelectedStakeholder(parseInt(e.target.value))}
                  >
                    {stakeholders.map(s => <option key={s.id} value={s.id}>{s.name} ({s.type})</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Invoice Currency</label>
                  <select 
                    className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none"
                    value={invoiceCurrency.code}
                    onChange={e => setInvoiceCurrency(CURRENCIES.find(c => c.code === e.target.value) || CURRENCIES[0])}
                  >
                    {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code} ({c.symbol})</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Payment Method</label>
                  <select 
                    className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none"
                    value={paymentMethod}
                    onChange={e => setPaymentMethod(e.target.value as any)}
                  >
                    <option value="cash">Cash</option>
                    <option value="card">Card</option>
                    <option value="credit">Credit / On Account</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Global Discount (%)</label>
                  <input 
                    type="number" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none"
                    value={globalDiscount.value} onChange={e => setGlobalDiscount({ ...globalDiscount, value: parseFloat(e.target.value) || 0 })}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Global Tax (%)</label>
                  <input 
                    type="number" className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none"
                    value={globalTax.value} onChange={e => setGlobalTax({ ...globalTax, value: parseFloat(e.target.value) || 0 })}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Payment Currency</label>
                  <select 
                    className="w-full p-3 bg-app-bg border border-app-border rounded-xl outline-none"
                    value={paymentCurrency.code}
                    onChange={e => setPaymentCurrency(CURRENCIES.find(c => c.code === e.target.value) || CURRENCIES[0])}
                  >
                    {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code} ({c.symbol})</option>)}
                  </select>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-xs font-black uppercase tracking-widest opacity-50">Invoice Items</h3>
                </div>
                
                {/* Search to add item */}
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 opacity-30" size={16} />
                  <input
                    id="item-search-input"
                    type="text"
                    placeholder="Search product by name or barcode..."
                    className="w-full pl-10 pr-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all text-sm"
                    value={itemSearch}
                    onChange={e => setItemSearch(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Escape') setItemSearch('');
                    }}
                  />
                  {itemSearch.length > 0 && (
                    <div className="absolute left-0 right-0 top-full mt-1 bg-app-surface border border-app-border rounded-xl shadow-2xl z-50 max-h-48 overflow-y-auto">
                      {products.filter(p => {
                        const q = itemSearch.toLowerCase();
                        return p.name.toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q);
                      }).slice(0, 8).map(p => (
                        <button key={p.id} className="w-full flex justify-between items-center p-3 hover:bg-app-ink hover:text-app-bg transition-colors text-left text-sm border-b border-app-border/10 last:border-none"
                          onClick={() => {
                            const initialPrice = invoiceType === 'purchase' ? (p.cost || 0) : p.price;
                            setInvoiceItems(prev => [...prev, {
                              product_id: p.id, quantity: 1, price: initialPrice,
                              price_lbp: Math.round(initialPrice * 89500),
                              discount: { type: 'percentage' as const, value: 0 },
                              tax: { type: 'percentage' as const, value: 0 },
                            }]);
                            setItemSearch('');
                            // Focus the qty field of the newly added item after render
                            setTimeout(() => {
                              const qtyInputs = document.querySelectorAll('[data-field="qty"]');
                              const last = qtyInputs[qtyInputs.length - 1] as HTMLInputElement;
                              last?.focus();
                              last?.select();
                            }, 50);
                          }}>
                          <div>
                            <span className="font-bold">{p.name}</span>
                            {p.barcode && <span className="ml-2 text-xs opacity-50 font-mono">{p.barcode}</span>}
                          </div>
                          <span className="font-mono text-xs opacity-70">${(invoiceType === 'purchase' ? (p.cost || 0) : p.price).toFixed(2)}</span>
                        </button>
                      ))}
                      {products.filter(p => {
                        const q = itemSearch.toLowerCase();
                        return p.name.toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q);
                      }).length === 0 && (
                        <p className="p-4 text-center text-xs opacity-30">No products found</p>
                      )}
                    </div>
                  )}
                </div>
                
                <div className="max-h-64 overflow-y-auto space-y-2 pr-2">
                  {invoiceItems.map((item, idx) => {
                    const isUSD = invoiceCurrency.code === 'USD';
                    const isLBP = invoiceCurrency.code === 'LBP';
                    const pName = products.find(p => p.id === item.product_id)?.name || 'Product';
                    return (
                    <div key={idx} className="flex gap-2 items-end bg-app-bg/20 p-3 rounded-xl border border-app-border/50">
                      <div className="flex-1 min-w-0">
                        <p className="text-[8px] font-black uppercase opacity-30">Product</p>
                        <p className="text-xs font-bold truncate">{pName}</p>
                      </div>
                      <div className="w-16 space-y-1">
                        <label className="text-[8px] font-black uppercase opacity-30">Qty</label>
                        <input data-field="qty" tabIndex={0}
                          type="number" className="w-full p-2 bg-app-bg border border-app-border rounded-lg text-xs outline-none focus:border-app-ink"
                          value={item.quantity} onChange={e => updateItem(idx, 'quantity', parseInt(e.target.value) || 0)}
                        />
                      </div>
                      <div className="w-24 space-y-1">
                        <label className="text-[8px] font-black uppercase opacity-30">Price (USD)</label>
                        <input data-field="price-usd" tabIndex={0}
                          type="number" className={`w-full p-2 bg-app-bg border border-app-border rounded-lg text-xs outline-none font-mono focus:border-app-ink ${isLBP ? 'opacity-30 cursor-not-allowed' : ''}`}
                          disabled={isLBP}
                          value={item.price} onChange={e => updateItem(idx, 'price', e.target.value)}
                        />
                      </div>
                      <div className="w-28 space-y-1">
                        <label className="text-[8px] font-black uppercase opacity-30">Price (LBP)</label>
                        <input data-field="price-lbp" tabIndex={0}
                          type="number" className={`w-full p-2 bg-app-bg border border-app-border rounded-lg text-xs outline-none font-mono focus:border-app-ink ${isUSD ? 'opacity-30 cursor-not-allowed' : ''}`}
                          disabled={isUSD}
                          value={item.price_lbp} onChange={e => updateItem(idx, 'price_lbp', e.target.value)}
                        />
                      </div>
                      <div className="w-24 space-y-1">
                        <label className="text-[8px] font-black uppercase opacity-30">Line Total</label>
                        <input data-field="line-total" tabIndex={0}
                          type="number" className="w-full p-2 bg-app-bg border border-app-border rounded-lg text-xs outline-none font-mono font-bold focus:border-app-ink"
                          value={(item.price * item.quantity).toFixed(2)} 
                          onChange={e => updateItem(idx, 'line_total', e.target.value)}
                        />
                      </div>
                      <div className="w-16 space-y-1">
                        <label className="text-[8px] font-black uppercase opacity-30">Disc%</label>
                        <input data-field="disc" tabIndex={0}
                          type="number" className="w-full p-2 bg-app-bg border border-app-border rounded-lg text-xs outline-none focus:border-app-ink"
                          value={item.discount.value} onChange={e => {
                            const newItems = [...invoiceItems];
                            newItems[idx].discount.value = parseFloat(e.target.value) || 0;
                            setInvoiceItems(newItems);
                          }}
                        />
                      </div>
                      <div className="w-16 space-y-1">
                        <label className="text-[8px] font-black uppercase opacity-30">Tax%</label>
                        <input data-field="tax" tabIndex={0}
                          type="number" className="w-full p-2 bg-app-bg border border-app-border rounded-lg text-xs outline-none focus:border-app-ink"
                          value={item.tax.value} onChange={e => {
                            const newItems = [...invoiceItems];
                            newItems[idx].tax.value = parseFloat(e.target.value) || 0;
                            setInvoiceItems(newItems);
                          }}
                          onKeyDown={e => {
                            if (e.key === 'Tab' && !e.shiftKey) {
                              // If this is the last item's last field, loop back to search
                              if (idx === invoiceItems.length - 1) {
                                e.preventDefault();
                                document.getElementById('item-search-input')?.focus();
                              }
                            }
                          }}
                        />
                      </div>
                      <div className="w-24 text-right">
                        <p className="text-[8px] font-black uppercase opacity-30">Subtotal</p>
                        <p className="text-xs font-mono font-bold">${calculateItemTotal(item).toFixed(2)}</p>
                      </div>
                      <button tabIndex={0} onClick={() => removeItem(idx)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  );})}
                  {invoiceItems.length === 0 && (
                    <div className="p-6 text-center opacity-30 border-2 border-dashed border-app-border rounded-xl">
                      <p className="text-xs font-black uppercase tracking-widest">Search above to add products</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex justify-between items-end pt-4 border-t border-app-border">
                <div className="flex gap-8">
                  <div>
                    <p className="text-[10px] font-black uppercase opacity-50">Final Total ({invoiceCurrency.code})</p>
                    <p className="text-2xl font-black font-mono">{invoiceCurrency.symbol}{finalTotal.toFixed(2)}</p>
                  </div>
                  <div className="w-32">
                    <label className="text-[10px] font-black uppercase opacity-50">Paid ({paymentCurrency.code})</label>
                    <input 
                      type="number" 
                      className="w-full p-2 bg-app-bg border border-app-border rounded-lg outline-none font-mono font-bold"
                      value={paidAmount}
                      onChange={e => setPaidAmount(parseFloat(e.target.value) || 0)}
                    />
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase opacity-50">Remaining Credit ({invoiceCurrency.code})</p>
                    <p className="text-xl font-black font-mono text-red-500">
                      {invoiceCurrency.symbol}{Math.max(0, finalTotal - (paidAmount / paymentCurrency.rate * invoiceCurrency.rate)).toFixed(2)}
                    </p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <button onClick={() => { setIsAdding(false); setEditingId(null); }} className="px-6 py-4 border-2 border-app-border rounded-xl font-black uppercase text-xs">Cancel</button>
                  <button onClick={handleAddInvoice} className="px-8 py-4 bg-app-ink text-app-bg rounded-xl font-black uppercase text-xs flex items-center gap-2">
                    <Save size={18} /> Finalize Invoice
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}