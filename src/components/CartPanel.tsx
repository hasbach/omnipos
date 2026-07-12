import React from 'react';
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
import Fuse from 'fuse.js';

export default function CartPanel() {
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
  handleSuggestionClick, updateQuantity, applyItemDiscount, calculateItemTotal, calculateItemTotalLBP, handleCreateCustomer,
  handleCheckout, handleQuickCash, printReceipt, subtotalUSD, subtotalLBP, totalUSD, totalLBP, 
  totalSelected, categories, filteredProducts, totalPages, paginatedProducts, t, socketRef, 
  barcodeRef, customerDropdownRef, localExpired 
  } = pos as any;
return (
<>
{/* Left Panel: Cart */}
        <div className="w-2/3 flex flex-col border-r border-app-border transition-colors duration-300">
          {/* Barcode Input Area */}
          <div className="p-4 border-b border-app-border bg-app-surface transition-colors duration-300 relative">
            <form onSubmit={handleBarcodeSubmit} className="relative">
              <Barcode className="absolute left-4 top-1/2 -translate-y-1/2 opacity-40" size={20} />
              <input
                ref={barcodeRef}
                type="text"
                placeholder={t?.search_placeholder || 'Scan or search...'}
                className="w-full pl-12 pr-4 py-4 bg-app-bg/50 border-2 border-transparent focus:border-app-border transition-all outline-none font-mono text-lg"
                value={barcodeInput}
                onChange={(e) => {
                  const val = e.target.value;
                  setBarcodeInput(val);
                  if (val.length > 1) {
                    const fuse = new Fuse(products, {
                      keys: ['name', 'barcode', 'barcodes'],
                      threshold: 0.3,
                    });
                    setSuggestions(fuse.search(val).map((r: any) => r.item).slice(0, 5));
                  } else {
                    setSuggestions([]);
                  }
                }}
                autoFocus
              />
            </form>

            {/* Suggestions Dropdown */}
            <AnimatePresence>
              {suggestions.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="absolute left-4 right-4 top-full mt-1 bg-app-surface border border-app-border shadow-2xl z-50 rounded-lg overflow-hidden"
                >
                  {suggestions.map((p: any) => (
                    <button
                      key={p.id}
                      onClick={() => handleSuggestionClick(p)}
                      className="w-full flex items-center justify-between p-4 hover:bg-app-ink hover:text-app-bg transition-colors text-left border-b border-app-border/5 last:border-none"
                    >
                      <div>
                        <div className="font-bold">{p.name}</div>
                        <div className="text-xs opacity-50 font-mono">{p.barcode}</div>
                      </div>
                      <div className="font-mono font-bold text-right">
                        <div>${(p.price || 0).toFixed(2)}</div>
                        <div className="text-[10px] text-emerald-600">{(p.price_lbp || Math.round((p.price || 0) * 89500)).toLocaleString()} LL</div>
                      </div>
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Cart Items */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            <AnimatePresence mode="popLayout">
              {cart.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center opacity-20 italic">
                  <Package size={64} strokeWidth={1} />
                  <p className="mt-4">Cart is empty</p>
                </div>
              ) : (
                cart.map((item: any) => (
                  <motion.div
                    key={item.id}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="flex items-center justify-between p-4 bg-app-surface border border-app-border/10 rounded-lg group hover:border-app-border transition-colors"
                  >
                    <div className="flex-1">
                      <h3 className="font-bold">{item.name}</h3>
                      <p className="text-xs opacity-50 font-mono">{item.barcode} • ${item.price.toFixed(2)}/unit</p>
                    </div>
                    
                    <div className="flex items-center gap-4">
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex items-center gap-1">
                          <button 
                            onClick={() => {
                              const val = prompt('Enter discount value:', item.discount?.value.toString() || '0');
                              if (val !== null) applyItemDiscount(item.id, item.discount?.type || 'percentage', parseFloat(val));
                            }}
                            className={`p-1 rounded text-[10px] font-bold border ${item.discount?.value ? 'bg-orange-500 text-white border-orange-500' : 'border-app-border/20 opacity-30 hover:opacity-100'}`}
                          >
                            <Tag size={10} className="inline mr-1" />
                            {item.discount?.value ? (item.discount.type === 'percentage' ? `-${item.discount.value}%` : `-$${item.discount.value}`) : 'DISC'}
                          </button>
                          {item.discount?.value ? (
                            <button 
                              onClick={() => applyItemDiscount(item.id, 'percentage', 0)}
                              className="text-[10px] opacity-50 hover:text-red-500"
                            >
                              ✕
                            </button>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex items-center border border-app-border rounded overflow-hidden">
                        <button 
                          onClick={() => updateQuantity(item.id, -1)}
                          className="p-2 hover:bg-app-ink hover:text-app-bg transition-colors"
                        >
                          <Minus size={14} />
                        </button>
                        <span className="w-12 text-center font-mono font-bold">{item.quantity}</span>
                        <button 
                          onClick={() => updateQuantity(item.id, 1)}
                          className="p-2 hover:bg-app-ink hover:text-app-bg transition-colors"
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                      <div className="w-24 text-right font-mono font-bold">
                        <div>${calculateItemTotal(item).toFixed(2)}</div>
                        <div className="text-[10px] text-emerald-600">{Math.round(calculateItemTotalLBP(item)).toLocaleString()} LL</div>
                      </div>
                      <button 
                        onClick={() => updateQuantity(item.id, -item.quantity)}
                        className="p-2 text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </motion.div>
                ))
              )}
            </AnimatePresence>
          </div>

          {/* Cart Summary */}
          <div className="p-6 bg-app-surface border-t border-app-border space-y-4 transition-colors duration-300">
            <div className="flex justify-between items-start">
              <div className="space-y-4">
                <div>
                  <p className="text-xs uppercase tracking-widest opacity-50 mb-1">Total Amount</p>
                  <div className="flex items-baseline gap-2">
                    <span className="text-4xl font-bold tracking-tighter">${totalUSD.toFixed(2)}</span>
                    <span className="text-xl opacity-40 font-mono">USD</span>
                    <span className="text-xl font-bold text-emerald-600 ml-4">{totalLBP.toLocaleString()} LL</span>
                  </div>
                  {subtotalUSD !== totalUSD && (
                    <p className="text-xs opacity-50 line-through font-mono mt-1">Subtotal: ${subtotalUSD.toFixed(2)}</p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase opacity-50">Global Discount:</span>
                  <div className="flex items-center gap-1 bg-app-bg/50 p-1 rounded border border-app-border/10">
                    <button 
                      onClick={() => setGlobalDiscount((prev: any) => ({ ...prev, type: prev.type === 'percentage' ? 'fixed' : 'percentage' }))}
                      className="p-1 hover:bg-app-ink/10 rounded"
                    >
                      {globalDiscount.type === 'percentage' ? <Percent size={12} /> : <DollarSign size={12} />}
                    </button>
                    <input 
                      type="number" 
                      className="w-12 bg-transparent border-none text-xs font-mono font-bold focus:ring-0 p-0"
                      value={globalDiscount.value}
                      onChange={(e) => setGlobalDiscount((prev: any) => ({ ...prev, value: parseFloat(e.target.value) || 0 }))}
                    />
                  </div>
                </div>
              </div>
              
              <div className="text-right">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs opacity-50">Display Currency:</span>
                  <div className="flex gap-1">
                    {currencies.map((c: any) => (
                      <button
                        key={c.code}
                        onClick={() => setSelectedCurrency(c)}
                        className={`px-2 py-1 text-[10px] font-bold border ${selectedCurrency.code === c.code ? 'bg-app-ink text-app-bg border-app-border' : 'border-app-border/20 hover:border-app-border'}`}
                      >
                        {c.code}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="text-2xl font-mono font-bold">
                  {selectedCurrency.symbol} {totalSelected.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
            </div>
            
            <div className="flex gap-2">
              <button 
                disabled={cart.length === 0 || isProcessing}
                onClick={handleQuickCash}
                className="flex-1 py-4 bg-emerald-600 text-white font-bold uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-emerald-700 transition-all disabled:opacity-20 disabled:cursor-not-allowed"
              >
                Quick Cash (F3) <Banknote size={20} />
              </button>
              <button 
                disabled={cart.length === 0 || isProcessing}
                onClick={() => {
                  setPaymentCurrency(selectedCurrency);
                  setShowCheckout(true);
                }}
                className="flex-1 py-4 bg-app-ink text-app-bg font-bold uppercase tracking-widest flex items-center justify-center gap-2 hover:opacity-90 transition-all disabled:opacity-20 disabled:cursor-not-allowed"
              >
                Checkout (F1) <ArrowRight size={20} />
              </button>
            </div>
          </div>
        </div>
</>
);
}