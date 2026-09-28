import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CreditCard, Receipt, ShoppingBag, Users, Wallet } from 'lucide-react';
import {
  Badge,
  DataTable,
  type DataTableColumn,
  DonutChart,
  PageHeader,
  StatCard,
} from '../components/ui';
import { useI18n } from '../intl/index';
import { formatMoney, localToday, formatTime, transactionStatusLabel, paymentMethodLabel } from '../lib/format';
import { api } from '../lib/api';

interface Transaction {
  id: number;
  created_at: string;
  stakeholder_name?: string;
  user_name?: string;
  total_amount: number;
  type: string;
  status: string;
  currency?: string;
}

interface PaymentBreakdown {
  method: string;
  total: number;
  total_usd: number;
}

interface CustomerBreakdown {
  customer: string;
  total: number;
}

export default function DailySales() {
  const { t, lang } = useI18n();
  const [date, setDate] = useState(localToday());
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [byPayment, setByPayment] = useState<PaymentBreakdown[]>([]);
  const [byCustomer, setByCustomer] = useState<CustomerBreakdown[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [txRes, paymentRes, customerRes] = await Promise.all([
        api.get<Transaction[]>('/api/reports/daily-sales', { date }),
        api.get<PaymentBreakdown[]>('/api/reports/daily-sales-by-payment', { date }),
        api.get<CustomerBreakdown[]>('/api/reports/daily-sales-by-customer', { date }),
      ]);
      setTransactions(txRes || []);
      setByPayment(paymentRes || []);
      setByCustomer(customerRes || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    fetchAll();
    const handleSync = (e: any) => {
      if (e.detail?.type === 'TRANSACTIONS_UPDATED') fetchAll();
    };
    window.addEventListener('pos-sync', handleSync);
    return () => window.removeEventListener('pos-sync', handleSync);
  }, [fetchAll]);

  const sales = transactions.filter((tr) => tr.type !== 'refund');
  const refunds = transactions.filter((tr) => tr.type === 'refund');
  const totalSales = sales.reduce((sum, tr) => sum + tr.total_amount, 0);
  const totalRefunds = refunds.reduce((sum, tr) => sum + tr.total_amount, 0);
  const netTotal = totalSales - totalRefunds;
  const avgSale = sales.length > 0 ? totalSales / sales.length : 0;

  const donutData = useMemo(
    () =>
      byPayment.map((p) => ({
        label: paymentMethodLabel(p.method, t),
        value: p.total_usd,
      })),
    [byPayment, t],
  );

  const columns: DataTableColumn<Transaction>[] = [
    { key: 'id', header: t('fin_ds_id', 'ID'), sortable: true, render: (r) => <span className="num">#{r.id}</span> },
    {
      key: 'created_at',
      header: t('fin_time', 'Time'),
      sortable: true,
      render: (r) => <span className="num text-text-3">{formatTime(r.created_at, lang, { seconds: true })}</span>,
    },
    { key: 'stakeholder_name', header: t('fin_ds_customer', 'Customer'), render: (r) => r.stakeholder_name || t('fin_ds_walk_in', 'Walk-in') },
    { key: 'user_name', header: t('fin_ds_cashier', 'Cashier'), render: (r) => r.user_name || t('fin_ds_system', 'System') },
    {
      key: 'total_amount',
      header: t('fin_ds_total', 'Total'),
      align: 'end',
      sortable: true,
      render: (r) => (
        <span className={['num font-semibold', r.type === 'refund' ? 'text-danger' : 'text-text'].join(' ')}>
          {r.type === 'refund' ? '-' : ''}
          {formatMoney(r.total_amount, { code: 'USD', symbol: '$' })}
        </span>
      ),
    },
    {
      key: 'status',
      header: t('fin_ds_status', 'Status'),
      render: (r) => <Badge variant={r.type === 'refund' ? 'danger' : 'success'}>{transactionStatusLabel(r.status, t)}</Badge>,
    },
    {
      key: 'view',
      header: '',
      render: (r) => (
        <a href={`/dashboard/invoices?id=${r.id}`} className="text-xs font-medium text-primary hover:underline">
          {t('fin_ds_view_invoice', 'View invoice')}
        </a>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t('fin_ds_title', 'Daily Sales History')}
        subtitle={t('fin_ds_subtitle', 'Review orders and performance by date.')}
        actions={
          <input
            type="date"
            className="h-9 rounded-[var(--radius-input)] border border-border bg-surface px-3 text-sm font-medium text-text outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t('fin_ds_total_for_day', 'Total for Day')} icon={Wallet} value={formatMoney(netTotal, { code: 'USD', symbol: '$' })} />
        <StatCard label={t('fin_ds_transactions_count', 'Transactions')} icon={ShoppingBag} value={sales.length} />
        <StatCard label={t('fin_ds_avg_sale', 'Average Sale')} icon={CreditCard} value={formatMoney(avgSale, { code: 'USD', symbol: '$' })} />
        <StatCard label={t('fin_ds_refunds', 'Refunds')} icon={Receipt} value={formatMoney(totalRefunds, { code: 'USD', symbol: '$' })} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
          <h3 className="mb-3 text-sm font-semibold text-text">{t('fin_ds_by_payment', 'By Payment Method')}</h3>
          {donutData.length > 0 ? (
            <DonutChart data={donutData} valueFormatter={(v) => formatMoney(v, { code: 'USD', symbol: '$' })} centerLabel="USD" />
          ) : (
            <p className="py-8 text-center text-sm text-text-3">{t('fin_ds_no_payment_data', 'No payment data for this date')}</p>
          )}
        </div>
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text">
            <Users size={15} /> {t('fin_ds_by_customer', 'By Customer')}
          </h3>
          {byCustomer.length > 0 ? (
            <div className="flex flex-col gap-2">
              {byCustomer
                .slice()
                .sort((a, b) => b.total - a.total)
                .map((c) => (
                  <div key={c.customer} className="flex items-center justify-between border-b border-border/60 pb-1.5 text-sm last:border-0">
                    <span className="text-text-2">{c.customer}</span>
                    <span className="num font-semibold text-text">{formatMoney(c.total, { code: 'USD', symbol: '$' })}</span>
                  </div>
                ))}
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-text-3">{t('fin_ds_no_customer_data', 'No customer sales for this date')}</p>
          )}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">{t('fin_ds_transactions', 'Transactions')}</h3>
        <DataTable
          columns={columns}
          data={transactions}
          rowKey={(r) => r.id}
          loading={loading}
          searchable
          emptyTitle={t('fin_ds_no_transactions', 'No transactions found')}
          emptyDescription={t('fin_ds_no_transactions_desc', 'No transactions were recorded for this date.')}
        />
      </div>
    </div>
  );
}
