import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, HandCoins, AlertTriangle, Plus, Edit2, Trash2, Upload } from 'lucide-react';
import {
  PageHeader,
  Tabs,
  StatCard,
  Toolbar,
  SearchInput,
  Select,
  DataTable,
  Badge,
  Button,
  IconButton,
  useToast,
  useConfirm,
} from '../components/ui';
import type { DataTableColumn } from '../components/ui';
import { useI18n } from '../intl/index';
import { api } from '../lib/api';
import { formatMoney, partyDisplayName } from '../lib/format';
import { useSettings } from '../lib/useSettings';
import type { Currency, PriceLevel, Stakeholder } from '../types';
import { EditDrawer } from './stakeholders/EditDrawer';
import { DetailDrawer } from './stakeholders/DetailDrawer';
import { PaymentModal } from './stakeholders/PaymentModal';

const usd: Currency = { code: 'USD', symbol: '$', rate: 1, is_default: 1 };

export default function StakeholderManagement() {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { priceLevelsEnabled } = useSettings();

  const [stakeholders, setStakeholders] = useState<Stakeholder[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'customer' | 'supplier'>('customer');

  const [priceLevelFilter, setPriceLevelFilter] = useState<string>('all');
  const [balanceFilter, setBalanceFilter] = useState<string>('all'); // all | with_balance | over_limit

  const [editing, setEditing] = useState<Stakeholder | null>(null);
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);
  const [detailStakeholder, setDetailStakeholder] = useState<Stakeholder | null>(null);
  const [paymentStakeholder, setPaymentStakeholder] = useState<Stakeholder | null>(null);

  const fetchStakeholders = () => {
    setLoading(true);
    return api
      .get<Stakeholder[]>('/api/stakeholders')
      .then(setStakeholders)
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchStakeholders();
    api.get<Currency[]>('/api/currencies').then(setCurrencies).catch(() => {});

    const handleSync = (e: any) => {
      if (e.detail?.type === 'STAKEHOLDERS_UPDATED' || e.detail?.type === 'SETTINGS_UPDATED') {
        fetchStakeholders();
      }
    };
    window.addEventListener('pos-sync', handleSync);
    return () => window.removeEventListener('pos-sync', handleSync);
  }, []);

  const byType = useMemo(() => stakeholders.filter((s) => s.type === tab), [stakeholders, tab]);

  const filtered = useMemo(() => {
    return byType.filter((s) => {
      if (priceLevelsEnabled && priceLevelFilter !== 'all' && (s.price_level || 'retail') !== priceLevelFilter) return false;
      const overLimit = !!s.credit_limit && s.credit_limit > 0 && -s.balance > s.credit_limit;
      if (balanceFilter === 'with_balance' && s.balance === 0) return false;
      if (balanceFilter === 'over_limit' && !overLimit) return false;
      return true;
    });
  }, [byType, priceLevelFilter, balanceFilter]);

  const kpis = useMemo(() => {
    const count = byType.length;
    const totalOutstanding = byType.reduce((sum, s) => sum + (s.balance < 0 ? -s.balance : 0), 0);
    const overLimitCount = byType.filter((s) => !!s.credit_limit && s.credit_limit > 0 && -s.balance > s.credit_limit).length;
    return { count, totalOutstanding, overLimitCount };
  }, [byType]);

  const openNew = () => {
    setEditing(null);
    setEditDrawerOpen(true);
  };

  const openEdit = (s: Stakeholder) => {
    setEditing(s);
    setEditDrawerOpen(true);
  };

  const handleDelete = async (s: Stakeholder) => {
    const ok = await confirm({
      title: t('stk_delete_confirm_title'),
      description: t('stk_delete_confirm_desc').replace('{name}', partyDisplayName(s.name, t)),
    });
    if (!ok) return;
    try {
      await api.del(`/api/stakeholders/${s.id}`);
      toast.success(t('usr_toast_deleted', 'Deleted'));
      fetchStakeholders();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const priceLevelLabel = (level?: PriceLevel) =>
    level === 'wholesale'
      ? t('stk_price_level_wholesale')
      : level === 'super_wholesale'
      ? t('stk_price_level_super_wholesale')
      : t('stk_price_level_retail');

  const columns: DataTableColumn<Stakeholder>[] = [
    { key: 'name', header: t('stk_col_name'), sortable: true, render: (s) => <span className="font-medium text-text">{partyDisplayName(s.name, t)}</span> },
    {
      key: 'contact',
      header: t('stk_col_contact'),
      render: (s) => (
        <div className="text-xs text-text-3">
          {s.phone && <div>{s.phone}</div>}
          {s.address && <div className="truncate max-w-[220px]">{s.address}</div>}
          {!s.phone && !s.address && '—'}
        </div>
      ),
    },
    ...(priceLevelsEnabled ? [{
      key: 'price_level',
      header: t('stk_col_price_level'),
      render: (s: Stakeholder) => <Badge variant="neutral">{priceLevelLabel(s.price_level)}</Badge>,
      sortValue: (s: Stakeholder) => s.price_level || 'retail',
      sortable: true,
    } as DataTableColumn<Stakeholder>] : []),
    {
      key: 'credit_limit',
      header: t('stk_col_credit_limit'),
      align: 'end',
      sortable: true,
      sortValue: (s) => s.credit_limit || 0,
      render: (s) => (s.credit_limit ? formatMoney(s.credit_limit, usd) : <span className="text-text-3">{t('stk_unlimited')}</span>),
    },
    {
      key: 'balance',
      header: t('stk_col_balance'),
      align: 'end',
      sortable: true,
      sortValue: (s) => s.balance,
      render: (s) => {
        const overLimit = !!s.credit_limit && s.credit_limit > 0 && -s.balance > s.credit_limit;
        const label =
          s.balance < 0
            ? t('stk_owes').replace('{amount}', formatMoney(-s.balance, usd))
            : s.balance > 0
            ? t('stk_credit').replace('{amount}', formatMoney(s.balance, usd))
            : t('stk_settled');
        const pct = s.credit_limit ? Math.min(100, (Math.max(0, -s.balance) / s.credit_limit) * 100) : 0;
        return (
          <div className="flex flex-col items-end gap-1">
            <span className={['num text-sm font-semibold', s.balance < 0 ? 'text-danger' : s.balance > 0 ? 'text-success' : 'text-text-3'].join(' ')}>
              {label}
            </span>
            {!!s.credit_limit && (
              <div className="h-1 w-24 overflow-hidden rounded-full bg-surface-2">
                <div className={['h-full rounded-full', overLimit ? 'bg-danger' : 'bg-primary'].join(' ')} style={{ width: `${pct}%` }} />
              </div>
            )}
            {overLimit && <Badge variant="danger">{t('stk_over_limit_badge')}</Badge>}
          </div>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      align: 'end',
      width: 88,
      render: (s) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <IconButton aria-label={t('stk_edit')} size="sm" onClick={() => openEdit(s)}>
            <Edit2 size={15} />
          </IconButton>
          <IconButton aria-label={t('stk_delete')} size="sm" onClick={() => handleDelete(s)}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('stk_title')}
        subtitle={t('stk_subtitle')}
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate(`/dashboard/import?entity=${tab === 'customer' ? 'customers' : 'suppliers'}`)}>
              <Upload size={16} /> {t('stk_import_wizard', 'Import')}
            </Button>
            <Button variant="primary" onClick={openNew}>
              <Plus size={16} /> {tab === 'customer' ? t('stk_add_customer') : t('stk_add_supplier')}
            </Button>
          </>
        }
      />

      <Tabs
        value={tab}
        onChange={(v) => setTab(v as 'customer' | 'supplier')}
        items={[
          { value: 'customer', label: t('stk_tab_customers') },
          { value: 'supplier', label: t('stk_tab_suppliers') },
        ]}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          icon={Users}
          label={tab === 'customer' ? t('stk_kpi_count_customers') : t('stk_kpi_count_suppliers')}
          value={kpis.count}
        />
        <StatCard
          icon={HandCoins}
          label={tab === 'customer' ? t('stk_kpi_receivable') : t('stk_kpi_payable')}
          value={formatMoney(kpis.totalOutstanding, usd)}
        />
        <StatCard icon={AlertTriangle} label={t('stk_kpi_over_limit')} value={kpis.overLimitCount} />
      </div>

      <Toolbar
        actions={
          <>
            {priceLevelsEnabled && (
              <Select
                value={priceLevelFilter}
                onChange={(e) => setPriceLevelFilter(e.target.value)}
                className="w-44"
                options={[
                  { value: 'all', label: t('stk_filter_all') },
                  { value: 'retail', label: t('stk_price_level_retail') },
                  { value: 'wholesale', label: t('stk_price_level_wholesale') },
                  { value: 'super_wholesale', label: t('stk_price_level_super_wholesale') },
                ]}
              />
            )}
            <Select
              value={balanceFilter}
              onChange={(e) => setBalanceFilter(e.target.value)}
              className="w-44"
              options={[
                { value: 'all', label: t('stk_filter_all') },
                { value: 'with_balance', label: t('stk_filter_with_balance') },
                { value: 'over_limit', label: t('stk_filter_over_limit') },
              ]}
            />
          </>
        }
      />

      <DataTable
        columns={columns}
        data={filtered}
        rowKey={(s) => s.id}
        loading={loading}
        searchable
        searchPlaceholder={t('stk_search_placeholder')}
        emptyTitle={t('stk_no_results_title')}
        emptyDescription={t('stk_no_results_desc')}
        onRowClick={(s) => setDetailStakeholder(s)}
        defaultPageSize={25}
      />

      <EditDrawer
        open={editDrawerOpen}
        onClose={() => setEditDrawerOpen(false)}
        stakeholder={editing}
        defaultType={tab}
        onSaved={fetchStakeholders}
      />

      <DetailDrawer
        open={!!detailStakeholder}
        onClose={() => setDetailStakeholder(null)}
        stakeholder={detailStakeholder}
        currencies={currencies}
        onEdit={(s) => {
          setDetailStakeholder(null);
          openEdit(s);
        }}
        onPay={(s) => setPaymentStakeholder(s)}
      />

      <PaymentModal
        open={!!paymentStakeholder}
        onClose={() => setPaymentStakeholder(null)}
        stakeholder={paymentStakeholder}
        currencies={currencies}
        onDone={fetchStakeholders}
      />
    </div>
  );
}
