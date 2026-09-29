import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Package, ChevronLeft, ChevronRight, ChevronsUpDown, ChevronsDownUp } from 'lucide-react';
import { usePosContext } from '../context/PosContext';
import { useI18n } from '../intl/index';
import { Badge } from './ui';
import { formatMoney } from '../lib/format';
import { usePosLayout } from '../hooks/usePosLayout';

const TILE = {
  sm: { min: 112, h: 'min-h-[68px]', pad: 'p-2', name: 'text-xs', price: 'text-xs' },
  md: { min: 150, h: 'min-h-[92px]', pad: 'p-3', name: 'text-sm', price: 'text-sm' },
  lg: { min: 210, h: 'min-h-[120px]', pad: 'p-4', name: 'text-base', price: 'text-base' },
} as const;

const COLLAPSE_KEY = 'pos_categories_collapsed';

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}

export default function ProductGrid() {
  const { dir } = useI18n();
  const isRtl = dir === 'rtl';
  const pos = usePosContext();
  const {
    searchTerm, setSearchTerm, selectedCategory, setSelectedCategory,
    addToCart, categories, filteredProducts, totalPages, paginatedProducts,
    currentPage, setCurrentPage, unitPriceUSD, priceLevel, t,
  } = pos as any;

  const { layout } = usePosLayout();
  const tile = TILE[layout.tileSize];
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* storage unavailable */ }
      return next;
    });
  };

  // scrollLeft is zero/negative in RTL browsers, so compare absolute offsets.
  const updateArrows = useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const pos = Math.abs(el.scrollLeft);
    setCanPrev(pos > 2);
    setCanNext(pos < max - 2);
  }, []);

  useEffect(() => {
    updateArrows();
    const el = rowRef.current;
    if (!el) return;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateArrows) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [updateArrows, categories, collapsed]);

  // Keep the active chip visible (also after collapse/expand or an external category change).
  useEffect(() => {
    const chip = rowRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    chip?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedCategory, collapsed]);

  const scrollByPage = (towardsEnd: boolean) => {
    const el = rowRef.current;
    if (!el) return;
    const sign = (towardsEnd ? 1 : -1) * (isRtl ? -1 : 1);
    el.scrollBy({ left: sign * Math.max(120, el.clientWidth * 0.7), behavior: 'smooth' });
  };

  const stockBadge = (p: any) => {
    if (p.track_inventory === 0) return null;
    const stock = p.stock ?? 0;
    const reorder = p.reorder_point ?? 0;
    if (stock <= 0) return <Badge variant="danger">{t('pos_out_of_stock', 'Out of Stock')}</Badge>;
    if (reorder > 0 && stock <= reorder) return <Badge variant="warning">{t('pos_low_stock', 'Low Stock')} · {stock}</Badge>;
    return <Badge variant="neutral">{stock} {p.unit}</Badge>;
  };

  const arrowCls = 'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-border text-text-2 hover:border-border-strong disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer';
  const toggleLabel = collapsed ? t('pos_categories_expand', 'Show all categories') : t('pos_categories_collapse', 'Show only the selected category');

  return (
    <div className="w-full h-full bg-bg flex flex-col overflow-hidden">
      <div className="p-3 border-b border-border flex flex-col gap-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Package size={16} className="text-text-3" />
          <h2 className="text-xs font-bold uppercase tracking-wide text-text-2">{t('product_catalog', 'Product Catalog')}</h2>
        </div>

        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 text-text-3" size={14} />
            <input
              type="text"
              placeholder={t('search_products', 'Search products...')}
              className="w-full ps-9 pe-3 py-2.5 min-h-[40px] bg-surface border border-border rounded-[var(--radius-input)] text-sm focus:border-primary outline-none transition-all text-text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-1" role="group" aria-label={t('pos_categories', 'Categories')}>
            {!collapsed && (
              <button
                type="button"
                onClick={() => scrollByPage(false)}
                disabled={!canPrev}
                aria-label={t('pos_categories_prev', 'Previous categories')}
                className={arrowCls}
              >
                {isRtl ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronLeft size={16} aria-hidden="true" />}
              </button>
            )}
            <div
              ref={rowRef}
              onScroll={updateArrows}
              className="flex min-w-0 flex-1 flex-nowrap gap-1.5 overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {categories
                .filter((cat: string) => !collapsed || cat === selectedCategory)
                .map((cat: string) => (
                  <button
                    key={cat}
                    type="button"
                    data-active={selectedCategory === cat}
                    aria-pressed={selectedCategory === cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`flex-shrink-0 whitespace-nowrap px-3 py-1.5 min-h-[32px] text-xs font-semibold border transition-all rounded-lg cursor-pointer ${selectedCategory === cat ? 'bg-primary text-on-primary border-primary' : 'border-border text-text-2 hover:border-border-strong'}`}
                  >
                    {cat === 'All' ? t('category_all', 'All') : cat}
                  </button>
                ))}
            </div>
            {!collapsed && (
              <button
                type="button"
                onClick={() => scrollByPage(true)}
                disabled={!canNext}
                aria-label={t('pos_categories_next', 'Next categories')}
                className={arrowCls}
              >
                {isRtl ? <ChevronLeft size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
              </button>
            )}
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-expanded={!collapsed}
              aria-label={toggleLabel}
              title={toggleLabel}
              className={arrowCls}
            >
              {collapsed ? <ChevronsUpDown size={16} aria-hidden="true" /> : <ChevronsDownUp size={16} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </div>

      {/* Scrollable Product Grid */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 grid gap-2 content-start" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tile.min}px, 1fr))` }}>
        {paginatedProducts.map((p: any) => {
          const unit = unitPriceUSD(p, 1);
          return (
          <button
            key={p.id}
            onClick={() => addToCart(p)}
            disabled={p.track_inventory !== 0 && (p.stock ?? 0) <= 0}
            className={`${tile.pad} ${tile.h} bg-surface border border-border rounded-[var(--radius-card)] text-start hover:border-primary hover:shadow-[var(--shadow-card)] transition-all active:scale-[0.98] group flex flex-col justify-between gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer`}
          >
            <div className={`${tile.name} font-semibold text-text truncate group-hover:text-primary transition-colors`} title={p.name}>{p.name}</div>
            <div className="flex justify-between items-end gap-1">
              <div className="min-w-0">
                <div className={`${tile.price} font-bold num text-text`}>{formatMoney(unit, { code: 'USD', symbol: '$' })}</div>
                <div className="text-[10px] text-text-3 uppercase font-semibold truncate">{p.category}</div>
              </div>
              {stockBadge(p)}
            </div>
          </button>
        );})}
        {filteredProducts.length === 0 && (
          <div className="col-span-full py-8 text-center text-text-3 italic text-xs">
            {t('no_products_found', 'No products found')}
          </div>
        )}
      </div>

      {/* Pagination Controls - always visible at bottom */}
      {totalPages > 1 && (
        <div className="p-3 border-t border-border flex justify-between items-center bg-surface flex-shrink-0">
          <button
            disabled={currentPage === 1}
            onClick={() => setCurrentPage((prev: number) => Math.max(1, prev - 1))}
            className="px-3 py-2 min-h-[36px] bg-primary text-on-primary text-[10px] font-bold uppercase tracking-wide rounded disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
          >
            {t('prev', 'Prev')}
          </button>
          <span className="text-[10px] font-bold text-text-3">{t('page', 'Page')} {currentPage} {t('of', 'of')} {totalPages}</span>
          <button
            disabled={currentPage === totalPages}
            onClick={() => setCurrentPage((prev: number) => Math.min(totalPages, prev + 1))}
            className="px-3 py-2 min-h-[36px] bg-primary text-on-primary text-[10px] font-bold uppercase tracking-wide rounded disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
          >
            {t('next', 'Next')}
          </button>
        </div>
      )}
    </div>
  );
}
