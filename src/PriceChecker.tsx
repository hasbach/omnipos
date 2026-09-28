import React, { useState, useEffect, useRef } from 'react';
import { Barcode, X, ArrowLeft } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Link } from 'react-router-dom';
import { Product } from './types';
import { I18nProvider, useI18n } from './intl/index';
import WindowFrame from './components/WindowFrame';
import { formatNumber } from './lib/format';

function PriceCheckerBody() {
  const { t, setLang } = useI18n();
  const [barcode, setBarcode] = useState('');
  const [product, setProduct] = useState<Product | null>(null);
  const productRef = useRef<Product | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState('');
  const [priceLevelsEnabled, setPriceLevelsEnabled] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    productRef.current = product;
  }, [product]);

  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(settings => {
        if (settings.language) setLang(settings.language);
        if (settings.store_name) setBusinessName(settings.store_name);
        setPriceLevelsEnabled(settings.enable_price_levels !== '0');
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
          if (settings.language) setLang(settings.language);
          if (settings.store_name) setBusinessName(settings.store_name);
          setPriceLevelsEnabled(settings.enable_price_levels !== '0');
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
        setError(t('product_not_found', 'Product Not Found'));
      }
    } catch (err) {
      setError('Error fetching product');
    } finally {
      setBarcode('');
    }
  };

  return (
    <WindowFrame title={t('price_checker_title', 'Price Checker')} icon={<Barcode size={14} />}>
      <div className="h-full bg-bg text-text flex flex-col p-8 overflow-y-auto">
        <header className="flex justify-between items-center mb-10 flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <Link to="/" className="p-3 bg-surface border border-border rounded-xl hover:bg-primary hover:text-on-primary transition-all">
              <ArrowLeft size={22} className="rtl:rotate-180" />
            </Link>
            <h1 className="text-3xl font-black tracking-tight">{t('price_checker_title', 'Price Checker')}</h1>
          </div>
          <div className="text-end">
            <p className="text-xs font-black uppercase text-text-3 tracking-wide">{businessName || 'Price Checker'}</p>
            <p className="text-lg font-bold">{t('pos_price_checker_subtitle', 'Price Checker Terminal')}</p>
          </div>
        </header>

        <main className="flex-1 flex flex-col items-center justify-center max-w-4xl mx-auto w-full">
          <form onSubmit={handleScan} className="w-full mb-10">
            <div className="relative">
              <Barcode className="absolute start-6 top-1/2 -translate-y-1/2 text-text-3" size={40} />
              <input
                ref={inputRef}
                type="text"
                placeholder={t('scan_barcode', 'Scan Barcode')}
                className="w-full ps-20 pe-8 py-8 bg-surface border-4 border-border rounded-3xl outline-none focus:border-primary transition-all text-3xl font-mono text-text"
                value={barcode}
                onChange={e => setBarcode(e.target.value)}
                autoFocus
              />
            </div>
          </form>

          <div className="w-full min-h-[400px] flex items-center justify-center">
            <AnimatePresence mode="wait">
              {product ? (
                <motion.div
                  key={product.id}
                  initial={{ opacity: 0, scale: 0.9, y: 20 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: -20 }}
                  className="w-full bg-surface border-4 border-border rounded-3xl p-10 shadow-2xl flex flex-col items-center text-center space-y-6"
                >
                  <div className="px-5 py-1.5 bg-success text-white rounded-full text-sm font-black uppercase tracking-wide">
                    {t('product_found', 'Product Found')}
                  </div>
                  <h2 className="text-5xl font-black uppercase tracking-tight">{product.name}</h2>

                  <div className={`grid gap-6 w-full ${priceLevelsEnabled ? 'grid-cols-3' : 'grid-cols-1'}`}>
                    <div className="p-4 bg-bg rounded-2xl border border-border">
                      <p className="text-[10px] font-black uppercase text-text-3 tracking-wide mb-1">{t('pos_tier_retail', 'Retail')}</p>
                      <p className="text-3xl font-black num">${(product.price || 0).toFixed(2)}</p>
                    </div>
                    {priceLevelsEnabled && (
                      <>
                        <div className="p-4 bg-bg rounded-2xl border border-border">
                          <p className="text-[10px] font-black uppercase text-text-3 tracking-wide mb-1">{t('pos_tier_wholesale', 'Wholesale')}</p>
                          <p className="text-3xl font-black num">${((product as any).price_wholesale || product.price || 0).toFixed(2)}</p>
                        </div>
                        <div className="p-4 bg-bg rounded-2xl border border-border">
                          <p className="text-[10px] font-black uppercase text-text-3 tracking-wide mb-1">{t('pos_tier_super_wholesale', 'Super Wholesale')}</p>
                          <p className="text-3xl font-black num">${((product as any).price_super_wholesale || (product as any).price_wholesale || product.price || 0).toFixed(2)}</p>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="text-4xl font-black text-success tracking-tight num">
                    {formatNumber((product as any).price_lbp || Math.round((product.price || 0) * 89500), { decimals: 0 })} LL
                  </div>

                  <div className="grid grid-cols-2 gap-8 w-full pt-6 border-t border-border">
                    <div>
                      <p className="text-xs font-black uppercase text-text-3 tracking-wide mb-1">{t('category', 'Category')}</p>
                      <p className="text-xl font-bold uppercase">{product.category}</p>
                    </div>
                    <div>
                      <p className="text-xs font-black uppercase text-text-3 tracking-wide mb-1">{t('stock', 'Stock')}</p>
                      <p className={`text-xl font-bold ${product.stock < 10 ? 'text-danger' : ''}`}>
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
                  <div className="p-8 bg-danger-soft text-danger rounded-full">
                    <X size={56} />
                  </div>
                  <h2 className="text-3xl font-black uppercase tracking-tight text-danger">{error}</h2>
                  <p className="text-lg text-text-3 font-medium">{t('pos_try_scanning_again', 'Please try scanning again')}</p>
                </motion.div>
              ) : (
                <motion.div
                  key="idle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center text-center space-y-6 text-text-3"
                >
                  <Barcode size={100} strokeWidth={1} />
                  <p className="text-xl font-black uppercase tracking-wide">{t('scan_barcode', 'Scan Barcode')}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>

        <footer className="mt-10 text-center text-text-3">
          <p className="text-xs font-black uppercase tracking-[0.2em]">{t('pos_ready_for_next_scan', 'Ready for next scan')}</p>
        </footer>
      </div>
    </WindowFrame>
  );
}

export default function PriceChecker() {
  return (
    <I18nProvider>
      <PriceCheckerBody />
    </I18nProvider>
  );
}
