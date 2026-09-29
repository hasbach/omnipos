import React, { useEffect, useMemo, useState } from 'react';
import { Download, Plus, Truck } from 'lucide-react';
import * as XLSX from 'xlsx';
import {
  PageHeader, Toolbar, DateRangePicker, SearchInput, Select, Combobox, Badge, DataTable, Button, IconButton,
  type DataTableColumn, useToast,
} from '../components/ui';
import { useI18n } from '../intl/index';
import { api } from '../lib/api';
import { formatMoney, formatDateTime, resolveDateRangePreset, partyDisplayName, type DateRange } from '../lib/format';
import type { Product, Stakeholder } from '../types';
import InvoiceDetailDrawer from './invoices/InvoiceDetailDrawer';
import InvoiceEditor from './invoices/InvoiceEditor';
import UpdateSellingPricesModal, { type PriceSuggestionRow } from './invoices/UpdateSellingPricesModal';
import { payStatus, type CurrencyRow, type PurchaseListRow } from './invoices/types';

const USD: CurrencyRow = { code: 'USD', symbol: '$', rate: 1 };

export default function PurchaseManagement() {
  const { t, lang } = useI18n();
  const toast = useToast();

  const [rows, setRows] = useState<PurchaseListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Stakeholder[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyRow[]>([USD]);
  const [isAdmin, setIsAdmin] = useState(false);

  const [dateRange, setDateRange] = useState<DateRange>(() => resolveDateRangePreset('this_month'));
  const [supplierFilter, setSupplierFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all'); // all | paid | unpaid
  const [settledOnly, setSettledOnly] = useState(false);
  const [editedOnly, setEditedOnly] = useState(false);
  const [search, setSearch] = useState('');

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorId, setEditorId] = useState<number | null>(null);

  const [priceRows, setPriceRows] = useState<PriceSuggestionRow[]>([]);
  const [priceModalOpen, setPriceModalOpen] = useState(false);

  const fetchRows = () => {
    setLoading(true);
    api.get<PurchaseListRow[]>('/api/purchases', {
      supplier_id: supplierFilter !== 'all' ? supplierFilter : undefined,
      status: statusFilter !== 'all' ? statusFilter : undefined,
      from: dateRange.from,
      to: dateRange.to,
      search: search || undefined,
    })
      .then(setRows)
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    api.get<Product[]>('/api/products').then(setProducts).catch(() => {});
    api.get<Stakeholder[]>('/api/stakeholders').then((all) => setSuppliers(all.filter((s) => s.type === 'supplier'))).catch(() => {});
    api.get<CurrencyRow[]>('/api/currencies').then((rows) => { if (rows?.length) setCurrencies(rows); }).catch(() => {});
    api.get<any[]>('/api/users').then((users) => {
      const raw = sessionStorage.getItem('currentCashierId');
      const id = raw ? parseInt(raw, 10) : NaN;
      const me = users.find((u) => u.id === id);
      setIsAdmin(me ? me.role === 'admin' : true);
    }).catch(() => setIsAdmin(true));
  }, []);

  useEffect(fetchRows, [supplierFilter, statusFilter, dateRange.from, dateRange.to, search]);

  const filteredRows = useMemo(() => rows.filter((r) => {
    if (settledOnly && !r.archived) return false;
    if (editedOnly && !(r.edit_count && r.edit_count > 0)) return false;
    return true;
  }), [rows, settledOnly, editedOnly]);

  const totalSpent = filteredRows.reduce((s, r) => s + r.total_amount, 0);
  const totalPaid = filteredRows.reduce((s, r) => s + r.paid_amount, 0);
  const totalOutstanding = Math.max(0, totalSpent - totalPaid);

  const openDetail = (id: number) => { setDetailId(id); setDetailOpen(true); };
  const openEditor = (id: number | null) => { setEditorId(id); setEditorOpen(true); setDetailOpen(false); };

  const handleMarkReceived = async (id: number) => {
    try {
      await api.put(`/api/purchases/${id}/receive`);
      toast.success(t('pur_marked_received', 'Purchase order marked as received.'));
      fetchRows();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const handleExport = () => {
    const sheet = filteredRows.map((r) => ({
      'PO #': r.id,
      Supplier: r.supplier_name ? partyDisplayName(r.supplier_name, t) : '',
      Date: formatDateTime(r.created_at, lang),
      Items: r.item_count,
      Total: r.total_amount,
      Paid: r.paid_amount,
      Balance: Math.max(0, r.total_amount - r.paid_amount),
      Status: payStatus(r.total_amount, r.paid_amount),
      Settled: r.archived ? 'Yes' : 'No',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet), 'Purchases');
    XLSX.writeFile(wb, `purchases_${dateRange.from}_${dateRange.to}.xlsx`);
  };

  const afterPurchaseSaved = async (id: number) => {
    setEditorOpen(false);
    fetchRows();

    // Offer to update selling prices for every product this purchase touched, keeping current
    // markup, per the brief. `products` (fetched before this save) is the pre-purchase snapshot;
    // re-fetch the catalog to see each touched product's post-purchase (WAC-blended) cost.
    try {
      const tx = await api.get<any>(`/api/transactions/${id}`);
      const freshProducts = await api.get<Product[]>('/api/products');
      setProducts(freshProducts);
      const rows: PriceSuggestionRow[] = (tx.items || [])
        .map((it: any) => {
          const before = products.find((p) => p.id === it.product_id);
          const after = freshProducts.find((p) => p.id === it.product_id);
          if (!before || !after) return null;
          return { product: before, newCost: after.cost ?? before.cost ?? 0 } as PriceSuggestionRow;
        })
        .filter(Boolean) as PriceSuggestionRow[];
      if (rows.length > 0) {
        setPriceRows(rows);
        setPriceModalOpen(true);
      }
    } catch {
      /* best-effort — the purchase itself already saved fine */
    }

    setDetailId(id);
    setDetailOpen(true);
  };

  const columns: DataTableColumn<PurchaseListRow>[] = [
    { key: 'id', header: t('inv_col_number', '#'), sortable: true, render: (r) => <span className="num font-medium">#{r.id}</span> },
    { key: 'supplier_name', header: t('inv_col_supplier', 'Supplier'), sortable: true, render: (r) => r.supplier_name ? partyDisplayName(r.supplier_name, t) : '—' },
    { key: 'created_at', header: t('inv_col_date', 'Date'), sortable: true, sortValue: (r) => new Date(r.created_at).getTime(), render: (r) => <span className="num text-text-2">{formatDateTime(r.created_at, lang)}</span> },
    { key: 'item_count', header: t('inv_col_items', 'Items'), align: 'center', sortable: true },
    { key: 'total_amount', header: t('inv_col_total', 'Total'), align: 'end', sortable: true, render: (r) => formatMoney(r.total_amount, USD) },
    { key: 'paid_amount', header: t('inv_col_paid', 'Paid'), align: 'end', sortable: true, render: (r) => formatMoney(r.paid_amount, USD) },
    { key: 'due', header: t('inv_col_due', 'Due'), align: 'end', sortValue: (r) => Math.max(0, r.total_amount - r.paid_amount), render: (r) => formatMoney(Math.max(0, r.total_amount - r.paid_amount), USD) },
    {
      key: 'status', header: t('inv_col_status', 'Status'), align: 'center',
      render: (r) => { const s = payStatus(r.total_amount, r.paid_amount) === 'partial' ? 'partial' : (r.total_amount - r.paid_amount <= 0.01 ? 'paid' : 'unpaid'); return <Badge variant={s === 'paid' ? 'success' : s === 'partial' ? 'warning' : 'danger'}>{t(`inv_status_${s}`, s)}</Badge>; },
    },
    {
      key: 'flags', header: t('inv_col_flags', 'Flags'),
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.archived ? <Badge variant="neutral">{t('inv_flag_settled', 'Settled')}</Badge> : null}
          {r.edit_count ? <Badge variant="warning">{r.edit_count > 1 ? t('inv_flag_edited_many', 'Edited ×{n}').replace('{n}', String(r.edit_count)) : t('inv_flag_edited_one', 'Edited')}</Badge> : null}
          {r.status === 'received' ? <Badge variant="info">{t('pur_mark_received', 'Received')}</Badge> : null}
        </div>
      ),
    },
    {
      key: 'actions', header: t('inv_col_actions', 'Actions'), align: 'end',
      render: (r) => (
        !r.archived && r.status !== 'received' ? (
          <IconButton aria-label={t('pur_mark_received', 'Mark received')} title={t('pur_mark_received', 'Mark received')} onClick={(e) => { e.stopPropagation(); handleMarkReceived(r.id); }}>
            <Truck size={15} />
          </IconButton>
        ) : null
      ),
    },
  ];

  const footerTotals = {
    total_amount: <span className="num">{formatMoney(totalSpent, USD)}</span>,
    paid_amount: <span className="num">{formatMoney(totalPaid, USD)}</span>,
    due: <span className="num">{formatMoney(totalOutstanding, USD)}</span>,
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('pur_page_title', 'Purchases')}
        subtitle={t('pur_page_subtitle')}
        actions={
          <>
            <Button variant="secondary" onClick={handleExport}><Download size={15} /> {t('inv_export', 'Export')}</Button>
            <Button variant="primary" onClick={() => openEditor(null)}><Plus size={15} /> {t('pur_new_purchase', 'New purchase invoice')}</Button>
          </>
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
          <p className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">{t('inv_footer_totals', 'Totals')}</p>
          <p className="num text-2xl font-bold text-text">{filteredRows.length}</p>
        </div>
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
          <p className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">{t('inv_col_total', 'Total')}</p>
          <p className="num text-2xl font-bold text-text">{formatMoney(totalSpent, USD)}</p>
        </div>
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
          <p className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">{t('inv_col_due', 'Due')}</p>
          <p className={['num text-2xl font-bold', totalOutstanding > 0 ? 'text-danger' : 'text-success'].join(' ')}>{formatMoney(totalOutstanding, USD)}</p>
        </div>
      </div>

      <Toolbar
        actions={
          <>
            <button type="button" onClick={() => setSettledOnly((v) => !v)} className={['cursor-pointer', settledOnly ? '' : 'opacity-60'].join(' ')}>
              <Badge variant={settledOnly ? 'primary' : 'neutral'}>{t('inv_chip_settled', 'Settled only')}</Badge>
            </button>
            <button type="button" onClick={() => setEditedOnly((v) => !v)} className={['cursor-pointer', editedOnly ? '' : 'opacity-60'].join(' ')}>
              <Badge variant={editedOnly ? 'primary' : 'neutral'}>{t('inv_chip_edited', 'Edited only')}</Badge>
            </button>
            {(supplierFilter !== 'all' || statusFilter !== 'all' || settledOnly || editedOnly || search) && (
              <Button variant="ghost" size="sm" onClick={() => { setSupplierFilter('all'); setStatusFilter('all'); setSettledOnly(false); setEditedOnly(false); setSearch(''); }}>
                {t('inv_clear_filters', 'Clear filters')}
              </Button>
            )}
          </>
        }
      >
        <DateRangePicker value={dateRange} onChange={(r) => setDateRange(r)} />
        <Combobox value={supplierFilter} onChange={setSupplierFilter} className="w-52" clearable aria-label={t('pur_filter_supplier_all', 'All suppliers')}
          allOption={{ value: 'all', label: t('pur_filter_supplier_all', 'All suppliers') }}
          options={suppliers.map((s) => ({ value: String(s.id), label: partyDisplayName(s.name, t), secondary: s.phone || undefined, keywords: s.email || undefined }))} />
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-40" options={[
          { value: 'all', label: t('inv_filter_status_all', 'Any status') },
          { value: 'paid', label: t('inv_filter_status_paid', 'Paid') },
          { value: 'unpaid', label: t('inv_filter_status_unpaid', 'Unpaid') },
        ]} />
        <SearchInput value={search} onChange={setSearch} placeholder={t('inv_search_placeholder')} className="max-w-xs" />
      </Toolbar>

      <DataTable
        columns={columns}
        data={filteredRows}
        rowKey={(r) => r.id}
        loading={loading}
        onRowClick={(r) => openDetail(r.id)}
        emptyTitle={t('inv_empty_title', 'No invoices found')}
        emptyDescription={t('inv_empty_description')}
        footerTotals={footerTotals}
        defaultPageSize={50}
      />

      <InvoiceDetailDrawer
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        invoiceId={detailId}
        currencies={currencies}
        isAdmin={isAdmin}
        onEdit={(id) => openEditor(id)}
        onDeleted={fetchRows}
      />

      <InvoiceEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        txType="purchase"
        editingId={editorId}
        products={products}
        stakeholders={suppliers}
        currencies={currencies}
        onSaved={afterPurchaseSaved}
      />

      <UpdateSellingPricesModal
        open={priceModalOpen}
        onClose={() => setPriceModalOpen(false)}
        rows={priceRows}
        onApplied={() => { setPriceModalOpen(false); }}
      />
    </div>
  );
}
