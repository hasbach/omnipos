import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Boxes, DollarSign, ListOrdered, PackageX } from 'lucide-react';

import {
  PageHeader,
  Toolbar,
  SearchInput,
  Select,
  Tabs,
  DataTable,
  DataTableColumn,
  StatCard,
  Badge,
  Button,
  useToast,
} from '../components/ui';
import { useI18n } from '../intl/index';
import { api } from '../lib/api';
import { usePermissions } from '../lib/usePermissions';
import { formatDateTime, formatMoney } from '../lib/format';
import { Product, Currency } from '../types';
import { AdjustStockModal, AdjustStockTarget } from './stock/AdjustStockModal';
import { MovementsDrawer } from './stock/MovementsDrawer';

type StatusFilter = 'all' | 'low' | 'out';

interface InventoryValuationRow {
  product_id: number;
  stock: number;
  cost: number;
  value_cost: number;
  price: number;
  value_retail: number;
}

interface InventoryValuationResponse {
  rows: InventoryValuationRow[];
  totals: { value_cost: number; value_retail: number; potential_profit: number; product_count: number };
}

interface LowStockRow {
  product_id: number;
  stock: number;
  reorder_point: number;
}

interface StockAdjustmentRow {
  id: number;
  product_id: number;
  product_name: string;
  user_name: string | null;
  qty_before: number;
  qty_after: number;
  delta: number;
  reason: string | null;
  created_at: string;
}

