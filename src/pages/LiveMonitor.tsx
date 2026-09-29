import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Globe, Monitor, Users, Wallet, Zap } from 'lucide-react';
import { Badge, EmptyState, PageHeader, StatCard } from '../components/ui';
import { useI18n } from '../intl/index';
import { formatMoney, formatTime, transactionTypeLabel, partyDisplayName } from '../lib/format';
import { api } from '../lib/api';
import type { Tenant } from '../types';
import AccessLinksCard from './monitor/AccessLinksCard';

interface Activity {
  id: number;
  type: 'sale' | 'refund' | 'purchase' | string;
  created_at: string;
  user_name?: string;
  stakeholder_name?: string;
  total_amount: number;
  currency?: string;
}

interface TerminalCart {
  user: string;
  cart: { name: string; quantity: number; price: number }[];
  total: number;
  lastUpdate: Date;
}

export default function LiveMonitor() {
  const { t, lang } = useI18n();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activeTerminals, setActiveTerminals] = useState<Record<string, TerminalCart>>({});
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [stats, setStats] = useState({ todayTotal: 0, todayCount: 0, activeUsers: new Set<string>() });

  useEffect(() => {
    api.get<Tenant>('/api/auth/me').then(setTenant).catch(() => {});

    api.get<Activity[]>('/api/reports/daily-sales').then((data) => {
      setActivities(data || []);
      const total = (data || []).reduce((acc, a) => acc + a.total_amount, 0);
      const users = new Set((data || []).map((a) => a.user_name || ''));
      setStats({ todayTotal: total, todayCount: (data || []).length, activeUsers: users });
    }).catch(() => {});

    const handleSync = (e: any) => {
      const data = e.detail;
      if (data.type === 'TRANSACTIONS_UPDATED' && data.transaction) {
        const newTx = data.transaction as Activity;
        setActivities((prev) => [newTx, ...prev].slice(0, 50));
        setStats((prev) => ({
          todayTotal: prev.todayTotal + newTx.total_amount,
          todayCount: prev.todayCount + 1,
          activeUsers: new Set([...Array.from(prev.activeUsers), newTx.user_name || '']),
        }));
        setActiveTerminals((prev) => {
          const next = { ...prev };
          delete next[data.terminalId];
          return next;
        });
      }

      if (data.type === 'REMOTE_CART_UPDATE') {
        setActiveTerminals((prev) => ({
          ...prev,
          [data.terminalId]: {
            user: data.user,
            cart: data.cart,
            total: data.total,
            lastUpdate: new Date(),
          },
        }));
      }

      if (data.type === 'TERMINAL_OFFLINE') {
        setActiveTerminals((prev) => {
          const next = { ...prev };
          delete next[data.terminalId];
          return next;
        });
      }
    };

    window.addEventListener('pos-sync', handleSync);
    return () => window.removeEventListener('pos-sync', handleSync);
  }, []);

  const isOnlineExpired =
    tenant &&
    tenant.email !== 'hasbach' &&
    tenant.online_license_type !== 'lifetime' &&
    (!tenant.online_license_expiry || new Date(tenant.online_license_expiry) < new Date());

  if (isOnlineExpired) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-12">
        <EmptyState
          icon={Globe}
          title={t('fin_lm_expired_title', 'Online Monitor Expired')}
          description={t('fin_lm_expired_desc', 'Your online monitoring subscription has expired. Please renew to access real-time terminal tracking.')}
        />
        <div className="mt-6 w-full max-w-4xl"><AccessLinksCard tenantEmail={tenant?.email} /></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-success">
        <span className="h-2 w-2 animate-pulse rounded-full bg-success" />
        {t('fin_lm_live_feed', 'Live Remote Feed')}
      </div>
      <PageHeader
        title={t('fin_lm_title', 'Store Monitor')}
        subtitle={t('fin_lm_subtitle', 'Real-time activity from all POS terminals.')}
      />

      <AccessLinksCard tenantEmail={tenant?.email} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t('fin_lm_sales_today', 'Sales Today')} icon={Wallet} value={formatMoney(stats.todayTotal, { code: 'USD', symbol: '$' })} />
        <StatCard label={t('fin_lm_transactions', 'Transactions')} icon={Zap} value={stats.todayCount} />
        <StatCard label={t('fin_lm_active_staff', 'Active Staff')} icon={Users} value={stats.activeUsers.size} />
        <StatCard label={t('fin_lm_active_terminals', 'Active Terminals')} icon={Monitor} value={Object.keys(activeTerminals).length} />
      </div>

      {Object.keys(activeTerminals).length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-text">{t('fin_lm_live_terminals', 'Live Terminals (Current Carts)')}</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <AnimatePresence>
              {Object.entries(activeTerminals).map(([id, data]) => (
                <motion.div
                  key={id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="overflow-hidden rounded-[var(--radius-card)] border-2 border-primary bg-surface shadow-[var(--shadow-modal)]"
                >
                  <div className="flex items-center justify-between bg-primary px-4 py-2.5 text-on-primary">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-success" />
                      <span className="text-xs font-bold uppercase tracking-[0.04em]">{id}</span>
                    </div>
                    <span className="num text-xs opacity-80">{data.user}</span>
                  </div>
                  <div className="flex flex-col gap-3 p-4">
                    <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
                      {data.cart.length > 0 ? (
                        data.cart.map((item, i) => (
                          <div key={i} className="flex justify-between text-xs">
                            <span className="text-text-2">{item.quantity}x {item.name}</span>
                            <span className="num font-semibold text-text">{formatMoney(item.price * item.quantity, { code: 'USD', symbol: '$' })}</span>
                          </div>
                        ))
                      ) : (
                        <p className="py-4 text-center text-[11px] font-semibold uppercase italic text-text-3">{t('fin_lm_empty_cart', 'Empty cart')}</p>
                      )}
                    </div>
                    <div className="flex items-end justify-between border-t border-border pt-3">
                      <span className="text-[10px] font-bold uppercase text-text-3">{t('fin_lm_current_total', 'Current Total')}</span>
                      <span className="num text-xl font-bold text-text">{formatMoney(data.total, { code: 'USD', symbol: '$' })}</span>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-card)]">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-text">{t('fin_lm_activity_stream', 'Activity Stream')}</h2>
          <span className="text-xs text-text-3">{t('fin_lm_last_50', 'Showing last 50 events')}</span>
        </div>
        <div className="divide-y divide-border">
          <AnimatePresence initial={false}>
            {activities.length > 0 ? (
              activities.map((activity) => (
                <motion.div
                  key={activity.id}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="flex items-center justify-between px-5 py-3.5 transition-colors hover:bg-surface-2"
                >
                  <div className="flex items-center gap-4">
                    <div
                      className={[
                        'flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold',
                        activity.type === 'sale' ? 'bg-success-soft text-success' : activity.type === 'refund' ? 'bg-danger-soft text-danger' : 'bg-info-soft text-info',
                      ].join(' ')}
                    >
                      {activity.type === 'sale' ? '$' : activity.type === 'refund' ? 'R' : 'P'}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-text">{transactionTypeLabel(activity.type, t)} #{activity.id}</p>
                        <span className="text-[11px] text-text-3">{formatTime(activity.created_at, lang, { seconds: true })}</span>
                      </div>
                      <p className="text-xs text-text-3">
                        {t('fin_lm_processed_by', 'Processed by')} <span className="font-medium text-text-2">{activity.user_name}</span>
                        {activity.stakeholder_name && (
                          <>
                            {' '}
                            {t('fin_lm_for', 'for')} <span className="font-medium text-text-2">{partyDisplayName(activity.stakeholder_name, t)}</span>
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="text-end">
                    <p className={['num text-base font-bold', activity.type === 'refund' ? 'text-danger' : 'text-text'].join(' ')}>
                      {activity.type === 'refund' ? '-' : ''}
                      {formatMoney(activity.total_amount, { code: 'USD', symbol: '$' })}
                    </p>
                    <Badge variant="neutral">{activity.currency || 'USD'}</Badge>
                  </div>
                </motion.div>
              ))
            ) : (
              <EmptyState icon={Zap} title={t('fin_lm_waiting', 'Waiting for activity…')} />
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
