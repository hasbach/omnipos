import React, { useState, useEffect, useRef, useCallback } from 'react';
import Fuse from 'fuse.js';
import { Product, CartItem, Stakeholder, Transaction, Payment, Discount, Tenant } from '../types';
import { translations, Language } from '../i18n';
import { useTheme } from './useTheme';

export const CURRENCIES = [
  { code: 'USD', symbol: '$', rate: 1 },
  { code: 'EUR', symbol: '€', rate: 0.92 },
  { code: 'LBP', symbol: 'LL', rate: 89500 },
];

export function usePos(tenant: any, setTenant: any, currentUser: any, setCurrentUser: any, users: any, setUsers: any, handleLogout?: any) {
  // Read terminal identity from URL (?terminalId=POS+1) injected by Electron on launch
  const terminalId = new URLSearchParams(window.location.search).get('terminalId') || 'MAIN';
const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [stakeholders, setStakeholders] = useState<Stakeholder[]>([]);
  const [selectedStakeholder, setSelectedStakeholder] = useState<number>(1); // Default to Walk-in
  const [barcodeInput, setBarcodeInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [recentTransactions, setRecentTransactions] = useState<any[]>([]);
  // Currencies configured by this tenant in Settings (with symbol/rate/is_default). Starts as the
  // built-in fallback and is replaced once /api/currencies loads. Rates stay relative to USD (the
  // internal accounting base), so all the totalUSD math below is unchanged.
  const [currencies, setCurrencies] = useState<any[]>(CURRENCIES);
  const currencyInitRef = useRef(false);
  const [selectedCurrency, setSelectedCurrency] = useState(CURRENCIES[2]); // Default to LBP
  const [showCheckout, setShowCheckout] = useState(false);
  const [payments, setPayments] = useState<any[]>([]);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'credit'>('cash');
  const [paymentCurrency, setPaymentCurrency] = useState(CURRENCIES[0]);
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [newCustomerForm, setNewCustomerForm] = useState({ name: '', phone: '', email: '' });
  const [isPriceChecker, setIsPriceChecker] = useState(false);
  const [isDarkMode] = useTheme();
  const [globalDiscount, setGlobalDiscount] = useState<Discount>({ type: 'percentage', value: 0 });
  const [showReceiptDialog, setShowReceiptDialog] = useState(true);
  const [lastTransaction, setLastTransaction] = useState<any>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [suggestions, setSuggestions] = useState<Product[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 12;
  const [language, setLanguage] = useState<Language>('en');
  const t = translations[language];
  const [customerSearchTerm, setCustomerSearchTerm] = useState('');
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [showDailyHistory, setShowDailyHistory] = useState(false);
  const [dailyTransactions, setDailyTransactions] = useState<any[]>([]);
  const [historyDate, setHistoryDate] = useState(new Date().toISOString().split('T')[0]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [selectedHistoryTransaction, setSelectedHistoryTransaction] = useState<any>(null);
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [refundQuantities, setRefundQuantities] = useState<Record<number, number>>({});
  const [showDebtModal, setShowDebtModal] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateVersion, setUpdateVersion] = useState('');
  const [updateStatus, setUpdateStatus] = useState<'idle'|'checking'|'available'|'downloading'|'downloaded'|'error'>('idle');
  const [updateProgress, setUpdateProgress] = useState(0);
  const [isUpdating, setIsUpdating] = useState(false);
              const socketRef = useRef<WebSocket | null>(null);
  
  const barcodeRef = useRef<HTMLInputElement>(null);
  const customerDropdownRef = useRef<HTMLDivElement>(null);



  useEffect(() => {
    if (!tenant) return;

    // Real-time Sync via WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}`);
    socketRef.current = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ 
        type: 'IDENTIFY', 
        tenantId: tenant.tenantId,
        terminalId,
        isMonitor: false
      }));
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('Sync Event:', data.type);
        
        const safeFetch = (url: string, callback: (data: any) => void) => {
          fetch(url)
            .then(res => {
              if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
              const contentType = res.headers.get("content-type");
              if (!contentType || !contentType.includes("application/json")) {
                throw new TypeError("Oops, we haven't got JSON!");
              }
              return res.json();
            })
            .then(callback)
            .catch(err => console.error(`Fetch error for ${url}:`, err));
        };

        switch (data.type) {
          case 'PRODUCTS_UPDATED':
            safeFetch('/api/products', setProducts);
            break;
          case 'TRANSACTIONS_UPDATED':
            safeFetch('/api/transactions/recent', setRecentTransactions);
            break;
          case 'SETTINGS_UPDATED':
            fetchSettings();
            fetchCurrencies();
            break;
          case 'UPDATE_AVAILABLE':
            setUpdateVersion(data.version);
            setShowUpdateModal(true);
            break;
        }
      } catch (err) {
        console.error('WS Error:', err);
      }
    };

    socket.onclose = () => {
      console.log('Sync Disconnected. Retrying in 5s...');
    };

    return () => socket.close();
  }, [tenant]);

  useEffect(() => {
    if (!tenant) return;
    
    // Check for scheduled updates
    const checkScheduledUpdate = () => {
      if (tenant.scheduled_update_at) {
        const scheduledTime = new Date(tenant.scheduled_update_at).getTime();
        const now = new Date().getTime();
        if (now >= scheduledTime) {
          handleInstallUpdate();
        }
      }
    };

    const interval = setInterval(checkScheduledUpdate, 60000); // Check every minute
    checkScheduledUpdate(); // Check immediately
    
    return () => clearInterval(interval);
  }, [tenant]);

  const handleInstallUpdate = () => {
    // Tell the main process to quit and apply the downloaded installer
    if (window.electronAPI?.installUpdate) {
      setIsUpdating(true);
      window.electronAPI.installUpdate();
    } else {
      // Browser fallback: call old API route
      fetch('/api/tenant/install-update', { method: 'POST' }).then(() => window.location.reload());
    }
  };

  const handleCheckForUpdates = async () => {
    if (window.electronAPI?.checkForUpdates) {
      setUpdateStatus('checking');
      await window.electronAPI.checkForUpdates();
    }
  };

  const handleDownloadUpdate = async () => {
    if (window.electronAPI?.downloadUpdate) {
      setUpdateStatus('downloading');
      await window.electronAPI.downloadUpdate();
    }
  };

  const [scheduleForm, setScheduleForm] = useState({ date: new Date().toISOString().split('T')[0], time: '02:00' });

  const handleScheduleUpdate = async () => {
    const scheduledAt = `${scheduleForm.date}T${scheduleForm.time}:00`;
    try {
      const res = await fetch('/api/tenant/schedule-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_at: scheduledAt })
      });
      if (res.ok) {
        setShowUpdateModal(false);
      }
    } catch (err) {
      console.error('Scheduling failed:', err);
    }
  };

  // Listen to real electron-updater events forwarded from main process via IPC
  useEffect(() => {
    if (!window.electronAPI?.onUpdateStatus) return;
    const cleanup = window.electronAPI.onUpdateStatus((data: any) => {
      switch (data.event) {
        case 'checking':
          setUpdateStatus('checking');
          break;
        case 'available':
          setUpdateStatus('available');
          setUpdateVersion(data.version || '');
          setShowUpdateModal(true);
          break;
        case 'not-available':
          setUpdateStatus('idle');
          break;
        case 'progress':
          setUpdateStatus('downloading');
          setUpdateProgress(data.percent || 0);
          break;
        case 'downloaded':
          setUpdateStatus('downloaded');
          setUpdateVersion(data.version || '');
          setShowUpdateModal(true);
          break;
        case 'error':
          setUpdateStatus('error');
          console.error('Updater error:', data.message);
          break;
      }
    });
    return cleanup;
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (customerDropdownRef.current && !customerDropdownRef.current.contains(event.target as Node)) {
        setShowCustomerDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const fetchSettings = useCallback(() => {
    fetch('/api/settings')
      .then(res => {
        if (!res.ok) return null;
        const contentType = res.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) return null;
        return res.json();
      })
      .then(settings => {
        if (settings && settings.language) setLanguage(settings.language as Language);
        if (settings) setShowReceiptDialog(settings.show_receipt_dialog !== '0');
      })
      .catch(err => console.error('Settings fetch error:', err));
  }, []);

  // Load this tenant's configured currencies and, on first load, default the display + payment
  // currency to the one marked default in Settings (e.g. LBP). Falls back to USD, then the first
  // entry, if none is flagged. Subsequent refetches (Settings changes) refresh the list/rates but
  // don't yank the currency out from under an in-progress sale.
  const fetchCurrencies = useCallback(() => {
    fetch('/api/currencies')
      .then(res => (res.ok ? res.json() : null))
      .then((rows: any[] | null) => {
        if (!rows || rows.length === 0) return;
        const list = rows.map(c => ({ code: c.code, symbol: c.symbol, rate: c.rate, is_default: c.is_default }));
        setCurrencies(list);
        if (!currencyInitRef.current) {
          currencyInitRef.current = true;
          const def = list.find(c => c.is_default) || list.find(c => c.code === 'USD') || list[0];
          if (def) {
            setSelectedCurrency(def);
            setPaymentCurrency(def);
          }
        }
      })
      .catch(err => console.error('Currencies fetch error:', err));
  }, []);



  const fetchDailyHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const res = await fetch(`/api/reports/daily-sales?date=${historyDate}`);
      if (res.ok) {
        const data = await res.json();
        setDailyTransactions(data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingHistory(false);
    }
  }, [historyDate]);

  useEffect(() => {
    if (showDailyHistory) {
      fetchDailyHistory();
    }
  }, [showDailyHistory, fetchDailyHistory]);

  const handleRefund = async () => {
    if (!selectedHistoryTransaction) return;
    
    const itemsToRefund = selectedHistoryTransaction.items
      .filter((item: any) => refundQuantities[item.id] > 0)
      .map((item: any) => ({
        id: item.product_id,
        quantity: refundQuantities[item.id],
        price: item.unit_price,
        discount: { type: item.discount_type, value: item.discount_value },
        tax: { type: item.tax_type, value: item.tax_value }
      }));

    if (itemsToRefund.length === 0) {
      alert('Please select at least one item to refund.');
      return;
    }

    const calculateRefundAmount = (item: any, qty: number) => {
      let price = item.unit_price * qty;
      if (item.discount_type === 'percentage') {
        price -= (price * (item.discount_value || 0)) / 100;
      } else if (item.discount_type === 'fixed') {
        price -= (item.discount_value || 0) * (qty / item.quantity); // Pro-rated fixed discount
      }
      return price;
    };

    const totalRefund = itemsToRefund.reduce((sum: number, item: any) => {
      const originalItem = selectedHistoryTransaction.items.find((i: any) => i.product_id === item.id);
      return sum + calculateRefundAmount(originalItem, item.quantity);
    }, 0);

    setIsProcessing(true);
    try {
      const res = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stakeholder_id: selectedHistoryTransaction.stakeholder_id,
          user_id: currentUser?.id || 1,
          type: 'refund',
          items: itemsToRefund,
          total_amount: totalRefund,
          currency: selectedHistoryTransaction.currency,
          exchange_rate: selectedHistoryTransaction.exchange_rate,
          payments: [{
            amount: totalRefund,
            method: 'cash',
            currency: selectedHistoryTransaction.currency,
            exchange_rate: selectedHistoryTransaction.exchange_rate
          }]
        })
      });

      if (res.ok) {
        setShowRefundModal(false);
        setSelectedHistoryTransaction(null);
        fetchDailyHistory();
        alert('Refund processed successfully');
      }
    } catch (err) {
      console.error(err);
      alert('Failed to process refund');
    } finally {
      setIsProcessing(false);
    }
  };

  const fetchData = useCallback(async () => {
    try {
      const [pRes, sRes, tRes, uRes] = await Promise.all([
        fetch('/api/products'),
        fetch('/api/stakeholders'),
        fetch('/api/transactions/recent'),
        fetch('/api/users')
      ]);
      
      if (pRes.ok) setProducts(await pRes.json());
      if (sRes.ok) setStakeholders(await sRes.json());
      if (tRes.ok) setRecentTransactions(await tRes.json());
      if (uRes.ok) {
        const userData = await uRes.json();
        setUsers(userData);
      }
    } catch (err) {
      console.error('Fetch data failed:', err);
    }
  }, [currentUser]);

  // Initial load when tenant is available
  useEffect(() => {
    if (tenant) {
      fetchData();
      fetchSettings();
      fetchCurrencies();
    }
  }, [tenant, fetchData, fetchSettings, fetchCurrencies]);

  const addToCart = (product: Product) => {
    setCart(prev => {
      const existing = prev.find(item => item.id === product.id);
      if (existing) {
        return prev.map(item => 
          item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      return [...prev, { ...product, quantity: 1 }];
    });
  };

  const handleBarcodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!barcodeInput) return;
    
    try {
      const res = await fetch(`/api/products/${barcodeInput}`);
      if (res.ok) {
        const product = await res.json();
        addToCart(product);
        setBarcodeInput('');
        setSuggestions([]);
      } else {
        alert('Product not found');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleSuggestionClick = (product: Product) => {
    addToCart(product);
    setBarcodeInput('');
    setSuggestions([]);
    barcodeRef.current?.focus();
  };

  const updateQuantity = (id: number, delta: number) => {
    setCart(prev => prev.map(item => {
      if (item.id === id) {
        const newQty = Math.max(0, item.quantity + delta);
        return { ...item, quantity: newQty };
      }
      return item;
    }).filter(item => item.quantity > 0));
  };

  const applyItemDiscount = (id: number, type: 'percentage' | 'fixed', value: number) => {
    setCart(prev => prev.map(item => {
      if (item.id === id) {
        return { ...item, discount: { type, value } };
      }
      return item;
    }));
  };

  // --- Currency-aware pricing --------------------------------------------------------------
  // A product can carry a directly-entered price per currency (price_lbp / package_price_lbp).
  // When the active (selected) currency has its own entered price we use THAT as authoritative
  // rather than converting the USD price by the exchange rate — so a product priced at 300,000 LL
  // shows and charges 300,000, not a rounded conversion. USD remains the stored accounting base
  // and is DERIVED from the active-currency total, so the receipt, payment amount and change all
  // agree with what the cashier sees.
  const activeCode = selectedCurrency?.code || 'USD';
  const activeRate = selectedCurrency?.rate || 1;
  // The product model stores exactly two prices: the USD base (`price`) and one local-currency
  // price (`price_lbp`). So any non-USD currency IS the local currency and maps to price_lbp —
  // regardless of the code the merchant chose for it (LBP, LB, LL, …). Match on "not USD" rather
  // than a hard-coded 'LBP', which is what made a currency coded "LB" fall back to conversion.
  const usesLocalPrice = (code: string) => code !== 'USD';
  const localCurrency = currencies.find((c: any) => c.code !== 'USD');
  const localCode = localCurrency?.code || 'LBP';
  const lbpRate = localCurrency?.rate || activeRate || 89500;

  const hasPrice = (v: any) => v !== null && v !== undefined && v !== '' && !isNaN(Number(v)) && Number(v) > 0;
  const unitPriceIn = (item: any, code: string, rate: number) =>
    (usesLocalPrice(code) && hasPrice(item.price_lbp)) ? Number(item.price_lbp) : (Number(item.price) || 0) * rate;
  const packagePriceIn = (item: any, code: string, rate: number) =>
    (usesLocalPrice(code) && hasPrice(item.package_price_lbp)) ? Number(item.package_price_lbp) : (Number(item.package_price) || 0) * rate;

  // Item line total in a given currency, honouring bulk pricing and the per-item discount.
  const itemTotalIn = (item: any, code: string, rate: number) => {
    let base = unitPriceIn(item, code, rate) * item.quantity;
    if (item.package_price && item.units_per_package && item.units_per_package > 1) {
      const numPackages = Math.floor(item.quantity / item.units_per_package);
      const remainder = item.quantity % item.units_per_package;
      base = (numPackages * packagePriceIn(item, code, rate)) + (remainder * unitPriceIn(item, code, rate));
    }
    if (!item.discount || item.discount.value === 0) return base;
    if (item.discount.type === 'percentage') return base * (1 - item.discount.value / 100);
    return Math.max(0, base - item.discount.value * rate); // fixed discounts are entered in USD
  };

  const applyGlobalDiscount = (subtotal: number, rate: number) => {
    if (globalDiscount.value === 0) return subtotal;
    if (globalDiscount.type === 'percentage') return subtotal * (1 - globalDiscount.value / 100);
    return Math.max(0, subtotal - globalDiscount.value * rate);
  };

  // USD line total (accounting base), derived from the active-currency price so what we store
  // matches what we charge.
  const calculateItemTotal = (item: CartItem) => itemTotalIn(item as any, activeCode, activeRate) / activeRate;
  // Local-currency line total straight from the entered price_lbp (for the green "LL" line).
  const calculateItemTotalLBP = (item: CartItem) => itemTotalIn(item as any, localCode, lbpRate);

  const subtotalActive = cart.reduce((sum, item) => sum + itemTotalIn(item as any, activeCode, activeRate), 0);
  const totalActive = applyGlobalDiscount(subtotalActive, activeRate);

  const subtotalUSD = subtotalActive / activeRate;
  const totalUSD = totalActive / activeRate;

  // The secondary "LL" figures always sum the entered LBP prices (matching the per-item LBP lines),
  // so they stay consistent whether the active currency is LBP or USD.
  const subtotalLBPraw = cart.reduce((sum, item) => sum + itemTotalIn(item as any, localCode, lbpRate), 0);
  const subtotalLBP = Math.round(subtotalLBPraw);
  const totalLBP = Math.round(applyGlobalDiscount(subtotalLBPraw, lbpRate));

  useEffect(() => {
    if (showCheckout && !lastTransaction && cart.length > 0) {
      // Calculate remaining balance
      const paidUSD = payments.reduce((sum, p) => sum + (p.amount / p.exchange_rate), 0);
      const remainingUSD = totalUSD - paidUSD;
      if (remainingUSD > 0) {
        setPaymentAmount((remainingUSD * paymentCurrency.rate).toFixed(2));
      }
    }
  }, [showCheckout, totalUSD, lastTransaction, payments, paymentCurrency, cart.length]);

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsProcessing(true);
    try {
      const res = await fetch('/api/stakeholders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newCustomerForm, type: 'customer', balance: 0 })
      });
      if (res.ok) {
        const data = await res.json();
        const newCustomer = { ...newCustomerForm, id: data.id, type: 'customer' as const, balance: 0 };
        setStakeholders(prev => [...prev, newCustomer]);
        setSelectedStakeholder(data.id);
        setShowAddCustomerModal(false);
        setNewCustomerForm({ name: '', phone: '', email: '' });
        setShowCustomerDropdown(false);
      } else {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        alert(`Error saving customer: ${err.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsProcessing(false);
    }
  };

  useEffect(() => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN && tenant) {
      socketRef.current.send(JSON.stringify({
        type: 'CART_UPDATE',
        cart,
        user: currentUser?.name || tenant.name,
        total: totalUSD
      }));
    }
  }, [cart, totalUSD, tenant, currentUser]);

  const totalSelected = totalUSD * selectedCurrency.rate;

  const categories = ['All', ...new Set(products.map(p => p.category))];

  const filteredProducts = (() => {
    let result = products;

    if (selectedCategory !== 'All') {
      result = result.filter(p => p.category === selectedCategory);
    }

    if (searchTerm) {
      const fuse = new Fuse(result, {
        keys: ['name', 'barcode', 'barcodes'],
        threshold: 0.3,
      });
      result = fuse.search(searchTerm).map(r => r.item);
    }

    return result;
  })();

  const totalPages = Math.ceil(filteredProducts.length / itemsPerPage);
  const paginatedProducts = filteredProducts.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  const handleCheckout = useCallback(async (payments: any[]) => {
    setIsProcessing(true);
    const transaction: any = {
      stakeholder_id: selectedStakeholder,
      user_id: currentUser?.id || 1,
      items: cart,
      total_amount: totalUSD,
      currency: 'USD',
      exchange_rate: 1,
      discount: globalDiscount.value > 0 ? globalDiscount : undefined,
      terminalId,
      payments: payments
    };

    try {
      const res = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(transaction)
      });
      if (res.ok) {
        const data = await res.json();
        setCart([]);
        setPayments([]); // Reset split payments
        setSelectedStakeholder(1); // Reset to Walk-in default customer
        fetchData();

        if (showReceiptDialog) {
          setLastTransaction({ ...transaction, id: data.id, created_at: new Date().toISOString() });
          setShowCheckout(true);
        } else {
          // Skip the post-checkout confirmation screen; go straight back to a fresh sale.
          setLastTransaction(null);
          setShowCheckout(false);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsProcessing(false);
    }
  }, [selectedStakeholder, cart, totalUSD, globalDiscount, fetchData, setShowCheckout, currentUser, showReceiptDialog]);

  const handleQuickCash = useCallback(() => {
    if (cart.length > 0 && !isProcessing) {
      handleCheckout([{
        amount: totalUSD,
        method: 'cash',
        currency: 'USD',
        exchange_rate: 1
      }]);
    }
  }, [cart, isProcessing, handleCheckout, totalUSD]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F1') {
        e.preventDefault();
        setPaymentCurrency(selectedCurrency);
        setShowCheckout(true);
      }
      if (e.key === 'F2') {
        e.preventDefault();
        barcodeRef.current?.focus();
      }
      if (e.key === 'F3') {
        e.preventDefault();
        handleQuickCash();
      }
      if (e.key === 'Escape') {
        setShowCheckout(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleQuickCash]);

  const printReceipt = async (transaction: any) => {
    // Prefer sending a real ESC/POS job to a configured receipt printer; only fall back
    // to the plain browser-print window if no printer is configured or the print fails.
    if (transaction.id) {
      try {
        const printersRes = await fetch('/api/printers');
        const printers = printersRes.ok ? await printersRes.json() : [];
        const receiptPrinter = Array.isArray(printers)
          ? printers.find((p: any) => p.type === 'receipt' && p.is_default && p.enabled)
          : null;

        if (receiptPrinter) {
          const openDrawer = Array.isArray(transaction.payments) && transaction.payments.some((p: any) => p.method === 'cash');
          const printRes = await fetch('/api/print/receipt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transactionId: transaction.id, printerId: receiptPrinter.id, openDrawer })
          });
          if (printRes.ok) return;
          console.error('Thermal receipt print failed, falling back to browser print');
        }
      } catch (err) {
        console.error('Thermal receipt print error, falling back to browser print:', err);
      }
    }

    const stakeholder = stakeholders.find(s => s.id === transaction.stakeholder_id)?.name || 'Walk-in Customer';
    const lines = [
      "================================",
      "           OMNIPOS              ",
      "       RETAIL SOLUTIONS         ",
      "================================",
      `Date: ${new Date(transaction.created_at).toLocaleString()}`,
      `Receipt: ${
        transaction.terminal_id && transaction.terminal_sequence
          ? `${transaction.terminal_id}-${String(transaction.terminal_sequence).padStart(4, '0')}`
          : `#${transaction.id || 'N/A'}`
      }`,
      `Customer: ${stakeholder}`,
      "--------------------------------",
      "Item            Qty     Price   ",
    ];

    transaction.items.forEach((item: any) => {
      const name = item.name.padEnd(15).substring(0, 15);
      const qty = item.quantity.toString().padStart(5);
      const price = `$${(item.price * item.quantity).toFixed(2)}`.padStart(8);
      lines.push(`${name} ${qty} ${price}`);
      if (item.discount?.value > 0) {
        const disc = item.discount.type === 'percentage' ? `-${item.discount.value}%` : `-$${item.discount.value}`;
        lines.push(`  (Discount: ${disc})`);
      }
    });

    lines.push("--------------------------------");
    lines.push(`TOTAL:            $${transaction.total_amount.toFixed(2)}`);
    
    if (transaction.discount?.value > 0) {
      const disc = transaction.discount.type === 'percentage' ? `${transaction.discount.value}%` : `$${transaction.discount.value}`;
      lines.push(`Global Discount:   ${disc}`);
    }

    lines.push("================================",
               "       THANK YOU FOR            ",
               "       SHOPPING WITH US         ",
               "================================");

    const receiptText = lines.join('\n');
    
    // Simple print window
    const printWindow = window.open('', '_blank', 'width=400,height=600');
    if (printWindow) {
      printWindow.document.write(`<pre style="font-family: monospace; font-size: 12px;">${receiptText}</pre>`);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
      printWindow.close();
    }
  };

  
  const handleReceiveDebt = async (amount: number, method: 'cash' | 'card' | 'credit', currency: any) => {
    if (!tenant || !selectedStakeholder) return;
    setIsProcessing(true);
    try {
      const res = await fetch('/api/stakeholders/settle-balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stakeholder_id: selectedStakeholder,
          amount: amount,
          method: method,
          currency: currency.code,
          exchange_rate: currency.rate
        })
      });
      if (res.ok) {
        setShowDebtModal(false);
        fetchData(); // Refresh stakeholders balance
        alert('Payment received successfully');
      } else {
        alert('Failed to process payment');
      }
    } catch (err) {
      console.error(err);
      alert('Network error while processing payment');
    } finally {
      setIsProcessing(false);
    }
  };

  return {
    products,
    setProducts,
    cart,
    setCart,
    stakeholders,
    setStakeholders,
    selectedStakeholder,
    setSelectedStakeholder,
    barcodeInput,
    setBarcodeInput,
    isProcessing,
    setIsProcessing,
    recentTransactions,
    setRecentTransactions,
    currencies,
    selectedCurrency,
    setSelectedCurrency,
    showCheckout,
    setShowCheckout,
    payments,
    setPayments,
    paymentAmount,
    setPaymentAmount,
    paymentMethod,
    setPaymentMethod,
    paymentCurrency,
    setPaymentCurrency,
    showAddCustomerModal,
    setShowAddCustomerModal,
    newCustomerForm,
    setNewCustomerForm,
    isPriceChecker,
    setIsPriceChecker,
    globalDiscount,
    setGlobalDiscount,
    lastTransaction,
    setLastTransaction,
    searchTerm,
    setSearchTerm,
    selectedCategory,
    setSelectedCategory,
    suggestions,
    setSuggestions,
    currentPage,
    setCurrentPage,
    language,
    setLanguage,
    customerSearchTerm,
    setCustomerSearchTerm,
    showCustomerDropdown,
    setShowCustomerDropdown,
    showDailyHistory,
    setShowDailyHistory,
    dailyTransactions,
    setDailyTransactions,
    historyDate,
    setHistoryDate,
    loadingHistory,
    setLoadingHistory,
    selectedHistoryTransaction,
    setSelectedHistoryTransaction,
    showRefundModal,
    setShowRefundModal,
    refundQuantities,
    setRefundQuantities,
    showDebtModal,
    setShowDebtModal,
    showUpdateModal,
    setShowUpdateModal,
    updateVersion,
    setUpdateVersion,
    isUpdating,
    setIsUpdating,
    updateStatus,
    updateProgress,
    scheduleForm,
    setScheduleForm,
    fetchDailyHistory,
    fetchData,
    handleCheckout,
    handleQuickCash,

    handleInstallUpdate,
    handleCheckForUpdates,
    handleDownloadUpdate,
    handleScheduleUpdate,
    handleRefund,
    handleReceiveDebt,
    handleBarcodeSubmit,
    handleCreateCustomer,
    addToCart,
    handleSuggestionClick,
    updateQuantity,
    applyItemDiscount,
    calculateItemTotal,
    calculateItemTotalLBP,
    totalUSD,
    filteredProducts,
    printReceipt,
    subtotalUSD,
    subtotalLBP,
    totalLBP,
    totalSelected,
    categories,
    totalPages,
    paginatedProducts,
    t,
    socketRef,
    barcodeRef,
    customerDropdownRef,
    tenant,
    users,
    currentUser,
    setCurrentUser,
    setTenant,
    terminalId,
    handleLogout
  };
}
