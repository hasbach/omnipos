import React, { useState, useEffect, useMemo } from 'react';
import { Search, Plus, Minus, Trash2, ShoppingCart, Banknote, CreditCard, CheckCircle2, User } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { supabase } from '../lib/supabase';
import { Tenant } from '../types';

// Minimal emergency fallback for when the local register is unreachable.
// Deliberately out of scope: purchases, receipt printing, product create/edit/delete,
// per-item discounts, tax, and split payments — just cash-or-credit sales.

interface OnlineProduct {
  global_id: string;
  name: string;
  barcode: string | null;
  price: number;
  package_price: number | null;
  units_per_package: number | null;
  stock: number;
  track_inventory: number | null;
  category: string | null;
}

interface OnlineStakeholder {
  global_id: string;
  name: string;
  type: string;
  balance: number;
}

interface OnlineUser {
  global_id: string;
  name: string;
}

interface CartLine extends OnlineProduct {
  quantity: number;
}

function lineTotal(item: CartLine): number {
  if (item.package_price && item.units_per_package && item.units_per_package > 1) {
    const numPackages = Math.floor(item.quantity / item.units_per_package);
    const remainder = item.quantity % item.units_per_package;
    return numPackages * item.package_price + remainder * item.price;
  }
  return item.price * item.quantity;
}

