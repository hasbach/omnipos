import React, { useState, useEffect, useRef } from 'react';
import {
  ShoppingCart, Banknote, Package, Plus, Minus, Trash2, Barcode, ArrowRight,
  Percent, DollarSign, Tag, X, Pencil
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { usePosContext } from '../context/PosContext';
import { CURRENCIES } from '../hooks/usePos';
import { Badge } from './ui';
import { formatMoney, formatBalance, formatNumber } from '../lib/format';
import { uomUnitPrice } from '../lib/pricing';
import { usePermissions } from '../lib/usePermissions';
import { usePosLayout } from '../hooks/usePosLayout';
import PosLayoutMenu from './PosLayoutMenu';
import { searchProducts, MAX_SUGGESTIONS } from '../lib/productSearch';
import { clampMoneyInput } from '../lib/money';

export default function CartPanel() {
  const pos = usePosContext();
  const {
    products, cart, barcodeInput, setBarcodeInput, isProcessing,
    currencies = CURRENCIES, selectedCurrency, setSelectedCurrency, setShowCheckout, setLastTransaction, setPaymentCurrency,
    globalDiscount, setGlobalDiscount, searchTerm, suggestions, setSuggestions,
    handleBarcodeSubmit, handleSuggestionClick, updateQuantity, setItemQuantity, applyItemDiscount, setItemUnit,
    calculateItemTotal, calculateItemTotalLBP, handleQuickCash, subtotalUSD, totalUSD, totalLBP,
    priceLevel, allowPriceOverride, enforceMinPrice, unitPriceUSD, setItemPriceOverride,
    creditLimit, availableCredit, t, barcodeRef, priceLevelsEnabled, belowCostOf, sellableProducts,
    selectedStakeholder, prevBalanceUSD, thisSaleEffectUSD, newBalanceUSD,
    lastAdded, saleTabs = [], activeTabId, newSaleTab, switchSaleTab, closeSaleTab,
  } = pos as any;

  const { layout } = usePosLayout();
  const compact = layout.density === 'compact';
  const { can } = usePermissions();
  const canDiscount = can('pos.discount');
  const canOverridePrice = can('pos.price_override');

  const [discountEditorId, setDiscountEditorId] = useState<string | null>(null);
  const [discountDraft, setDiscountDraft] = useState<{ type: 'percentage' | 'fixed'; value: string }>({ type: 'percentage', value: '0' });
  const [priceEditorId, setPriceEditorId] = useState<string | null>(null);
  const [priceDraft, setPriceDraft] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const cartListRef = useRef<HTMLDivElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Reset the highlighted suggestion whenever the list changes.
  useEffect(() => { setHighlight(-1); }, [suggestions]);

  // Keep the highlighted suggestion visible in the scrollable dropdown.
  useEffect(() => {
    if (highlight < 0) return;
    suggestionsRef.current?.querySelector<HTMLElement>(`[data-sugg-index="${highlight}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  // Follow the last added / incremented cart line without stealing focus from the barcode input.
  useEffect(() => {
    if (!lastAdded) return;
    const raf = requestAnimationFrame(() => {
      const rows = cartListRef.current?.querySelectorAll<HTMLElement>('[data-line-key]');
      const row = rows && Array.from(rows).find(r => r.dataset.lineKey === lastAdded.key);
      row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
  }, [lastAdded]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(h => Math.min(suggestions.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => Math.max(0, h - 1));
    } else if (e.key === 'Enter' && highlight >= 0 && suggestions[highlight]) {
      e.preventDefault();
      const p = suggestions[highlight];
      const mu = (p.units || []).find((u: any) => u.barcode && u.barcode === barcodeInput.trim());
      handleSuggestionClick(p, mu ? mu.id : null);
    }
  };

  const openDiscountEditor = (item: any) => {
    setDiscountEditorId(item.line_key);
    setDiscountDraft({ type: item.discount?.type || 'percentage', value: String(item.discount?.value ?? 0) });
  };

  const saveDiscountEditor = () => {
    if (discountEditorId == null) return;
    applyItemDiscount(discountEditorId, discountDraft.type, parseFloat(discountDraft.value) || 0);
    setDiscountEditorId(null);
  };

  const openPriceEditor = (item: any) => {
    setPriceEditorId(item.line_key);
    const usd = item.unit_price != null ? item.unit_price : unitPriceUSD(item, item.quantity);
    setPriceDraft((usd * (selectedCurrency?.rate || 1)).toFixed(selectedCurrency?.code === 'USD' ? 2 : 0));
  };

  const savePriceEditor = (item: any) => {
    const raw = parseFloat(priceDraft);
    if (Number.isFinite(raw) && raw >= 0) {
      const usd = raw / (selectedCurrency?.rate || 1);
      setItemPriceOverride(item.line_key, usd);
    }
    setPriceEditorId(null);
  };

  const clearPriceOverride = (key: string) => setItemPriceOverride(key, null);

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
      <div className="flex-1 min-h-0 w-full flex flex-col">
        {/* Sale tabs: several open sales, one active at a time */}
        <div className="flex items-center gap-1 px-2 h-10 shrink-0 border-b border-border bg-surface-2">
          <div role="tablist" aria-label={t('pos_sale_tabs', 'Open sales')} className="flex items-center gap-1 min-w-0 overflow-x-auto">
            {saleTabs.map((tab: any) => {
              const active = tab.id === activeTabId;
              const canClose = saleTabs.length > 1 || tab.lineCount > 0;
              return (
                <div
                  key={tab.id}
                  className={`flex items-center shrink-0 rounded-[var(--radius-input)] border ${active ? 'bg-primary text-on-primary border-primary' : 'bg-surface text-text-2 border-border hover:border-border-strong hover:text-text'}`}
                >
                  <button
                    role="tab"
                    aria-selected={active}
                    onClick={() => switchSaleTab(tab.id)}
                    className="flex items-center gap-1.5 ps-2.5 pe-1.5 h-8 text-xs font-bold cursor-pointer whitespace-nowrap"
                  >
                    <span>{t('pos_sale_n', 'Sale {n}', { n: tab.number })}</span>
                    {tab.lineCount > 0 && (
                      <span className={`px-1.5 rounded-full text-[10px] leading-4 ${active ? 'bg-on-primary/20' : 'bg-primary/15 text-primary'}`}>{tab.lineCount}</span>
                    )}
                    {tab.customerName && <span className="max-w-[90px] truncate font-medium opacity-80">{tab.customerName}</span>}
                  </button>
                  {canClose ? (
                    <button
                      onClick={() => closeSaleTab(tab.id)}
                      aria-label={t('pos_close_sale_n', 'Close sale {n}', { n: tab.number })}
                      className="me-1 p-1 rounded hover:bg-black/10 cursor-pointer"
                    >
                      <X size={12} />
                    </button>
                  ) : <span className="pe-1.5" />}
                </div>
              );
            })}
          </div>
          <button
            onClick={() => newSaleTab()}
            className="flex items-center gap-1.5 shrink-0 px-2.5 h-8 text-xs font-bold text-primary rounded-[var(--radius-input)] hover:bg-surface cursor-pointer whitespace-nowrap"
          >
            <Plus size={14} /> {t('pos_new_sale_tab', 'New sale')} <span className="opacity-70">(Alt+N)</span>
          </button>
          <div className="ms-auto ps-1"><PosLayoutMenu /></div>
        </div>
        {/* Barcode Input Area */}
        <div className={`${compact ? 'px-3 py-2' : 'p-4'} border-b border-border bg-surface relative shrink-0`}>
          <form onSubmit={handleBarcodeSubmit} className="relative">
            <Barcode className="absolute start-3.5 top-1/2 -translate-y-1/2 text-text-3" size={compact ? 18 : 20} />
            <input
              ref={barcodeRef}
              type="text"
              placeholder={t('search_placeholder', 'Scan or search...')}
              className={`w-full ps-11 pe-4 ${compact ? 'py-2 min-h-[44px] text-base' : 'py-4 min-h-[56px] text-lg'} bg-bg border-2 border-transparent focus:border-primary transition-all outline-none font-mono rounded-[var(--radius-input)] text-text`}
              value={barcodeInput}
              onChange={(e) => {
                const val = e.target.value;
                setBarcodeInput(val);
                setSuggestions(searchProducts(sellableProducts || products, val, MAX_SUGGESTIONS));
              }}
              onKeyDown={onSearchKeyDown}
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
                ref={suggestionsRef}
                className="absolute start-3 end-3 top-full mt-1 bg-surface border border-border shadow-[var(--shadow-modal)] z-50 rounded-lg max-h-[60vh] overflow-y-auto"
              >
                {suggestions.map((p: any, idx: number) => {
                  // A typed unit barcode adds that unit (carton/pack) instead of a single piece.
                  const mu = (p.units || []).find((u: any) => u.barcode && u.barcode === barcodeInput.trim());
                  return (
                  <button
                    key={p.id}
                    type="button"
                    data-sugg-index={idx}
                    onClick={() => handleSuggestionClick(p, mu ? mu.id : null)}
                    className={`w-full flex items-center justify-between px-4 py-2.5 hover:bg-primary hover:text-on-primary transition-colors text-start border-b border-border last:border-none cursor-pointer ${idx === highlight ? 'bg-primary text-on-primary' : ''}`}
                  >
                    <div>
                      <div className="font-semibold">
                        {p.name}
                        {mu && <span className="ms-2 text-xs font-bold opacity-80">{mu.name} ×{mu.factor}</span>}
                      </div>
                      <div className="text-xs opacity-70 font-mono">{mu ? mu.barcode : p.barcode}</div>
                    </div>
                    <div className="font-mono font-bold text-end num">
                      <div>{formatMoney(mu ? uomUnitPrice(p, mu, priceLevel) : unitPriceUSD(p, 1), { code: 'USD', symbol: '$' })}</div>
                      {!mu && <div className="text-[10px] text-success">{formatNumber(p.price_lbp || Math.round((p.price || 0) * 89500), { decimals: 0 })} LL</div>}
                    </div>
                  </button>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Cart Items */}
        <div ref={cartListRef} className={`flex-1 min-h-0 overflow-y-auto ${compact ? 'p-2 space-y-1.5' : 'p-3 space-y-2'}`}>
          <AnimatePresence mode="popLayout">
            {cart.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-text-3 italic gap-3">
                <Package size={56} strokeWidth={1} />
                <p>{t('cart_empty', 'Cart is empty')}</p>
              </div>
            ) : (
              cart.map((item: any) => {
                const belowMin = item.min_price && item.min_price > 0 && (item.unit_price ?? unitPriceUSD(item, item.quantity)) < item.min_price;
                const belowCost = belowCostOf ? belowCostOf(item) : null;
                const unit = item.uom_id != null ? (item.units || []).find((u: any) => u.id === item.uom_id) : null;
                const unitPrice = item.unit_price != null ? item.unit_price : unitPriceUSD(item, item.quantity);
                const baseLabel = item.unit || t('uom_piece', 'Piece');
                const stepH = compact ? 'h-10' : 'h-11';
                const stepBtn = compact ? 'h-10 w-10' : 'h-11 w-11';
                return (
                <motion.div
                  key={item.line_key}
                  data-line-key={item.line_key}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className={`${compact ? 'px-2.5 py-1.5 min-h-[52px]' : 'p-3'} bg-surface border border-border rounded-[var(--radius-card)] group hover:border-border-strong transition-colors`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <h3 className={`font-semibold text-text truncate ${compact ? 'text-sm leading-5' : ''}`} title={item.name}>{item.name}</h3>
                        {item.unit_price != null && (
                          <Badge variant="warning" title={t('pos_override_price', 'Override unit price')}>
                            <Pencil size={10} />
                          </Badge>
                        )}
                        {tierLabel && item.unit_price == null && (
                          <Badge variant="info">{tierLabel}</Badge>
                        )}
                      </div>
                      {!unit ? (
                        <p className="text-[11px] leading-4 text-text-3 font-mono truncate">
                          {item.barcode} • {formatMoney(unitPrice, { code: 'USD', symbol: '$' })}/{t('uom_unit_short', 'unit')}
                        </p>
                      ) : (
                        <p className="text-[11px] leading-4 text-text-3 font-mono truncate">
                          {formatNumber(item.quantity, { decimals: 0 })} × {unit.name} ({unit.factor} {baseLabel}) • {formatMoney(unitPrice, { code: 'USD', symbol: '$' })} / {unit.name} • = {formatNumber(item.quantity * unit.factor, { decimals: 0 })} {baseLabel}{unit.barcode ? ` • ${unit.barcode}` : ''}
                        </p>
                      )}
                      {belowCost != null && (
                        <p className="text-[10px] leading-4 text-danger font-semibold">
                          {t('pos_below_cost', 'Below cost ({cost}) - raise the price to sell this product.', { cost: formatMoney(belowCost, { code: 'USD', symbol: '$' }) })}
                        </p>
                      )}
                      {belowMin && (
                        <p className="text-[10px] leading-4 text-danger font-semibold">
                          {t('pos_below_min_price', 'Price is below the minimum price ({min}) for this product.', { min: formatMoney(item.min_price, { code: 'USD', symbol: '$' }) })}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {Array.isArray(item.units) && item.units.length > 0 && (
                        <select
                          aria-label={t('uom_select_unit', 'Unit of measure')}
                          value={item.uom_id ?? ''}
                          onChange={(e) => setItemUnit(item.line_key, e.target.value === '' ? null : Number(e.target.value))}
                          className="h-8 max-w-[110px] rounded-[var(--radius-input)] border border-border bg-surface px-1.5 text-xs font-semibold text-text outline-none focus:border-primary cursor-pointer"
                        >
                          <option value="">{item.unit || t('uom_piece', 'Piece')}</option>
                          {item.units.map((u: any) => (
                            <option key={u.id} value={u.id}>{u.name} ×{u.factor}</option>
                          ))}
                        </select>
                      )}

                      <div className="flex items-center gap-1">
                        {(canDiscount || item.discount?.value) && <button
                          disabled={!canDiscount}
                          onClick={() => openDiscountEditor(item)}
                          className={`px-2 h-8 min-w-[40px] rounded text-[10px] font-bold border cursor-pointer whitespace-nowrap ${item.discount?.value ? 'bg-accent text-white border-accent' : 'border-border text-text-3 hover:text-text hover:border-border-strong'}`}
                        >
                          <Tag size={10} className="inline me-1" />
                          {item.discount?.value ? (item.discount.type === 'percentage' ? `-${item.discount.value}%` : `-$${item.discount.value}`) : t('discount_short', 'DISC')}
                        </button>}
                        {allowPriceOverride && canOverridePrice && (
                          item.unit_price != null ? (
                            <button
                              onClick={() => clearPriceOverride(item.line_key)}
                              title={`${t('cancel', 'Cancel')} ${t('pos_override_price', 'Override')}`}
                              aria-label={`${t('cancel', 'Cancel')} ${t('pos_override_price', 'Override')}`}
                              className="h-8 w-8 flex items-center justify-center rounded border border-border text-text-3 hover:text-danger hover:border-danger cursor-pointer"
                            >
                              <X size={14} />
                            </button>
                          ) : (
                            <button
                              onClick={() => openPriceEditor(item)}
                              title={t('pos_override_price', 'Override unit price')}
                              aria-label={t('pos_override_price', 'Override unit price')}
                              className="h-8 w-8 flex items-center justify-center rounded border border-border text-text-3 hover:text-primary hover:border-primary cursor-pointer"
                            >
                              <Pencil size={13} />
                            </button>
                          )
                        )}
                      </div>

                      <div className={`flex items-center border border-border rounded-[var(--radius-input)] overflow-hidden ${stepH}`}>
                        <button
                          onClick={() => updateQuantity(item.line_key, -1)}
                          className={`${stepBtn} flex items-center justify-center hover:bg-primary hover:text-on-primary transition-colors cursor-pointer text-text`}
                        >
                          <Minus size={16} />
                        </button>
                        <input
                          type="number"
                          className="w-12 text-center font-mono font-bold bg-transparent outline-none num text-text"
                          value={item.quantity}
                          onChange={(e) => setItemQuantity(item.line_key, parseFloat(e.target.value) || 0)}
                          onFocus={(e) => e.target.select()}
                        />
                        <button
                          onClick={() => updateQuantity(item.line_key, 1)}
                          className={`${stepBtn} flex items-center justify-center hover:bg-primary hover:text-on-primary transition-colors cursor-pointer text-text`}
                        >
                          <Plus size={16} />
                        </button>
                      </div>
                      <div className="w-24 text-end font-mono font-bold num text-text leading-tight">
                        <div className="text-sm">{formatMoney(calculateItemTotal(item), { code: 'USD', symbol: '$' })}</div>
                        <div className="text-[10px] text-success">{formatNumber(Math.round(calculateItemTotalLBP(item)), { decimals: 0 })} LL</div>
                      </div>
                      <button
                        onClick={() => updateQuantity(item.line_key, -item.quantity)}
                        className={`${compact ? 'h-10 w-9' : 'h-11 w-11'} flex items-center justify-center text-danger opacity-40 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer`}
                        aria-label={t('pos_remove_line', 'Remove line')}
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </div>


                  {/* Inline discount editor */}
                  {discountEditorId === item.line_key && (
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
                        onChange={(e) => setDiscountDraft(d => ({ ...d, value: d.type === 'fixed' ? clampMoneyInput(e.target.value) : e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveDiscountEditor(); if (e.key === 'Escape') setDiscountEditorId(null); }}
                      />
                      <button onClick={saveDiscountEditor} className="px-3 h-9 bg-primary text-on-primary rounded-[var(--radius-input)] text-xs font-bold cursor-pointer">{t('save', 'Save')}</button>
                      <button onClick={() => setDiscountEditorId(null)} className="p-2 h-9 w-9 flex items-center justify-center text-text-3 cursor-pointer"><X size={14} /></button>
                    </div>
                  )}

                  {/* Inline price-override editor */}
                  {priceEditorId === item.line_key && (
                    <div className="mt-2 pt-2 border-t border-border flex items-center gap-2">
                      <span className="text-xs text-text-3 shrink-0">{selectedCurrency.symbol}</span>
                      <input
                        autoFocus
                        type="number"
                        className="flex-1 h-9 rounded-[var(--radius-input)] border border-border bg-surface px-3 text-sm num text-text outline-none focus:border-primary"
                        value={priceDraft}
                        onChange={(e) => setPriceDraft(clampMoneyInput(e.target.value))}
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
        <div className={`${compact ? 'px-3 py-2 space-y-2' : 'p-5 space-y-4'} bg-surface border-t border-border shrink-0`}>
          <div className="flex justify-between items-center gap-3">
            <div className="min-w-0 flex items-baseline gap-x-2 flex-wrap">
              <span className="text-xs uppercase tracking-wide text-text-3">{t('total_amount', 'Total Amount')}</span>
              <span className={`${compact ? 'text-2xl' : 'text-3xl'} font-bold tracking-tight num text-text`}>{formatMoney(totalUSD, { code: 'USD', symbol: '$' })}</span>
              <span className={`${compact ? 'text-base' : 'text-lg'} font-bold text-success num`}>{formatNumber(totalLBP, { decimals: 0 })} LL</span>
              {subtotalUSD !== totalUSD && (
                <span className="text-xs text-text-3 line-through font-mono num">{t('subtotal', 'Subtotal')}: {formatMoney(subtotalUSD, { code: 'USD', symbol: '$' })}</span>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-text-3 hidden xl:inline">{t('display_currency_label', 'Display Currency:')}</span>
              <div className="flex gap-1">
                {currencies.map((c: any) => (
                  <button
                    key={c.code}
                    onClick={() => setSelectedCurrency(c)}
                    aria-pressed={selectedCurrency.code === c.code}
                    title={t('display_currency_label', 'Display Currency:')}
                    className={`px-2.5 min-h-[32px] text-[10px] font-bold border rounded cursor-pointer ${selectedCurrency.code === c.code ? 'bg-primary text-on-primary border-primary' : 'border-border text-text-2 hover:border-border-strong'}`}
                  >
                    {c.code}
                  </button>
                ))}
              </div>
              <div className="text-lg font-mono font-bold num text-text whitespace-nowrap">
                {formatMoney(totalUSD * selectedCurrency.rate, selectedCurrency)}
              </div>
            </div>
          </div>

          {(canDiscount || creditLimit > 0 || (!isWalkIn && cart.length > 0)) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              {canDiscount && <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase text-text-3">{t('global_discount_label', 'Global Discount:')}</span>
                <div className="flex items-center gap-1 bg-bg p-0.5 rounded border border-border">
                  <button
                    onClick={() => setGlobalDiscount((prev: any) => ({ ...prev, type: prev.type === 'percentage' ? 'fixed' : 'percentage' }))}
                    className="h-7 w-7 flex items-center justify-center hover:bg-surface-2 rounded cursor-pointer text-text"
                  >
                    {globalDiscount.type === 'percentage' ? <Percent size={12} /> : <DollarSign size={12} />}
                  </button>
                  <input
                    type="number"
                    className="w-14 bg-transparent border-none text-xs font-mono font-bold focus:ring-0 p-0 num text-text"
                    value={globalDiscount.value}
                    onChange={(e) => setGlobalDiscount((prev: any) => ({ ...prev, value: parseFloat(prev.type === 'fixed' ? clampMoneyInput(e.target.value) : e.target.value) || 0 }))}
                  />
                </div>
              </div>}
              {creditLimit > 0 && (
                <span className={`font-semibold ${availableCredit != null && availableCredit < totalUSD ? 'text-danger' : 'text-text-3'}`}>
                  {t('pos_available_credit', 'Available Credit')}: {formatMoney(availableCredit || 0, { code: 'USD', symbol: '$' })}
                </span>
              )}
              {!isWalkIn && cart.length > 0 && (() => {
                const prev = formatBalance(prevBalanceUSD, USD, t);
                const next = formatBalance(newBalanceUSD, USD, t);
                const variantClass = (v: 'danger' | 'success' | 'neutral') =>
                  v === 'danger' ? 'text-danger' : v === 'success' ? 'text-success' : 'text-text-3';
                return (
                  <>
                    <span className="text-text-3">
                      {t('pos_previous_balance', 'Previous balance')}: <span className={`num font-semibold ${variantClass(prev.variant)}`}>{prev.amount} {prev.label}</span>
                    </span>
                    <span className="text-text-3">
                      {t('pos_this_sale', 'This sale')}: <span className="num font-semibold text-text">{formatMoney(Math.abs(thisSaleEffectUSD), USD)}</span>
                    </span>
                    <span className="text-text-3">
                      {t('pos_new_balance', 'New balance')}: <span className={`num font-semibold ${variantClass(next.variant)}`}>{next.amount} {next.label}</span>
                    </span>
                  </>
                );
              })()}
            </div>
          )}

          <div className="flex gap-2">
            <button
              disabled={cart.length === 0 || isProcessing}
              onClick={handleQuickCash}
              className="flex-1 py-2 min-h-[52px] bg-success text-white font-bold uppercase tracking-wide flex items-center justify-center gap-2 hover:opacity-90 transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer rounded-[var(--radius-input)]"
            >
              {t('quick_cash', 'Quick Cash')} <Kbd1 /> <Banknote size={20} />
            </button>
            <button
              disabled={cart.length === 0 || isProcessing}
              onClick={() => {
                setLastTransaction?.(null);
                setPaymentCurrency(selectedCurrency);
                setShowCheckout(true);
              }}
              className="flex-1 py-2 min-h-[52px] bg-primary text-on-primary font-bold uppercase tracking-wide flex items-center justify-center gap-2 hover:bg-primary-hover transition-all disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer rounded-[var(--radius-input)]"
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
