import React from 'react';
import Fuse from 'fuse.js';
import { 
  Search, ShoppingCart, User, CreditCard, Banknote, Package, History, 
  Plus, Minus, Trash2, Barcode, ArrowRight, Settings, DollarSign, Sun, 
  Moon, Percent, Tag, Printer, CheckCircle2, LayoutDashboard, BarChart3, 
  Calendar, X, RotateCcw, Shield, AlertTriangle, RefreshCw, Clock
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Link } from 'react-router-dom';
import { usePosContext } from '../context/PosContext';
import { CURRENCIES } from '../hooks/usePos';

export default function PaymentModal() {
  const pos = usePosContext();
  const { 
  products, setProducts, cart, setCart, stakeholders, setStakeholders, selectedStakeholder, setSelectedStakeholder, 
  barcodeInput, setBarcodeInput, isProcessing, setIsProcessing, recentTransactions, setRecentTransactions, 
  currencies = CURRENCIES, selectedCurrency, setSelectedCurrency, showCheckout, setShowCheckout, payments, setPayments,
  paymentAmount, setPaymentAmount, paymentMethod, setPaymentMethod, paymentCurrency, setPaymentCurrency,
  showAddCustomerModal, setShowAddCustomerModal, newCustomerForm, setNewCustomerForm, isPriceChecker, 
  setIsPriceChecker, globalDiscount, setGlobalDiscount, lastTransaction, setLastTransaction, searchTerm, 
  setSearchTerm, selectedCategory, setSelectedCategory, suggestions, setSuggestions, currentPage, 
  setCurrentPage, language, setLanguage, customerSearchTerm, setCustomerSearchTerm, showCustomerDropdown, 
  setShowCustomerDropdown, showDailyHistory, setShowDailyHistory, dailyTransactions, setDailyTransactions, 
  historyDate, setHistoryDate, loadingHistory, setLoadingHistory, selectedHistoryTransaction, 
  setSelectedHistoryTransaction, showRefundModal, setShowRefundModal, refundQuantities, setRefundQuantities, 
  tenant, showUpdateModal, setShowUpdateModal, updateVersion, setUpdateVersion, isUpdating, setIsUpdating, 
  users, currentUser, setCurrentUser, handleLogout, handleInstallUpdate, scheduleForm, setScheduleForm, handleScheduleUpdate, 
  fetchSettings, fetchDailyHistory, handleRefund, fetchData, addToCart, handleBarcodeSubmit, 
  handleSuggestionClick, updateQuantity, applyItemDiscount, calculateItemTotal, handleCreateCustomer, 
  handleCheckout, handleQuickCash, printReceipt, subtotalUSD, subtotalLBP, totalUSD, totalLBP, 
  totalSelected, categories, filteredProducts, totalPages, paginatedProducts, t, socketRef, 
  barcodeRef, customerDropdownRef, localExpired, showDebtModal, setShowDebtModal, handleReceiveDebt,
  terminalId
  } = pos as any;

  // Format a transaction display ID as e.g. 'POS1-0024', falling back to '#id' for legacy records
  const formatTxId = (tx: any) =>
    tx.terminal_id && tx.terminal_sequence
      ? `${tx.terminal_id}-${String(tx.terminal_sequence).padStart(4, '0')}`
      : `#${tx.id}`;
return (<>
<AnimatePresence>
        {showAddCustomerModal && (
          <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowAddCustomerModal(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-app-surface w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl border border-app-border"
            >
              <div className="p-6 border-b border-app-border bg-app-bg/30">
                <h2 className="text-xl font-black tracking-tighter uppercase">Quick Add Customer</h2>
              </div>
              <form onSubmit={handleCreateCustomer} className="p-6 space-y-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold uppercase opacity-50 ml-1">Full Name</label>
                  <input 
                    autoFocus
                    required
                    type="text" 
                    className="w-full px-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all"
                    value={newCustomerForm.name}
                    onChange={e => setNewCustomerForm({ ...newCustomerForm, name: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold uppercase opacity-50 ml-1">Phone Number</label>
                  <input 
                    type="text" 
                    className="w-full px-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all"
                    value={newCustomerForm.phone}
                    onChange={e => setNewCustomerForm({ ...newCustomerForm, phone: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold uppercase opacity-50 ml-1">Email (Optional)</label>
                  <input 
                    type="email" 
                    className="w-full px-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all"
                    value={newCustomerForm.email}
                    onChange={e => setNewCustomerForm({ ...newCustomerForm, email: e.target.value })}
                  />
                </div>
                <div className="flex gap-3 pt-2">
                  <button 
                    type="button"
                    onClick={() => setShowAddCustomerModal(false)}
                    className="flex-1 py-3 border-2 border-app-border rounded-xl font-bold uppercase tracking-widest text-[10px] hover:bg-app-bg transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    disabled={isProcessing}
                    type="submit"
                    className="flex-2 py-3 bg-app-ink text-app-bg rounded-xl font-bold uppercase tracking-widest text-[10px] hover:opacity-90 transition-all disabled:opacity-50"
                  >
                    {isProcessing ? 'Saving...' : 'Save Customer'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Price Checker Overlay */}
      <AnimatePresence>
        {isPriceChecker && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-app-ink text-app-bg flex flex-col items-center justify-center p-12"
          >
            <button 
              onClick={() => setIsPriceChecker(false)}
              className="absolute top-8 right-8 text-app-bg/50 hover:text-app-bg"
            >
              Close (Esc)
            </button>
            
            <div className="text-center space-y-8 w-full max-w-4xl relative">
              <h2 className="text-2xl font-bold tracking-widest uppercase opacity-50">Scan Barcode or Search Name</h2>
              
              <div className="relative">
                <form onSubmit={handleBarcodeSubmit} className="relative">
                  <input
                    autoFocus
                    type="text"
                    className="w-full bg-transparent border-b-4 border-app-bg/20 focus:border-app-bg transition-all outline-none text-8xl font-bold text-center py-8 tracking-tighter"
                    value={barcodeInput}
                    onChange={(e) => {
                      const val = e.target.value;
                      setBarcodeInput(val);
                      if (val.length > 1) {
                        const fuse = new Fuse(products, {
                          keys: ['name', 'barcode', 'barcodes'],
                          threshold: 0.3,
                        });
                        setSuggestions(fuse.search(val).map(r => r.item).slice(0, 5));
                      } else {
                        setSuggestions([]);
                      }
                    }}
                  />
                </form>

                {/* Price Checker Suggestions */}
                <AnimatePresence>
                  {suggestions.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="absolute left-0 right-0 top-full mt-4 bg-app-surface text-app-ink rounded-2xl shadow-2xl overflow-hidden z-50"
                    >
                      {suggestions.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => handleSuggestionClick(p)}
                          className="w-full flex items-center justify-between p-6 hover:bg-app-ink hover:text-app-bg transition-colors text-left border-b border-app-border/10 last:border-none"
                        >
                          <div className="text-2xl font-bold">{p.name}</div>
                          <div className="text-right">
                            <div className="text-3xl font-mono font-black">${(p.price || 0).toFixed(2)}</div>
                            <div className="text-xl font-mono font-bold text-emerald-600">{(p.price_lbp || Math.round((p.price || 0) * 89500)).toLocaleString()} LL</div>
                          </div>
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {cart.length > 0 && (
                <motion.div 
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  className="bg-app-surface text-app-ink p-12 rounded-3xl shadow-2xl"
                >
                  <h3 className="text-4xl font-bold mb-2">{cart[cart.length-1].name}</h3>
                  <p className="text-xl opacity-50 mb-8 font-mono">{cart[cart.length-1].barcode}</p>
                  <div className="flex flex-col items-center">
                    <div className="text-9xl font-black tracking-tighter">
                      ${(cart[cart.length-1].price || 0).toFixed(2)}
                    </div>
                    <div className="text-6xl font-black text-emerald-600 tracking-tighter mt-4">
                      {(cart[cart.length-1].price_lbp || Math.round((cart[cart.length-1].price || 0) * 89500)).toLocaleString()} LL
                    </div>
                  </div>
                  <div className="mt-8 flex justify-center gap-8 text-2xl font-mono opacity-50">
                    <span>€ {((cart[cart.length-1].price || 0) * 0.92).toFixed(2)}</span>
                  </div>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Daily History Overlay */}
      <AnimatePresence>
        {showDailyHistory && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-8">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowDailyHistory(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-md"
            />
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="relative bg-app-surface w-full max-w-5xl h-[80vh] rounded-3xl overflow-hidden shadow-2xl border border-app-border flex flex-col"
            >
              <div className="p-8 border-b border-app-border flex justify-between items-center bg-app-bg/30">
                <div>
                  <h2 className="text-3xl font-black tracking-tighter uppercase">Daily Order History</h2>
                  <p className="text-sm opacity-50 font-medium">Review transactions and re-print receipts.</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="relative">
                    <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 opacity-40" size={16} />
                    <input 
                      type="date" 
                      className="pl-10 pr-4 py-2 bg-app-surface border border-app-border rounded-xl font-bold text-sm outline-none focus:border-app-ink transition-all"
                      value={historyDate}
                      onChange={(e) => setHistoryDate(e.target.value)}
                    />
                  </div>
                  <button 
                    onClick={() => setShowDailyHistory(false)}
                    className="p-3 hover:bg-app-ink hover:text-app-bg rounded-full transition-all"
                  >
                    <X size={24} />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-8">
                <div className="bg-app-bg/30 rounded-2xl border border-app-border overflow-hidden">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-app-ink text-app-bg text-[10px] uppercase tracking-widest font-black">
                        <th className="p-4">ID</th>
                        <th className="p-4">Time</th>
                        <th className="p-4">Customer</th>
                        <th className="p-4">User</th>
                        <th className="p-4 text-right">Total</th>
                        <th className="p-4 text-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm">
                      {loadingHistory ? (
                        <tr>
                          <td colSpan={6} className="p-12 text-center opacity-50 italic">Loading history...</td>
                        </tr>
                      ) : dailyTransactions.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="p-12 text-center opacity-50 italic">No transactions found for this date.</td>
                        </tr>
                      ) : (
                        dailyTransactions.map(tr => (
                          <tr 
                            key={tr.id} 
                            onClick={() => setSelectedHistoryTransaction(tr)}
                            className={`border-b border-app-border/5 hover:bg-app-ink/5 transition-colors cursor-pointer ${selectedHistoryTransaction?.id === tr.id ? 'bg-app-ink/10' : ''}`}
                          >
                            <td className="p-4 font-mono font-bold">{formatTxId(tr)}</td>
                            <td className="p-4 opacity-50">{new Date(tr.created_at).toLocaleTimeString()}</td>
                            <td className="p-4 font-bold">{tr.stakeholder_name || 'Walk-in'}</td>
                            <td className="p-4 font-medium">{tr.user_name || 'System'}</td>
                            <td className="p-4 text-right font-mono font-black">${tr.total_amount.toFixed(2)}</td>
                            <td className="p-4 text-center">
                              <span className={`px-2 py-1 rounded text-[8px] font-black uppercase tracking-widest ${
                                tr.type === 'refund' ? 'bg-red-500 text-white' : 
                                tr.type === 'purchase' ? 'bg-blue-500 text-white' : 'bg-emerald-500 text-white'
                              }`}>
                                {tr.type}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="p-8 border-t border-app-border bg-app-bg/30 flex justify-between items-center">
                <div className="flex gap-4">
                  <div className="text-sm font-bold opacity-50 uppercase tracking-widest">
                    Total Transactions: {dailyTransactions.length}
                  </div>
                  {selectedHistoryTransaction && (
                    <div className="flex gap-2">
                      <button 
                        onClick={async () => {
                          try {
                            const res = await fetch(`/api/transactions/${selectedHistoryTransaction.id}`);
                            if (res.ok) {
                              const fullTransaction = await res.json();
                              printReceipt(fullTransaction);
                            }
                          } catch (err) {
                            console.error(err);
                          }
                        }}
                        className="px-4 py-2 bg-app-ink text-app-bg rounded-xl font-bold uppercase text-[10px] tracking-widest flex items-center gap-2 hover:opacity-90 transition-all"
                      >
                        <Printer size={14} /> Print Receipt
                      </button>
                      {selectedHistoryTransaction.type === 'sale' && (
                        <button 
                          onClick={async () => {
                            const res = await fetch(`/api/transactions/${selectedHistoryTransaction.id}`);
                            if (res.ok) {
                              const full = await res.json();
                              setSelectedHistoryTransaction(full);
                              const initialRefunds: Record<number, number> = {};
                              full.items.forEach((item: any) => initialRefunds[item.id] = 0);
                              setRefundQuantities(initialRefunds);
                              setShowRefundModal(true);
                            }
                          }}
                          className="px-4 py-2 bg-red-600 text-white rounded-xl font-bold uppercase text-[10px] tracking-widest flex items-center gap-2 hover:bg-red-700 transition-all"
                        >
                          <RotateCcw size={14} /> Refund
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="text-2xl font-black font-mono">
                  Total: ${dailyTransactions.reduce((sum, t) => sum + (t.type === 'refund' || t.type === 'purchase' ? -t.total_amount : t.total_amount), 0).toFixed(2)}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Refund Modal */}
      <AnimatePresence>
        {showRefundModal && selectedHistoryTransaction && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowRefundModal(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-app-surface w-full max-w-2xl rounded-3xl overflow-hidden shadow-2xl border border-app-border flex flex-col max-h-[90vh]"
            >
              <div className="p-6 border-b border-app-border bg-app-bg/30">
                <h2 className="text-2xl font-black tracking-tighter uppercase">Process Refund</h2>
                <p className="text-sm opacity-50">Select items and quantities to return for Transaction #{selectedHistoryTransaction.id}</p>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                {selectedHistoryTransaction.items.map((item: any) => (
                  <div key={item.id} className="flex items-center justify-between p-4 bg-app-bg/30 rounded-2xl border border-app-border/10">
                    <div className="flex-1">
                      <h4 className="font-bold">{item.product_name || item.name || 'Product'}</h4>
                      <p className="text-xs opacity-50 font-mono">Purchased: {item.quantity} @ ${item.unit_price.toFixed(2)}</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="flex items-center border border-app-border rounded-xl overflow-hidden bg-app-surface">
                        <button 
                          onClick={() => setRefundQuantities(prev => ({ ...prev, [item.id]: Math.max(0, (prev[item.id] || 0) - 1) }))}
                          className="p-2 hover:bg-app-ink hover:text-app-bg transition-colors"
                        >
                          <Minus size={14} />
                        </button>
                        <span className="w-12 text-center font-mono font-bold">{refundQuantities[item.id] || 0}</span>
                        <button 
                          onClick={() => setRefundQuantities(prev => ({ ...prev, [item.id]: Math.min(item.quantity, (prev[item.id] || 0) + 1) }))}
                          className="p-2 hover:bg-app-ink hover:text-app-bg transition-colors"
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                      <div className="w-24 text-right font-mono font-bold text-red-500">
                        -${(() => {
                          const qty = refundQuantities[item.id] || 0;
                          let price = item.unit_price * qty;
                          if (item.discount_type === 'percentage') {
                            price -= (price * (item.discount_value || 0)) / 100;
                          } else if (item.discount_type === 'fixed') {
                            price -= (item.discount_value || 0) * (qty / item.quantity);
                          }
                          return price.toFixed(2);
                        })()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="p-6 border-t border-app-border bg-app-bg/30 flex flex-col gap-4">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-bold opacity-50 uppercase">Total Refund Amount</span>
                  <span className="text-3xl font-black font-mono text-red-500">
                    -${selectedHistoryTransaction.items.reduce((sum: number, item: any) => {
                      const qty = refundQuantities[item.id] || 0;
                      let price = item.unit_price * qty;
                      if (item.discount_type === 'percentage') {
                        price -= (price * (item.discount_value || 0)) / 100;
                      } else if (item.discount_type === 'fixed') {
                        price -= (item.discount_value || 0) * (qty / item.quantity);
                      }
                      return sum + price;
                    }, 0).toFixed(2)}
                  </span>
                </div>
                <div className="flex gap-3">
                  <button 
                    onClick={() => setShowRefundModal(false)}
                    className="flex-1 py-4 border-2 border-app-border rounded-2xl font-bold uppercase tracking-widest text-xs hover:bg-app-bg transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleRefund}
                    disabled={isProcessing || Object.values(refundQuantities).every(q => q === 0)}
                    className="flex-2 py-4 bg-red-600 text-white rounded-2xl font-bold uppercase tracking-widest text-xs hover:bg-red-700 transition-all disabled:opacity-20 flex items-center justify-center gap-2"
                  >
                    {isProcessing ? 'Processing...' : 'Confirm Refund'} <RotateCcw size={16} />
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Checkout Modal */}
      <AnimatePresence>
        {showCheckout && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowCheckout(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-app-surface w-full max-w-md rounded-2xl overflow-hidden shadow-2xl border border-app-border flex flex-col max-h-[90vh]"
            >
              <div className="p-6 border-b border-app-border flex-shrink-0">
                <h2 className="text-2xl font-bold tracking-tighter uppercase">
                  {lastTransaction ? 'Transaction Success' : 'Finalize Payment'}
                </h2>
                <p className="text-sm opacity-50">
                  {lastTransaction ? `Transaction #${lastTransaction.id} completed` : `Select payment method for $${totalUSD.toFixed(2)}`}
                </p>
              </div>
              
              <div className="p-6 space-y-4 overflow-y-auto flex-1">
                {lastTransaction ? (
                  <div className="space-y-6">
                    <div className="flex flex-col items-center justify-center py-8 text-emerald-500">
                      <CheckCircle2 size={64} />
                      <p className="mt-4 font-bold uppercase tracking-widest">Payment Received</p>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <button
                        onClick={() => printReceipt(lastTransaction)}
                        className="flex items-center justify-center gap-2 p-4 bg-app-ink text-app-bg rounded-xl font-bold uppercase text-xs hover:opacity-90 transition-all"
                      >
                        <Printer size={18} /> Print Receipt
                      </button>
                      <button
                        onClick={() => {
                          setLastTransaction(null);
                          setShowCheckout(false);
                        }}
                        className="flex items-center justify-center gap-2 p-4 border-2 border-app-border rounded-xl font-bold uppercase text-xs hover:bg-app-bg transition-all"
                      >
                        New Sale
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="space-y-4">
                      <div className="p-4 bg-app-bg rounded-xl flex justify-between items-center">
                        <span className="text-xs font-bold opacity-50 uppercase tracking-widest">Total Due</span>
                        <span className="text-2xl font-black font-mono">${totalUSD.toFixed(2)}</span>
                      </div>

                      {/* Current Payments */}
                      {payments.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-[10px] font-black uppercase tracking-widest opacity-30">Payments Added</p>
                          {payments.map((p, idx) => (
                            <div key={idx} className="flex justify-between items-center p-3 bg-app-bg/50 rounded-xl border border-app-border">
                              <div className="flex items-center gap-2">
                                {p.method === 'cash' ? <Banknote size={14} /> : <CreditCard size={14} />}
                                <span className="text-xs font-bold">{p.method.toUpperCase()}</span>
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="font-mono text-xs font-bold">{p.amount.toLocaleString()} {p.currency}</span>
                                <button 
                                  onClick={() => setPayments(prev => prev.filter((_, i) => i !== idx))}
                                  className="p-1 hover:bg-rose-500 hover:text-white rounded transition-colors"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Remaining Balance / Overpayment */}
                      {(() => {
                        const paidUSD = payments.reduce((sum, p) => sum + (p.amount / p.exchange_rate), 0);
                        const remainingUSD = totalUSD - paidUSD;
                        const overpaidUSD = paidUSD - totalUSD;
                        const isFullyPaid = remainingUSD <= 0.01;
                        const isWalkIn = selectedStakeholder === 1;

                        return (
                          <div className="space-y-4">
                            {!isFullyPaid && (
                              <div className="p-6 bg-app-surface border-2 border-app-ink rounded-2xl space-y-4 shadow-xl">
                                <div className="flex justify-between items-center">
                                  <span className="text-xs font-black uppercase tracking-widest">Remaining</span>
                                  <span className="text-xl font-black font-mono text-rose-500">${remainingUSD.toFixed(2)}</span>
                                </div>

                                <div className="grid grid-cols-3 gap-2">
                                  <button
                                    onClick={() => setPaymentMethod('cash')}
                                    className={`py-2 rounded-lg text-[10px] font-black uppercase border transition-all ${paymentMethod === 'cash' ? 'bg-app-ink text-app-bg border-app-ink' : 'opacity-50 border-app-border'}`}
                                  >
                                    Cash
                                  </button>
                                  <button
                                    onClick={() => setPaymentMethod('card')}
                                    className={`py-2 rounded-lg text-[10px] font-black uppercase border transition-all ${paymentMethod === 'card' ? 'bg-app-ink text-app-bg border-app-ink' : 'opacity-50 border-app-border'}`}
                                  >
                                    Card
                                  </button>
                                  <div className="relative group/credit">
                                    <button
                                      disabled={isWalkIn}
                                      onClick={() => setPaymentMethod('credit')}
                                      className={`w-full py-2 rounded-lg text-[10px] font-black uppercase border transition-all ${paymentMethod === 'credit' ? 'bg-app-ink text-app-bg border-app-ink' : 'opacity-50 border-app-border'} ${isWalkIn ? 'opacity-10 cursor-not-allowed' : ''}`}
                                    >
                                      Credit
                                    </button>
                                    {isWalkIn && (
                                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-app-ink text-app-bg text-[8px] font-bold rounded whitespace-nowrap z-50 opacity-0 group-hover/credit:opacity-100 transition-opacity pointer-events-none">
                                        Select a customer first
                                      </div>
                                    )}
                                  </div>
                                </div>

                                <div className="grid grid-cols-3 gap-2">
                                  {currencies.map((c: any) => (
                                    <button
                                      key={c.code}
                                      onClick={() => setPaymentCurrency(c)}
                                      className={`py-2 rounded-lg text-[10px] font-black uppercase border transition-all ${paymentCurrency.code === c.code ? 'bg-app-ink text-app-bg border-app-ink' : 'opacity-50 border-app-border'}`}
                                    >
                                      {c.code}
                                    </button>
                                  ))}
                                </div>

                                <div className="relative">
                                  <input
                                    type="number"
                                    placeholder={`Amount in ${paymentCurrency.code}`}
                                    className="w-full p-4 bg-app-bg border border-app-border rounded-xl font-mono text-xl outline-none focus:border-app-ink transition-all"
                                    value={paymentAmount}
                                    onChange={(e) => setPaymentAmount(e.target.value)}
                                  />
                                  <button
                                    onClick={() => {
                                      const amt = parseFloat(paymentAmount);
                                      if (amt > 0) {
                                        setPayments(prev => [...prev, {
                                          amount: amt,
                                          method: paymentMethod,
                                          currency: paymentCurrency.code,
                                          exchange_rate: paymentCurrency.rate
                                        }]);
                                        setPaymentAmount('');
                                      }
                                    }}
                                    className="absolute right-2 top-2 bottom-2 px-4 bg-app-ink text-app-bg rounded-lg font-black uppercase text-[10px] tracking-widest"
                                  >
                                    Add
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* Overpayment / Credit to Balance Section */}
                            {isFullyPaid && overpaidUSD > 0.01 && (() => {
                              const buildTrimmedPayments = () => {
                                let remaining = totalUSD;
                                const trimmed: any[] = [];
                                for (const p of payments) {
                                  const pUSD = p.amount / p.exchange_rate;
                                  if (p.method === 'credit') continue;
                                  if (remaining <= 0) break;
                                  if (pUSD <= remaining) {
                                    trimmed.push(p);
                                    remaining -= pUSD;
                                  } else {
                                    trimmed.push({ ...p, amount: remaining * p.exchange_rate });
                                    remaining = 0;
                                  }
                                }
                                return trimmed;
                              };
                              return (
                                <div className="p-4 bg-emerald-500/10 border-2 border-emerald-500/30 rounded-2xl space-y-3">
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-black uppercase tracking-widest text-emerald-600">Change Due</span>
                                    <span className="text-xl font-black font-mono text-emerald-600">+${overpaidUSD.toFixed(2)}</span>
                                  </div>
                                  {isWalkIn ? (
                                    <div className="space-y-2">
                                      <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-center">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-amber-600">Walk-in — Credit Not Available</p>
                                        <p className="text-xs opacity-70 mt-1">Select a registered customer to credit their account.</p>
                                      </div>
                                      <button onClick={() => handleCheckout(buildTrimmedPayments())} disabled={isProcessing}
                                        className="w-full py-3 bg-emerald-500 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-600 transition-all disabled:opacity-50">
                                        {isProcessing ? 'Processing...' : `Complete & Give Change $${overpaidUSD.toFixed(2)}`}
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="space-y-2">
                                      <p className="text-[10px] font-bold uppercase opacity-60">How to handle overpayment?</p>
                                      <div className="grid grid-cols-2 gap-2">
                                        <button onClick={() => handleCheckout(payments)} disabled={isProcessing}
                                          className="py-3 bg-emerald-500 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-600 transition-all disabled:opacity-50 flex flex-col items-center gap-1">
                                          <span>Credit Balance</span>
                                          <span className="opacity-70 text-[8px]">+${overpaidUSD.toFixed(2)} to account</span>
                                        </button>
                                        <button onClick={() => handleCheckout(buildTrimmedPayments())} disabled={isProcessing}
                                          className="py-3 border-2 border-app-border rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-app-bg transition-all disabled:opacity-50 flex flex-col items-center gap-1">
                                          <span>Give as Change</span>
                                          <span className="opacity-70 text-[8px]">Return ${overpaidUSD.toFixed(2)}</span>
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}

                            {(!isFullyPaid || (isFullyPaid && overpaidUSD <= 0.01)) && (
                              <button
                                disabled={!isFullyPaid || isProcessing}
                                onClick={() => handleCheckout(payments)}
                                className={`w-full py-5 rounded-2xl font-black uppercase tracking-widest text-lg shadow-2xl transition-all active:scale-95 ${isFullyPaid ? 'bg-emerald-500 text-white hover:bg-emerald-600' : 'bg-app-bg text-app-ink opacity-20 cursor-not-allowed'}`}
                              >
                                {isProcessing ? 'Processing...' : isFullyPaid ? 'Complete Transaction' : 'Balance Remaining'}
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    <button
                      onClick={() => {
                        setShowCheckout(false);
                        setPayments([]);
                      }}
                      className="w-full py-3 text-xs font-black uppercase tracking-widest opacity-30 hover:opacity-100 transition-opacity"
                    >
                      Cancel Sale
                    </button>
                  </>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      
      {/* Debt Modal */}
      <AnimatePresence>
        {showDebtModal && (
          <div className="fixed inset-0 z-[160] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !isProcessing && setShowDebtModal(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-app-surface w-full max-w-sm rounded-2xl overflow-hidden shadow-2xl border border-app-border"
            >
              <div className="p-6 border-b border-app-border bg-app-bg/30">
                <h2 className="text-xl font-black tracking-tighter uppercase">Receive Debt Payment</h2>
                <p className="text-xs opacity-50 font-bold mt-1">Customer: {stakeholders.find((s: any) => s.id === selectedStakeholder)?.name}</p>
                <div className="mt-4 p-4 bg-red-500/10 text-red-500 rounded-xl border border-red-500/20 text-center">
                  <span className="text-[10px] font-black uppercase tracking-widest block mb-1">Current Balance</span>
                  <span className="text-3xl font-mono font-black">${Math.abs(stakeholders.find((s: any) => s.id === selectedStakeholder)?.balance || 0).toFixed(2)}</span>
                </div>
              </div>
              <div className="p-6 space-y-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold uppercase opacity-50 ml-1">Payment Amount</label>
                  <input 
                    autoFocus
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="Enter amount..."
                    className="w-full px-4 py-3 bg-app-bg border border-app-border rounded-xl outline-none focus:border-app-ink transition-all font-mono text-xl"
                    value={paymentAmount}
                    onChange={e => setPaymentAmount(e.target.value)}
                  />
                </div>
                
                <div className="grid grid-cols-2 gap-2 mt-4">
                  <button
                    onClick={() => setPaymentMethod('cash')}
                    className={`py-3 rounded-xl text-xs font-black uppercase border transition-all ${paymentMethod === 'cash' ? 'bg-app-ink text-app-bg border-app-ink' : 'opacity-50 border-app-border hover:opacity-100 px-2'}`}
                  >
                    Cash
                  </button>
                  <button
                    onClick={() => setPaymentMethod('card')}
                    className={`py-3 rounded-xl text-xs font-black uppercase border transition-all ${paymentMethod === 'card' ? 'bg-app-ink text-app-bg border-app-ink' : 'opacity-50 border-app-border hover:opacity-100 px-2'}`}
                  >
                    Card
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-2 mt-2">
                  {currencies.map((c: any) => (
                    <button
                      key={c.code}
                      onClick={() => setPaymentCurrency(c)}
                      className={`py-2 rounded-lg text-[10px] font-black uppercase border transition-all ${paymentCurrency.code === c.code ? 'bg-app-ink text-app-bg border-app-ink' : 'opacity-50 border-app-border'}`}
                    >
                      {c.code}
                    </button>
                  ))}
                </div>

                <div className="flex gap-3 pt-4">
                  <button 
                    onClick={() => {
                      setShowDebtModal(false);
                      setPaymentAmount('');
                    }}
                    className="flex-1 py-3 border-2 border-app-border rounded-xl font-bold uppercase tracking-widest text-[10px] hover:bg-app-bg transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    disabled={isProcessing || !paymentAmount || parseFloat(paymentAmount) <= 0}
                    onClick={() => {
                      handleReceiveDebt(parseFloat(paymentAmount), paymentMethod, paymentCurrency);
                      setPaymentAmount('');
                    }}
                    className="flex-2 py-3 bg-emerald-500 text-white rounded-xl font-bold uppercase tracking-widest text-[10px] hover:opacity-90 transition-all disabled:opacity-50"
                  >
                    {isProcessing ? 'Processing' : 'Receive'}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Update Modal */}
      <AnimatePresence>
        {showUpdateModal && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-app-ink/80 backdrop-blur-sm"
              onClick={() => !isUpdating && setShowUpdateModal(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-app-surface border border-app-border rounded-3xl overflow-hidden shadow-2xl"
            >
              <div className="p-8 text-center space-y-6">
                <div className="w-20 h-20 bg-app-ink text-app-bg rounded-full flex items-center justify-center mx-auto">
                  <RefreshCw size={40} className={isUpdating ? 'animate-spin' : ''} />
                </div>
                
                <div className="space-y-2">
                  <h2 className="text-2xl font-black uppercase tracking-tight">Update Available</h2>
                  <p className="opacity-50 text-sm">A new version of OmniPOS ({updateVersion}) is ready to be installed. Your current version is {tenant?.current_version}.</p>
                </div>

                {isUpdating ? (
                  <div className="py-4 space-y-4">
                    <div className="h-2 w-full bg-app-bg rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: '100%' }}
                        transition={{ duration: 2 }}
                        className="h-full bg-app-ink"
                      />
                    </div>
                    <p className="text-[10px] font-black uppercase tracking-widest animate-pulse">Installing updates... Please wait</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <button 
                      onClick={handleInstallUpdate}
                      className="w-full py-4 bg-app-ink text-app-bg rounded-xl font-black uppercase tracking-widest hover:opacity-90 transition-all flex items-center justify-center gap-2"
                    >
                      Install Now <ArrowRight size={18} />
                    </button>
                    
                    <div className="p-6 bg-app-bg rounded-2xl border border-app-border/10 space-y-4">
                      <div className="flex items-center gap-2 text-[10px] font-black uppercase opacity-40">
                        <Clock size={14} /> Schedule for later
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input 
                          type="date" 
                          className="bg-app-surface border border-app-border rounded-lg p-2 text-xs outline-none focus:border-app-ink transition-all"
                          value={scheduleForm.date}
                          onChange={e => setScheduleForm({...scheduleForm, date: e.target.value})}
                        />
                        <input 
                          type="time" 
                          className="bg-app-surface border border-app-border rounded-lg p-2 text-xs outline-none focus:border-app-ink transition-all"
                          value={scheduleForm.time}
                          onChange={e => setScheduleForm({...scheduleForm, time: e.target.value})}
                        />
                      </div>
                      <button 
                        onClick={handleScheduleUpdate}
                        className="w-full py-2 border border-app-border rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-app-ink hover:text-app-bg transition-all"
                      >
                        Confirm Schedule
                      </button>
                    </div>

                    <button 
                      onClick={() => setShowUpdateModal(false)}
                      className="text-[10px] font-black uppercase tracking-widest opacity-30 hover:opacity-100 transition-opacity"
                    >
                      Remind me later
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Footer Status */}
      <footer className="bg-app-ink text-app-bg p-2 px-4 flex justify-between items-center text-[10px] uppercase tracking-widest font-bold transition-colors duration-300">
        <div className="flex gap-4">
          <span className="flex items-center gap-1"><div className="w-1.5 h-1.5 rounded-full bg-green-500"></div> Database Online</span>
          <span className="opacity-50">Terminal: {terminalId}</span>
        </div>
        <div className="flex gap-4">
          <span className="opacity-50">User: Admin</span>
          <span>{new Date().toLocaleDateString()}</span>
        </div>
      </footer>
    
</>);
}