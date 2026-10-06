import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Field, MoneyInput, Select, Button, useToast, useConfirm } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, partyDisplayName } from '../../lib/format';
import { effectiveLocalCurrency, formatRate } from '../../lib/orderTotals';
import { translateServerError } from '../../lib/serverErrors';
import type { Currency, Stakeholder } from '../../types';

export interface PaymentModalProps {
  open: boolean;
  onClose: () => void;
  stakeholder: Stakeholder | null;
  currencies: Currency[];
  onDone: () => void;
}

/** Collect payment from a customer, or pay a supplier — POST /api/balance-payment. */
export function PaymentModal({ open, onClose, stakeholder, currencies, onDone }: PaymentModalProps) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [amount, setAmount] = useState<number>(0);
  const [currencyCode, setCurrencyCode] = useState('USD');
  const [saving, setSaving] = useState(false);

  const direction: 'collect' | 'pay' = stakeholder?.type === 'supplier' ? 'pay' : 'collect';

  useEffect(() => {
    if (!open) return;
    setAmount(0);
    const usd = currencies.find((c) => c.code === 'USD');
    setCurrencyCode(usd ? 'USD' : currencies[0]?.code || 'USD');
  }, [open, currencies]);

  // The party's own local-currency rate (when set) overrides the global one.
  const effLocal = effectiveLocalCurrency(currencies, stakeholder);
  const effCurrencies = useMemo(
    () => currencies.map((c) => (effLocal && c.code === effLocal.code ? { ...c, rate: effLocal.rate } : c)),
    [currencies, effLocal?.code, effLocal?.rate],
  );
  const currency = useMemo(() => effCurrencies.find((c) => c.code === currencyCode), [effCurrencies, currencyCode]);
  const exchangeRate = currency?.rate || 1;

  const currencyOptions = effCurrencies.map((c) => ({
    value: c.code,
    label: effLocal && c.code === effLocal.code
      ? `${c.code} (${c.symbol}) @ ${formatRate(c.rate)}${effLocal.source === 'party' ? ` ${direction === 'pay' ? t('party_rate_supplier', 'supplier rate') : t('party_rate_customer', 'customer rate')}` : ''}`
      : `${c.code} (${c.symbol})`,
  }));

  const handleSubmit = async () => {
    if (!stakeholder || amount <= 0) return;
    const amountUsd = amount / exchangeRate;
    const ok = await confirm({
      title: t('stk_payment_confirm_title'),
      description: t('stk_payment_confirm_desc')
        .replace('{amount}', formatMoney(amount, currency))
        .replace('{name}', partyDisplayName(stakeholder.name, t)),
      variant: 'primary',
      confirmLabel: t('stk_payment_submit'),
    });
    if (!ok) return;

    setSaving(true);
    try {
      await api.post('/api/balance-payment', {
        stakeholder_id: stakeholder.id,
        amount,
        currency: currencyCode,
        exchange_rate: exchangeRate,
        direction,
        user_id: sessionStorage.getItem('currentCashierId') || undefined,
      });
      toast.success(
        (direction === 'collect' ? t('stk_toast_payment_collected') : t('stk_toast_payment_paid')).replace(
          '{name}',
          partyDisplayName(stakeholder.name, t),
        ),
      );
      onDone();
      onClose();
    } catch (err: any) {
      toast.error(translateServerError(err, t) || t('stk_payment_error', 'Error'));
    } finally {
      setSaving(false);
    }
  };

  if (!stakeholder) return null;

  const title = (direction === 'collect' ? t('stk_payment_title_collect') : t('stk_payment_title_pay')).replace(
    '{name}',
    partyDisplayName(stakeholder.name, t),
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('stk_cancel')}</Button>
          <Button variant="primary" loading={saving} disabled={amount <= 0} onClick={handleSubmit}>
            {t('stk_payment_submit')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('stk_payment_amount')}>
            <MoneyInput currencySymbol={currency?.symbol || '$'} value={amount} onChange={setAmount} autoFocus />
          </Field>
          <Field label={t('stk_payment_currency')}>
            <Select value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} options={currencyOptions} />
          </Field>
        </div>
        {currencyCode !== 'USD' && (
          <p className="text-xs text-text-3 num">
            ≈ {formatMoney(amount / exchangeRate, { code: 'USD', symbol: '$' })}
          </p>
        )}
      </div>
    </Modal>
  );
}

export default PaymentModal;
