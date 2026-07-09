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

export default function Reports() {
  const [reportType, setReportType] = useState('daily-sales');
  const [reportData, setReportData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [stakeholders, setStakeholders] = useState<Stakeholder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedStakeholder, setSelectedStakeholder] = useState('');

  // Builder Filters
  const [builderFilters, setBuilderFilters] = useState({
    stakeholderId: '',
    type: '',
    status: '',
    fromDate: '',
    toDate: '',
    productId: '',
    invoiceNumber: '',
    category: ''
  });

  const reportOptions = [
    { id: 'daily-sales', name: 'Daily Sales (Last 30 Days)' },
    { id: 'daily-sales-by-payment', name: 'Daily Sales by Payment Type' },
    { id: 'daily-sales-by-customer', name: 'Daily Sales by Customer' },
    { id: 'customer-statement', name: 'Detailed Customer Statement' },
    { id: 'unpaid-sales', name: 'Unpaid Sales (Receivables)' },
    { id: 'unpaid-purchases', name: 'Unpaid Purchases (Payables)' },
    { id: 'custom-builder', name: 'Custom Report Builder' },
  ];

  useEffect(() => {
    fetch('/api/stakeholders')
      .then(res => res.json())
      .then(data => setStakeholders(data));
    
    fetch('/api/products')
      .then(res => res.json())
      .then(data => {
        setProducts(data);
        setCategories(['All', ...new Set(data.map((p: any) => p.category))].filter(Boolean) as string[]);
      });
  }, []);

  const customQueries = [
    { name: 'Top 10 Selling Products', query: 'SELECT p.name, SUM(ti.quantity) as total_sold FROM transaction_items ti JOIN products p ON ti.product_id = p.id GROUP BY p.id ORDER BY total_sold DESC LIMIT 10' },
    { name: 'Stock Value by Category', query: 'SELECT category, SUM(stock * price) as total_value FROM products WHERE track_inventory = 1 GROUP BY category' },
    { name: 'Customer Balance Summary', query: 'SELECT name, balance FROM stakeholders WHERE type = "customer" AND balance != 0' },
    { name: 'Monthly Sales Summary', query: 'SELECT strftime("%Y-%m", created_at) as month, SUM(total_amount) as total FROM transactions WHERE type = "sale" GROUP BY month ORDER BY month DESC' },
    { name: 'Low Stock Items', query: 'SELECT name, stock, reorder_point FROM products WHERE track_inventory = 1 AND stock <= reorder_point' },
  ];

  const downloadCSV = () => {
    if (reportData.length === 0) return;
    const headers = Object.keys(reportData[0]);
    const rows = reportData.map(row => headers.map(header => JSON.stringify(row[header])).join(','));
    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `report-${reportType}-${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const fetchReport = async () => {
    setLoading(true);
    try {
      let url = `/api/reports/${reportType}`;
      let options: any = { method: 'GET' };

      if (reportType === 'daily-sales-by-payment' || reportType === 'daily-sales-by-customer') {
        url += `?date=${selectedDate}`;
      } else if (reportType === 'customer-statement') {
        if (!selectedStakeholder) {
          setLoading(false);
          return;
        }
        url = `/api/reports/customer-statement/${selectedStakeholder}`;
      } else if (reportType === 'custom-builder') {
        url = `/api/reports/custom-builder`;
        options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(builderFilters)
        };
      } else if (reportType === 'daily-sales') {
        url = `/api/reports/sales`;
      }

      const res = await fetch(url, options);
      const data = await res.json();
      setReportData(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (reportType !== 'custom-builder' && reportType !== 'customer-statement') {
      fetchReport();
    }
    if (reportType === 'customer-statement' && selectedStakeholder) {
      fetchReport();
    }
  }, [reportType, selectedDate, selectedStakeholder]);

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h1 className="text-4xl font-black tracking-tighter uppercase">Reports</h1>
          <p className="opacity-50 font-medium">Business intelligence and analytics.</p>
        </div>
        <div className="flex flex-wrap gap-4 w-full md:w-auto">
          {reportType === 'customer-statement' && (
            <select 
              value={selectedStakeholder}
              onChange={(e) => setSelectedStakeholder(e.target.value)}
              className="px-4 py-2 bg-app-surface border border-app-border rounded-xl outline-none focus:border-app-ink transition-all text-sm font-bold"
            >
              <option value="">Select Customer...</option>
              {stakeholders.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          )}
          {(reportType === 'daily-sales-by-payment' || reportType === 'daily-sales-by-customer') && (
            <input 
              type="date" 
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="px-4 py-2 bg-app-surface border border-app-border rounded-xl outline-none focus:border-app-ink transition-all text-sm font-bold"
            />
          )}
          <select 
            value={reportType}
            onChange={(e) => {
              setReportType(e.target.value);
              setReportData([]);
              if (e.target.value === 'custom-builder') {
                setBuilderFilters({
                  stakeholderId: '',
                  type: '',
                  status: '',
                  fromDate: '',
                  toDate: '',
                  productId: '',
                  invoiceNumber: '',
                  category: ''
                });
              }
            }}
            className="flex-1 md:flex-none px-4 py-2 bg-app-surface border border-app-border rounded-xl outline-none focus:border-app-ink transition-all text-sm font-bold uppercase tracking-widest"
          >
            {reportOptions.map(opt => (
              <option key={opt.id} value={opt.id}>{opt.name}</option>
            ))}
          </select>
          {reportData.length > 0 && (
            <div className="flex gap-2">
              <button 
                onClick={() => window.print()}
                className="px-4 py-2 bg-app-ink text-app-bg rounded-xl text-sm font-bold uppercase tracking-widest hover:opacity-90 transition-all"
              >
                Print
              </button>
              <button 
                onClick={downloadCSV}
                className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm font-bold uppercase tracking-widest hover:bg-emerald-700 transition-all"
              >
                Export CSV
              </button>
            </div>
          )}
        </div>
      </header>

      {reportType === 'custom-builder' && (
        <div className="p-8 bg-app-surface border border-app-border rounded-[32px] space-y-8 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-app-ink text-app-bg rounded-xl flex items-center justify-center">
              <BarChart3 size={20} />
            </div>
            <div>
              <h3 className="font-black uppercase tracking-widest text-sm">Report Builder</h3>
              <p className="text-[10px] font-bold opacity-50 uppercase tracking-widest">Customize your data view</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {/* Stakeholder */}
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase opacity-50 tracking-widest ml-1">Customer / Supplier</label>
              <select 
                value={builderFilters.stakeholderId}
                onChange={(e) => setBuilderFilters({ ...builderFilters, stakeholderId: e.target.value })}
                className="w-full px-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all text-sm font-bold"
              >
                <option value="">All Stakeholders</option>
                {stakeholders.map(s => (
                  <option key={s.id} value={s.id}>{s.name} ({s.type})</option>
                ))}
              </select>
            </div>

            {/* Type */}
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase opacity-50 tracking-widest ml-1">Invoice Type</label>
              <select 
                value={builderFilters.type}
                onChange={(e) => setBuilderFilters({ ...builderFilters, type: e.target.value })}
                className="w-full px-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all text-sm font-bold"
              >
                <option value="">All Types</option>
                <option value="sale">Sale (Invoice)</option>
                <option value="purchase">Purchase (Order)</option>
                <option value="refund">Refund</option>
              </select>
            </div>

            {/* Status */}
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase opacity-50 tracking-widest ml-1">Payment Status</label>
              <select 
                value={builderFilters.status}
                onChange={(e) => setBuilderFilters({ ...builderFilters, status: e.target.value })}
                className="w-full px-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all text-sm font-bold"
              >
                <option value="">All Statuses</option>
                <option value="paid">Fully Paid</option>
                <option value="unpaid">Unpaid / Partial</option>
              </select>
            </div>

            {/* Product */}
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase opacity-50 tracking-widest ml-1">Specific Product</label>
              <select 
                value={builderFilters.productId}
                onChange={(e) => setBuilderFilters({ ...builderFilters, productId: e.target.value })}
                className="w-full px-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all text-sm font-bold"
              >
                <option value="">All Products</option>
                {products.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            {/* From Date */}
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase opacity-50 tracking-widest ml-1">From Date</label>
              <input 
                type="date"
                value={builderFilters.fromDate}
                onChange={(e) => setBuilderFilters({ ...builderFilters, fromDate: e.target.value })}
                className="w-full px-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all text-sm font-bold"
              />
            </div>

            {/* To Date */}
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase opacity-50 tracking-widest ml-1">To Date</label>
              <input 
                type="date"
                value={builderFilters.toDate}
                onChange={(e) => setBuilderFilters({ ...builderFilters, toDate: e.target.value })}
                className="w-full px-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all text-sm font-bold"
              />
            </div>

            {/* Category */}
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase opacity-50 tracking-widest ml-1">Category</label>
              <select 
                value={builderFilters.category}
                onChange={(e) => setBuilderFilters({ ...builderFilters, category: e.target.value })}
                className="w-full px-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all text-sm font-bold"
              >
                <option value="">All Categories</option>
                {categories.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {/* Invoice Number */}
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase opacity-50 tracking-widest ml-1">Invoice #</label>
              <input 
                type="text"
                placeholder="e.g. 1042"
                value={builderFilters.invoiceNumber}
                onChange={(e) => setBuilderFilters({ ...builderFilters, invoiceNumber: e.target.value })}
                className="w-full px-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all text-sm font-bold"
              />
            </div>
          </div>

          <div className="flex justify-end pt-4">
            <button 
              onClick={fetchReport}
              disabled={loading}
              className="px-10 py-4 bg-app-ink text-app-bg rounded-2xl font-black uppercase tracking-widest text-xs hover:opacity-90 transition-all disabled:opacity-50 flex items-center gap-3"
            >
              {loading ? (
                <div className="w-4 h-4 border-2 border-app-bg border-t-transparent rounded-full animate-spin" />
              ) : (
                <>Generate Report</>
              )}
            </button>
          </div>
        </div>
      )}

      <div className="bg-app-surface border border-app-border rounded-3xl overflow-hidden min-h-[400px] shadow-sm print:border-none print:shadow-none print:rounded-none">
        <div id="printable-report">
          <div className="hidden print:block mb-8 border-b-2 border-app-ink pb-4">
            <h1 className="text-2xl font-black uppercase tracking-tighter">OmniPOS Business Report</h1>
            <p className="text-xs font-bold uppercase tracking-widest opacity-50">
              {reportOptions.find(o => o.id === reportType)?.name} - {new Date().toLocaleDateString()}
            </p>
          </div>
          {loading ? (
          <div className="flex items-center justify-center h-[400px]">
            <div className="w-8 h-8 border-4 border-app-ink border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : reportData.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-app-bg/50 border-b border-app-border">
                  {Object.keys(reportData[0]).map(key => (
                    <th key={key} className="p-4 text-[10px] font-bold uppercase tracking-widest opacity-50 whitespace-nowrap">{key.replace('_', ' ')}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {reportData.map((row, i) => (
                  <tr key={i} className="border-b border-app-border/5 hover:bg-app-bg/30 transition-colors">
                    {Object.values(row).map((val: any, j) => (
                      <td key={j} className="p-4 text-sm font-medium whitespace-nowrap">
                        {typeof val === 'number' ? (
                          (val % 1 !== 0 || Math.abs(val) > 1000) ? val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : val
                        ) : String(val)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-[400px] opacity-30 text-center p-12">
            <BarChart3 size={48} strokeWidth={1} />
            <p className="mt-4 font-black uppercase tracking-widest">No data found for this report</p>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}