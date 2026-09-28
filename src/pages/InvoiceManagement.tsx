import React, { useEffect, useMemo, useState } from 'react';
import { Download, Plus } from 'lucide-react';
import * as XLSX from 'xlsx';
import {
  PageHeader, Toolbar, DateRangePicker, SearchInput, Select, Badge, DataTable, Button,
  type DataTableColumn, useToast,
} from '../components/ui';
import { useI18n } from '../intl/index';
import { api } from '../lib/api';
import { formatMoney, formatDateTime, resolveDateRangePreset, type DateRange } from '../lib/format';
import type { Product, Stakeholder } from '../types';
import InvoiceDetailDrawer from './invoices/InvoiceDetailDrawer';
import InvoiceEditor from './invoices/InvoiceEditor';
import { payStatus, type CurrencyRow, type InvoiceListRow } from './invoices/types';

const USD: CurrencyRow = { code: 'USD', symbol: '$', rate: 1 };

function typeBadgeVariant(type: string): 'success' | 'info' | 'danger' | 'neutral' {
  if (type === 'refund') return 'danger';
  if (type === 'purchase') return 'info';
  if (type === 'sale') return 'success';
  return 'neutral';
}

function statusBadgeVariant(status: string): 'success' | 'warning' | 'danger' {
  if (status === 'paid') return 'success';
  if (status === 'partial') return 'warning';
  return 'danger';
}

