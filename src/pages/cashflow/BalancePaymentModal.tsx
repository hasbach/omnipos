import React, { useEffect, useMemo, useState } from 'react';
import { Button, Combobox, Field, Modal, MoneyInput, Select, useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { formatMoney, partyDisplayName } from '../../lib/format';
import { api } from '../../lib/api';
import { effectiveLocalCurrency, formatRate } from '../../lib/orderTotals';

interface Currency {
  id?: number;
  code: string;
  symbol: string;
  rate: number;
}

interface Stakeholder {
  id: number;
  name: string;
  balance: number;
  phone?: string | null;
  type?: 'customer' | 'supplier';
  local_rate?: number | null;
}

const DEFAULT_CURRENCIES: Currency[] = [{ code: 'USD', symbol: '$', rate: 1 }];

export interface BalancePaymentModalProps {
  open: boolean;
  onClose: () => void;
  initialDirection?: 'collect' | 'pay';
  onRecorded?: () => void;
}

export function BalancePaymentModal({ open, onClose, initialDirection = 'collect', onRecorded }: BalancePaymentModalProps) {
  const { t } = useI18n();
  const toast = useToast();

  const [stakeholders, setStakeholders] = useState<Stakeholder[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>(DEFAULT_CURRENCIES);
  const [direction, setDirection] = useState<'collect' | 'pay'>(initialDirection);
  const [stakeholderId, setStakeholderId] = useState('');
  const [amount, setAmount] = useState<number | ''>('');
  const [currencyCode, setCurrencyCode] = useState('USD');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDirection(initialDirection);
    setStakeholderId('');
    setAmount('');
    setCurrencyCode('USD');
    let cancelled = false;
    (async () => {
      try {
        const [stakeholdersRes, currenciesRes] = await Promise.all([
          api.get<Stakeholder[]>('/api/stakeholders'),
          api.get<Currency[]>('/api/currencies'),
        ]);
        if (cancelled) return;
        setStakeholders(stakeholdersRes || []);
        setCurrencies(Array.isArray(currenciesRes) && currenciesRes.length > 0 ? currenciesRes : DEFAULT_CURRENCIES);
      } catch (err: any) {
        if (!cancelled) toast.error(err.message || String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);


  const switchDirection = (d: 'collect' | 'pay') => {
    setDirection(d);
    setStakeholderId('');
    setAmount('');
    setCurrencyCode('USD');
  };

  const selectedStakeholder = stakeholders.find((s) => s.id === parseInt(stakeholderId));

  // A party's own local-currency rate overrides the global one for converting what's entered.
  const effLocal = effectiveLocalCurrency(currencies, selectedStakeholder);
  const effCurrencies: Currency[] = currencies.map((c) => (effLocal && c.code === effLocal.code ? { ...c, rate: effLocal.rate } : c));
  const currency = effCurrencies.find((c) => c.code === currencyCode) || effCurrencies[0];
  const partyRateHint = (c: Currency) =>
    effLocal?.source === 'party' && c.code === effLocal.code
      ? ` ${direction === 'pay' ? t('party_rate_supplier', 'supplier rate') : t('party_rate_customer', 'customer rate')}`
      : '';

  // Searchable party list, restricted to the relevant type: customers when collecting, suppliers when
  // paying. Whoever has a balance in this direction first (with what's owed), then the rest of that type.
  const options = useMemo(() => {
    const ofType = stakeholders.filter((s) => s.type === (direction === 'collect' ? 'customer' : 'supplier'));
    const first = direction === 'collect' ? ofType.filter((s) => s.balance > 0.01) : ofType.filter((s) => s.balance < -0.01);
    const firstIds = new Set(first.map((s) => s.id));
    const usd = (n: number) => formatMoney(n, { code: 'USD', symbol: '$' });
    return [
      ...first.map((s) => ({
        value: String(s.id),
        label: partyDisplayName(s.name, t),
        secondary: `${usd(Math.abs(s.balance))} ${s.balance > 0 ? t('fin_cfr_owed', 'owed to you') : t('fin_cfr_outstanding', 'you owe')}`,
        keywords: [s.name, s.phone].filter(Boolean).join(' '),
      })),
      ...ofType.filter((s) => !firstIds.has(s.id)).map((s) => ({
        value: String(s.id),
        label: partyDisplayName(s.name, t),
        secondary: usd(s.balance),
        keywords: [s.name, s.phone].filter(Boolean).join(' '),
      })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stakeholders, direction, t]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const numAmount = typeof amount === 'number' ? amount : parseFloat(String(amount));
    if (!stakeholderId || !numAmount || numAmount <= 0) return;

    setSubmitting(true);
    try {
      await api.post('/api/balance-payment', {
        stakeholder_id: parseInt(stakeholderId),
        amount: numAmount,
        currency: currency.code,
        exchange_rate: currency.rate,
        direction,
      });
      toast.success(t('fin_cfr_payment_recorded', 'Payment recorded.'));
      onRecorded?.();
      onClose();
    } catch (err: any) {
      toast.error(err.message || t('fin_cfr_balance_payment_failed', 'Failed to process payment'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={direction === 'collect' ? t('fin_cfr_collect', 'Collect from Customer') : t('fin_cfr_pay', 'Pay Supplier')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('fin_cancel', 'Cancel')}</Button>
          <Button
            type="submit"
            form="cfr-balance-form"
            variant={direction === 'collect' ? 'success' : 'danger'}
            loading={submitting}
          >
            {direction === 'collect' ? t('fin_cfr_record_collection', 'Record Collection') : t('fin_cfr_record_payment', 'Record Payment')}
          </Button>
        </>
      }
    >
      <form id="cfr-balance-form" className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <div className="flex gap-2 rounded-[var(--radius-input)] border border-border bg-surface-2 p-1">
          <button
            type="button"
            onClick={() => switchDirection('collect')}
            className={[
              'flex-1 cursor-pointer rounded-md py-1.5 text-xs font-semibold uppercase tracking-[0.04em]',
              direction === 'collect' ? 'bg-success text-white' : 'text-text-3',
            ].join(' ')}
          >
            {t('fin_cfr_collect', 'Collect from Customer')}
          </button>
          <button
            type="button"
            onClick={() => switchDirection('pay')}
            className={[
              'flex-1 cursor-pointer rounded-md py-1.5 text-xs font-semibold uppercase tracking-[0.04em]',
              direction === 'pay' ? 'bg-danger text-white' : 'text-text-3',
            ].join(' ')}
          >
            {t('fin_cfr_pay', 'Pay Supplier')}
          </button>
        </div>

        <Field label={direction === 'collect' ? t('fin_cfr_customer', 'Customer') : t('fin_cfr_supplier', 'Supplier')}>
          <Combobox
            value={stakeholderId}
            onChange={setStakeholderId}
            placeholder={direction === 'collect' ? t('fin_cfr_select_customer', 'Select customer…') : t('fin_cfr_select_supplier', 'Select supplier…')}
            aria-label={direction === 'collect' ? t('fin_cfr_customer', 'Customer') : t('fin_cfr_supplier', 'Supplier')}
            options={options}
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
            value={currencyCode}
            onChange={(e) => setCurrencyCode(e.target.value)}
            options={effCurrencies.map((c) => ({ value: c.code, label: `${c.code} (rate ${formatRate(c.rate)}${partyRateHint(c) ? ',' + partyRateHint(c) : ''})` }))}
          />
        </Field>

        <Field label={`${t('fin_amount', 'Amount')} (${currency.symbol})`}
          helper={
            currency.code !== 'USD' && amount
              ? `${t('fin_approx_usd', 'Approx. USD')}: ${formatMoney((typeof amount === 'number' ? amount : 0) / currency.rate, { code: 'USD', symbol: '$' })}`
              : undefined
          }
        >
          <MoneyInput value={amount} onChange={setAmount} currencySymbol={currency.symbol} />
        </Field>
      </form>
    </Modal>
  );
}

export default BalancePaymentModal;
