import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Banknote, PiggyBank, Receipt, ShoppingBag, Users, Wallet } from 'lucide-react';
import {
  Button,
  Combobox,
  DataTable,
  Field,
  Input,
  Modal,
  MoneyInput,
  PageHeader,
  Select,
  Tabs,
  Textarea,
  useToast,
} from '../components/ui';
import { AnalyticsPanel } from './cashflow/AnalyticsPanel';
import { CashFlowEditModal } from './cashflow/EditModal';
import { cashFlowColumns } from './cashflow/columns';
import { FitStat, STAT_GRID, cashFlowErrorMessage, type CashFlowRow } from './cashflow/common';
import { useCashFlowCategories } from './cashflow/useCashFlowCategories';
import { useI18n } from '../intl/index';
import { formatMoney, partyDisplayName } from '../lib/format';
import { api } from '../lib/api';
import { usePermissions } from '../lib/usePermissions';

interface Currency {
  id?: number;
  code: string;
  symbol: string;
  rate: number;
}

type CashFlowEntry = CashFlowRow;

interface Summary {
  scope?: 'shift' | 'day';
  since?: string;
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
  phone?: string | null;
}

// Only USD (rate 1) is safe as a hardcoded fallback — anything else must come from the tenant's
// own configured rate (GET /api/currencies), or an entry recorded before that fetch resolves would
// silently use a stale guessed exchange rate instead of the real one.
const USD = { code: 'USD', symbol: '$' };
const DEFAULT_CURRENCIES: Currency[] = [{ code: 'USD', symbol: '$', rate: 1 }];

