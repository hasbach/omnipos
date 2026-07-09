import React, { useState, useEffect, useCallback } from 'react';
import { Search, ShoppingCart, Eye, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

const CURRENCIES = [
  { code: 'USD', symbol: '$', rate: 1 },
  { code: 'EUR', symbol: '€', rate: 0.92 },
  { code: 'LBP', symbol: 'LL', rate: 89500 },
];

export default function PurchaseManagement() {
  const [purchases, setPurchases] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewPO, setViewPO] = useState<any>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const fetchPurchases = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (searchTerm) params.set('search', searchTerm);
      const res = await fetch(`/api/purchases?${params}`);
      if (res.ok) setPurchases(await res.json());
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, [statusFilter, searchTerm]);

  useEffect(() => { fetchPurchases(); }, [fetchPurchases]);

  const totalSpent = purchases.reduce((s, p) => s + p.total_amount, 0);
  const totalPaid = purchases.reduce((s, p) => s + p.paid_amount, 0);
  const totalOutstanding = totalSpent - totalPaid;

  const openDetail = async (id: number) => {
    try {
      const res = await fetch(`/api/purchases/${id}`);
      if (res.ok) setViewPO(await res.json());
    } catch (err) { console.error(err); }
  };

  return (
    <div className="h-full flex flex-col space-y-6">
      <header className="flex justify-between items-end flex-shrink-0">
        <div>
          <h1 className="text-4xl font-black tracking-tighter uppercase">Purchases</h1>
          <p className="opacity-50 font-medium">View supplier purchase orders created from Invoices.</p>
        </div>
      </header>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 flex-shrink-0">
        {[
          { label: 'Total Orders', value: purchases.length, color: 'text-blue-500' },
          { label: 'Total Spent (USD)', value: `$${totalSpent.toFixed(2)}`, color: 'text-emerald-500' },
          { label: 'Outstanding', value: `$${totalOutstanding.toFixed(2)}`, color: totalOutstanding > 0 ? 'text-rose-500' : 'text-emerald-500' },
        ].map(s => (
          <div key={s.label} className="bg-app-surface border border-app-border rounded-2xl p-4 shadow-sm">
            <p className="text-[10px] font-black uppercase tracking-widest opacity-50">{s.label}</p>
            <p className={`text-2xl font-black font-mono ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 opacity-30" size={18} />
          <input type="text" placeholder="Search by supplier name..."
            className="w-full pl-12 pr-4 py-3 bg-app-surface border border-app-border rounded-xl outline-none focus:border-app-ink transition-all"
            value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
        </div>
        {['all', 'paid', 'unpaid'].map(f => (
          <button key={f} onClick={() => setStatusFilter(f)}
            className={`px-5 py-3 rounded-xl font-black uppercase text-[10px] tracking-widest transition-all ${statusFilter === f ? 'bg-app-ink text-app-bg shadow-lg' : 'bg-app-surface border border-app-border opacity-50 hover:opacity-100'}`}>
            {f}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 bg-app-surface border border-app-border rounded-2xl overflow-hidden shadow-sm flex flex-col">
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 z-10 bg-app-bg">
              <tr className="text-[10px] uppercase tracking-widest font-black opacity-50">
                <th className="p-4 border-b border-app-border">PO #</th>
                <th className="p-4 border-b border-app-border">Supplier</th>
                <th className="p-4 border-b border-app-border">Date</th>
                <th className="p-4 border-b border-app-border text-center">Items</th>
                <th className="p-4 border-b border-app-border text-right">Total</th>
                <th className="p-4 border-b border-app-border text-right">Paid</th>
                <th className="p-4 border-b border-app-border text-right">Balance</th>
                <th className="p-4 border-b border-app-border text-center">Status</th>
                <th className="p-4 border-b border-app-border text-center">View</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {loading ? (
                <tr><td colSpan={9} className="p-12 text-center opacity-30 italic">Loading...</td></tr>
              ) : purchases.length === 0 ? (
                <tr><td colSpan={9} className="p-12 text-center opacity-30">
                  <div className="flex flex-col items-center gap-3">
                    <ShoppingCart size={40} strokeWidth={1} />
                    <p className="font-black uppercase tracking-widest text-xs">No purchase orders found</p>
                    <p className="text-xs opacity-60">Create purchase invoices from the Invoices page.</p>
                  </div>
                </td></tr>
              ) : purchases.map(po => {
                const balance = po.total_amount - po.paid_amount;
                const isPaid = balance <= 0.01;
                return (
                  <tr key={po.id} className="hover:bg-app-bg/30 transition-colors group cursor-pointer" onClick={() => openDetail(po.id)}>
                    <td className="p-4 border-b border-app-border font-mono font-bold">#{po.id}</td>
                    <td className="p-4 border-b border-app-border font-bold">{po.supplier_name || 'Unknown'}</td>
                    <td className="p-4 border-b border-app-border opacity-50">{new Date(po.created_at).toLocaleDateString()}</td>
                    <td className="p-4 border-b border-app-border text-center">
                      <span className="bg-app-bg px-2 py-1 rounded-lg text-xs font-bold">{po.item_count}</span>
                    </td>
                    <td className="p-4 border-b border-app-border text-right font-mono font-bold">${po.total_amount.toFixed(2)}</td>
                    <td className="p-4 border-b border-app-border text-right font-mono text-emerald-500">${po.paid_amount.toFixed(2)}</td>
                    <td className={`p-4 border-b border-app-border text-right font-mono font-bold ${isPaid ? 'opacity-30' : 'text-rose-500'}`}>
                      ${balance.toFixed(2)}
                    </td>
                    <td className="p-4 border-b border-app-border text-center">
                      <span className={`px-2 py-1 rounded text-[8px] font-black uppercase tracking-widest ${isPaid ? 'bg-emerald-500 text-white' : 'bg-amber-500 text-white'}`}>
                        {isPaid ? 'Paid' : 'Unpaid'}
                      </span>
                    </td>
                    <td className="p-4 border-b border-app-border text-center">
                      <button className="p-2 hover:bg-app-ink hover:text-app-bg rounded-lg transition-all opacity-50 group-hover:opacity-100">
                        <Eye size={16} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* View PO Detail Modal */}
      <AnimatePresence>
        {viewPO && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setViewPO(null)} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <motion.div initial={{ scale: 0.9, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-app-surface w-full max-w-3xl rounded-2xl overflow-hidden shadow-2xl border border-app-border flex flex-col max-h-[85vh]">
              <div className="p-6 border-b border-app-border bg-app-bg/30 flex justify-between items-center flex-shrink-0">
                <div>
                  <h2 className="text-2xl font-black tracking-tighter uppercase">Purchase Order #{viewPO.id}</h2>
                  <p className="text-sm opacity-50">{viewPO.supplier_name} · {new Date(viewPO.created_at).toLocaleString()}</p>
                </div>
                <button onClick={() => setViewPO(null)} className="p-3 hover:bg-app-ink hover:text-app-bg rounded-full transition-all"><X size={20} /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                <div>
                  <h3 className="text-xs font-black uppercase tracking-widest opacity-50 mb-3">Items</h3>
                  <div className="space-y-2">
                    {viewPO.items?.map((item: any) => (
                      <div key={item.id} className="flex justify-between items-center p-3 bg-app-bg/30 rounded-xl border border-app-border/10">
                        <div>
                          <p className="font-bold">{item.product_name || item.name}</p>
                          <p className="text-xs opacity-50 font-mono">{item.barcode}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-mono font-bold">{item.quantity} × ${item.unit_price.toFixed(2)}</p>
                          <p className="text-xs font-mono opacity-50">${(item.quantity * item.unit_price).toFixed(2)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                {viewPO.payments?.length > 0 && (
                  <div>
                    <h3 className="text-xs font-black uppercase tracking-widest opacity-50 mb-3">Payments</h3>
                    <div className="space-y-2">
                      {viewPO.payments.map((p: any) => (
                        <div key={p.id} className="flex justify-between items-center p-3 bg-app-bg/30 rounded-xl border border-app-border/10">
                          <span className="text-xs font-black uppercase">{p.method} ({p.currency})</span>
                          <span className="font-mono font-bold">{p.amount.toLocaleString()} {p.currency}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="p-6 border-t border-app-border bg-app-bg/30 flex justify-between items-center flex-shrink-0">
                <div className="flex gap-6">
                  <div><p className="text-[10px] font-black uppercase opacity-50">Total</p><p className="text-xl font-black font-mono">${viewPO.total_amount.toFixed(2)}</p></div>
                  <div><p className="text-[10px] font-black uppercase opacity-50">Paid</p><p className="text-xl font-black font-mono text-emerald-500">${viewPO.paid_amount.toFixed(2)}</p></div>
                  <div><p className="text-[10px] font-black uppercase opacity-50">Balance</p>
                    <p className={`text-xl font-black font-mono ${viewPO.balance > 0.01 ? 'text-rose-500' : 'text-emerald-500'}`}>${viewPO.balance.toFixed(2)}</p>
                  </div>
                </div>
                <span className={`px-3 py-1.5 rounded-lg text-xs font-black uppercase ${viewPO.balance <= 0.01 ? 'bg-emerald-500 text-white' : 'bg-amber-500 text-white'}`}>
                  {viewPO.balance <= 0.01 ? 'Fully Paid' : 'Outstanding'}
                </span>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}