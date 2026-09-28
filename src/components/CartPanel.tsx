import React, { useState } from 'react';
import {
  ShoppingCart, Banknote, Package, Plus, Minus, Trash2, Barcode, ArrowRight,
  Percent, DollarSign, Tag, X, Pencil
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Fuse from 'fuse.js';
import { usePosContext } from '../context/PosContext';
import { CURRENCIES } from '../hooks/usePos';
import { Badge } from './ui';
import { formatMoney, formatBalance } from '../lib/format';

export default function CartPanel() {
  const pos = usePosContext();
  const {
    products, cart, barcodeInput, setBarcodeInput, isProcessing,
    currencies = CURRENCIES, selectedCurrency, setSelectedCurrency, setShowCheckout, setPaymentCurrency,
    globalDiscount, setGlobalDiscount, searchTerm, suggestions, setSuggestions,
    handleBarcodeSubmit, handleSuggestionClick, updateQuantity, setItemQuantity, applyItemDiscount,
    calculateItemTotal, calculateItemTotalLBP, handleQuickCash, subtotalUSD, totalUSD, totalLBP,
    priceLevel, allowPriceOverride, enforceMinPrice, unitPriceUSD, setItemPriceOverride,
    creditLimit, availableCredit, t, barcodeRef, priceLevelsEnabled,
    selectedStakeholder, prevBalanceUSD, thisSaleEffectUSD, newBalanceUSD,
  } = pos as any;

  const [discountEditorId, setDiscountEditorId] = useState<number | null>(null);
  const [discountDraft, setDiscountDraft] = useState<{ type: 'percentage' | 'fixed'; value: string }>({ type: 'percentage', value: '0' });
  const [priceEditorId, setPriceEditorId] = useState<number | null>(null);
  const [priceDraft, setPriceDraft] = useState('');

  const openDiscountEditor = (item: any) => {
    setDiscountEditorId(item.id);
    setDiscountDraft({ type: item.discount?.type || 'percentage', value: String(item.discount?.value ?? 0) });
  };

  const saveDiscountEditor = () => {
    if (discountEditorId == null) return;
    applyItemDiscount(discountEditorId, discountDraft.type, parseFloat(discountDraft.value) || 0);
    setDiscountEditorId(null);
  };

  const openPriceEditor = (item: any) => {
    setPriceEditorId(item.id);
    const usd = item.unit_price != null ? item.unit_price : unitPriceUSD(item, item.quantity);
    setPriceDraft((usd * (selectedCurrency?.rate || 1)).toFixed(selectedCurrency?.code === 'USD' ? 2 : 0));
  };

  const savePriceEditor = (item: any) => {
    const raw = parseFloat(priceDraft);
    if (Number.isFinite(raw) && raw >= 0) {
      const usd = raw / (selectedCurrency?.rate || 1);
      setItemPriceOverride(item.id, usd);
    }
    setPriceEditorId(null);
  };

  const clearPriceOverride = (id: number) => setItemPriceOverride(id, null);

  const tierLabel = !priceLevelsEnabled ? null : priceLevel === 'wholesale'
    ? t('pos_tier_wholesale', 'Wholesale')
    : priceLevel === 'super_wholesale'
      ? t('pos_tier_super_wholesale', 'Super Wholesale')
      : null;

  const USD = { code: 'USD', symbol: '$' };
  const isWalkIn = selectedStakeholder === 1;

  return (
    <>
      {/* Left Panel: Cart */}
      <div className="w-2/3 flex flex-col border-e border-border">
        {/* Barcode Input Area */}
        <div className="p-4 border-b border-border bg-surface relative">
          <form onSubmit={handleBarcodeSubmit} className="relative">
            <Barcode className="absolute start-4 top-1/2 -translate-y-1/2 text-text-3" size={20} />
            <input
              ref={barcodeRef}
              type="text"
              placeholder={t('search_placeholder', 'Scan or search...')}
              className="w-full ps-12 pe-4 py-4 min-h-[56px] bg-bg border-2 border-transparent focus:border-primary transition-all outline-none font-mono text-lg rounded-[var(--radius-input)] text-text"
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
                className="absolute start-4 end-4 top-full mt-1 bg-surface border border-border shadow-[var(--shadow-modal)] z-50 rounded-lg overflow-hidden"
              >
                {suggestions.map((p: any) => (
                  <button
                    key={p.id}
                    onClick={() => handleSuggestionClick(p)}
                    className="w-full flex items-center justify-between p-4 hover:bg-primary hover:text-on-primary transition-colors text-start border-b border-border last:border-none cursor-pointer"
                  >
                    <div>
                      <div className="font-semibold">{p.name}</div>
                      <div className="text-xs opacity-70 font-mono">{p.barcode}</div>
                    </div>
                    <div className="font-mono font-bold text-end num">
                      <div>{formatMoney(unitPriceUSD(p, 1), { code: 'USD', symbol: '$' })}</div>
                      <div className="text-[10px] text-success">{(p.price_lbp || Math.round((p.price || 0) * 89500)).toLocaleString()} LL</div>
                    </div>
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Cart Items */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          <AnimatePresence mode="popLayout">
            {cart.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-text-3 italic gap-3">
                <Package size={56} strokeWidth={1} />
                <p>{t('cart_empty', 'Cart is empty')}</p>
              </div>
            ) : (
              cart.map((item: any) => {
                const belowMin = item.min_price && item.min_price > 0 && (item.unit_price ?? unitPriceUSD(item, item.quantity)) < item.min_price;
                return (
                <motion.div
                  key={item.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="p-3 bg-surface border border-border rounded-[var(--radius-card)] group hover:border-border-strong transition-colors"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-text truncate">{item.name}</h3>
                        {item.unit_price != null && (
                          <Badge variant="warning" title={t('pos_override_price', 'Override unit price')}>
                            <Pencil size={10} />
                          </Badge>
                        )}
                        {tierLabel && item.unit_price == null && (
                          <Badge variant="info">{tierLabel}</Badge>
                        )}
                      </div>
                      <p className="text-xs text-text-3 font-mono truncate">
                        {item.barcode} • {formatMoney(item.unit_price != null ? item.unit_price : unitPriceUSD(item, item.quantity), { code: 'USD', symbol: '$' })}/unit
                      </p>
                      {belowMin && (
                        <p className="text-[10px] text-danger font-semibold mt-0.5">
                          {t('pos_below_min_price', 'Price is below the minimum price ({min}) for this product.', { min: formatMoney(item.min_price, { code: 'USD', symbol: '$' }) })}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <div className="flex flex-col items-end gap-1">
                        <button
                          onClick={() => openDiscountEditor(item)}
                          className={`px-2 py-1.5 min-h-[30px] rounded text-[10px] font-bold border cursor-pointer ${item.discount?.value ? 'bg-accent text-white border-accent' : 'border-border text-text-3 hover:text-text hover:border-border-strong'}`}
                        >
                          <Tag size={10} className="inline me-1" />
                          {item.discount?.value ? (item.discount.type === 'percentage' ? `-${item.discount.value}%` : `-$${item.discount.value}`) : t('discount_short', 'DISC')}
                        </button>
                        {allowPriceOverride && (
                          item.unit_price != null ? (
                            <button onClick={() => clearPriceOverride(item.id)} className="text-[10px] text-text-3 hover:text-danger cursor-pointer">
                              {t('cancel', 'Cancel')} {t('pos_override_price', 'Override')}
                            </button>
                          ) : (
                            <button onClick={() => openPriceEditor(item)} className="text-[10px] text-text-3 hover:text-primary cursor-pointer flex items-center gap-1">
                              <Pencil size={9} /> {t('pos_override_price', 'Override unit price')}
                            </button>
                          )
                        )}
                      </div>

                      <div className="flex items-center border border-border rounded-[var(--radius-input)] overflow-hidden h-11">
                        <button
                          onClick={() => updateQuantity(item.id, -1)}
                          className="h-11 w-11 flex items-center justify-center hover:bg-primary hover:text-on-primary transition-colors cursor-pointer text-text"
                        >
                          <Minus size={16} />
                        </button>
                        <input
                          type="number"
                          className="w-14 text-center font-mono font-bold bg-transparent outline-none num text-text"
                          value={item.quantity}
                          onChange={(e) => setItemQuantity(item.id, parseFloat(e.target.value) || 0)}
                          onFocus={(e) => e.target.select()}
                        />
                        <button
                          onClick={() => updateQuantity(item.id, 1)}
                          className="h-11 w-11 flex items-center justify-center hover:bg-primary hover:text-on-primary transition-colors cursor-pointer text-text"
                        >
                          <Plus size={16} />
                        </button>
                      </div>
                      <div className="w-24 text-end font-mono font-bold num text-text">
                        <div>{formatMoney(calculateItemTotal(item), { code: 'USD', symbol: '$' })}</div>
                        <div className="text-[10px] text-success">{Math.round(calculateItemTotalLBP(item)).toLocaleString()} LL</div>
                      </div>
                      <button
                        onClick={() => updateQuantity(item.id, -item.quantity)}
                        className="h-11 w-11 flex items-center justify-center text-danger opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                        aria-label="Remove line"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </div>

                  {/* Inline discount editor */}
                  {discountEditorId === item.id && (
                    <div className="mt-2 pt-2 border-t border-border flex items-center gap-2">
                      <button
                        onClick={() => setDiscountDraft(d => ({ ...d, type: d.type === 'percentage' ? 'fixed' : 'percentage' }))}
                        className="p-2 min-h-[36px] min-w-[36px] flex items-center justify-center bg-surface-2 rounded-[var(--radius-input)] border border-border cursor-pointer text-text"
                      >
                        {discountDraft.type === 'percentage' ? <Percent size={14} /> : <DollarSign size={14} />}
                      </button>
                      <input
                        autoFocus
                        type="number"
                        className="flex-1 h-9 rounded-[var(--radius-input)] border border-border bg-surface px-3 text-sm num text-text outline-none focus:border-primary"
                        value={discountDraft.value}
                        onChange={(e) => setDiscountDraft(d => ({ ...d, value: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveDiscountEditor(); if (e.key === 'Escape') setDiscountEditorId(null); }}
                      />
                      <button onClick={saveDiscountEditor} className="px-3 h-9 bg-primary text-on-primary rounded-[var(--radius-input)] text-xs font-bold cursor-pointer">{t('save', 'Save')}</button>
                      <button onClick={() => setDiscountEditorId(null)} className="p-2 h-9 w-9 flex items-center justify-center text-text-3 cursor-pointer"><X size={14} /></button>
                    </div>
                  )}

                  {/* Inline price-override editor */}
                  {priceEditorId === item.id && (
                    <div className="mt-2 pt-2 border-t border-border flex items-center gap-2">
                      <span className="text-xs text-text-3 shrink-0">{selectedCurrency.symbol}</span>
                      <input
                        autoFocus
                        type="number"
                        className="flex-1 h-9 rounded-[var(--radius-input)] border border-border bg-surface px-3 text-sm num text-text outline-none focus:border-primary"
                        value={priceDraft}
                        onChange={(e) => setPriceDraft(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={(e) => { if (e.key === 'Enter') savePriceEditor(item); if (e.key === 'Escape') setPriceEditorId(null); }}
                      />
                      <button onClick={() => savePriceEditor(item)} className="px-3 h-9 bg-primary text-on-primary rounded-[var(--radius-input)] text-xs font-bold cursor-pointer">{t('save', 'Save')}</button>
                      <button onClick={() => setPriceEditorId(null)} className="p-2 h-9 w-9 flex items-center justify-center text-text-3 cursor-pointer"><X size={14} /></button>
                    </div>
                  )}
                </motion.div>
              );})
            )}
          </AnimatePresence>
        </div>

        {/* Cart Summary */}
        <div className="p-5 bg-surface border-t border-border space-y-4">
          <div className="flex justify-between items-start gap-4">
            <div className="space-y-3 min-w-0">
              <div>
                <p className="text-xs uppercase tracking-wide text-text-3 mb-1">{t('total_amount', 'Total Amount')}</p>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-3xl font-bold tracking-tight num text-text">{formatMoney(totalUSD, { code: 'USD', symbol: '$' })}</span>
                  <span className="text-lg font-bold text-success num">{totalLBP.toLocaleString()} LL</span>
                </div>
                {subtotalUSD !== totalUSD && (
                  <p className="text-xs text-text-3 line-through font-mono mt-1 num">{t('subtotal', 'Subtotal')}: {formatMoney(subtotalUSD, { code: 'USD', symbol: '$' })}</p>
                )}
                {creditLimit > 0 && (
                  <p className={`text-xs font-semibold mt-1 ${availableCredit != null && availableCredit < totalUSD ? 'text-danger' : 'text-text-3'}`}>
                    {t('pos_available_credit', 'Available Credit')}: {formatMoney(availableCredit || 0, { code: 'USD', symbol: '$' })}
                  </p>
                )}

                {!isWalkIn && cart.length > 0 && (() => {
                  const prev = formatBalance(prevBalanceUSD, USD, t);
                  const next = formatBalance(newBalanceUSD, USD, t);
                  const variantClass = (v: 'danger' | 'success' | 'neutral') =>
                    v === 'danger' ? 'text-danger' : v === 'success' ? 'text-success' : 'text-text-3';
                  return (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                      <span className="text-text-3">
                        {t('pos_previous_balance', 'Previous balance')}: <span className={`num font-semibold ${variantClass(prev.variant)}`}>{prev.amount} {prev.label}</span>
                      </span>
                      <span className="text-text-3">
                        {t('pos_this_sale', 'This sale')}: <span className="num font-semibold text-text">{formatMoney(Math.abs(thisSaleEffectUSD), USD)}</span>
                      </span>
                      <span className="text-text-3">
                        {t('pos_new_balance', 'New balance')}: <span className={`num font-semibold ${variantClass(next.variant)}`}>{next.amount} {next.label}</span>
                      </span>
                    </div>
                  );
                })()}
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase text-text-3">{t('global_discount_label', 'Global Discount:')}</span>
                <div className="flex items-center gap-1 bg-bg p-1 rounded border border-border">
                  <button
                    onClick={() => setGlobalDiscount((prev: any) => ({ ...prev, type: prev.type === 'percentage' ? 'fixed' : 'percentage' }))}
                    className="p-1.5 hover:bg-surface-2 rounded cursor-pointer text-text"
                  >
                    {globalDiscount.type === 'percentage' ? <Percent size={12} /> : <DollarSign size={12} />}
                  </button>
                  <input
                    type="number"
                    className="w-14 bg-transparent border-none text-xs font-mono font-bold focus:ring-0 p-0 num text-text"
                    value={globalDiscount.value}
                    onChange={(e) => setGlobalDiscount((prev: any) => ({ ...prev, value: parseFloat(e.target.value) || 0 }))}
                  />
                </div>
              </div>
            </div>

            <div className="text-end shrink-0">
              <div className="flex items-center gap-2 mb-2 justify-end">
                <span className="text-xs text-text-3">{t('display_currency_label', 'Display Currency:')}</span>
                <div className="flex gap-1">
                  {currencies.map((c: any) => (
                    <button
                      key={c.code}
                      onClick={() => setSelectedCurrency(c)}
                      className={`px-2.5 py-1 min-h-[28px] text-[10px] font-bold border rounded cursor-pointer ${selectedCurrency.code === c.code ? 'bg-primary text-on-primary border-primary' : 'border-border text-text-2 hover:border-border-strong'}`}
                    >
                      {c.code}
                    </button>
                  ))}
                </div>
              </div>
              <div className="text-xl font-mono font-bold num text-text">
                {formatMoney(totalUSD * selectedCurrency.rate, selectedCurrency)}
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              disabled={cart.length === 0 || isProcessing}
              onClick={handleQuickCash}
              className="flex-1 py-4 min-h-[52px] bg-success text-white font-bold uppercase tracking-wide flex items-center justify-center gap-2 hover:opacity-90 transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer rounded-[var(--radius-input)]"
            >
              {t('quick_cash', 'Quick Cash')} <Kbd1 /> <Banknote size={20} />
            </button>
            <button
              disabled={cart.length === 0 || isProcessing}
              onClick={() => {
                setPaymentCurrency(selectedCurrency);
                setShowCheckout(true);
              }}
              className="flex-1 py-4 min-h-[52px] bg-primary text-on-primary font-bold uppercase tracking-wide flex items-center justify-center gap-2 hover:bg-primary-hover transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer rounded-[var(--radius-input)]"
            >
              {t('checkout_key', 'Checkout')} <Kbd2 /> <ArrowRight size={20} className="rtl:rotate-180" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// Tiny inline (F3)/(F1) badges — kept local since they're purely decorative next to the buttons.
function Kbd1() { return <span className="text-xs opacity-70">(F3)</span>; }
function Kbd2() { return <span className="text-xs opacity-70">(F1)</span>; }
