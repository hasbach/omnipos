import React, { useState, useEffect, useCallback } from 'react';
import { Wallet, ArrowDownLeft, ArrowUpRight, Users } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export const CURRENCIES = [
  { code: 'USD', symbol: '$', rate: 1 },
  { code: 'EUR', symbol: '€', rate: 0.92 },
  { code: 'LBP', symbol: 'LL', rate: 89500 },
];

export default function CashFlowRegister() {
  const [entries, setEntries] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [type, setType] = useState<'in' | 'out'>('in');
  const [selectedCurrencyCode, setSelectedCurrencyCode] = useState('USD');

  // Balance payment state
  const [activeTab, setActiveTab] = useState<'manual' | 'balance'>('manual');
  const [stakeholders, setStakeholders] = useState<any[]>([]);
  const [balStakeholderId, setBalStakeholderId] = useState('');
  const [balAmount, setBalAmount] = useState('');
  const [balDirection, setBalDirection] = useState<'collect' | 'pay'>('collect');
  const [balCurrencyCode, setBalCurrencyCode] = useState('USD');

  const currentCurrency = CURRENCIES.find(c => c.code === selectedCurrencyCode) || CURRENCIES[0];
  const balCurrency = CURRENCIES.find(c => c.code === balCurrencyCode) || CURRENCIES[0];

  const fetchData = useCallback(async () => {
    try {
      const [entriesRes, summaryRes, stakeholdersRes] = await Promise.all([
        fetch('/api/cash-flow'),
        fetch('/api/cash-flow/summary'),
        fetch('/api/stakeholders'),
      ]);
      if (entriesRes.ok) setEntries(await entriesRes.json());
      if (summaryRes.ok) setSummary(await summaryRes.json());
      if (stakeholdersRes.ok) setStakeholders(await stakeholdersRes.json());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const handleSync = (e: any) => {
      if (e.detail.type === 'CASH_FLOW_UPDATED' || e.detail.type === 'STAKEHOLDERS_UPDATED') {
        fetchData();
      }
    };
    window.addEventListener('pos-sync', handleSync);
    return () => window.removeEventListener('pos-sync', handleSync);
  }, [fetchData]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const numAmount = parseFloat(amount);
    if (!amount || numAmount <= 0) return;

    try {
      const res = await fetch('/api/cash-flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          type, 
          amount: numAmount, 
          currency: currentCurrency.code,
          exchange_rate: currentCurrency.rate,
          reason 
        })
      });
      if (res.ok) {
        setAmount('');
        setReason('');
        fetchData();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleBalancePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    const numAmount = parseFloat(balAmount);
    if (!balStakeholderId || !balAmount || numAmount <= 0) return;

    try {
      const res = await fetch('/api/balance-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stakeholder_id: parseInt(balStakeholderId),
          amount: numAmount,
          currency: balCurrency.code,
          exchange_rate: balCurrency.rate,
          direction: balDirection,
        })
      });
      if (res.ok) {
        setBalAmount('');
        setBalStakeholderId('');
        fetchData();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to process payment');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const selectedStakeholder = stakeholders.find(s => s.id === parseInt(balStakeholderId));
  const customersWithBalance = stakeholders.filter(s => s.balance > 0.01);
  const suppliersWithBalance = stakeholders.filter(s => s.balance < -0.01);

  return (
    <div className="space-y-6">
      <header className="flex justify-between items-end">
        <div>
          <h1 className="text-4xl font-black tracking-tighter uppercase">Cash Flow Register</h1>
          <p className="opacity-50 font-medium">Track cash movements, collect balances, and pay suppliers.</p>
        </div>
        {summary && (
          <div className="bg-app-ink text-app-bg p-4 rounded-2xl shadow-xl flex flex-col items-end">
            <span className="text-[10px] uppercase tracking-widest font-black opacity-50">Expected Drawer Balance</span>
            <span className="text-3xl font-black font-mono">${summary.expectedBalance.toFixed(2)}</span>
          </div>
        )}
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
          {/* Tab Switcher */}
          <div className="flex gap-1 p-1 bg-app-bg border border-app-border rounded-xl">
            <button onClick={() => setActiveTab('manual')}
              className={`flex-1 py-2.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-1.5 ${activeTab === 'manual' ? 'bg-app-ink text-app-bg shadow-lg' : 'opacity-50 hover:opacity-100'}`}>
              <Wallet size={14} /> Cash Movement
            </button>
            <button onClick={() => setActiveTab('balance')}
              className={`flex-1 py-2.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-1.5 ${activeTab === 'balance' ? 'bg-app-ink text-app-bg shadow-lg' : 'opacity-50 hover:opacity-100'}`}>
              <Users size={14} /> Balance Payment
            </button>
          </div>

          <AnimatePresence mode="wait">
            {activeTab === 'manual' ? (
              <motion.form key="manual" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
                onSubmit={handleSubmit} className="bg-app-surface border border-app-border rounded-2xl p-6 shadow-sm space-y-4">
                <h2 className="text-lg font-black uppercase tracking-tight">Add Movement</h2>
                
                <div className="flex gap-2 p-1 bg-app-bg rounded-xl">
                  <button type="button" onClick={() => setType('in')}
                    className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase transition-all ${type === 'in' ? 'bg-emerald-500 text-white shadow-lg' : 'opacity-50 hover:opacity-100'}`}>
                    Cash In
                  </button>
                  <button type="button" onClick={() => setType('out')}
                    className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase transition-all ${type === 'out' ? 'bg-rose-500 text-white shadow-lg' : 'opacity-50 hover:opacity-100'}`}>
                    Cash Out
                  </button>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-widest font-black opacity-50 ml-1">Currency</label>
                  <div className="grid grid-cols-3 gap-2">
                    {CURRENCIES.map(c => (
                      <button key={c.code} type="button" onClick={() => setSelectedCurrencyCode(c.code)}
                        className={`py-2 rounded-xl text-[10px] font-black border transition-all ${selectedCurrencyCode === c.code ? 'bg-app-ink text-app-bg border-app-ink' : 'bg-app-bg border-app-border opacity-50 hover:opacity-100'}`}>
                        {c.code}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-widest font-black opacity-50 ml-1">Amount ({currentCurrency.symbol})</label>
                  <input type="number" step="0.01" required
                    className="w-full p-3 bg-app-bg border border-app-border rounded-xl font-mono text-lg outline-none focus:border-app-ink transition-all"
                    value={amount} onChange={(e) => setAmount(e.target.value)} />
                  {currentCurrency.code !== 'USD' && amount && (
                    <p className="text-[10px] opacity-50 font-mono mt-1">≈ ${(parseFloat(amount) / currentCurrency.rate).toFixed(2)} USD</p>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-widest font-black opacity-50 ml-1">Reason / Note</label>
                  <textarea className="w-full p-3 bg-app-bg border border-app-border rounded-xl text-sm outline-none focus:border-app-ink transition-all min-h-[80px]"
                    value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g., Petty cash for cleaning supplies" />
                </div>

                <button type="submit"
                  className="w-full py-4 bg-app-ink text-app-bg rounded-xl font-black uppercase tracking-widest shadow-lg hover:opacity-90 transition-all active:scale-95">
                  Record Movement
                </button>
              </motion.form>
            ) : (
              <motion.form key="balance" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}
                onSubmit={handleBalancePayment} className="bg-app-surface border border-app-border rounded-2xl p-6 shadow-sm space-y-4">
                <h2 className="text-lg font-black uppercase tracking-tight">Balance Payment</h2>

                <div className="flex gap-2 p-1 bg-app-bg rounded-xl">
                  <button type="button" onClick={() => { setBalDirection('collect'); setBalStakeholderId(''); }}
                    className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase transition-all flex items-center justify-center gap-1 ${balDirection === 'collect' ? 'bg-emerald-500 text-white shadow-lg' : 'opacity-50 hover:opacity-100'}`}>
                    <ArrowDownLeft size={14} /> Collect
                  </button>
                  <button type="button" onClick={() => { setBalDirection('pay'); setBalStakeholderId(''); }}
                    className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase transition-all flex items-center justify-center gap-1 ${balDirection === 'pay' ? 'bg-rose-500 text-white shadow-lg' : 'opacity-50 hover:opacity-100'}`}>
                    <ArrowUpRight size={14} /> Pay Supplier
                  </button>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-widest font-black opacity-50 ml-1">
                    {balDirection === 'collect' ? 'Customer' : 'Supplier'}
                  </label>
                  <select required value={balStakeholderId} onChange={e => setBalStakeholderId(e.target.value)}
                    className="w-full p-3 bg-app-bg border border-app-border rounded-xl text-sm font-bold outline-none focus:border-app-ink">
                    <option value="">Select {balDirection === 'collect' ? 'customer' : 'supplier'}...</option>
                    {(balDirection === 'collect' ? customersWithBalance : suppliersWithBalance).map(s => (
                      <option key={s.id} value={s.id}>{s.name} — ${Math.abs(s.balance).toFixed(2)} {s.balance > 0 ? 'owed' : 'outstanding'}</option>
                    ))}
                    {/* Also show all stakeholders in case of partial or zero balance */}
                    <optgroup label="All Stakeholders">
                      {stakeholders.map(s => (
                        <option key={`all-${s.id}`} value={s.id}>{s.name} (Balance: ${s.balance.toFixed(2)})</option>
                      ))}
                    </optgroup>
                  </select>
                  {selectedStakeholder && (
                    <p className="text-[10px] opacity-70 font-mono mt-1">
                      Current balance: <span className={selectedStakeholder.balance > 0 ? 'text-amber-500 font-bold' : selectedStakeholder.balance < 0 ? 'text-rose-500 font-bold' : 'text-emerald-500'}>
                        ${selectedStakeholder.balance.toFixed(2)}
                      </span>
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-widest font-black opacity-50 ml-1">Currency</label>
                  <div className="grid grid-cols-3 gap-2">
                    {CURRENCIES.map(c => (
                      <button key={c.code} type="button" onClick={() => setBalCurrencyCode(c.code)}
                        className={`py-2 rounded-xl text-[10px] font-black border transition-all ${balCurrencyCode === c.code ? 'bg-app-ink text-app-bg border-app-ink' : 'bg-app-bg border-app-border opacity-50 hover:opacity-100'}`}>
                        {c.code}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-widest font-black opacity-50 ml-1">Amount ({balCurrency.symbol})</label>
                  <input type="number" step="0.01" required
                    className="w-full p-3 bg-app-bg border border-app-border rounded-xl font-mono text-lg outline-none focus:border-app-ink transition-all"
                    value={balAmount} onChange={(e) => setBalAmount(e.target.value)} />
                  {balCurrency.code !== 'USD' && balAmount && (
                    <p className="text-[10px] opacity-50 font-mono mt-1">≈ ${(parseFloat(balAmount) / balCurrency.rate).toFixed(2)} USD</p>
                  )}
                </div>

                <button type="submit"
                  className={`w-full py-4 rounded-xl font-black uppercase tracking-widest shadow-lg hover:opacity-90 transition-all active:scale-95 ${balDirection === 'collect' ? 'bg-emerald-500 text-white' : 'bg-rose-500 text-white'}`}>
                  {balDirection === 'collect' ? 'Record Collection' : 'Record Payment'}
                </button>
              </motion.form>
            )}
          </AnimatePresence>

          {summary && (
            <div className="bg-app-surface border border-app-border rounded-2xl p-6 shadow-sm space-y-4">
              <h2 className="text-lg font-black uppercase tracking-tight">Daily Summary</h2>
              <div className="space-y-3">
                <div className="flex justify-between items-center text-sm">
                  <span className="opacity-50">Opening Balance</span>
                  <span className="font-mono font-bold">${summary.openingBalance.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="opacity-50">Cash Sales</span>
                  <span className="font-mono font-bold text-emerald-500">+${summary.totalSales.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="opacity-50">Cash Purchases</span>
                  <span className="font-mono font-bold text-rose-500">-${summary.totalPurchases.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="opacity-50">Manual Cash In</span>
                  <span className="font-mono font-bold text-emerald-500">+${summary.totalIn.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="opacity-50">Manual Cash Out</span>
                  <span className="font-mono font-bold text-rose-500">-${summary.totalOut.toFixed(2)}</span>
                </div>
                <div className="pt-3 border-t border-app-border flex justify-between items-center">
                  <span className="font-black uppercase text-[10px] tracking-widest">Expected Total</span>
                  <span className="font-mono font-black text-lg">${summary.expectedBalance.toFixed(2)}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="lg:col-span-2">
          <div className="bg-app-surface border border-app-border rounded-2xl overflow-hidden shadow-sm">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-app-bg/50 text-[10px] uppercase tracking-widest font-black opacity-50">
                  <th className="p-4 border-b border-app-border">Time</th>
                  <th className="p-4 border-b border-app-border">Type</th>
                  <th className="p-4 border-b border-app-border">Amount</th>
                  <th className="p-4 border-b border-app-border">Reason</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {loading ? (
                  <tr><td colSpan={4} className="p-12 text-center opacity-30 italic">Loading...</td></tr>
                ) : entries.length === 0 ? (
                  <tr><td colSpan={4} className="p-12 text-center opacity-30 italic">No movements recorded today.</td></tr>
                ) : (
                  entries.map(entry => (
                    <tr key={entry.id} className="hover:bg-app-bg/30 transition-colors">
                      <td className="p-4 border-b border-app-border font-mono text-[10px] opacity-50">
                        {new Date(entry.created_at).toLocaleTimeString()}
                      </td>
                      <td className="p-4 border-b border-app-border">
                        <span className={`px-2 py-1 text-[10px] font-black uppercase rounded ${entry.type === 'in' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
                          {entry.type === 'in' ? 'In' : 'Out'}
                        </span>
                      </td>
                      <td className={`p-4 border-b border-app-border font-mono font-bold ${entry.type === 'in' ? 'text-emerald-500' : 'text-rose-500'}`}>
                        <div className="flex flex-col">
                          <span>{entry.type === 'in' ? '+' : '-'}{entry.amount.toLocaleString()} {entry.currency}</span>
                          {entry.currency !== 'USD' && (
                            <span className="text-[10px] opacity-50 font-normal">
                              ≈ ${(entry.amount / entry.exchange_rate).toFixed(2)}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-4 border-b border-app-border opacity-70">
                        {entry.reason || '-'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}