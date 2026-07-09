import React, { useState, useEffect, useRef } from 'react';
import { Barcode, Search, X, ArrowLeft } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Link } from 'react-router-dom';
import { Product } from './types';
import { translations, Language } from './i18n';

import WindowFrame from './components/WindowFrame';

export default function PriceChecker() {
  const [barcode, setBarcode] = useState('');
  const [product, setProduct] = useState<Product | null>(null);
  const productRef = useRef<Product | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<Language>('en');
  const inputRef = useRef<HTMLInputElement>(null);
  const t = translations[language];

  useEffect(() => {
    productRef.current = product;
  }, [product]);

  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(settings => {
        if (settings.language) setLanguage(settings.language as Language);
      });

    // Real-time Sync
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}`);
    
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const currentProduct = productRef.current;
      if (data.type === 'PRODUCTS_UPDATED' && currentProduct) {
        // Refresh the current product if it was updated
        fetch(`/api/products/${currentProduct.barcode}`).then(res => {
          if (res.ok) return res.json();
          return null;
        }).then(setProduct);
      }
      if (data.type === 'SETTINGS_UPDATED') {
        fetch('/api/settings').then(res => res.json()).then(settings => {
          if (settings.language) setLanguage(settings.language as Language);
        });
      }
    };
    
    // Keep input focused
    const focusInput = () => inputRef.current?.focus();
    document.addEventListener('click', focusInput);
    focusInput();

    return () => {
      document.removeEventListener('click', focusInput);
      socket.close();
    };
  }, []);

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!barcode) return;

    try {
      const res = await fetch(`/api/products/${barcode}`);
      if (res.ok) {
        const data = await res.json();
        setProduct(data);
        setError(null);
      } else {
        setProduct(null);
        setError(t.product_not_found);
      }
    } catch (err) {
      setError('Error fetching product');
    } finally {
      setBarcode('');
    }
  };

  return (
    <WindowFrame title={t.price_checker_title} icon={<Barcode size={14} />}>
      <div className="h-full bg-app-bg text-app-ink flex flex-col p-8 transition-colors duration-300 overflow-y-auto">
        <header className="flex justify-between items-center mb-12">
          <div className="flex items-center gap-4">
            <Link to="/" className="p-3 bg-app-surface border border-app-border rounded-xl hover:bg-app-ink hover:text-app-bg transition-all">
              <ArrowLeft size={24} />
            </Link>
            <h1 className="text-4xl font-black tracking-tighter uppercase">{t.price_checker_title}</h1>
          </div>
          <div className="text-right">
            <p className="text-xs font-black uppercase opacity-50 tracking-widest">OmniPOS System</p>
            <p className="text-lg font-bold">Price Checker Terminal</p>
          </div>
        </header>

        <main className="flex-1 flex flex-col items-center justify-center max-w-4xl mx-auto w-full">
          <form onSubmit={handleScan} className="w-full mb-12">
            <div className="relative">
              <Barcode className="absolute left-6 top-1/2 -translate-y-1/2 opacity-30" size={48} />
              <input
                ref={inputRef}
                type="text"
                placeholder={t.scan_barcode}
                className="w-full pl-24 pr-8 py-10 bg-app-surface border-4 border-app-border rounded-3xl outline-none focus:border-emerald-500 transition-all text-4xl font-mono"
                value={barcode}
                onChange={e => setBarcode(e.target.value)}
                autoFocus
              />
            </div>
          </form>

          <div className="w-full h-[400px] flex items-center justify-center">
            <AnimatePresence mode="wait">
              {product ? (
                <motion.div
                  key={product.id}
                  initial={{ opacity: 0, scale: 0.9, y: 20 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: -20 }}
                  className="w-full bg-app-surface border-4 border-app-border rounded-3xl p-12 shadow-2xl flex flex-col items-center text-center space-y-6"
                >
                  <div className="px-6 py-2 bg-emerald-500 text-white rounded-full text-sm font-black uppercase tracking-widest">
                    {t.product_found}
                  </div>
                  <h2 className="text-6xl font-black uppercase tracking-tight">{product.name}</h2>
                  <div className="flex items-baseline gap-4">
                    <span className="text-8xl font-black font-mono">${product.price.toFixed(2)}</span>
                    <span className="text-2xl opacity-50 font-bold uppercase">/ {product.unit}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-8 w-full pt-8 border-t border-app-border/10">
                    <div>
                      <p className="text-xs font-black uppercase opacity-50 tracking-widest mb-1">{t.category}</p>
                      <p className="text-2xl font-bold uppercase">{product.category}</p>
                    </div>
                    <div>
                      <p className="text-xs font-black uppercase opacity-50 tracking-widest mb-1">{t.stock}</p>
                      <p className={`text-2xl font-bold ${product.stock < 10 ? 'text-red-500' : ''}`}>
                        {product.stock} {product.unit}
                      </p>
                    </div>
                  </div>
                </motion.div>
              ) : error ? (
                <motion.div
                  key="error"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="flex flex-col items-center text-center space-y-4"
                >
                  <div className="p-8 bg-red-500/10 text-red-500 rounded-full">
                    <X size={64} />
                  </div>
                  <h2 className="text-4xl font-black uppercase tracking-tight text-red-500">{error}</h2>
                  <p className="text-xl opacity-50 font-medium">Please try scanning again</p>
                </motion.div>
              ) : (
                <motion.div
                  key="idle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center text-center space-y-6 opacity-20"
                >
                  <Barcode size={120} strokeWidth={1} />
                  <p className="text-2xl font-black uppercase tracking-widest">{t.scan_barcode}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>

        <footer className="mt-12 text-center opacity-30">
          <p className="text-xs font-black uppercase tracking-[0.2em]">Ready for next scan</p>
        </footer>
      </div>
    </WindowFrame>
  );
}
