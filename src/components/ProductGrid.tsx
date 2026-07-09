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

export default function ProductGrid() {
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
  barcodeRef, customerDropdownRef, localExpired 
  } = pos as any;
return (
<div className="w-1/3 bg-app-bg/50 transition-colors duration-300 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-app-border/10 flex flex-col gap-4 flex-shrink-0">
            <div className="flex items-center gap-2">
              <Package size={18} className="opacity-50" />
              <h2 className="text-xs font-bold uppercase tracking-widest">Product Catalog</h2>
            </div>
            
            <div className="space-y-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 opacity-40" size={14} />
                <input 
                  type="text"
                  placeholder="Search products..."
                  className="w-full pl-9 pr-3 py-2 bg-app-surface border border-app-border/20 rounded text-xs focus:border-app-border outline-none transition-all"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              
              <div className="flex flex-wrap gap-1">
                {categories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-2 py-1 text-[9px] font-bold uppercase tracking-tighter border transition-all rounded ${selectedCategory === cat ? 'bg-app-ink text-app-bg border-app-border' : 'border-app-border/10 opacity-50 hover:opacity-100 hover:border-app-border'}`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Scrollable Product Grid */}
          <div className="flex-1 overflow-y-auto p-4 grid grid-cols-2 gap-2 content-start">
            {paginatedProducts.map(p => (
              <button
                key={p.id}
                onClick={() => addToCart(p)}
                className="p-3 bg-app-surface border border-app-border/10 rounded text-left hover:border-app-border transition-all active:scale-95 group"
              >
                <div className="text-xs font-bold truncate group-hover:text-app-ink transition-colors">{p.name}</div>
                <div className="flex justify-between items-center mt-1">
                  <div className="text-[10px] font-mono opacity-50">${p.price.toFixed(2)}</div>
                  <div className="text-[8px] opacity-30 uppercase font-bold">{p.category}</div>
                </div>
              </button>
            ))}
            {filteredProducts.length === 0 && (
              <div className="col-span-2 py-8 text-center opacity-20 italic text-xs">
                No products found
              </div>
            )}
          </div>

          {/* Pagination Controls - always visible at bottom */}
          {totalPages > 1 && (
            <div className="p-4 border-t border-app-border/10 flex justify-between items-center bg-app-surface/30 flex-shrink-0">
              <button 
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                className="px-3 py-1 bg-app-ink text-app-bg text-[10px] font-black uppercase tracking-widest rounded disabled:opacity-20"
              >
                Prev
              </button>
              <span className="text-[10px] font-black opacity-50">Page {currentPage} of {totalPages}</span>
              <button 
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                className="px-3 py-1 bg-app-ink text-app-bg text-[10px] font-black uppercase tracking-widest rounded disabled:opacity-20"
              >
                Next
              </button>
            </div>
          )}
        </div>
      
);
}