export default function OnlineSale({ tenant }: { tenant: Tenant }) {
  const [products, setProducts] = useState<OnlineProduct[]>([]);
  const [stakeholders, setStakeholders] = useState<OnlineStakeholder[]>([]);
  const [users, setUsers] = useState<OnlineUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [selectedStakeholderId, setSelectedStakeholderId] = useState<string>('');
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [method, setMethod] = useState<'cash' | 'credit'>('cash');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');
  const [successTotal, setSuccessTotal] = useState<number | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const [{ data: productsData }, { data: stakeholdersData }, { data: usersData }] = await Promise.all([
        supabase.from('products').select('global_id, name, barcode, price, package_price, units_per_package, stock, track_inventory, category')
          .eq('tenant_id', (tenant as any).global_id).is('deleted_at', null),
        supabase.from('stakeholders').select('global_id, name, type, balance')
          .eq('tenant_id', (tenant as any).global_id).eq('type', 'customer').is('deleted_at', null),
        supabase.from('users').select('global_id, name')
          .eq('tenant_id', (tenant as any).global_id).is('deleted_at', null),
      ]);

      setProducts(productsData || []);
      setStakeholders(stakeholdersData || []);
      setUsers(usersData || []);

      const walkIn = (stakeholdersData || []).find((s: OnlineStakeholder) => s.name === 'Walk-in Customer');
      setSelectedStakeholderId(walkIn?.global_id || (stakeholdersData || [])[0]?.global_id || '');

      setLoading(false);
    };
    load();
  }, [(tenant as any).global_id]);

  const filteredProducts = useMemo(() => {
    if (!searchTerm) return products;
    const term = searchTerm.toLowerCase();
    return products.filter(p => p.name.toLowerCase().includes(term) || (p.barcode || '').includes(term));
  }, [products, searchTerm]);

  const total = useMemo(() => cart.reduce((sum, item) => sum + lineTotal(item), 0), [cart]);

  const addToCart = (product: OnlineProduct) => {
    setCart(prev => {
      const existing = prev.find(i => i.global_id === product.global_id);
      if (existing) {
        return prev.map(i => i.global_id === product.global_id ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, { ...product, quantity: 1 }];
    });
  };

  const updateQuantity = (id: string, delta: number) => {
    setCart(prev => prev
      .map(i => i.global_id === id ? { ...i, quantity: i.quantity + delta } : i)
      .filter(i => i.quantity > 0));
  };

  const removeFromCart = (id: string) => {
    setCart(prev => prev.filter(i => i.global_id !== id));
  };

  const handleCompleteSale = async () => {
    if (cart.length === 0) return;
    if (method === 'credit' && !selectedStakeholderId) {
      setError('Select a customer for a credit sale.');
      return;
    }

    setIsProcessing(true);
    setError('');

    try {
      const { data, error: rpcError } = await supabase.rpc('record_online_sale', {
        p_items: cart.map(item => ({ product_id: item.global_id, quantity: item.quantity })),
        p_stakeholder_id: selectedStakeholderId || null,
        p_method: method,
        p_idempotency_key: idempotencyKey,
        p_user_id: selectedUserId || null,
      });

      if (rpcError) {
        setError(rpcError.message || 'Failed to record sale');
        return;
      }

      const result = Array.isArray(data) ? data[0] : data;
      setSuccessTotal(result?.total_amount ?? total);
      setCart([]);
      setIdempotencyKey(crypto.randomUUID());
    } catch (err: any) {
      setError(err.message || 'Network error connecting to cloud');
    } finally {
      setIsProcessing(false);
    }
  };

  if (loading) {
    return <div className="p-20 text-center opacity-30 font-black uppercase tracking-widest">Loading catalog...</div>;
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="p-4 bg-orange-500/10 border border-orange-500/20 rounded-2xl text-orange-600 text-sm font-bold text-center">
        Emergency mode — use this only when the local register is unreachable. Cash or credit sales only.
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Product picker */}
        <div className="lg:col-span-2 bg-app-surface border border-app-border rounded-[32px] overflow-hidden shadow-xl">
          <div className="p-6 border-b border-app-border">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 opacity-30" size={18} />
              <input
                type="text"
                placeholder="Search products..."
                className="w-full pl-12 pr-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
              />
            </div>
          </div>
          <div className="p-6 grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-[60vh] overflow-y-auto">
            {filteredProducts.map(p => (
              <button
                key={p.global_id}
                onClick={() => addToCart(p)}
                className="p-4 bg-app-bg border border-app-border/50 rounded-2xl text-left hover:border-app-ink transition-all"
              >
                <p className="font-bold text-sm truncate">{p.name}</p>
                <p className="text-xs opacity-50">${p.price.toFixed(2)}</p>
              </button>
            ))}
            {filteredProducts.length === 0 && (
              <p className="col-span-full text-center opacity-30 py-12 font-bold uppercase text-xs tracking-widest">No products found</p>
            )}
          </div>
        </div>

        {/* Cart + checkout */}
        <div className="bg-app-surface border border-app-border rounded-[32px] overflow-hidden shadow-xl flex flex-col">
          <div className="p-6 border-b border-app-border flex items-center gap-2">
            <ShoppingCart size={18} />
            <h3 className="font-black uppercase tracking-widest text-xs">Cart</h3>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-2 max-h-[40vh]">
            {cart.length === 0 ? (
              <p className="text-center opacity-30 py-12 font-bold uppercase text-xs tracking-widest">Cart is empty</p>
            ) : (
              cart.map(item => (
                <div key={item.global_id} className="p-3 bg-app-bg rounded-xl flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-sm truncate">{item.name}</p>
                    <p className="text-xs opacity-50">${lineTotal(item).toFixed(2)}</p>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button onClick={() => updateQuantity(item.global_id, -1)} className="p-1.5 bg-app-surface border border-app-border rounded-lg"><Minus size={12} /></button>
                    <span className="w-6 text-center text-sm font-bold">{item.quantity}</span>
                    <button onClick={() => updateQuantity(item.global_id, 1)} className="p-1.5 bg-app-surface border border-app-border rounded-lg"><Plus size={12} /></button>
                    <button onClick={() => removeFromCart(item.global_id)} className="p-1.5 text-red-500"><Trash2 size={14} /></button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="p-6 border-t border-app-border space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase opacity-50 flex items-center gap-1"><User size={12} /> Customer</label>
              <select
                className="w-full p-2.5 bg-app-bg border border-app-border rounded-lg text-sm outline-none"
                value={selectedStakeholderId}
                onChange={e => setSelectedStakeholderId(e.target.value)}
              >
                <option value="">Walk-in (no customer)</option>
                {stakeholders.map(s => (
                  <option key={s.global_id} value={s.global_id}>{s.name}</option>
                ))}
              </select>
            </div>

            {users.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase opacity-50">Staff (optional)</label>
                <select
                  className="w-full p-2.5 bg-app-bg border border-app-border rounded-lg text-sm outline-none"
                  value={selectedUserId}
                  onChange={e => setSelectedUserId(e.target.value)}
                >
                  <option value="">Unassigned</option>
                  {users.map(u => (
                    <option key={u.global_id} value={u.global_id}>{u.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setMethod('cash')}
                className={`p-3 rounded-xl font-black uppercase text-xs flex items-center justify-center gap-2 transition-all ${method === 'cash' ? 'bg-app-ink text-app-bg' : 'bg-app-bg border border-app-border'}`}
              >
                <Banknote size={14} /> Cash
              </button>
              <button
                onClick={() => setMethod('credit')}
                className={`p-3 rounded-xl font-black uppercase text-xs flex items-center justify-center gap-2 transition-all ${method === 'credit' ? 'bg-app-ink text-app-bg' : 'bg-app-bg border border-app-border'}`}
              >
                <CreditCard size={14} /> Credit
              </button>
            </div>

            <div className="flex items-center justify-between py-2">
              <span className="text-xs font-bold uppercase opacity-50">Total</span>
              <span className="text-2xl font-black font-mono">${total.toFixed(2)}</span>
            </div>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500 text-xs text-center">{error}</div>
            )}

            <button
              onClick={handleCompleteSale}
              disabled={cart.length === 0 || isProcessing}
              className="w-full py-4 bg-emerald-600 text-white rounded-xl font-black uppercase text-xs tracking-widest hover:opacity-90 transition-all disabled:opacity-40"
            >
              {isProcessing ? 'Recording...' : 'Complete Sale'}
            </button>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {successTotal !== null && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSuccessTotal(null)} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} className="relative bg-app-surface w-full max-w-sm rounded-2xl shadow-2xl border border-app-border p-8 text-center space-y-4">
              <CheckCircle2 size={56} className="mx-auto text-emerald-500" />
              <div>
                <p className="font-black uppercase tracking-widest">Sale Recorded</p>
                <p className="text-2xl font-black font-mono mt-1">${successTotal.toFixed(2)}</p>
              </div>
              <p className="text-xs opacity-50">Will sync to the register when it's back online.</p>
              <button onClick={() => setSuccessTotal(null)} className="w-full py-3 bg-app-ink text-app-bg rounded-xl font-black uppercase text-xs">Close</button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