export default function InvoiceManagement() {
  const { t, lang } = useI18n();
  const toast = useToast();

  const [rows, setRows] = useState<InvoiceListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<Product[]>([]);
  const [stakeholders, setStakeholders] = useState<Stakeholder[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyRow[]>([USD]);
  const [isAdmin, setIsAdmin] = useState(false);

  const [dateRange, setDateRange] = useState<DateRange>(() => resolveDateRangePreset('this_month'));
  const [typeFilter, setTypeFilter] = useState('all');
  const [partyFilter, setPartyFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [settledOnly, setSettledOnly] = useState(false);
  const [editedOnly, setEditedOnly] = useState(false);
  const [search, setSearch] = useState('');

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorType, setEditorType] = useState<'sale' | 'purchase'>('sale');
  const [editorId, setEditorId] = useState<number | null>(null);

  const fetchRows = () => {
    setLoading(true);
    api.get<InvoiceListRow[]>('/api/transactions/recent', {
      type: typeFilter !== 'all' ? typeFilter : undefined,
      stakeholder_id: partyFilter !== 'all' ? partyFilter : undefined,
      date_from: dateRange.from,
      date_to: dateRange.to,
      q: search || undefined,
      limit: 2000,
    })
      .then(setRows)
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    api.get<Product[]>('/api/products').then(setProducts).catch(() => {});
    api.get<Stakeholder[]>('/api/stakeholders').then(setStakeholders).catch(() => {});
    api.get<CurrencyRow[]>('/api/currencies').then((rows) => { if (rows?.length) setCurrencies(rows); }).catch(() => {});
    api.get<any[]>('/api/users').then((users) => {
      const raw = sessionStorage.getItem('currentCashierId');
      const id = raw ? parseInt(raw, 10) : NaN;
      const me = users.find((u) => u.id === id);
      setIsAdmin(me ? me.role === 'admin' : true);
    }).catch(() => setIsAdmin(true));
  }, []);

  useEffect(fetchRows, [typeFilter, partyFilter, dateRange.from, dateRange.to, search]);

  const filteredRows = useMemo(() => rows.filter((r) => {
    if (settledOnly && !r.archived) return false;
    if (editedOnly && !(r.edit_count && r.edit_count > 0)) return false;
    if (statusFilter !== 'all') {
      const status = payStatus(r.total_amount, r.paid_amount);
      if (status !== statusFilter) return false;
    }
    return true;
  }), [rows, settledOnly, editedOnly, statusFilter]);

  const openDetail = (id: number) => { setDetailId(id); setDetailOpen(true); };
  const openEditor = (type: 'sale' | 'purchase', id: number | null) => {
    setEditorType(type);
    setEditorId(id);
    setEditorOpen(true);
    setDetailOpen(false);
  };

  const handleExport = () => {
    const sheet = filteredRows.map((r) => ({
      '#': r.id,
      Type: r.type,
      Party: r.stakeholder_name || '',
      Date: formatDateTime(r.created_at, lang),
      Items: r.item_count,
      Total: r.total_amount,
      Paid: r.paid_amount,
      Due: Math.max(0, r.total_amount - r.paid_amount),
      Status: payStatus(r.total_amount, r.paid_amount),
      Settled: r.archived ? 'Yes' : 'No',
      Edits: r.edit_count || 0,
      User: r.user_name || '',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet), 'Invoices');
    XLSX.writeFile(wb, `invoices_${dateRange.from}_${dateRange.to}.xlsx`);
  };

  const columns: DataTableColumn<InvoiceListRow>[] = [
    { key: 'id', header: t('inv_col_number', '#'), sortable: true, render: (r) => <span className="num font-medium">#{r.id}</span> },
    { key: 'created_at', header: t('inv_col_date', 'Date'), sortable: true, sortValue: (r) => new Date(r.created_at).getTime(), render: (r) => <span className="num text-text-2">{formatDateTime(r.created_at, lang)}</span> },
    {
      key: 'type', header: t('inv_col_type', 'Type'), sortable: true,
      render: (r) => (
        <div className="flex flex-col gap-0.5">
          <Badge variant={typeBadgeVariant(r.type)}>{t(`inv_type_${r.type}`, r.type)}</Badge>
          {r.type === 'refund' && r.original_transaction_id ? (
            <button
              type="button"
              className="w-fit cursor-pointer text-xs text-text-3 underline-offset-2 hover:text-primary hover:underline"
              onClick={(e) => { e.stopPropagation(); openDetail(r.original_transaction_id as number); }}
            >
              {t('inv_refund_of', 'Refund of #{id}').replace('{id}', String(r.original_transaction_id))}
            </button>
          ) : null}
        </div>
      ),
    },
    { key: 'stakeholder_name', header: t('inv_col_party', 'Party'), sortable: true, render: (r) => r.stakeholder_name || '—' },
    { key: 'item_count', header: t('inv_col_items', 'Items'), align: 'center', sortable: true },
    { key: 'total_amount', header: t('inv_col_total', 'Total'), align: 'end', sortable: true, render: (r) => formatMoney(r.total_amount, USD) },
    { key: 'paid_amount', header: t('inv_col_paid', 'Paid'), align: 'end', sortable: true, render: (r) => formatMoney(r.paid_amount, USD) },
    { key: 'due', header: t('inv_col_due', 'Due'), align: 'end', sortValue: (r) => Math.max(0, r.total_amount - r.paid_amount), render: (r) => formatMoney(Math.max(0, r.total_amount - r.paid_amount), USD) },
    {
      key: 'status', header: t('inv_col_status', 'Status'), align: 'center',
      render: (r) => { const s = payStatus(r.total_amount, r.paid_amount); return <Badge variant={statusBadgeVariant(s)}>{t(`inv_status_${s}`, s)}</Badge>; },
    },
    {
      key: 'flags', header: t('inv_col_flags', 'Flags'),
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.archived ? <Badge variant="neutral">{t('inv_flag_settled', 'Settled')}</Badge> : null}
          {r.edit_count ? <Badge variant="warning">{r.edit_count > 1 ? t('inv_flag_edited_many', 'Edited ×{n}').replace('{n}', String(r.edit_count)) : t('inv_flag_edited_one', 'Edited')}</Badge> : null}
        </div>
      ),
    },
    { key: 'user_name', header: t('inv_col_user', 'User'), render: (r) => r.user_name || '—' },
  ];

  const footerTotals = {
    total_amount: <span className="num">{formatMoney(filteredRows.reduce((s, r) => s + r.total_amount, 0), USD)}</span>,
    paid_amount: <span className="num">{formatMoney(filteredRows.reduce((s, r) => s + r.paid_amount, 0), USD)}</span>,
    due: <span className="num">{formatMoney(filteredRows.reduce((s, r) => s + Math.max(0, r.total_amount - r.paid_amount), 0), USD)}</span>,
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('inv_page_title', 'Invoices')}
        subtitle={t('inv_page_subtitle')}
        actions={
          <>
            <Button variant="secondary" onClick={handleExport}><Download size={15} /> {t('inv_export', 'Export')}</Button>
            <Button variant="secondary" onClick={() => openEditor('purchase', null)}><Plus size={15} /> {t('inv_new_purchase', 'New purchase invoice')}</Button>
            <Button variant="primary" onClick={() => openEditor('sale', null)}><Plus size={15} /> {t('inv_new_sale', 'New sale invoice')}</Button>
          </>
        }
      />

      <Toolbar
        actions={
          <>
            <button type="button" onClick={() => setSettledOnly((v) => !v)} className={['cursor-pointer', settledOnly ? '' : 'opacity-60'].join(' ')}>
              <Badge variant={settledOnly ? 'primary' : 'neutral'}>{t('inv_chip_settled', 'Settled only')}</Badge>
            </button>
            <button type="button" onClick={() => setEditedOnly((v) => !v)} className={['cursor-pointer', editedOnly ? '' : 'opacity-60'].join(' ')}>
              <Badge variant={editedOnly ? 'primary' : 'neutral'}>{t('inv_chip_edited', 'Edited only')}</Badge>
            </button>
            {(typeFilter !== 'all' || partyFilter !== 'all' || statusFilter !== 'all' || settledOnly || editedOnly || search) && (
              <Button variant="ghost" size="sm" onClick={() => { setTypeFilter('all'); setPartyFilter('all'); setStatusFilter('all'); setSettledOnly(false); setEditedOnly(false); setSearch(''); }}>
                {t('inv_clear_filters', 'Clear filters')}
              </Button>
            )}
          </>
        }
      >
        <DateRangePicker value={dateRange} onChange={(r) => setDateRange(r)} />
        <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="w-40" options={[
          { value: 'all', label: t('inv_filter_type_all', 'All types') },
          { value: 'sale', label: t('inv_filter_type_sale', 'Sales') },
          { value: 'purchase', label: t('inv_filter_type_purchase', 'Purchases') },
          { value: 'refund', label: t('inv_filter_type_refund', 'Refunds') },
        ]} />
        <Select value={partyFilter} onChange={(e) => setPartyFilter(e.target.value)} className="w-48" options={[
          { value: 'all', label: t('inv_filter_party_all', 'All parties') },
          ...stakeholders.map((s) => ({ value: String(s.id), label: s.name })),
        ]} />
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-40" options={[
          { value: 'all', label: t('inv_filter_status_all', 'Any status') },
          { value: 'paid', label: t('inv_filter_status_paid', 'Paid') },
          { value: 'partial', label: t('inv_filter_status_partial', 'Partial') },
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
        onEdit={(id, type) => openEditor(type === 'purchase' ? 'purchase' : 'sale', id)}
        onDeleted={fetchRows}
        onRefunded={fetchRows}
        onOpenInvoice={(id) => openDetail(id)}
      />

      <InvoiceEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        txType={editorType}
        editingId={editorId}
        products={products}
        stakeholders={stakeholders}
        currencies={currencies}
        onSaved={(id) => {
          setEditorOpen(false);
          fetchRows();
          api.get<Product[]>('/api/products').then(setProducts).catch(() => {});
          setDetailId(id);
          setDetailOpen(true);
        }}
      />
    </div>
  );
}
