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
  LogOut,
  Lock
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

export default function Settlement() {
  const [dailyReports, setDailyReports] = useState<any[]>([]);
  const [yearlyReports, setYearlyReports] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const parsedCashierId = parseInt(sessionStorage.getItem('currentCashierId') || '');
  const [selectedUserId, setSelectedUserId] = useState<number>(isNaN(parsedCashierId) ? 0 : parsedCashierId);
  const [actualBalances, setActualBalances] = useState<Record<string, string>>(
    CURRENCIES.reduce((acc, c) => ({ ...acc, [c.code]: '' }), {})
  );
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'daily' | 'yearly'>('daily');
  const [showAdminConfirm, setShowAdminConfirm] = useState(false);
  const [cashierShifts, setCashierShifts] = useState<any[]>([]);

  const fetchData = useCallback(async () => {
    try {
      const [dailyRes, yearlyRes, summaryRes, usersRes, shiftsRes] = await Promise.all([
        fetch('/api/reports/daily'),
        fetch('/api/reports/yearly'),
        fetch('/api/cash-flow/summary'),
        fetch('/api/users'),
        fetch('/api/tenant/cashier-shifts')
      ]);
      if (dailyRes.ok) setDailyReports(await dailyRes.json());
      if (yearlyRes.ok) setYearlyReports(await yearlyRes.json());
      if (summaryRes.ok) setSummary(await summaryRes.json());
      if (usersRes.ok) {
        const userData = await usersRes.json();
        setUsers(userData);
        if (userData.length > 0 && !selectedUserId) setSelectedUserId(userData[0].id);
      }
      if (shiftsRes.ok) setCashierShifts(await shiftsRes.json());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [selectedUserId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const totalActualUSD = (Object.entries(actualBalances) as [string, string][]).reduce((sum, [code, val]) => {
    if (!val) return sum;
    const currency = CURRENCIES.find(c => c.code === code);
    return sum + (parseFloat(val) / (currency?.rate || 1));
  }, 0);

  const selectedUser = users.find(u => u.id === selectedUserId);
  const isAdmin = selectedUser?.role === 'admin';

  // Cash Out: saves report snapshot, keeps transactions/order numbers
  const handleCashOut = async () => {
    if (totalActualUSD <= 0 && !confirm('Cash out with zero balance?')) return;

    const notesWithBreakdown = notes + (Object.entries(actualBalances).some(([_, v]) => v) 
      ? ` [Breakdown: ${Object.entries(actualBalances).filter(([_, v]) => v).map(([c, v]) => `${v} ${c}`).join(', ')}]` 
      : '');

    try {
      const res = await fetch('/api/tenant/cashout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: selectedUserId,
          opening_balance: 0, // This could be made an input field if needed
          actual_cash: totalActualUSD,
          notes: notesWithBreakdown
        })
      });

      if (res.ok) {
        const data = await res.json();
        setActualBalances(CURRENCIES.reduce((acc, c) => ({ ...acc, [c.code]: '' }), {}));
        setNotes('');
        fetchData();
        if (confirm('Cash out complete. Your shift has been recorded. Would you like to print the receipt?')) {
          printXReport(data.shift, 'CASH OUT');
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Complete Settlement (Admin only): full archival + order number reset
  const handleDailySettlement = async () => {
    if (!isAdmin) {
      alert('Only admin users can perform a complete settlement.');
      return;
    }

    const report = {
      date: new Date().toISOString().split('T')[0],
      user_id: selectedUserId,
      opening_balance: summary.openingBalance,
      total_sales: summary.totalSales,
      total_refunds: summary.totalRefunds,
      total_purchases: summary.totalPurchases,
      total_cash_in: summary.totalIn,
      total_cash_out: summary.totalOut,
      closing_balance: summary.expectedBalance,
      actual_balance: totalActualUSD,
      notes: notes + (Object.entries(actualBalances).some(([_, v]) => v) 
        ? ` [Breakdown: ${Object.entries(actualBalances).filter(([_, v]) => v).map(([c, v]) => `${v} ${c}`).join(', ')}]` 
        : '')
    };

    try {
      const res = await fetch('/api/reports/daily', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report)
      });
      if (res.ok) {
        // Also trigger the transaction archival/reset
        await fetch('/api/tenant/settlement', { method: 'POST' });
        
        setActualBalances(CURRENCIES.reduce((acc, c) => ({ ...acc, [c.code]: '' }), {}));
        setNotes('');
        setShowAdminConfirm(false);
        fetchData();
        if (confirm('Settlement saved. All data has been archived and order numbering reset. Would you like to print the X-Report?')) {
          printXReport(report, 'END OF DAY');
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleYearlySettlement = async () => {
    const year = new Date().getFullYear();
    const notes = prompt('Enter notes for the yearly settlement:');
    if (notes === null) return;

    try {
      const res = await fetch('/api/reports/yearly', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, notes })
      });
      if (res.ok) {
        fetchData();
        alert('Yearly settlement generated successfully.');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const printXReport = (report: any, title: string = 'DAILY X-REPORT') => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    const diff = report.actual_balance - report.closing_balance;

    printWindow.document.write(`
      <html>
        <head>
          <title>${title} - ${report.date}</title>
          <style>
            body { font-family: 'Courier New', Courier, monospace; padding: 20px; width: 300px; }
            h1 { text-align: center; font-size: 18px; margin-bottom: 5px; }
            .meta { text-align: center; font-size: 12px; margin-bottom: 20px; border-bottom: 1px dashed #000; padding-bottom: 10px; }
            .row { display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 14px; }
            .total { border-top: 1px solid #000; margin-top: 10px; padding-top: 10px; font-weight: bold; }
            .diff { color: ${diff < 0 ? 'red' : 'green'}; }
            .footer { margin-top: 30px; text-align: center; font-size: 10px; opacity: 0.5; }
          </style>
        </head>
        <body>
          <h1>${title}</h1>
          <div class="meta">
            Date: ${report.date}<br>
            Time: ${new Date().toLocaleTimeString()}
          </div>
          <div class="row"><span>Opening Bal:</span> <span>$${(report.opening_balance || 0).toFixed(2)}</span></div>
          <div class="row"><span>Cash Sales:</span> <span>+$${(report.total_sales || 0).toFixed(2)}</span></div>
          ${(report.total_refunds || 0) > 0 ? `<div class="row"><span>Cash Refunds:</span> <span>-$${report.total_refunds.toFixed(2)}</span></div>` : ''}
          <div class="row"><span>Cash Purchases:</span> <span>-$${(report.total_purchases || 0).toFixed(2)}</span></div>
          <div class="row"><span>Manual In:</span> <span>+$${(report.total_cash_in || 0).toFixed(2)}</span></div>
          <div class="row"><span>Manual Out:</span> <span>-$${(report.total_cash_out || 0).toFixed(2)}</span></div>
          <div class="row total"><span>Expected Bal:</span> <span>$${(report.closing_balance || 0).toFixed(2)}</span></div>
          <div class="row"><span>Actual Bal:</span> <span>$${(report.actual_balance || 0).toFixed(2)}</span></div>
          <div class="row total"><span>Difference:</span> <span class="diff">${diff >= 0 ? '+' : ''}${diff.toFixed(2)}</span></div>
          ${report.notes ? `<div style="margin-top: 15px; font-size: 12px; border-top: 1px dashed #000; padding-top: 5px;"><strong>Notes:</strong><br>${report.notes}</div>` : ''}
          <div class="footer">OmniPOS v2.5.0<br>${title}</div>
          <script>window.print(); window.close();</script>
        </body>
      </html>
    `);
  };

  return (
    <div className="space-y-6">
      <header className="flex justify-between items-end">
        <div>
          <h1 className="text-4xl font-black tracking-tighter uppercase">Settlement & Reports</h1>
          <p className="opacity-50 font-medium">Close the day or year and audit your finances.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('daily')}
            className={`px-6 py-3 rounded-xl font-black uppercase tracking-widest transition-all ${activeTab === 'daily' ? 'bg-app-ink text-app-bg shadow-lg' : 'bg-app-surface border border-app-border opacity-50 hover:opacity-100'}`}
          >
            Daily
          </button>
          <button
            onClick={() => setActiveTab('yearly')}
            className={`px-6 py-3 rounded-xl font-black uppercase tracking-widest transition-all ${activeTab === 'yearly' ? 'bg-app-ink text-app-bg shadow-lg' : 'bg-app-surface border border-app-border opacity-50 hover:opacity-100'}`}
          >
            Yearly
          </button>
        </div>
      </header>

      {activeTab === 'daily' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 space-y-6">
            <div className="bg-app-surface border border-app-border rounded-2xl p-6 shadow-sm space-y-6">
              <h2 className="text-xl font-black uppercase tracking-tight flex items-center gap-2">
                <CalendarCheck className="text-emerald-500" /> End of Day
              </h2>

              {summary ? (
                <div className="space-y-4">
                  <div className="p-4 bg-app-bg rounded-xl border border-app-border/50">
                    <span className="text-[10px] uppercase tracking-widest font-black opacity-50 block mb-1">Expected Balance</span>
                    <span className="text-3xl font-black font-mono">${summary.expectedBalance.toFixed(2)}</span>
                  </div>

                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] font-black uppercase tracking-widest opacity-60 px-1">
                    <div className="flex justify-between"><span>Sales:</span> <span className="text-emerald-500 font-mono">+${summary.totalSales.toFixed(2)}</span></div>
                    <div className="flex justify-between"><span>Refunds:</span> <span className="text-rose-500 font-mono">-${(summary.totalRefunds || 0).toFixed(2)}</span></div>
                    <div className="flex justify-between"><span>Purchases:</span> <span className="text-rose-500 font-mono">-${summary.totalPurchases.toFixed(2)}</span></div>
                    <div className="flex justify-between"><span>Manual:</span> <span className={`${(summary.totalIn - summary.totalOut) >= 0 ? 'text-emerald-500' : 'text-rose-500'} font-mono`}>{(summary.totalIn - summary.totalOut) >= 0 ? '+' : ''}${(summary.totalIn - summary.totalOut).toFixed(2)}</span></div>
                  </div>

                  {/* User Selector */}
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase tracking-widest font-black opacity-50 ml-1">Cashier</label>
                    <select
                      className="w-full p-3 bg-app-bg border border-app-border rounded-xl text-sm font-bold outline-none focus:border-app-ink transition-all disabled:opacity-50 cursor-not-allowed"
                      value={selectedUserId}
                      onChange={(e) => setSelectedUserId(parseInt(e.target.value))}
                      disabled
                    >
                      {users.map(u => (
                        <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-3">
                    <label className="text-[10px] uppercase tracking-widest font-black opacity-50 ml-1">Actual Cash in Drawer</label>
                    {CURRENCIES.map(c => (
                      <div key={c.code} className="flex items-center gap-3">
                        <div className="w-12 text-xs font-black opacity-50">{c.code}</div>
                        <input
                          type="number"
                          step="0.01"
                          placeholder="0.00"
                          className="flex-1 p-3 bg-app-bg border border-app-border rounded-xl font-mono text-lg outline-none focus:border-app-ink transition-all"
                          value={actualBalances[c.code]}
                          onChange={(e) => setActualBalances(prev => ({ ...prev, [c.code]: e.target.value }))}
                        />
                      </div>
                    ))}
                    <div className="p-3 bg-app-ink/5 rounded-xl border border-dashed border-app-ink/20 flex justify-between items-center">
                      <span className="text-[10px] uppercase font-black opacity-50">Total (USD)</span>
                      <span className="font-mono font-black text-lg">${totalActualUSD.toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] uppercase tracking-widest font-black opacity-50 ml-1">Notes</label>
                    <textarea
                      placeholder="Any discrepancies or notes..."
                      className="w-full p-3 bg-app-bg border border-app-border rounded-xl text-sm outline-none focus:border-app-ink transition-all min-h-[80px]"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  </div>

                  {/* Cash Out Button — available to all */}
                  <button
                    onClick={handleCashOut}
                    className="w-full py-4 bg-amber-500 text-white rounded-xl font-black uppercase tracking-widest shadow-lg shadow-amber-500/20 hover:bg-amber-600 transition-all active:scale-95 flex items-center justify-center gap-2"
                  >
                    <LogOut size={18} /> Cash Out
                  </button>

                  {/* Complete Settlement — admin only */}
                  {isAdmin ? (
                    <button
                      onClick={() => setShowAdminConfirm(true)}
                      className="w-full py-4 bg-emerald-500 text-white rounded-xl font-black uppercase tracking-widest shadow-lg shadow-emerald-500/20 hover:bg-emerald-600 transition-all active:scale-95 flex items-center justify-center gap-2"
                    >
                      <CheckCircle2 size={18} /> Complete Settlement
                    </button>
                  ) : (
                    <div className="w-full py-4 bg-app-bg border border-app-border rounded-xl flex items-center justify-center gap-2 opacity-40 cursor-not-allowed">
                      <Lock size={16} />
                      <span className="text-[10px] font-black uppercase tracking-widest">Admin only — Complete Settlement</span>
                    </div>
                  )}

                  <div className="text-[10px] opacity-40 text-center px-2 leading-relaxed">
                    <strong>Cash Out</strong> resets today's sales summary but keeps order numbers.<br />
                    <strong>Complete Settlement</strong> archives all data and resets order numbers (admin only).
                  </div>
                </div>
              ) : (
                <div className="py-12 text-center opacity-30 italic">Loading summary...</div>
              )}
            </div>
          </div>

          <div className="lg:col-span-2 space-y-6">
            {/* Cashier Shifts Table */}
            <div className="bg-app-surface border border-app-border rounded-2xl overflow-hidden shadow-sm">
              <div className="p-4 bg-app-bg/30 border-b border-app-border flex justify-between items-center">
                <h3 className="text-xs font-black uppercase tracking-widest">Today's Cashier Shifts</h3>
              </div>
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-app-bg/50 text-[10px] uppercase tracking-widest font-black opacity-50">
                    <th className="p-4 border-b border-app-border">Cashier</th>
                    <th className="p-4 border-b border-app-border">Sales</th>
                    <th className="p-4 border-b border-app-border">Expected</th>
                    <th className="p-4 border-b border-app-border">Actual</th>
                    <th className="p-4 border-b border-app-border">Diff</th>
                    <th className="p-4 border-b border-app-border">Action</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {loading ? (
                    <tr><td colSpan={6} className="p-12 text-center opacity-30 italic">Loading...</td></tr>
                  ) : cashierShifts.length === 0 ? (
                    <tr><td colSpan={6} className="p-12 text-center opacity-30 italic">No shifts recorded today.</td></tr>
                  ) : (
                    cashierShifts.map(shift => (
                      <tr key={shift.id} className="hover:bg-app-bg/30 transition-colors group">
                        <td className="p-4 border-b border-app-border font-bold">{shift.user_name}</td>
                        <td className="p-4 border-b border-app-border font-mono text-xs">${shift.cash_sales.toFixed(2)}</td>
                        <td className="p-4 border-b border-app-border font-mono text-xs">${shift.expected_cash.toFixed(2)}</td>
                        <td className="p-4 border-b border-app-border font-mono text-xs">${shift.actual_cash.toFixed(2)}</td>
                        <td className={`p-4 border-b border-app-border font-mono text-xs font-bold ${shift.difference === 0 ? 'opacity-30' : shift.difference > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                          {shift.difference > 0 ? '+' : ''}{shift.difference.toFixed(2)}
                        </td>
                        <td className="p-4 border-b border-app-border">
                          <button 
                            onClick={() => printXReport(shift, 'CASH OUT')}
                            className="p-2 hover:bg-app-ink hover:text-app-bg rounded-lg transition-all opacity-0 group-hover:opacity-100"
                          >
                            <Printer size={14} />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="bg-app-surface border border-app-border rounded-2xl overflow-hidden shadow-sm">
              <div className="p-4 bg-app-bg/30 border-b border-app-border flex justify-between items-center">
                <h3 className="text-xs font-black uppercase tracking-widest">Settlement History</h3>
              </div>
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-app-bg/50 text-[10px] uppercase tracking-widest font-black opacity-50">
                    <th className="p-4 border-b border-app-border">Date</th>
                    <th className="p-4 border-b border-app-border">Expected</th>
                    <th className="p-4 border-b border-app-border">Actual</th>
                    <th className="p-4 border-b border-app-border">Diff</th>
                    <th className="p-4 border-b border-app-border">User</th>
                    <th className="p-4 border-b border-app-border">Action</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {loading ? (
                    <tr><td colSpan={6} className="p-12 text-center opacity-30 italic">Loading...</td></tr>
                  ) : dailyReports.length === 0 ? (
                    <tr><td colSpan={6} className="p-12 text-center opacity-30 italic">No reports found.</td></tr>
                  ) : (
                    dailyReports.map(report => (
                      <tr key={report.id} className="hover:bg-app-bg/30 transition-colors group">
                        <td className="p-4 border-b border-app-border font-bold">{report.date}</td>
                        <td className="p-4 border-b border-app-border font-mono text-xs">${report.closing_balance.toFixed(2)}</td>
                        <td className="p-4 border-b border-app-border font-mono text-xs">${report.actual_balance.toFixed(2)}</td>
                        <td className={`p-4 border-b border-app-border font-mono text-xs font-bold ${report.difference === 0 ? 'opacity-30' : report.difference > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                          {report.difference > 0 ? '+' : ''}{report.difference.toFixed(2)}
                        </td>
                        <td className="p-4 border-b border-app-border opacity-50">{report.user_name}</td>
                        <td className="p-4 border-b border-app-border">
                          <button 
                            onClick={() => printXReport(report)}
                            className="p-2 hover:bg-app-ink hover:text-app-bg rounded-lg transition-all opacity-0 group-hover:opacity-100"
                          >
                            <Printer size={14} />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="bg-app-surface border border-app-border rounded-2xl p-8 shadow-sm flex flex-col items-center text-center space-y-6">
            <div className="w-20 h-20 bg-app-ink text-app-bg rounded-3xl flex items-center justify-center shadow-2xl">
              <Zap size={40} />
            </div>
            <div className="max-w-md">
              <h2 className="text-3xl font-black uppercase tracking-tighter">Yearly Closing</h2>
              <p className="opacity-50 mt-2">Generate a comprehensive financial report for the current year. This will calculate total sales, purchases, and net profit.</p>
            </div>
            <button
              onClick={handleYearlySettlement}
              className="px-12 py-4 bg-app-ink text-app-bg rounded-2xl font-black uppercase tracking-widest shadow-2xl hover:opacity-90 transition-all active:scale-95"
            >
              Generate {new Date().getFullYear()} Report
            </button>
          </div>

          <div className="bg-app-surface border border-app-border rounded-2xl overflow-hidden shadow-sm">
            <div className="p-4 bg-app-bg/30 border-b border-app-border">
              <h3 className="text-xs font-black uppercase tracking-widest">Yearly Reports History</h3>
            </div>
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-app-bg/50 text-[10px] uppercase tracking-widest font-black opacity-50">
                  <th className="p-4 border-b border-app-border">Year</th>
                  <th className="p-4 border-b border-app-border">Total Sales</th>
                  <th className="p-4 border-b border-app-border">Total Purchases</th>
                  <th className="p-4 border-b border-app-border">Net Profit</th>
                  <th className="p-4 border-b border-app-border">User</th>
                  <th className="p-4 border-b border-app-border">Notes</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {loading ? (
                  <tr><td colSpan={6} className="p-12 text-center opacity-30 italic">Loading...</td></tr>
                ) : yearlyReports.length === 0 ? (
                  <tr><td colSpan={6} className="p-12 text-center opacity-30 italic">No yearly reports found.</td></tr>
                ) : (
                  yearlyReports.map(report => (
                    <tr key={report.id} className="hover:bg-app-bg/30 transition-colors">
                      <td className="p-4 border-b border-app-border font-black text-lg">{report.year}</td>
                      <td className="p-4 border-b border-app-border font-mono text-emerald-500 font-bold">${report.total_sales.toFixed(2)}</td>
                      <td className="p-4 border-b border-app-border font-mono text-rose-500 font-bold">${report.total_purchases.toFixed(2)}</td>
                      <td className="p-4 border-b border-app-border font-mono font-black text-lg">${report.total_profit.toFixed(2)}</td>
                      <td className="p-4 border-b border-app-border opacity-50">{report.user_name}</td>
                      <td className="p-4 border-b border-app-border opacity-70 italic">{report.notes || '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Admin Confirmation Modal for Complete Settlement */}
      <AnimatePresence>
        {showAdminConfirm && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-app-ink/80 backdrop-blur-sm"
              onClick={() => setShowAdminConfirm(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-app-surface border border-app-border rounded-3xl overflow-hidden shadow-2xl"
            >
              <div className="p-8 text-center space-y-6">
                <div className="w-20 h-20 bg-rose-500/10 text-rose-500 rounded-full flex items-center justify-center mx-auto">
                  <AlertCircle size={40} />
                </div>
                
                <div className="space-y-2">
                  <h2 className="text-2xl font-black uppercase tracking-tight">Complete Settlement</h2>
                  <p className="opacity-50 text-sm">This will <strong>archive all transactions</strong> and <strong>reset order numbering</strong>. This action cannot be undone. Are you sure?</p>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => setShowAdminConfirm(false)}
                    className="flex-1 py-4 bg-app-bg border border-app-border rounded-xl font-black uppercase tracking-widest hover:bg-app-ink hover:text-app-bg transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDailySettlement}
                    className="flex-1 py-4 bg-rose-500 text-white rounded-xl font-black uppercase tracking-widest hover:bg-rose-600 transition-all flex items-center justify-center gap-2"
                  >
                    <Shield size={16} /> Confirm
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