export default function StockManagement() {
  const { t, lang } = useI18n();
  const toast = useToast();

  const [products, setProducts] = useState<Product[]>([]);
  const [valuation, setValuation] = useState<InventoryValuationResponse | null>(null);
  const [lowStock, setLowStock] = useState<LowStockRow[]>([]);
  const [adjustments, setAdjustments] = useState<StockAdjustmentRow[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loading, setLoading] = useState(true);
  const [adjustmentsLoading, setAdjustmentsLoading] = useState(false);

  const [tab, setTab] = useState<'levels' | 'adjustments'>('levels');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');

  const [adjustTarget, setAdjustTarget] = useState<AdjustStockTarget | null>(null);
  const [movementsTarget, setMovementsTarget] = useState<{ id: number; name: string } | null>(null);

  const fetchAll = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get<Product[]>('/api/products'),
      api.get<InventoryValuationResponse>('/api/reports/inventory-valuation'),
      api.get<LowStockRow[]>('/api/reports/low-stock'),
    ])
      .then(([p, v, l]) => {
        setProducts(p);
        setValuation(v);
        setLowStock(l);
      })
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [toast]);

  const fetchAdjustments = useCallback(() => {
    setAdjustmentsLoading(true);
    api
      .get<StockAdjustmentRow[]>('/api/stock/adjustments')
      .then(setAdjustments)
      .catch((err) => toast.error(err.message))
      .finally(() => setAdjustmentsLoading(false));
  }, [toast]);

  useEffect(() => {
    fetchAll();
    api.get<Currency[]>('/api/currencies').then(setCurrencies).catch(() => {});

    const handleSync = (e: any) => {
      if (e.detail?.type === 'PRODUCTS_UPDATED') fetchAll();
    };
    window.addEventListener('pos-sync', handleSync);
    return () => window.removeEventListener('pos-sync', handleSync);
  }, [fetchAll]);

  useEffect(() => {
    if (tab === 'adjustments') fetchAdjustments();
  }, [tab, fetchAdjustments]);

  const { can } = usePermissions();
  const canAdjust = can('stock.adjust');

  const usdCurrency = useMemo(() => currencies.find((c) => c.code === 'USD') || { code: 'USD', symbol: '$', rate: 1 }, [currencies]);

  const trackedProducts = useMemo(() => products.filter((p) => p.track_inventory !== 0), [products]);
  const categories = useMemo(() => Array.from(new Set(trackedProducts.map((p) => p.category).filter(Boolean))).sort(), [trackedProducts]);

  const lowStockCount = useMemo(() => lowStock.filter((r) => r.stock > 0).length, [lowStock]);
  const outOfStockCount = useMemo(() => lowStock.filter((r) => r.stock <= 0).length, [lowStock]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return trackedProducts.filter((p) => {
      if (q && !p.name.toLowerCase().includes(q) && !(p.barcode || '').includes(search)) return false;
      if (category && p.category !== category) return false;
      const out = p.stock <= 0;
      const low = !out && p.stock > 0 && (p.reorder_point || 0) > 0 && p.stock <= (p.reorder_point || 0);
      if (status === 'low' && !low) return false;
      if (status === 'out' && !out) return false;
      return true;
    });
  }, [trackedProducts, search, category, status]);

  const openAdjust = (p: Product) => setAdjustTarget({ id: p.id, name: p.name, stock: p.stock, unit: p.unit });
  const openMovements = (p: Product) => setMovementsTarget({ id: p.id, name: p.name });

  const levelColumns = useMemo<DataTableColumn<Product>[]>(
    () => [
      {
        key: 'name',
        header: t('stock_col_product', 'Product'),
        sortable: true,
        render: (p) => (
          <div>
            <div className="font-medium text-text">{p.name}</div>
            <div className="font-mono text-xs text-text-3">{p.barcode}</div>
          </div>
        ),
      },
      { key: 'category', header: t('stock_col_category', 'Category'), sortable: true, render: (p) => <span className="text-text-3">{p.category}</span> },
      {
        key: 'stock',
        header: t('stock_col_stock', 'Current stock'),
        align: 'end',
        sortable: true,
        render: (p) => (
          <span className="num font-semibold text-text">
            {p.stock} {p.unit}
          </span>
        ),
      },
      {
        key: 'reorder_point',
        header: t('stock_col_reorder', 'Reorder point'),
        align: 'end',
        sortable: true,
        render: (p) => <span className="num text-text-3">{p.reorder_point || 0}</span>,
      },
      {
        key: 'status',
        header: t('stock_col_status', 'Status'),
        render: (p) => {
          const out = p.stock <= 0;
          const low = !out && (p.reorder_point || 0) > 0 && p.stock <= (p.reorder_point || 0);
          if (out) return <Badge variant="danger">{t('stock_status_out', 'Out of stock')}</Badge>;
          if (low) return <Badge variant="warning">{t('stock_status_low', 'Low stock')}</Badge>;
          return <Badge variant="success">{t('stock_status_in', 'In stock')}</Badge>;
        },
      },
      {
        key: 'actions',
        header: t('stock_col_actions', 'Actions'),
        align: 'end',
        render: (p) => (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); openMovements(p); }}>
              {t('stock_movements', 'Movements')}
            </Button>
            {canAdjust && (
              <Button size="sm" variant="primary" onClick={(e) => { e.stopPropagation(); openAdjust(p); }}>
                {t('stock_adjust', 'Adjust')}
              </Button>
            )}
          </div>
        ),
      },
    ],
    [t, canAdjust],
  );

  const adjustmentColumns = useMemo<DataTableColumn<StockAdjustmentRow>[]>(
    () => [
      {
        key: 'created_at',
        header: t('stock_adjustments_col_date', 'Date'),
        sortable: true,
        render: (r) => <span className="text-text-3">{formatDateTime(r.created_at, lang)}</span>,
      },
      { key: 'product_name', header: t('stock_adjustments_col_product', 'Product'), sortable: true, render: (r) => <span className="font-medium text-text">{r.product_name}</span> },
      {
        key: 'delta',
        header: t('stock_adjustments_col_change', 'Change'),
        align: 'end',
        sortable: true,
        render: (r) => <span className={`num font-semibold ${r.delta < 0 ? 'text-danger' : 'text-success'}`}>{r.delta > 0 ? `+${r.delta}` : r.delta}</span>,
      },
      { key: 'qty_before', header: t('stock_adjustments_col_before', 'Before'), align: 'end', render: (r) => <span className="num text-text-3">{r.qty_before}</span> },
      { key: 'qty_after', header: t('stock_adjustments_col_after', 'After'), align: 'end', render: (r) => <span className="num text-text">{r.qty_after}</span> },
      { key: 'reason', header: t('stock_adjustments_col_reason', 'Reason'), render: (r) => <span className="text-text-3">{r.reason || '—'}</span> },
      { key: 'user_name', header: t('stock_adjustments_col_user', 'User'), render: (r) => <span className="text-text-3">{r.user_name || '—'}</span> },
    ],
    [t, lang],
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t('stock_title', 'Stock')} subtitle={t('stock_subtitle')} />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label={t('stock_kpi_tracked_skus', 'Tracked SKUs')} value={valuation?.totals.product_count ?? 0} icon={Boxes} />
        <StatCard label={t('stock_kpi_value_cost', 'Inventory value (cost)')} value={formatMoney(valuation?.totals.value_cost || 0, usdCurrency)} icon={DollarSign} />
        <StatCard label={t('stock_kpi_value_retail', 'Inventory value (retail)')} value={formatMoney(valuation?.totals.value_retail || 0, usdCurrency)} icon={ListOrdered} />
        <StatCard label={t('stock_kpi_low', 'Low stock')} value={lowStockCount} icon={AlertTriangle} />
        <StatCard label={t('stock_kpi_out', 'Out of stock')} value={outOfStockCount} icon={PackageX} />
      </div>

      <Tabs
        className="mb-3"
        value={tab}
        onChange={(v) => setTab(v as any)}
        items={[
          { value: 'levels', label: t('stock_tab_levels', 'Stock levels') },
          { value: 'adjustments', label: t('stock_tab_adjustments', 'Recent adjustments') },
        ]}
      />

      {tab === 'levels' ? (
        <>
          <Toolbar className="mb-3">
            <SearchInput value={search} onChange={setSearch} placeholder={t('stock_search_placeholder')} className="max-w-sm" />
            <Select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              options={[{ value: '', label: t('stock_filter_category_all', 'All categories') }, ...categories.map((c) => ({ value: c, label: c }))]}
              className="w-44"
            />
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              options={[
                { value: 'all', label: t('stock_filter_status_all', 'All stock') },
                { value: 'low', label: t('stock_filter_status_low', 'Low stock') },
                { value: 'out', label: t('stock_filter_status_out', 'Out of stock') },
              ]}
              className="w-40"
            />
          </Toolbar>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            <DataTable
              columns={levelColumns}
              data={filtered}
              rowKey={(p) => p.id}
              loading={loading}
              emptyTitle={t('stock_empty_title', 'No products found')}
              emptyDescription={t('stock_empty_desc')}
              pageSizeOptions={[25, 50, 100]}
              defaultPageSize={25}
            />
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <DataTable
            columns={adjustmentColumns}
            data={adjustments}
            rowKey={(r) => r.id}
            loading={adjustmentsLoading}
            emptyTitle={t('stock_adjustments_empty', 'No adjustments recorded yet.')}
            pageSizeOptions={[25, 50, 100]}
            defaultPageSize={25}
          />
        </div>
      )}

      <AdjustStockModal
        open={!!adjustTarget}
        product={adjustTarget}
        onClose={() => setAdjustTarget(null)}
        onSaved={() => {
          fetchAll();
          if (tab === 'adjustments') fetchAdjustments();
        }}
      />

      <MovementsDrawer
        open={!!movementsTarget}
        productId={movementsTarget?.id ?? null}
        productName={movementsTarget?.name}
        onClose={() => setMovementsTarget(null)}
      />
    </div>
  );
}
