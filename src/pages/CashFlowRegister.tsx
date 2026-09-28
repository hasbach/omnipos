import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Banknote, PiggyBank, Receipt, ShoppingBag, Users, Wallet } from 'lucide-react';
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  Field,
  Modal,
  MoneyInput,
  PageHeader,
  Select,
  StatCard,
  Textarea,
  useToast,
} from '../components/ui';
import { useI18n } from '../intl/index';
import { formatDateTime, formatMoney, partyDisplayName } from '../lib/format';
import { api } from '../lib/api';

interface Currency {
  id?: number;
  code: string;
  symbol: string;
  rate: number;
}

interface CashFlowEntry {
  id: number;
  type: 'in' | 'out';
  amount: number;
  currency: string;
  exchange_rate: number;
  reason: string;
  created_at: string;
}

interface Summary {
  openingBalance: number;
  totalSales: number;
  totalRefunds: number;
  totalPurchases: number;
  totalIn: number;
  totalOut: number;
  expectedBalance: number;
}

interface Stakeholder {
  id: number;
  name: string;
  balance: number;
}

// Only USD (rate 1) is safe as a hardcoded fallback — anything else must come from the tenant's
// own configured rate (GET /api/currencies), or an entry recorded before that fetch resolves would
// silently use a stale guessed exchange rate instead of the real one.
const DEFAULT_CURRENCIES: Currency[] = [{ code: 'USD', symbol: '$', rate: 1 }];

