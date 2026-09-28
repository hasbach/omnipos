import React, { useEffect, useState } from 'react';
import {
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Modal,
  Field,
  Input,
  NumberInput,
  Switch,
  Button,
  IconButton,
  Badge,
  useToast,
  useConfirm,
} from '../../components/ui';
import type { DataTableColumn } from '../../components/ui';
import { Coins, Plus, Edit2, Trash2 } from 'lucide-react';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import type { Currency } from '../../types';

export function CurrenciesSection() {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Currency> | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchCurrencies = () => {
    setLoading(true);
    return api
      .get<Currency[]>('/api/currencies')
      .then(setCurrencies)
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchCurrencies();
  }, []);

  const handleSave = async () => {
    if (!editing || !editing.code || !editing.symbol) return;
    setSaving(true);
    try {
      if (editing.id) {
        await api.put(`/api/currencies/${editing.id}`, editing);
      } else {
        await api.post('/api/currencies', editing);
      }
      toast.success(t('set_saved_toast'));
      setEditing(null);
      fetchCurrencies();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (c: Currency) => {
    const ok = await confirm({
      title: t('set_currency_delete_title'),
      description: t('set_currency_delete_desc').replace('{code}', c.code),
    });
    if (!ok) return;
    try {
      await api.del(`/api/currencies/${c.id}`);
      toast.success(t('set_saved_toast'));
      fetchCurrencies();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const columns: DataTableColumn<Currency>[] = [
    {
      key: 'currency',
      header: t('set_currency_col_currency'),
      render: (c) => (
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface-2 text-sm font-bold">
            {c.symbol}
          </span>
          <span className="font-semibold text-text">{c.code}</span>
          {c.is_default === 1 && <Badge variant="success">{t('set_currency_col_default')}</Badge>}
        </div>
      ),
    },
    { key: 'rate', header: t('set_currency_col_rate'), align: 'end', render: (c) => <span className="num">1 USD = {c.rate} {c.code}</span> },
    {
      key: 'actions',
      header: '',
      align: 'end',
      width: 80,
      render: (c) => (
        <div className="flex justify-end gap-1">
          <IconButton aria-label={t('stk_edit')} size="sm" onClick={() => setEditing(c)}>
            <Edit2 size={15} />
          </IconButton>
          <IconButton aria-label={t('stk_delete')} size="sm" onClick={() => c.id && handleDelete(c)}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 text-text-2">
          <Coins size={18} />
          <h3 className="text-sm font-semibold">{t('set_currencies')}</h3>
        </div>
        <Button variant="primary" size="sm" onClick={() => setEditing({ code: '', symbol: '', rate: 1, is_default: 0 })}>
          <Plus size={14} /> {t('set_add_currency')}
        </Button>
      </CardHeader>
      <CardBody>
        <DataTable columns={columns} data={currencies} rowKey={(c) => c.id || c.code} loading={loading} defaultPageSize={25} />
      </CardBody>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? t('set_edit_currency') : t('set_new_currency')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>{t('stk_cancel')}</Button>
            <Button variant="primary" loading={saving} onClick={handleSave}>{t('stk_save')}</Button>
          </>
        }
      >
        {editing && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('set_currency_code')}>
                <Input value={editing.code || ''} onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })} />
              </Field>
              <Field label={t('set_currency_symbol')}>
                <Input value={editing.symbol || ''} onChange={(e) => setEditing({ ...editing, symbol: e.target.value })} />
              </Field>
            </div>
            <Field label={t('set_currency_rate')}>
              <NumberInput value={editing.rate ?? 0} onChange={(v) => setEditing({ ...editing, rate: v })} step={0.01} />
            </Field>
            <Switch
              checked={editing.is_default === 1}
              onChange={(v) => setEditing({ ...editing, is_default: v ? 1 : 0 })}
              label={t('set_currency_default')}
            />
          </div>
        )}
      </Modal>
    </Card>
  );
}

export default CurrenciesSection;
