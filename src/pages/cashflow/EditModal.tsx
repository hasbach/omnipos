import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Badge, Button, Field, Input, Modal, MoneyInput, Select, Textarea, useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatDateTime, formatMoney } from '../../lib/format';
import { CATEGORY_TYPES, cashFlowErrorMessage, categoryLabel, categoryOptions, type CashFlowRow, type Category } from './common';

interface Currency { code: string; symbol: string; rate: number }

interface EditRecord {
  id: number;
  created_at: string;
  user_name?: string | null;
  edit_reason: string;
  before: Record<string, any> | null;
  after: Record<string, any> | null;
}

/** Admin edit of a cash-flow row (open or settled) with a mandatory reason, plus its audit history. */
export function CashFlowEditModal({ row, currencies, onClose, onSaved }: {
  row: CashFlowRow | null;
  currencies: Currency[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [type, setType] = useState<'in' | 'out'>('in');
  const [category, setCategory] = useState('other');
  const [counterparty, setCounterparty] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [rate, setRate] = useState<number | ''>(1);
  const [amount, setAmount] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  const [editReason, setEditReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<EditRecord[]>([]);

  useEffect(() => {
    if (!row) return;
    setType(row.type);
    setCategory(row.category || 'other');
    setCounterparty(row.counterparty || '');
    setCurrency(row.currency || 'USD');
    setRate(row.exchange_rate || 1);
    setAmount(row.amount);
    setReason(row.reason || '');
    setEditReason('');
    setError('');
    setHistory([]);
    api.get<EditRecord[]>(`/api/cash-flow/${row.id}/edits`).then((r) => setHistory(Array.isArray(r) ? r : [])).catch(() => {});
  }, [row]);

  if (!row) return null;

  const changeType = (next: 'in' | 'out') => {
    setType(next);
    if (!CATEGORY_TYPES[category as Category]?.includes(next)) setCategory('other');
  };
  const changeCurrency = (code: string) => {
    setCurrency(code);
    const c = currencies.find((x) => x.code === code);
    if (c) setRate(c.rate);
  };
  const symbol = currencies.find((c) => c.code === currency)?.symbol || currency;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editReason.trim().length < 3) { setError(t('cf_err_reason_required', 'Enter a reason for the edit (at least 3 characters).')); return; }
    setSaving(true);
    setError('');
    try {
      await api.put(`/api/cash-flow/${row.id}${row.archived ? '?archived=1' : ''}`, {
        type,
        amount: typeof amount === 'number' ? amount : parseFloat(String(amount)),
        currency,
        exchange_rate: typeof rate === 'number' ? rate : parseFloat(String(rate)),
        category,
        counterparty,
        reason,
        edit_reason: editReason.trim(),
      });
      toast.success(t('cf_edit_saved', 'Entry updated.'));
      onSaved();
      onClose();
    } catch (err: any) {
      setError(cashFlowErrorMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  const describe = (rec: Record<string, any> | null) => {
    if (!rec) return '—';
    const cur = { code: rec.currency, symbol: rec.currency };
    return `${rec.type === 'in' ? '+' : '-'}${formatMoney(rec.amount, cur)} · ${categoryLabel(rec.category, t)}${rec.counterparty ? ` · ${rec.counterparty}` : ''}${rec.reason ? ` · ${rec.reason}` : ''}`;
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('cf_edit_title', 'Edit cash movement #{id}').replace('{id}', String(row.id))}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('fin_cancel', 'Cancel')}</Button>
          <Button type="submit" form="cf-edit-form" loading={saving}>{t('cf_edit_save', 'Save changes')}</Button>
        </>
      }
    >
      <form id="cf-edit-form" className="flex flex-col gap-4" onSubmit={submit}>
        {row.archived && (
          <div role="alert" className="flex items-start gap-2 rounded-[var(--radius-input)] border border-border-strong bg-accent-soft px-3 py-2 text-xs text-accent">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{t('cf_edit_settled_warning', 'This entry belongs to a closed (settled) day. Editing it changes that day\'s rebuilt figures.')}</span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('fin_cfr_movement_type', 'Movement Type')}>
            <Select value={type} onChange={(e) => changeType(e.target.value as 'in' | 'out')} options={[
              { value: 'in', label: t('fin_cfr_cash_in', 'Cash In') },
              { value: 'out', label: t('fin_cfr_cash_out', 'Cash Out') },
            ]} />
          </Field>
          <Field label={t('cf_category', 'Category')}>
            <Select value={category} onChange={(e) => setCategory(e.target.value)} options={categoryOptions(t, type)} />
          </Field>
          <Field label={t('fin_currency', 'Currency')}>
            <Select value={currency} onChange={(e) => changeCurrency(e.target.value)}
              options={(currencies.some((c) => c.code === currency) ? currencies : [...currencies, { code: currency, symbol: currency, rate: Number(rate) || 1 }]).map((c) => ({ value: c.code, label: c.code }))} />
          </Field>
          <Field label={`${t('fin_amount', 'Amount')} (${symbol})`}>
            <MoneyInput value={amount} onChange={setAmount} currencySymbol={symbol} />
          </Field>
          {currency !== 'USD' && (
            <Field label={t('cf_exchange_rate', 'Exchange rate')}>
              <Input type="number" step="any" min="0" value={rate} onChange={(e) => setRate(e.target.value === '' ? '' : Number(e.target.value))} />
            </Field>
          )}
          <Field label={t('cf_counterparty', 'Counterparty (optional)')} className={currency !== 'USD' ? '' : 'sm:col-span-1'}>
            <Input value={counterparty} onChange={(e) => setCounterparty(e.target.value)} placeholder={t('cf_counterparty_placeholder', 'Who lent the money / who was paid')} />
          </Field>
        </div>

        <Field label={t('fin_reason', 'Reason')}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </Field>

        <Field label={t('cf_edit_reason', 'Reason for this edit')} required error={error || undefined}>
          <Textarea
            value={editReason}
            onChange={(e) => { setEditReason(e.target.value); setError(''); }}
            rows={2}
            placeholder={t('cf_edit_reason_placeholder', 'e.g. Amount was typed wrong; receipt says 75')}
            invalid={!!error}
          />
        </Field>

        <section aria-label={t('cf_history', 'Edit history')} className="border-t border-border pt-3">
          <h3 className="mb-2 text-sm font-semibold text-text">{t('cf_history', 'Edit history')}</h3>
          {history.length === 0 ? (
            <p className="text-xs text-text-3">{t('cf_history_empty', 'This entry has never been edited.')}</p>
          ) : (
            <ul className="flex max-h-56 flex-col gap-2 overflow-y-auto">
              {history.map((h) => (
                <li key={h.id} className="rounded-[var(--radius-input)] border border-border bg-surface-2 p-2.5 text-xs">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-text-3">
                    <Badge variant="warning">{t('cf_edited', 'Edited')}</Badge>
                    <span className="num">{formatDateTime(h.created_at, lang)}</span>
                    {h.user_name && <span>· {h.user_name}</span>}
                  </div>
                  <p className="mb-1 font-medium text-text">{h.edit_reason}</p>
                  <p className="text-text-3"><span className="font-semibold">{t('cf_before', 'Before')}:</span> {describe(h.before)}</p>
                  <p className="text-text-2"><span className="font-semibold">{t('cf_after', 'After')}:</span> {describe(h.after)}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </form>
    </Modal>
  );
}
