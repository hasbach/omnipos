import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  PageHeader, Toolbar, DateRangePicker, SearchInput, Select, Badge, DataTable, Button, Switch,
  useToast, type DataTableColumn,
} from '../components/ui';
import { useI18n } from '../intl/index';
import { ordersApi, orderStates, type OrderRow, orderBadge } from '../lib/ordersApi';
import { formatDateTime, formatMoney, type DateRange } from '../lib/format';
import { translateServerError } from '../lib/serverErrors';
import { ordersMuted } from '../hooks/useOrderNotifications';
import { writeOrderMute } from '../lib/orderNotifications';
import OrderDetailDrawer from './orders/OrderDetailDrawer';

export default function OnlineOrders() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState('submitted');
  const [store, setStore] = useState('');
  const [stores, setStores] = useState<{ id: number; name: string }[]>([]);
  // New orders may be older than any calendar preset; leave dates unfiltered until chosen.
  const [date, setDate] = useState<DateRange>({ from: '', to: '' });
  const [q, setQ] = useState('');
  const [id, setId] = useState<number | null>(null);
  const [muted, setMuted] = useState(ordersMuted);
  const request = useRef(0);

  const load = useCallback(() => {
    const sequence = ++request.current;
    setLoading(true);
    ordersApi.list({ state, store, from: date.from, to: date.to, q })
      .then((result) => {
        // A filter change may finish before an older request; keep the newest result.
        if (sequence !== request.current) return;
        setRows(result.rows);
        setOnline(result.online);
        setStores((old) => Array.from(
          new Map([...old, ...result.rows.map((r) => r.store)].map((s) => [s.id, s])).values(),
        ));
      })
      .catch((e) => {
        if (sequence === request.current) toast.error(translateServerError(e, t));
      })
      .finally(() => {
        if (sequence === request.current) setLoading(false);
      });
  }, [state, store, date.from, date.to, q, t, toast]);

  useEffect(() => {
    load();
    const sync = (e: Event) => {
      if ((e as CustomEvent).detail?.type === 'ORDERS_UPDATED') load();
    };
    window.addEventListener('pos-sync', sync);
    return () => {
      ++request.current;
      window.removeEventListener('pos-sync', sync);
    };
  }, [load]);

  // Populate the filter independently of state/date without requiring store.view permission.
  useEffect(() => {
    let active = true;
    ordersApi.list()
      .then((r) => {
        if (active) {
          setStores((old) => Array.from(
            new Map([...old, ...r.rows.map((row) => row.store)].map((s) => [s.id, s])).values(),
          ));
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const update = () => setMuted(ordersMuted());
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);

  const columns: DataTableColumn<OrderRow>[] = [
    {
      key: 'number', header: t('orders_number'),
      render: (r) => <span className="num font-medium">{r.number}</span>,
    },
    { key: 'submitted_at', header: t('orders_time'), render: (r) => formatDateTime(r.submitted_at, lang) },
    {
      key: 'customer_name', header: t('orders_customer'),
      render: (r) => (
        <div>
          {r.customer_name}
          <div className="num text-xs text-text-3" dir="ltr">{r.customer_phone}</div>
        </div>
      ),
    },
    { key: 'fulfilment', header: t('orders_fulfilment'), render: (r) => t('orders_' + r.fulfilment) },
    {
      key: 'total_usd', header: t('orders_total'), align: 'end',
      render: (r) => formatMoney(r.confirmed_total_usd ?? r.total_usd, { code: 'USD', symbol: '$' }),
    },
    {
      key: 'effective_state', header: t('orders_state'),
      render: (r) => <Badge variant={orderBadge(r.effective_state)}>{t('orders_' + r.effective_state)}</Badge>,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('orders_title')}
        actions={
          <Switch
            checked={muted}
            label={t('orders_mute')}
            onChange={(v) => {
              try {
                writeOrderMute(window.localStorage, v);
              } catch {}
              setMuted(ordersMuted());
            }}
          />
        }
      />
      {!online && (
        <div role="status" className="rounded-md bg-accent-soft p-3 text-sm text-accent">
          {t('orders_offline')}
        </div>
      )}
      <Toolbar>
        <div className="flex flex-wrap gap-2">
          {[...orderStates, ''].map((s) => (
            <Button
              key={s}
              size="sm"
              variant={state === s ? 'primary' : 'secondary'}
              aria-pressed={state === s}
              onClick={() => setState(s)}
            >
              {t(s ? 'orders_' + s : 'orders_all')}
            </Button>
          ))}
        </div>
      </Toolbar>
      <Toolbar>
        <Select
          aria-label={t('orders_store')}
          value={store}
          onChange={(e) => setStore(e.target.value)}
          options={[
            { value: '', label: t('orders_all') },
            ...stores.map((s) => ({ value: String(s.id), label: s.name })),
          ]}
        />
        <DateRangePicker value={date} onChange={setDate} />
        <SearchInput value={q} onChange={setQ} placeholder={t('orders_search')} />
      </Toolbar>
      <DataTable
        columns={columns}
        data={rows}
        rowKey={(r) => r.id}
        loading={loading}
        emptyTitle={t('orders_empty')}
        onRowClick={(r) => setId(r.id)}
      />
      <OrderDetailDrawer orderId={id} open={id !== null} onClose={() => setId(null)} onChanged={load} />
    </div>
  );
}