export default function CashFlowRegister() {
  const { t, lang } = useI18n();
  const toast = useToast();

  const [entries, setEntries] = useState<CashFlowEntry[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [stakeholders, setStakeholders] = useState<Stakeholder[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>(DEFAULT_CURRENCIES);
  const [loading, setLoading] = useState(true);

  // Cash movement modal
  const [movementOpen, setMovementOpen] = useState(false);
  const [movementType, setMovementType] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  const [currencyCode, setCurrencyCode] = useState('USD');
  const [submittingMovement, setSubmittingMovement] = useState(false);

  // Balance payment modal
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [balDirection, setBalDirection] = useState<'collect' | 'pay'>('collect');
  const [balStakeholderId, setBalStakeholderId] = useState('');
  const [balAmount, setBalAmount] = useState<number | ''>('');
  const [balCurrencyCode, setBalCurrencyCode] = useState('USD');
  const [submittingBalance, setSubmittingBalance] = useState(false);

  const currentCurrency = currencies.find((c) => c.code === currencyCode) || currencies[0];
  const balCurrency = currencies.find((c) => c.code === balCurrencyCode) || currencies[0];

  const fetchData = useCallback(async () => {
    try {
      const [entriesRes, summaryRes, stakeholdersRes, currenciesRes] = await Promise.all([
        api.get<CashFlowEntry[]>('/api/cash-flow'),
        api.get<Summary>('/api/cash-flow/summary'),
        api.get<Stakeholder[]>('/api/stakeholders'),
        api.get<Currency[]>('/api/currencies'),
      ]);
      setEntries(entriesRes || []);
      setSummary(summaryRes || null);
      setStakeholders(stakeholdersRes || []);
      if (Array.isArray(currenciesRes) && currenciesRes.length > 0) setCurrencies(currenciesRes);
    } catch (err: any) {
      toast.error(err.message || String(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchData();
    const handleSync = (e: any) => {
      if (['CASH_FLOW_UPDATED', 'STAKEHOLDERS_UPDATED', 'SETTINGS_UPDATED'].includes(e.detail?.type)) {
        fetchData();
      }
    };
    window.addEventListener('pos-sync', handleSync);
    return () => window.removeEventListener('pos-sync', handleSync);
  }, [fetchData]);

  const openMovementModal = (type: 'in' | 'out') => {
    setMovementType(type);
    setAmount('');
    setReason('');
    setCurrencyCode('USD');
    setMovementOpen(true);
  };

  const quickReasons = useMemo(() => {
    const raw = movementType === 'in' ? t('fin_cfr_quick_reasons_in', '') : t('fin_cfr_quick_reasons_out', '');
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }, [movementType, t]);

  const handleSubmitMovement = async (e: React.FormEvent) => {
    e.preventDefault();
    const numAmount = typeof amount === 'number' ? amount : parseFloat(String(amount));
    if (!numAmount || numAmount <= 0) return;

    setSubmittingMovement(true);
    try {
      await api.post('/api/cash-flow', {
        type: movementType,
        amount: numAmount,
        currency: currentCurrency.code,
        exchange_rate: currentCurrency.rate,
        reason,
      });
      setMovementOpen(false);
      toast.success(t('fin_cfr_movement_recorded', 'Movement recorded.'));
      fetchData();
    } catch (err: any) {
      toast.error(err.message || String(err));
    } finally {
      setSubmittingMovement(false);
    }
  };

  const selectedStakeholder = stakeholders.find((s) => s.id === parseInt(balStakeholderId));
  const customersWithBalance = stakeholders.filter((s) => s.balance > 0.01);
  const suppliersWithBalance = stakeholders.filter((s) => s.balance < -0.01);

  const openBalanceModal = (direction: 'collect' | 'pay') => {
    setBalDirection(direction);
    setBalStakeholderId('');
    setBalAmount('');
    setBalCurrencyCode('USD');
    setBalanceOpen(true);
  };

  const handleSubmitBalance = async (e: React.FormEvent) => {
    e.preventDefault();
    const numAmount = typeof balAmount === 'number' ? balAmount : parseFloat(String(balAmount));
    if (!balStakeholderId || !numAmount || numAmount <= 0) return;

    setSubmittingBalance(true);
    try {
      await api.post('/api/balance-payment', {
        stakeholder_id: parseInt(balStakeholderId),
        amount: numAmount,
        currency: balCurrency.code,
        exchange_rate: balCurrency.rate,
        direction: balDirection,
      });
      setBalanceOpen(false);
      toast.success(t('fin_cfr_payment_recorded', 'Payment recorded.'));
      fetchData();
    } catch (err: any) {
      toast.error(err.message || t('fin_cfr_balance_payment_failed', 'Failed to process payment'));
    } finally {
      setSubmittingBalance(false);
    }
  };

  const columns: DataTableColumn<CashFlowEntry>[] = [
    {
      key: 'created_at',
      header: t('fin_time', 'Time'),
      sortable: true,
      render: (row) => <span className="num text-xs text-text-3">{formatDateTime(row.created_at, lang)}</span>,
    },
    {
      key: 'type',
      header: t('fin_cfr_movement_type', 'Movement Type'),
      render: (row) => (
        <Badge variant={row.type === 'in' ? 'success' : 'danger'}>
          {row.type === 'in' ? t('fin_cfr_cash_in', 'Cash In') : t('fin_cfr_cash_out', 'Cash Out')}
        </Badge>
      ),
    },
    {
      key: 'amount',
      header: t('fin_amount', 'Amount'),
      align: 'end',
      sortable: true,
      render: (row) => {
        const cur = currencies.find((c) => c.code === row.currency) || { code: row.currency, symbol: row.currency, rate: row.exchange_rate };
        return (
          <div className="flex flex-col items-end">
            <span className={['num font-semibold', row.type === 'in' ? 'text-success' : 'text-danger'].join(' ')}>
              {row.type === 'in' ? '+' : '-'}
              {formatMoney(row.amount, cur)}
            </span>
            {row.currency !== 'USD' && (
              <span className="num text-xs text-text-3">
                ≈ {formatMoney(row.amount / row.exchange_rate, { code: 'USD', symbol: '$' })}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'reason',
      header: t('fin_reason', 'Reason'),
      render: (row) => <span className="text-text-2">{row.reason || '—'}</span>,
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t('fin_cfr_title', 'Cash Flow Register')}
        subtitle={t('fin_cfr_subtitle', 'Track cash movements, collect balances, and pay suppliers.')}
        actions={
          <>
            <Button variant="secondary" onClick={() => openBalanceModal('collect')}>
              <Users size={15} /> {t('fin_cfr_balance_payment', 'Balance Payment')}
            </Button>
            <Button variant="success" onClick={() => openMovementModal('in')}>
              <ArrowDownLeft size={15} /> {t('fin_cfr_cash_in', 'Cash In')}
            </Button>
            <Button variant="danger" onClick={() => openMovementModal('out')}>
              <ArrowUpRight size={15} /> {t('fin_cfr_cash_out', 'Cash Out')}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <StatCard label={t('fin_cfr_opening_balance', 'Opening Balance')} icon={Wallet} value={summary ? formatMoney(summary.openingBalance, { code: 'USD', symbol: '$' }) : '—'} />
        <StatCard label={t('fin_cfr_cash_sales', 'Cash Sales')} icon={Banknote} value={summary ? `+${formatMoney(summary.totalSales, { code: 'USD', symbol: '$' })}` : '—'} />
        <StatCard label={t('fin_cfr_refunds', 'Refunds')} icon={Receipt} value={summary ? `-${formatMoney(summary.totalRefunds, { code: 'USD', symbol: '$' })}` : '—'} />
        <StatCard label={t('fin_cfr_purchases', 'Purchases')} icon={ShoppingBag} value={summary ? `-${formatMoney(summary.totalPurchases, { code: 'USD', symbol: '$' })}` : '—'} />
        <StatCard label={t('fin_cfr_manual_in', 'Manual Cash In')} icon={ArrowDownLeft} value={summary ? `+${formatMoney(summary.totalIn, { code: 'USD', symbol: '$' })}` : '—'} />
        <StatCard label={t('fin_cfr_manual_out', 'Manual Cash Out')} icon={ArrowUpRight} value={summary ? `-${formatMoney(summary.totalOut, { code: 'USD', symbol: '$' })}` : '—'} />
        <StatCard label={t('fin_cfr_expected', 'Expected in Drawer')} icon={PiggyBank} value={summary ? formatMoney(summary.expectedBalance, { code: 'USD', symbol: '$' }) : '—'} className="border-primary/40" />
      </div>

      <p className="rounded-[var(--radius-card)] border border-border-strong border-dashed bg-surface-2 px-4 py-2 text-center text-xs font-medium text-text-3">
        {t('fin_cfr_formula', 'Opening + Sales − Refunds − Purchases + In − Out = Expected')}
      </p>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-text">{t('fin_cfr_movements', 'Movements')}</h2>
        <DataTable
          columns={columns}
          data={entries}
          rowKey={(r) => r.id}
          loading={loading}
          searchable
          emptyTitle={t('fin_cfr_movements_empty', 'No movements recorded')}
          emptyDescription={t('fin_cfr_movements_empty_desc', 'Nothing has been recorded since the register was last closed.')}
        />
      </div>

      {/* Cash In / Cash Out modal */}
      <Modal
        open={movementOpen}
        onClose={() => setMovementOpen(false)}
        title={movementType === 'in' ? t('fin_cfr_cash_in', 'Cash In') : t('fin_cfr_cash_out', 'Cash Out')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setMovementOpen(false)}>{t('fin_cancel', 'Cancel')}</Button>
            <Button
              type="submit"
              form="cfr-movement-form"
              variant={movementType === 'in' ? 'success' : 'danger'}
              loading={submittingMovement}
            >
              {t('fin_cfr_record_movement', 'Record Movement')}
            </Button>
          </>
        }
      >
        <form id="cfr-movement-form" className="flex flex-col gap-4" onSubmit={handleSubmitMovement}>
          <Field label={t('fin_currency', 'Currency')}>
            <Select
              value={currencyCode}
              onChange={(e) => setCurrencyCode(e.target.value)}
              options={currencies.map((c) => ({ value: c.code, label: `${c.code} (rate ${c.rate})` }))}
            />
          </Field>
          <Field label={`${t('fin_amount', 'Amount')} (${currentCurrency.symbol})`}
            helper={
              currentCurrency.code !== 'USD' && amount
                ? `${t('fin_approx_usd', 'Approx. USD')}: ${formatMoney((typeof amount === 'number' ? amount : 0) / currentCurrency.rate, { code: 'USD', symbol: '$' })}`
                : undefined
            }
          >
            <MoneyInput value={amount} onChange={setAmount} currencySymbol={currentCurrency.symbol} autoFocus />
          </Field>
          <Field label={t('fin_reason', 'Reason')}>
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {quickReasons.map((q) => (
                <button
                  type="button"
                  key={q}
                  onClick={() => setReason(q)}
                  className="cursor-pointer rounded-[var(--radius-chip)] border border-border bg-surface-2 px-2 py-1 text-xs text-text-2 hover:border-primary hover:text-primary"
                >
                  {q}
                </button>
              ))}
            </div>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('fin_cfr_reason_placeholder', 'e.g. Petty cash for cleaning supplies')}
              rows={3}
            />
          </Field>
        </form>
      </Modal>

      {/* Balance payment modal */}
      <Modal
        open={balanceOpen}
        onClose={() => setBalanceOpen(false)}
        title={balDirection === 'collect' ? t('fin_cfr_collect', 'Collect from Customer') : t('fin_cfr_pay', 'Pay Supplier')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setBalanceOpen(false)}>{t('fin_cancel', 'Cancel')}</Button>
            <Button
              type="submit"
              form="cfr-balance-form"
              variant={balDirection === 'collect' ? 'success' : 'danger'}
              loading={submittingBalance}
            >
              {balDirection === 'collect' ? t('fin_cfr_record_collection', 'Record Collection') : t('fin_cfr_record_payment', 'Record Payment')}
            </Button>
          </>
        }
      >
        <form id="cfr-balance-form" className="flex flex-col gap-4" onSubmit={handleSubmitBalance}>
          <div className="flex gap-2 rounded-[var(--radius-input)] border border-border bg-surface-2 p-1">
            <button
              type="button"
              onClick={() => openBalanceModal('collect')}
              className={[
                'flex-1 cursor-pointer rounded-md py-1.5 text-xs font-semibold uppercase tracking-[0.04em]',
                balDirection === 'collect' ? 'bg-success text-white' : 'text-text-3',
              ].join(' ')}
            >
              {t('fin_cfr_collect', 'Collect from Customer')}
            </button>
            <button
              type="button"
              onClick={() => openBalanceModal('pay')}
              className={[
                'flex-1 cursor-pointer rounded-md py-1.5 text-xs font-semibold uppercase tracking-[0.04em]',
                balDirection === 'pay' ? 'bg-danger text-white' : 'text-text-3',
              ].join(' ')}
            >
              {t('fin_cfr_pay', 'Pay Supplier')}
            </button>
          </div>

          <Field label={balDirection === 'collect' ? t('fin_cfr_customer', 'Customer') : t('fin_cfr_supplier', 'Supplier')}>
            <Select
              value={balStakeholderId}
              onChange={(e) => setBalStakeholderId(e.target.value)}
              placeholder={balDirection === 'collect' ? t('fin_cfr_select_customer', 'Select customer…') : t('fin_cfr_select_supplier', 'Select supplier…')}
              options={[
                ...(balDirection === 'collect' ? customersWithBalance : suppliersWithBalance).map((s) => ({
                  value: String(s.id),
                  label: `${partyDisplayName(s.name, t)} — ${formatMoney(Math.abs(s.balance), { code: 'USD', symbol: '$' })} ${s.balance > 0 ? t('fin_cfr_owed', 'owed to you') : t('fin_cfr_outstanding', 'you owe')}`,
                })),
                ...stakeholders.map((s) => ({ value: String(s.id), label: `${partyDisplayName(s.name, t)} (${formatMoney(s.balance, { code: 'USD', symbol: '$' })})` })),
              ]}
            />
            {selectedStakeholder && (
              <p className="mt-1 text-xs text-text-3">
                {t('fin_cfr_current_balance', 'Current balance')}:{' '}
                <span className={selectedStakeholder.balance > 0 ? 'font-semibold text-accent' : selectedStakeholder.balance < 0 ? 'font-semibold text-danger' : 'text-success'}>
                  {formatMoney(selectedStakeholder.balance, { code: 'USD', symbol: '$' })}
                </span>
              </p>
            )}
          </Field>

          <Field label={t('fin_currency', 'Currency')}>
            <Select
              value={balCurrencyCode}
              onChange={(e) => setBalCurrencyCode(e.target.value)}
              options={currencies.map((c) => ({ value: c.code, label: `${c.code} (rate ${c.rate})` }))}
            />
          </Field>

          <Field label={`${t('fin_amount', 'Amount')} (${balCurrency.symbol})`}
            helper={
              balCurrency.code !== 'USD' && balAmount
                ? `${t('fin_approx_usd', 'Approx. USD')}: ${formatMoney((typeof balAmount === 'number' ? balAmount : 0) / balCurrency.rate, { code: 'USD', symbol: '$' })}`
                : undefined
            }
          >
            <MoneyInput value={balAmount} onChange={setBalAmount} currencySymbol={balCurrency.symbol} />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
