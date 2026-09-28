import React from 'react';
import { Search, Package } from 'lucide-react';
import { usePosContext } from '../context/PosContext';
import { Badge } from './ui';
import { formatMoney } from '../lib/format';

export default function ProductGrid() {
  const pos = usePosContext();
  const {
    searchTerm, setSearchTerm, selectedCategory, setSelectedCategory,
    addToCart, categories, filteredProducts, totalPages, paginatedProducts,
    currentPage, setCurrentPage, unitPriceUSD, priceLevel, t,
  } = pos as any;

  const stockBadge = (p: any) => {
    if (p.track_inventory === 0) return null;
    const stock = p.stock ?? 0;
    const reorder = p.reorder_point ?? 0;
    if (stock <= 0) return <Badge variant="danger">{t('pos_out_of_stock', 'Out of Stock')}</Badge>;
    if (reorder > 0 && stock <= reorder) return <Badge variant="warning">{t('pos_low_stock', 'Low Stock')} · {stock}</Badge>;
    return <Badge variant="neutral">{stock} {p.unit}</Badge>;
  };

  return (
    <div className="w-1/3 bg-bg flex flex-col overflow-hidden">
      <div className="p-4 border-b border-border flex flex-col gap-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Package size={16} className="text-text-3" />
          <h2 className="text-xs font-bold uppercase tracking-wide text-text-2">{t('product_catalog', 'Product Catalog')}</h2>
        </div>

        <div className="space-y-2.5">
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

          <div className="flex flex-wrap gap-1.5">
            {categories.map((cat: string) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-3 py-2 min-h-[36px] text-xs font-semibold border transition-all rounded-lg cursor-pointer ${selectedCategory === cat ? 'bg-primary text-on-primary border-primary' : 'border-border text-text-2 hover:border-border-strong'}`}
              >
                {cat === 'All' ? t('category_all', 'All') : cat}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Scrollable Product Grid */}
      <div className="flex-1 overflow-y-auto p-3 grid grid-cols-2 gap-2 content-start">
        {paginatedProducts.map((p: any) => {
          const unit = unitPriceUSD(p, 1);
          return (
          <button
            key={p.id}
            onClick={() => addToCart(p)}
            disabled={p.track_inventory !== 0 && (p.stock ?? 0) <= 0}
            className="p-3 min-h-[92px] bg-surface border border-border rounded-[var(--radius-card)] text-start hover:border-primary hover:shadow-[var(--shadow-card)] transition-all active:scale-[0.98] group flex flex-col justify-between gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            <div className="text-sm font-semibold text-text truncate group-hover:text-primary transition-colors">{p.name}</div>
            <div className="flex justify-between items-end gap-1">
              <div className="min-w-0">
                <div className="text-sm font-bold num text-text">{formatMoney(unit, { code: 'USD', symbol: '$' })}</div>
                <div className="text-[10px] text-text-3 uppercase font-semibold truncate">{p.category}</div>
              </div>
              {stockBadge(p)}
            </div>
          </button>
        );})}
        {filteredProducts.length === 0 && (
          <div className="col-span-2 py-8 text-center text-text-3 italic text-xs">
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
