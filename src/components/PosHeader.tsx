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

export default function PosHeader() {
  const pos = usePosContext();
  const { 
  products, setProducts, cart, setCart, stakeholders, setStakeholders, selectedStakeholder, setSelectedStakeholder, 
  barcodeInput, setBarcodeInput, isProcessing, setIsProcessing, recentTransactions, setRecentTransactions, 
  selectedCurrency, setSelectedCurrency, showCheckout, setShowCheckout, payments, setPayments, 
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
  barcodeRef, customerDropdownRef, localExpired, setShowDebtModal
  } = pos as any;
return (
<header className="border-b border-app-border p-4 flex justify-between items-center bg-app-surface transition-colors duration-300">
        <div className="flex items-center gap-3">
          <div className="bg-app-ink text-app-bg p-2 rounded transition-colors duration-300">
            <ShoppingCart size={24} />
          </div>
          <h1 className="text-xl font-bold tracking-tight uppercase">OmniPOS <span className="text-xs font-normal opacity-50">v1.0</span></h1>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="flex flex-col items-end mr-2">
            <span className="text-xs font-bold uppercase opacity-50">{tenant.name}</span>
            <button 
              onClick={handleLogout}
              className="text-[10px] font-mono uppercase hover:text-red-500 transition-colors"
            >
              Logout
            </button>
          </div>
          <div className="flex items-center gap-2 text-sm font-mono">
            <span className="opacity-50 italic">F1 Checkout</span>
            <span className="opacity-50 italic">F2 Scan</span>
            <span className="opacity-50 italic">F3 Cash</span>
          </div>
          <div className="h-8 w-[1px] bg-app-border opacity-10"></div>
          <div className="flex items-center gap-2 relative" ref={customerDropdownRef}>
            <User size={18} className="opacity-50" />
            <div className="relative">
              <button 
                onClick={() => setShowCustomerDropdown(!showCustomerDropdown)}
                className="bg-app-bg/50 border border-app-border/20 px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-2 hover:border-app-border transition-all min-w-[150px] justify-between"
              >
                <span className="truncate">
                  {stakeholders.find(s => s.id === selectedStakeholder)?.name || 'Select Customer'}
                </span>
                <Plus size={12} className={`transition-transform ${showCustomerDropdown ? 'rotate-45' : ''}`} />
              </button>

              <AnimatePresence>
                {showCustomerDropdown && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="absolute right-0 top-full mt-2 w-64 bg-app-surface border border-app-border shadow-2xl rounded-xl overflow-hidden z-[60]"
                  >
                    <div className="p-2 border-b border-app-border bg-app-bg/30">
                      <div className="relative">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 opacity-30" size={12} />
                        <input 
                          autoFocus
                          type="text"
                          placeholder="Search customers..."
                          className="w-full pl-7 pr-2 py-1.5 bg-app-surface border border-app-border/20 rounded-md text-xs outline-none focus:border-app-border transition-all"
                          value={customerSearchTerm}
                          onChange={(e) => setCustomerSearchTerm(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="max-h-60 overflow-y-auto">
                      <button
                        onClick={() => setShowAddCustomerModal(true)}
                        className="w-full text-left px-4 py-3 text-xs font-black uppercase tracking-widest bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500 hover:text-white transition-all flex items-center gap-2 border-b border-app-border/10"
                      >
                        <Plus size={14} /> Add New Customer
                      </button>
                      {stakeholders
                        .filter(s => s.type === 'customer' && s.name.toLowerCase().includes(customerSearchTerm.toLowerCase()))
                        .map(s => (
                          <button
                            key={s.id}
                            onClick={() => {
                              setSelectedStakeholder(s.id);
                              setShowCustomerDropdown(false);
                              setCustomerSearchTerm('');
                            }}
                            className={`w-full text-left px-4 py-2.5 text-xs font-bold hover:bg-app-ink hover:text-app-bg transition-colors flex justify-between items-center ${selectedStakeholder === s.id ? 'bg-app-ink/5' : ''}`}
                          >
                            <span>{s.name}</span>
                            {s.balance !== 0 && (
                              <span className={`text-[10px] ${s.balance < 0 ? 'text-red-500' : 'text-emerald-500'}`}>
                                ${Math.abs(s.balance).toFixed(2)}
                              </span>
                            )}
                          </button>
                        ))}
                      {stakeholders.filter(s => s.type === 'customer' && s.name.toLowerCase().includes(customerSearchTerm.toLowerCase())).length === 0 && (
                        <div className="p-4 text-center text-[10px] opacity-30 italic">No customers found</div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            
            {showCustomerDropdown === false && selectedStakeholder && stakeholders.find((s: any) => s.id === selectedStakeholder)?.type === 'customer' && stakeholders.find((s: any) => s.id === selectedStakeholder)?.balance < 0 && (
              <button 
                onClick={() => setShowDebtModal(true)}
                title="Receive Payment"
                className="ml-1 p-1.5 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500 hover:text-white rounded-lg transition-colors border border-emerald-500/20"
              >
                <Banknote size={14} />
              </button>
            )}
            
          </div>
          <div className="h-8 w-[1px] bg-app-border opacity-10"></div>
          
          {/* User Status & Lock */}
          <div className="flex items-center gap-2">
            <div className="px-3 py-1.5 bg-app-surface border border-app-border rounded-lg flex items-center gap-2">
              <User size={14} className="opacity-50" />
              <span className="text-[10px] font-black uppercase tracking-widest">{currentUser?.name || 'Cashier'}</span>
            </div>
            <button 
              onClick={() => setCurrentUser(null)}
              title="Lock Terminal"
              className="p-1.5 bg-red-500/10 text-red-500 border border-red-500/20 rounded-lg hover:bg-red-500 hover:text-white transition-all flex items-center justify-center"
            >
              <Shield size={16} />
            </button>
          </div>

          <button 
            onClick={() => setShowDailyHistory(true)}
            className="flex items-center gap-2 px-3 py-1.5 border-2 border-app-border rounded-lg text-xs font-black uppercase tracking-widest hover:bg-app-ink hover:text-app-bg transition-all"
          >
            <BarChart3 size={14} /> History
          </button>
          <Link 
            to="/price-checker" 
            className="flex items-center gap-2 px-3 py-1.5 border-2 border-app-border rounded-lg text-xs font-black uppercase tracking-widest hover:bg-app-ink hover:text-app-bg transition-all"
          >
            <Search size={14} /> {t.price_checker}
          </Link>
          <Link 
            to={`/dashboard?cashierId=${currentUser?.id || ''}`} 
            target="_blank"
            className="flex items-center gap-2 px-3 py-1.5 bg-app-ink text-app-bg rounded-lg text-xs font-black uppercase tracking-widest hover:opacity-90 transition-all"
          >
            <LayoutDashboard size={14} /> {t.dashboard}
          </Link>
        </div>
      </header>
);
}