export default function CashFlowRegister() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const cats = useCashFlowCategories();

  const [entries, setEntries] = useState<CashFlowEntry[]>([]);
  const { can } = usePermissions();
  const canAdd = can('cash_flow.add');
  const canEditEntries = can('cash_flow.edit');
  const canBalancePayment = canAdd || can('parties.edit'); // POST /api/balance-payment
  const [summary, setSummary] = useState<Summary | null>(null);
  const [stakeholders, setStakeholders] = useState<Stakeholder[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>(DEFAULT_CURRENCIES);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'register' | 'analytics'>('register');
  // Cashiers work the current shift (since the last Cash Out); whoever closes or audits the day
  // (settlement.close / settlement.view) can switch to the whole day since the last settlement.
  const canSeeDay = can('settlement.close') || can('settlement.view');
  const [scope, setScope] = useState<'shift' | 'day'>('shift');
  useEffect(() => {
    if (canSeeDay) setScope('day');
  }, [canSeeDay]);
  const [editing, setEditing] = useState<CashFlowRow | null>(null);

  // Cash movement modal
  const [movementOpen, setMovementOpen] = useState(false);
  const [movementType, setMovementType] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  const [category, setCategory] = useState('other');
  const [counterparty, setCounterparty] = useState('');
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
        api.get<CashFlowEntry[]>(`/api/cash-flow?scope=${scope}`),
        api.get<Summary>(`/api/cash-flow/summary?scope=${scope}`),
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
  }, [scope]);

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
    setCategory(type === 'in' ? 'top_up' : 'expense');
    setCounterparty('');
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
        category,
        counterparty: counterparty.trim() || undefined,
      });
      setMovementOpen(false);
      toast.success(t('fin_cfr_movement_recorded', 'Movement recorded.'));
      fetchData();
    } catch (err: any) {
      toast.error(cashFlowErrorMessage(err, t));
    } finally {
      setSubmittingMovement(false);
    }
  };

  const selectedStakeholder = stakeholders.find((s) => s.id === parseInt(balStakeholderId));
  const customersWithBalance = stakeholders.filter((s) => s.balance > 0.01);
  const suppliersWithBalance = stakeholders.filter((s) => s.balance < -0.01);
  // Searchable party list: whoever has a balance in this direction first (with what's owed), then
  // everyone else — each party once. Search matches the name (Arabic-variant insensitive) and phone.
  const balanceOptions = useMemo(() => {
    const first = balDirection === 'collect' ? customersWithBalance : suppliersWithBalance;
    const firstIds = new Set(first.map((s) => s.id));
    const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });
    return [
      ...first.map((s) => ({
        value: String(s.id),
        label: partyDisplayName(s.name, t),
        secondary: `${usd(Math.abs(s.balance))} ${s.balance > 0 ? t('fin_cfr_owed', 'owed to you') : t('fin_cfr_outstanding', 'you owe')}`,
        keywords: [s.name, s.phone].filter(Boolean).join(' '),
      })),
      ...stakeholders.filter((s) => !firstIds.has(s.id)).map((s) => ({
        value: String(s.id),
        label: partyDisplayName(s.name, t),
        secondary: usd(s.balance),
        keywords: [s.name, s.phone].filter(Boolean).join(' '),
      })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stakeholders, balDirection, t]);

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

  const columns = useMemo(
    () => cashFlowColumns({ t, lang, currencies, categoryLabel: cats.label, onEdit: canEditEntries ? setEditing : undefined }),
    [t, lang, currencies, canEditEntries, cats.label],
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t('fin_cfr_title', 'Cash Flow Register')}
        subtitle={t('fin_cfr_subtitle', 'Track cash movements, collect balances, and pay suppliers.')}
        actions={
          <>
            {canBalancePayment && (
              <Button variant="secondary" onClick={() => openBalanceModal('collect')}>
                <Users size={15} /> {t('fin_cfr_balance_payment', 'Balance Payment')}
              </Button>
            )}
            {canAdd && (
              <>
                <Button variant="success" onClick={() => openMovementModal('in')}>
                  <ArrowDownLeft size={15} /> {t('fin_cfr_cash_in', 'Cash In')}
                </Button>
                <Button variant="danger" onClick={() => openMovementModal('out')}>
                  <ArrowUpRight size={15} /> {t('fin_cfr_cash_out', 'Cash Out')}
                </Button>
              </>
            )}
          </>
        }
      />

      <Tabs
        value={tab}
        onChange={(v) => setTab(v as 'register' | 'analytics')}
        items={[
          { value: 'register', label: t('cf_tab_register', 'Open register') },
          { value: 'analytics', label: t('cf_tab_analytics', 'Analytics & history') },
        ]}
      />

      {tab === 'analytics' ? (
        <AnalyticsPanel currencies={currencies} />
      ) : (
      <>
      {canSeeDay && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-[var(--radius-input)] border border-border bg-surface-2 p-1 text-xs font-semibold" role="group" aria-label={t('fin_cfr_scope_label', 'Register period')}>
            {([['shift', t('fin_cfr_scope_shift', 'Current shift')], ['day', t('fin_cfr_scope_day', 'Whole day')]] as const).map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={scope === v}
                onClick={() => setScope(v)}
                className={['cursor-pointer rounded-md px-3 py-1.5 uppercase tracking-[0.04em]', scope === v ? 'bg-primary text-on-primary' : 'text-text-3 hover:text-text'].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="text-xs text-text-3">
            {scope === 'day'
              ? t('fin_cfr_scope_day_hint', 'Since the last settlement — every cashier shift included.')
              : t('fin_cfr_scope_shift_hint', 'Since the last cash out or settlement.')}
          </span>
        </div>
      )}

      {/* Multi-row grid (2 / 3 / 4 columns) with self-fitting figures: 7 cards never sit in one long row. */}
      <div className={STAT_GRID}>
        <FitStat label={t('fin_cfr_opening_balance', 'Opening Balance')} icon={Wallet} value={summary ? formatMoney(summary.openingBalance, USD) : '—'} />
        <FitStat label={t('fin_cfr_cash_sales', 'Cash Sales')} icon={Banknote} tone="success" value={summary ? `+${formatMoney(summary.totalSales, USD)}` : '—'} />
        <FitStat label={t('fin_cfr_refunds', 'Refunds')} icon={Receipt} tone="danger" value={summary ? `-${formatMoney(summary.totalRefunds, USD)}` : '—'} />
        <FitStat label={t('fin_cfr_purchases', 'Purchases')} icon={ShoppingBag} tone="danger" value={summary ? `-${formatMoney(summary.totalPurchases, USD)}` : '—'} />
        <FitStat label={t('fin_cfr_manual_in', 'Manual Cash In')} icon={ArrowDownLeft} tone="success" value={summary ? `+${formatMoney(summary.totalIn, USD)}` : '—'} />
        <FitStat label={t('fin_cfr_manual_out', 'Manual Cash Out')} icon={ArrowUpRight} tone="danger" value={summary ? `-${formatMoney(summary.totalOut, USD)}` : '—'} />
        <FitStat label={t('fin_cfr_expected', 'Expected in Drawer')} icon={PiggyBank} value={summary ? formatMoney(summary.expectedBalance, USD) : '—'} className="border-primary/40" />
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
      </>
      )}

      <CashFlowEditModal row={editing} currencies={currencies} onClose={() => setEditing(null)} onSaved={fetchData} />

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
          <Field label={t('cf_category', 'Category')}>
            <Select value={category} onChange={(e) => setCategory(e.target.value)} options={cats.options(movementType)} />
          </Field>
          <Field label={t('cf_counterparty', 'Counterparty (optional)')}>
            <Input value={counterparty} onChange={(e) => setCounterparty(e.target.value)} placeholder={t('cf_counterparty_placeholder', 'Who lent the money / who was paid')} />
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
            <Combobox
              value={balStakeholderId}
              onChange={setBalStakeholderId}
              placeholder={balDirection === 'collect' ? t('fin_cfr_select_customer', 'Select customer…') : t('fin_cfr_select_supplier', 'Select supplier…')}
              aria-label={balDirection === 'collect' ? t('fin_cfr_customer', 'Customer') : t('fin_cfr_supplier', 'Supplier')}
              options={balanceOptions}
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
