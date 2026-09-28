import React, { useEffect, useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button, Field, Input, Modal, Select, Tabs, Textarea, useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { translateServerError } from '../../lib/serverErrors';
import type { CountedLine, SettlementDetail } from './types';

export interface CurrencyInfo {
  code: string;
  symbol: string;
  rate: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  reportId: number;
  detail: SettlementDetail;
  currencies: CurrencyInfo[];
  onSaved: () => void;
}

type FieldErrors = Record<string, string>;

/** Admin-approved correction of a closed settlement: fix the counted cash, or add a missed adjustment. */
export function CorrectionModal({ open, onClose, reportId, detail, currencies, onSaved }: Props) {
  const { t } = useI18n();
  const toast = useToast();
  const [kind, setKind] = useState<'counted' | 'adjustment'>('counted');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState('');
  const [saving, setSaving] = useState(false);

  // Current effective count per currency = the corrected count when there is one, else the original.
  const baseLines: CountedLine[] = detail.corrected_counted ?? detail.counted ?? [];
  const lines = useMemo(() => {
    const byCode = new Map<string, CountedLine>();
    baseLines.forEach((l) => byCode.set(l.currency, l));
    currencies.forEach((c) => {
      if (!byCode.has(c.code)) byCode.set(c.code, { currency: c.code, amount: 0, rate: c.rate });
    });
    return Array.from(byCode.values());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, currencies]);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setKind('counted');
    setCounts(Object.fromEntries(lines.map((l) => [l.currency, String(l.amount ?? 0)])));
    setDirection('in');
    setAmount('');
    setCurrency(currencies[0]?.code || 'USD');
    setReason('');
    setPin('');
    setErrors({});
    setGeneral('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const rateFor = (code: string) => lines.find((l) => l.currency === code)?.rate || currencies.find((c) => c.code === code)?.rate || 1;
  const symbolFor = (code: string) => currencies.find((c) => c.code === code)?.symbol || code;

  const clearError = (k: string) => setErrors((prev) => (prev[k] ? { ...prev, [k]: '' } : prev));

  const submit = async () => {
    const local: FieldErrors = {};
    if (reason.trim().length < 3) local.reason = t('sd_err_reason_required', 'Enter a reason of at least 3 characters.');
    if (!pin.trim()) local.admin_pin = t('sd_err_pin_required', 'Enter the admin PIN.');

    let body: Record<string, unknown>;
    let sentCurrencies: string[] = [];
    if (kind === 'counted') {
      const payload = lines.map((l) => ({ currency: l.currency, amount: Number(counts[l.currency] === '' ? 0 : counts[l.currency]), rate: rateFor(l.currency) }));
      sentCurrencies = payload.map((p) => p.currency);
      payload.forEach((p) => {
        if (!Number.isFinite(p.amount) || p.amount < 0) local[`count:${p.currency}`] = t('sd_err_amount_invalid', 'Enter a valid amount.');
      });
      const changed = payload.some((p) => Math.abs(p.amount - (lines.find((l) => l.currency === p.currency)?.amount ?? 0)) > 0.0001);
      if (!changed && !Object.keys(local).length) setGeneral(t('sd_err_nothing_changed', 'Change at least one amount first.'));
      else setGeneral('');
      if (!changed && !Object.keys(local).length) return;
      body = { kind: 'counted', counted: payload };
    } else {
      const n = Number(amount);
      if (!amount || !Number.isFinite(n) || n <= 0) local.amount = t('sd_err_amount_invalid', 'Enter a valid amount.');
      body = { kind: 'adjustment', amount: direction === 'out' ? -n : n, currency, rate: rateFor(currency) };
    }

    setErrors(local);
    if (Object.keys(local).length) return;

    setSaving(true);
    setGeneral('');
    try {
      await api.post(`/api/settlements/${reportId}/corrections`, { ...body, admin_pin: pin, reason: reason.trim() });
      toast.success(t('sd_correction_saved', 'Correction saved.'));
      onSaved();
      onClose();
    } catch (err: any) {
      const msg = translateServerError(err, t) || String(err?.message || err);
      const field: string | undefined = err?.field;
      if (field === 'reason' || field === 'admin_pin' || field === 'amount') {
        setErrors({ [field]: msg });
      } else if (field && field.startsWith('counted.')) {
        const idx = Number(field.split('.')[1]);
        const code = sentCurrencies[idx];
        if (code) setErrors({ [`count:${code}`]: msg });
        else setGeneral(msg);
      } else {
        setGeneral(msg);
      }
    } finally {
      setSaving(false);
    }
  };

  const adjUsd = Number(amount) > 0 ? Number(amount) / rateFor(currency) : 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={t('sd_modal_title', 'Add correction')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>{t('sd_cancel', 'Cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={submit}>
            <ShieldCheck size={15} /> {t('sd_save_correction', 'Save correction')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Tabs
          value={kind}
          onChange={(v) => {
            setKind(v as 'counted' | 'adjustment');
            setGeneral('');
          }}
          items={[
            { value: 'counted', label: t('sd_tab_counted', 'Fix counted cash') },
            { value: 'adjustment', label: t('sd_tab_adjustment', 'Add adjustment') },
          ]}
        />

        {kind === 'counted' ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-text-3">{t('sd_counted_helper', 'Enter the correct count for each currency. Only currencies you change are recorded.')}</p>
            {lines.map((l) => (
              <Field key={l.currency} label={l.currency} htmlFor={`sd-count-${l.currency}`} error={errors[`count:${l.currency}`]}>
                <Input
                  id={`sd-count-${l.currency}`}
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={0}
                  className="num text-end"
                  startAdornment={symbolFor(l.currency)}
                  invalid={!!errors[`count:${l.currency}`]}
                  value={counts[l.currency] ?? ''}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => {
                    setCounts((prev) => ({ ...prev, [l.currency]: e.target.value }));
                    clearError(`count:${l.currency}`);
                  }}
                />
              </Field>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-text-3">{t('sd_adjustment_helper', 'Records a cash movement that was missed. The original counted cash stays unchanged.')}</p>
            <Field label={t('sd_direction', 'Direction')} htmlFor="sd-adj-direction">
              <Select
                id="sd-adj-direction"
                value={direction}
                onChange={(e) => setDirection(e.target.value as 'in' | 'out')}
                options={[
                  { value: 'in', label: t('sd_direction_in', 'Cash in (adds to expected)') },
                  { value: 'out', label: t('sd_direction_out', 'Cash out (subtracts from expected)') },
                ]}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('sd_amount', 'Amount')} htmlFor="sd-adj-amount" error={errors.amount}>
                <Input
                  id="sd-adj-amount"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={0}
                  className="num text-end"
                  invalid={!!errors.amount}
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    clearError('amount');
                  }}
                />
              </Field>
              <Field label={t('sd_currency', 'Currency')} htmlFor="sd-adj-currency">
                <Select
                  id="sd-adj-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  options={(currencies.length ? currencies : [{ code: 'USD', symbol: '$', rate: 1 }]).map((c) => ({ value: c.code, label: c.code }))}
                />
              </Field>
            </div>
            {currency !== 'USD' && adjUsd > 0 && (
              <p className="num text-xs text-text-3">{t('sd_equals_usd', '≈ {amount} USD').replace('{amount}', formatMoney(adjUsd, { code: 'USD', symbol: '$' }, { hideCurrency: true }))}</p>
            )}
          </div>
        )}

        <Field label={t('sd_reason', 'Reason')} htmlFor="sd-reason" required error={errors.reason}>
          <Textarea
            id="sd-reason"
            rows={3}
            invalid={!!errors.reason}
            value={reason}
            placeholder={t('sd_reason_placeholder', 'Why is this correction needed? (required)')}
            onChange={(e) => {
              setReason(e.target.value);
              clearError('reason');
            }}
          />
        </Field>

        <Field label={t('sd_admin_pin', 'Admin PIN')} htmlFor="sd-admin-pin" required helper={t('sd_admin_pin_helper', 'An administrator must approve every correction.')} error={errors.admin_pin}>
          <Input
            id="sd-admin-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            invalid={!!errors.admin_pin}
            value={pin}
            onChange={(e) => {
              setPin(e.target.value);
              clearError('admin_pin');
            }}
          />
        </Field>

        {general && (
          <div role="alert" className="rounded-[var(--radius-input)] border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
            {general}
          </div>
        )}
        {/* Enter submits from any single-line input. */}
        <button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
      </form>
    </Modal>
  );
}

export default CorrectionModal;
