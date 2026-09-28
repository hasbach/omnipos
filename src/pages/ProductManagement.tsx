import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence } from 'motion/react';
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { Download, Plus, Printer, Tag, Trash2, Upload, Edit2 } from 'lucide-react';

import {
  PageHeader,
  Toolbar,
  SearchInput,
  Select,
  Switch,
  DataTable,
  DataTableColumn,
  Badge,
  Button,
  IconButton,
  useToast,
  useConfirm,
} from '../components/ui';
import { useI18n } from '../intl/index';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';
import { useSettings } from '../lib/useSettings';
import { marginPct } from '../lib/pricing';
import { Product, Currency } from '../types';
import LabelPrinter from '../components/LabelPrinter';
import { ProductEditorDrawer } from './products/ProductEditorDrawer';
import { BulkPriceModal } from './products/BulkPriceModal';

type StockFilter = 'all' | 'low' | 'out' | 'service';
type StatusFilter = 'all' | 'active' | 'disabled';

function tf(str: string, vars: Record<string, string | number>): string {
  return str.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export default function ProductManagement() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { priceLevelsEnabled } = useSettings();

  const [products, setProducts] = useState<Product[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [stockFilter, setStockFilter] = useState<StockFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [showTiers, setShowTiers] = useState(true);
  // Multiple price levels can be turned off entirely (Settings → Sales & Pricing); when off the
  // wholesale/super-wholesale columns are hidden regardless of the "Show price levels" toggle.
  const tiersVisible = priceLevelsEnabled && showTiers;
  const [selectedKeys, setSelectedKeys] = useState<Set<string | number>>(new Set());

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [bulkPriceOpen, setBulkPriceOpen] = useState(false);
  const [showLabelPrinter, setShowLabelPrinter] = useState(false);
  const [labelPreSelected, setLabelPreSelected] = useState<number[]>([]);

  const fetchProducts = useCallback(() => {
    setLoading(true);
    api
      .get<Product[]>('/api/products')
      .then(setProducts)
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    fetchProducts();
    api.get<Currency[]>('/api/currencies').then(setCurrencies).catch(() => {});

    const handleSync = (e: any) => {
      if (e.detail?.type === 'PRODUCTS_UPDATED') fetchProducts();
    };
    window.addEventListener('pos-sync', handleSync);
    return () => window.removeEventListener('pos-sync', handleSync);
  }, [fetchProducts]);

  const usdCurrency = useMemo(() => currencies.find((c) => c.code === 'USD') || { code: 'USD', symbol: '$', rate: 1 }, [currencies]);
  const localCurrency = useMemo(() => currencies.find((c) => c.code !== 'USD') || null, [currencies]);

  const categories = useMemo(() => Array.from(new Set(products.map((p) => p.category).filter(Boolean))).sort(), [products]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (q && !p.name.toLowerCase().includes(q) && !(p.barcode || '').includes(search) && !p.barcodes?.some((b) => b.includes(search)) && !p.units?.some((u) => (u.barcode || '').includes(search))) {
        return false;
      }
      if (category && p.category !== category) return false;
      if (statusFilter === 'active' && p.active === 0) return false;
      if (statusFilter === 'disabled' && p.active !== 0) return false;
      if (stockFilter === 'service' && p.track_inventory !== 0) return false;
      if (stockFilter === 'low' && !(p.track_inventory !== 0 && p.stock > 0 && p.stock <= (p.reorder_point || 0))) return false;
      if (stockFilter === 'out' && !(p.track_inventory !== 0 && p.stock <= 0)) return false;
      return true;
    });
  }, [products, search, category, stockFilter, statusFilter]);

  const totalValueAtCost = useMemo(
    () => filtered.reduce((sum, p) => sum + (p.track_inventory !== 0 ? (p.stock || 0) * (p.cost || 0) : 0), 0),
    [filtered],
  );

  const openCreate = () => {
    setEditingProduct(null);
    setEditorOpen(true);
  };
  const openEdit = (p: Product) => {
    setEditingProduct(p);
    setEditorOpen(true);
  };

  const handleDelete = async (p: Product) => {
    const ok = await confirm({
      title: tf(t('prod_delete_confirm_title', 'Delete "{name}"?'), { name: p.name }),
      description: t('prod_delete_confirm_desc'),
      confirmLabel: t('prod_delete', 'Delete'),
    });
    if (!ok) return;
    try {
      await api.del(`/api/products/${p.id}`);
      toast.success(t('prod_deleted_toast', 'Product deleted.'));
      fetchProducts();
    } catch (err: any) {
      toast.error(err.message || t('prod_delete_error_toast'));
    }
  };

  const handleBulkDelete = async (selected: Product[], clear: () => void) => {
    const ok = await confirm({
      title: tf(t('prod_bulk_delete_confirm_title', 'Delete {count} products?'), { count: selected.length }),
      description: t('prod_bulk_delete_confirm_desc'),
      confirmLabel: t('prod_delete', 'Delete'),
    });
    if (!ok) return;
    try {
      await Promise.all(selected.map((p) => api.del(`/api/products/${p.id}`)));
      toast.success(t('prod_deleted_toast', 'Product deleted.'));
      clear();
      setSelectedKeys(new Set());
      fetchProducts();
    } catch (err: any) {
      toast.error(err.message || t('prod_delete_error_toast'));
    }
  };

  // ---- Export ----
  const handleExport = async (format: 'json' | 'csv' | 'xlsx' | 'pdf') => {
    try {
      const data = await api.get<any[]>('/api/products/export');
      const date = new Date().toISOString().split('T')[0];
      const filename = `products_export_${date}`;

      if (format === 'json') {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else if (format === 'csv' || format === 'xlsx') {
        const worksheet = XLSX.utils.json_to_sheet(
          data.map((p: any) => ({
            ID: p.id,
            Barcode: p.barcode,
            Barcodes: p.barcodes?.join(', '),
            Name: p.name,
            Category: p.category,
            Unit: p.unit,
            Cost: p.cost,
            Price: p.price,
            'Price Wholesale': p.price_wholesale,
            'Price Wholesale LBP': p.price_wholesale_lbp,
            'Price Super Wholesale': p.price_super_wholesale,
            'Price Super Wholesale LBP': p.price_super_wholesale_lbp,
            'Min Price': p.min_price,
            'Package Price': p.package_price,
            'Units/Pkg': p.units_per_package,
            Units: (p.units || []).map((u: any) => `${u.name} x${u.factor} @ ${u.price}${u.barcode ? ` [${u.barcode}]` : ''}`).join('; '),
            Stock: p.stock,
            Active: p.active === 0 ? 'no' : 'yes',
          })),
        );
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');
        XLSX.writeFile(workbook, `${filename}.${format}`);
      } else {
        const doc = new jsPDF();
        doc.text('Product Inventory Report', 14, 15);
        autoTable(doc, {
          startY: 20,
          head: [['Barcode', 'Name', 'Cost', 'Retail', 'Wholesale', 'Super WS', 'Stock', 'Category']],
          body: data.map((p: any) => [
            p.barcode,
            p.name,
            `$${(p.cost || 0).toFixed(2)}`,
            `$${(p.price || 0).toFixed(2)}`,
            p.price_wholesale ? `$${p.price_wholesale.toFixed(2)}` : '-',
            p.price_super_wholesale ? `$${p.price_super_wholesale.toFixed(2)}` : '-',
            p.stock,
            p.category,
          ]),
          theme: 'striped',
        });
        doc.save(`${filename}.pdf`);
      }
    } catch (err: any) {
      toast.error(err.message || t('prod_export_error_toast', 'Export failed.'));
    }
  };

  // ---- Columns ----
  const columns = useMemo<DataTableColumn<Product>[]>(() => {
    const cols: DataTableColumn<Product>[] = [
      { key: 'barcode', header: t('prod_col_barcode', 'Barcode'), sortable: true, render: (p) => <span className="font-mono text-xs text-text-3">{p.barcode || '—'}</span> },
      { key: 'name', header: t('prod_col_name', 'Name'), sortable: true, render: (p) => (
        <div className={`min-w-0 ${p.active === 0 ? 'opacity-60' : ''}`}>
          <span className={`font-medium ${p.active === 0 ? 'text-text-3' : 'text-text'}`}>{p.name}</span>
          {p.active === 0 && <Badge variant="neutral" className="ms-2">{t('prod_disabled_badge', 'Disabled')}</Badge>}
          {p.units && p.units.length > 0 && (
            <div className="mt-0.5 flex flex-wrap gap-1">
              {p.units.map((u) => (
                <span key={u.id} className="inline-flex items-center rounded-[var(--radius-chip)] bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-text-2" title={u.barcode || undefined}>
                  {u.name} ×{u.factor}
                </span>
              ))}
            </div>
          )}
        </div>
      ) },
      { key: 'category', header: t('prod_col_category', 'Category'), sortable: true, render: (p) => <span className="text-text-3">{p.category}</span> },
      {
        key: 'stock',
        header: t('prod_col_stock', 'Stock'),
        align: 'end',
        sortable: true,
        render: (p) => {
          if (p.track_inventory === 0) return <Badge variant="info">{t('prod_service_badge', 'Service')}</Badge>;
          const out = p.stock <= 0;
          const low = !out && p.stock <= (p.reorder_point || 0) && (p.reorder_point || 0) > 0;
          return (
            <span className={`num font-semibold ${out ? 'text-danger' : low ? 'text-accent' : 'text-text'}`}>
              {p.stock}
              {(out || low) && (
                <Badge variant={out ? 'danger' : 'warning'} className="ms-1.5">
                  {out ? t('prod_out_of_stock_badge', 'Out') : t('prod_low_stock_badge', 'Low')}
                </Badge>
              )}
            </span>
          );
        },
      },
      {
        key: 'cost',
        header: t('prod_col_cost', 'Cost'),
        align: 'end',
        sortable: true,
        render: (p) => <span className="num text-text-3">{formatMoney(p.cost || 0, usdCurrency)}</span>,
      },
      {
        key: 'price',
        header: t('prod_col_retail', 'Retail'),
        align: 'end',
        sortable: true,
        render: (p) => (
          <div className="leading-tight">
            <div className="num font-medium text-text">{formatMoney(p.price || 0, usdCurrency)}</div>
            {!!p.price_lbp && localCurrency && <div className="num text-xs text-text-3">{formatMoney(p.price_lbp, localCurrency)}</div>}
          </div>
        ),
      },
    ];

    if (tiersVisible) {
      cols.push(
        {
          key: 'price_wholesale',
          header: t('prod_col_wholesale', 'Wholesale'),
          align: 'end',
          render: (p) =>
            p.price_wholesale ? (
              <div className="leading-tight">
                <div className="num text-text">{formatMoney(p.price_wholesale, usdCurrency)}</div>
                {!!p.price_wholesale_lbp && localCurrency && <div className="num text-xs text-text-3">{formatMoney(p.price_wholesale_lbp, localCurrency)}</div>}
              </div>
            ) : (
              <span className="text-text-3">—</span>
            ),
        },
        {
          key: 'price_super_wholesale',
          header: t('prod_col_super_wholesale', 'Super wholesale'),
          align: 'end',
          render: (p) =>
            p.price_super_wholesale ? (
              <div className="leading-tight">
                <div className="num text-text">{formatMoney(p.price_super_wholesale, usdCurrency)}</div>
                {!!p.price_super_wholesale_lbp && localCurrency && <div className="num text-xs text-text-3">{formatMoney(p.price_super_wholesale_lbp, localCurrency)}</div>}
              </div>
            ) : (
              <span className="text-text-3">—</span>
            ),
        },
      );
    }

    cols.push(
      {
        key: 'margin',
        header: t('prod_col_margin', 'Margin'),
        align: 'end',
        sortValue: (p) => marginPct(p.price || 0, p.cost || 0),
        sortable: true,
        render: (p) => {
          const m = marginPct(p.price || 0, p.cost || 0);
          return <span className={`num font-medium ${m < 0 ? 'text-danger' : m < 15 ? 'text-accent' : 'text-success'}`}>{m.toFixed(1)}%</span>;
        },
      },
      {
        key: 'actions',
        header: t('prod_col_actions', 'Actions'),
        align: 'end',
        render: (p) => (
          <div className="flex justify-end gap-1">
            <IconButton
              aria-label={t('prod_labels_for_row', 'Print label')}
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setLabelPreSelected([p.id]);
                setShowLabelPrinter(true);
              }}
            >
              <Tag size={14} />
            </IconButton>
            <IconButton
              aria-label={t('prod_edit', 'Edit')}
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                openEdit(p);
              }}
            >
              <Edit2 size={14} />
            </IconButton>
            <IconButton
              aria-label={t('prod_delete', 'Delete')}
              size="sm"
              variant="danger"
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(p);
              }}
            >
              <Trash2 size={14} />
            </IconButton>
          </div>
        ),
      },
    );

    return cols;
  }, [t, tiersVisible, usdCurrency, localCurrency]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('prod_title', 'Products')}
        subtitle={t('prod_subtitle')}
        actions={
          <>
            <Button variant="secondary" onClick={() => { setLabelPreSelected([]); setShowLabelPrinter(true); }}>
              <Printer size={16} /> {t('prod_print_labels', 'Print labels')}
            </Button>
            <Button variant="secondary" onClick={() => navigate('/dashboard/import?entity=products')}>
              <Upload size={16} /> {t('prod_import_wizard', 'Import')}
            </Button>
            <Button variant="secondary" onClick={() => handleExport('xlsx')}>
              <Download size={16} /> {t('prod_export', 'Export Excel')}
            </Button>
            <Button variant="secondary" onClick={() => setBulkPriceOpen(true)}>
              <Tag size={16} /> {t('prod_bulk_price', 'Bulk price update')}
            </Button>
            <Button variant="primary" onClick={openCreate}>
              <Plus size={16} /> {t('prod_add', 'Add product')}
            </Button>
          </>
        }
      />

      <Toolbar
        className="mb-3"
        actions={
          priceLevelsEnabled ? (
            <label className="flex items-center gap-2 text-sm text-text-2">
              <Switch checked={showTiers} onChange={setShowTiers} />
              {t('prod_price_level_toggle', 'Show price levels')}
            </label>
          ) : undefined
        }
      >
        <SearchInput value={search} onChange={setSearch} placeholder={t('prod_search_placeholder')} className="max-w-sm" />
        <Select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          options={[{ value: '', label: t('prod_filter_category_all', 'All categories') }, ...categories.map((c) => ({ value: c, label: c }))]}
          className="w-44"
        />
        <Select
          value={stockFilter}
          onChange={(e) => setStockFilter(e.target.value as StockFilter)}
          options={[
            { value: 'all', label: t('prod_filter_stock_all', 'All stock') },
            { value: 'low', label: t('prod_filter_stock_low', 'Low stock') },
            { value: 'out', label: t('prod_filter_stock_out', 'Out of stock') },
            { value: 'service', label: t('prod_filter_stock_service', 'Service items') },
          ]}
          className="w-40"
        />
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          aria-label={t('prod_filter_status', 'Status')}
          options={[
            { value: 'all', label: t('prod_filter_status_all', 'All statuses') },
            { value: 'active', label: t('prod_filter_status_active', 'Active') },
            { value: 'disabled', label: t('prod_filter_status_disabled', 'Disabled') },
          ]}
          className="w-40"
        />
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <DataTable
          columns={columns}
          data={filtered}
          rowKey={(p) => p.id}
          loading={loading}
          selectable
          selectedKeys={selectedKeys}
          onSelectedKeysChange={setSelectedKeys}
          onRowClick={openEdit}
          emptyTitle={t('prod_empty_title', 'No products found')}
          emptyDescription={t('prod_empty_desc')}
          bulkActions={(selected, clear) => (
            <>
              <Button size="sm" variant="secondary" onClick={() => setBulkPriceOpen(true)}>
                <Tag size={14} /> {t('prod_bulk_price_update_selected', 'Bulk price update')}
              </Button>
              <Button size="sm" variant="danger" onClick={() => handleBulkDelete(selected, clear)}>
                <Trash2 size={14} /> {t('prod_bulk_delete', 'Delete selected')}
              </Button>
            </>
          )}
          footerTotals={{
            name: tf(t('prod_footer_count', '{count} products'), { count: filtered.length }),
            cost: <span className="num">{tf(t('prod_footer_value', 'Inventory value (cost): {value}'), { value: formatMoney(totalValueAtCost, usdCurrency) })}</span>,
          }}
          pageSizeOptions={[25, 50, 100]}
          defaultPageSize={25}
        />
      </div>

      <ProductEditorDrawer
        open={editorOpen}
        product={editingProduct}
        categories={categories}
        localCurrency={localCurrency ? { code: localCurrency.code, symbol: localCurrency.symbol, rate: localCurrency.rate } : null}
        priceLevelsEnabled={priceLevelsEnabled}
        onClose={() => setEditorOpen(false)}
        onSaved={fetchProducts}
      />

      <BulkPriceModal
        open={bulkPriceOpen}
        onClose={() => setBulkPriceOpen(false)}
        products={products}
        selectedIds={selectedKeys}
        categories={categories}
        priceLevelsEnabled={priceLevelsEnabled}
        onApplied={fetchProducts}
      />

      <AnimatePresence>
        {showLabelPrinter && <LabelPrinter products={products as any} preSelected={labelPreSelected} onClose={() => setShowLabelPrinter(false)} />}
      </AnimatePresence>
    </div>
  );
}
