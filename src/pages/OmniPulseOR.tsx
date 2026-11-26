import React, { useEffect, useState } from 'react';
import {
  Activity, AlertTriangle, CheckCircle2, ClipboardCheck, Lock, Plus, RefreshCw,
  ShieldAlert, Sliders, Truck, Wallet, XCircle,
} from 'lucide-react';
import {
  Badge, Button, Card, Checkbox, Input, Modal, PageHeader, Select, StatCard, Tabs, useConfirm, useToast,
} from '../components/ui';
import { useI18n } from '../intl/index';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';
import { usePermissions } from '../lib/usePermissions';
import type { Product, Stakeholder } from '../types';
import { BundleIdeas } from './or/BundleIdeas';

type TabKey = 'briefing' | 'draws' | 'pos' | 'cycle' | 'settings' | 'bundle-ideas';
const USD = { code: 'USD', symbol: '$' };

const MODE_VARIANT: Record<string, 'danger' | 'warning' | 'success'> = {
  CRISIS: 'danger',
  RECOVERY: 'warning',
  GROWTH: 'success',
};

const PO_STATUS_VARIANT: Record<string, 'neutral' | 'warning' | 'success' | 'danger'> = {
  DRAFT: 'neutral',
  APPROVED_LOCKED: 'warning',
  PARTIALLY_RECEIVED: 'warning',
  SETTLED: 'success',
  CANCELLED: 'danger',
};

export default function OmniPulseOR() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const { can } = usePermissions();

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<{ licensed: boolean; license_type: string; license_expiry: string | null } | null>(null);
  const [tab, setTab] = useState<TabKey>('briefing');

  // Data slices
  const [briefing, setBriefing] = useState<any>(null);
  const [drawsData, setDrawsData] = useState<{ usage: any; draws: any[] }>({ usage: null, draws: [] });
  const [poList, setPoList] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [activeSession, setActiveSession] = useState<any>(null);
  const [countInputs, setCountInputs] = useState<Record<number, string>>({});
  const [anomalies, setAnomalies] = useState<any[]>([]);
  const [configData, setConfigData] = useState<{ config: any; policies: any[]; obligations: any[]; suppliers: any[] } | null>(null);

  // Reference data
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Stakeholder[]>([]);
  const [customers, setCustomers] = useState<Stakeholder[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);

  // Modals
  const [drawModalOpen, setDrawModalOpen] = useState(false);
  const [drawForm, setDrawForm] = useState({
    cash_amount: '',
    account_id: '',
    product_id: '',
    item_qty: '1',
    override_reason: '',
  });
  const [drawItems, setDrawItems] = useState<Array<{ product_id: number; name: string; quantity: number; cost: number }>>([]);

  const [poModalOpen, setPoModalOpen] = useState(false);
  const [poForm, setPoForm] = useState({
    supplier_id: '',
    expected_delivery_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    payment_plan: 'CASH_ON_DELIVERY',
    estimated_order_total: '',
    notes: '',
  });

  const [receiveModalPo, setReceiveModalPo] = useState<any>(null);
  const [receiveForm, setReceiveForm] = useState({ actual_cash_paid: '', partial: false });
  const [receiveLines, setReceiveLines] = useState<Record<number, { qty: string; cost: string }>>({});

  const [obForm, setObForm] = useState({ name: '', amount_usd: '', frequency: 'monthly', due_day: '1', category: 'opex' });
  const [runningPipeline, setRunningPipeline] = useState(false);
  const [optLoading, setOptLoading] = useState(false);
  const [optSolution, setOptSolution] = useState<any>(null);

  const loadAll = async () => {
    setLoading(true);
    try {
      const st = await api.get<any>('/api/or/status');
      setStatus(st);
      if (!st.licensed) {
        setLoading(false);
        return;
      }
      const [br, dr, pos, cyc, anom, cfg, prods, stks, accs] = await Promise.all([
        api.get<any>('/api/or/briefing'),
        api.get<any>('/api/or/owner-draws'),
        api.get<any[]>('/api/or/po-commitments'),
        api.get<any[]>('/api/or/cycle-counts'),
        api.get<any[]>('/api/or/anomalies'),
        api.get<any>('/api/or/config'),
        api.get<Product[]>('/api/products').catch(() => []),
        api.get<Stakeholder[]>('/api/stakeholders').catch(() => []),
        api.get<any[]>('/api/cash-accounts').catch(() => []),
      ]);
      setBriefing(br);
      setDrawsData(dr);
      setPoList(pos || []);
      setSessions(cyc || []);
      setAnomalies(anom || []);
      setConfigData(cfg);
      setProducts(prods || []);
      setSuppliers((stks || []).filter((s) => s.type === 'supplier'));
      setCustomers((stks || []).filter((s) => s.type === 'customer'));
      setAccounts(accs || []);
    } catch (e: any) {
      toast.error(e.message || 'Failed to load OmniPulse OR');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleRunPipeline = async () => {
    setRunningPipeline(true);
    try {
      const res = await api.post<any>('/api/or/pipeline/run');
      toast.success(`Briefing refreshed (${res.skus_classified} SKUs, mode: ${res.survival_mode})`);
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRunningPipeline(false);
    }
  };

  const handleActionStatus = async (id: number, next: 'DONE' | 'DISMISSED') => {
    try {
      await api.post(`/api/or/actions/${id}/status`, { status: next });
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleAddDrawItem = () => {
    const pid = Number(drawForm.product_id);
    const qty = Number(drawForm.item_qty);
    const prod = products.find((p) => p.id === pid);
    if (!prod || !Number.isFinite(qty) || qty <= 0) return;
    setDrawItems((prev) => [...prev, { product_id: prod.id, name: prod.name, quantity: qty, cost: Number(prod.cost || 0) }]);
    setDrawForm((f) => ({ ...f, product_id: '', item_qty: '1' }));
  };

  const handleSubmitDraw = async () => {
    try {
      await api.post('/api/or/owner-draws', {
        cash_amount: Number(drawForm.cash_amount) || 0,
        account_id: drawForm.account_id ? Number(drawForm.account_id) : undefined,
        items: drawItems.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
        override_reason: drawForm.override_reason || undefined,
      });
      toast.success('Owner draw recorded');
      setDrawModalOpen(false);
      setDrawForm({ cash_amount: '', account_id: '', product_id: '', item_qty: '1', override_reason: '' });
      setDrawItems([]);
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleCreatePo = async () => {
    try {
      await api.post('/api/or/po-commitments', {
        supplier_id: Number(poForm.supplier_id),
        expected_delivery_date: poForm.expected_delivery_date,
        payment_plan: poForm.payment_plan,
        estimated_order_total: Number(poForm.estimated_order_total),
        notes: poForm.notes || undefined,
      });
      toast.success('Draft PO commitment created');
      setPoModalOpen(false);
      setPoForm({
        supplier_id: '',
        expected_delivery_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        payment_plan: 'CASH_ON_DELIVERY',
        estimated_order_total: '',
        notes: '',
      });
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleApprovePo = async (id: number, force = false) => {
    try {
      await api.post(`/api/or/po-commitments/${id}/approve`, { force });
      toast.success('PO approved & cash locked');
      await loadAll();
    } catch (e: any) {
      if (e.code === 'OR_PO_CASH_COLLISION') {
        const b = e.body || {};
        const ok = await confirm({
          title: t('or_cash_collision_title', 'Not enough free cash'),
          description: (
            <div className="space-y-2 text-sm">
              <p>
                {t('or_cash_collision_body', 'Locking {lock} for this PO is more than your free spendable cash ({free}). You would be {short} short.')
                  .replace('{lock}', formatMoney(Number(b.lock_amount) || 0, USD))
                  .replace('{free}', formatMoney(Number(b.free_spendable_usd) || 0, USD))
                  .replace('{short}', formatMoney(Number(b.shortfall) || 0, USD))}
              </p>
              <p className="text-text-3">{t('or_cash_collision_hint', 'You can still lock it; the shortfall is shown in the Morning Briefing.')}</p>
            </div>
          ),
          confirmLabel: t('or_cash_collision_confirm', 'Lock anyway'),
          cancelLabel: t('or_cancel', 'Cancel'),
          variant: 'danger',
        });
        if (ok) await handleApprovePo(id, true);
      } else {
        toast.error(e.message);
      }
    }
  };

  const handleReceivePo = async () => {
    if (!receiveModalPo) return;
    try {
      const items = (receiveModalPo.items || []).map((it: any) => ({
        product_id: it.product_id,
        received_qty: Number(receiveLines[it.id]?.qty) || 0,
        unit_cost: receiveLines[it.id]?.cost !== '' ? Number(receiveLines[it.id]?.cost) : undefined,
      }));
      const res = await api.post<any>(`/api/or/po-commitments/${receiveModalPo.id}/receive`, {
        items,
        actual_cash_paid: Number(receiveForm.actual_cash_paid) || 0,
        partial: receiveForm.partial,
      });
      toast.success(`PO received${res.releasedCash > 0 ? ` — $${res.releasedCash.toFixed(2)} released to Free Cash` : ''}`);
      setReceiveModalPo(null);
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const openReceiveModal = async (po: any) => {
    try {
      const full = await api.get<any>(`/api/or/po-commitments/${po.id}`);
      const lines: Record<number, { qty: string; cost: string }> = {};
      for (const it of full.items || []) {
        const remaining = Math.max(0, Number(it.ordered_qty) - Number(it.received_qty || 0));
        lines[it.id] = { qty: String(remaining), cost: String(it.unit_cost ?? '') };
      }
      setReceiveLines(lines);
      setReceiveForm({ actual_cash_paid: String(full.locked_cash_amount || ''), partial: false });
      setReceiveModalPo(full);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const receiveTotal = receiveModalPo
    ? (receiveModalPo.items || []).reduce((sum: number, it: any) => sum + (Number(receiveLines[it.id]?.qty) || 0) * (Number(receiveLines[it.id]?.cost) || 0), 0)
    : 0;

  const handleCancelPo = async (id: number) => {
    try {
      await api.post(`/api/or/po-commitments/${id}/cancel`);
      toast.success('PO cancelled and locked cash released');
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleRunOptimizer = async () => {
    setOptLoading(true);
    try {
      const sol = await api.post<any>('/api/or/optimizer/run');
      setOptSolution(sol);
      toast.success(`MILP solved (${sol.solver}, ${sol.solve_time_ms}ms) — ${sol.supplier_plans?.length || 0} supplier plan(s)`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setOptLoading(false);
    }
  };

  const handleApplyOptimizer = async () => {
    setOptLoading(true);
    try {
      const out = await api.post<any>('/api/or/optimizer/apply', optSolution?.plan_id ? { plan_id: optSolution.plan_id } : {});
      setOptSolution(out.solution);
      toast.success(`Created ${out.created_pos?.length || 0} Draft PO(s) for review`);
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setOptLoading(false);
    }
  };

  const handleGenerateCycleCount = async () => {
    try {
      const s = await api.post<any>('/api/or/cycle-counts/generate', { force: true });
      if (s?.empty) {
        toast.info('No tracked products available for cycle count.');
      } else {
        toast.success('Morning 5-minute cycle count generated');
        await openSession(s.id);
        await loadAll();
      }
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const openSession = async (id: number) => {
    try {
      const s = await api.get<any>(`/api/or/cycle-counts/${id}?blind=1`);
      setActiveSession(s);
      const map: Record<number, string> = {};
      for (const it of s.items || []) {
        map[it.id] = it.counted_qty != null ? String(it.counted_qty) : '';
      }
      setCountInputs(map);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleSubmitCounts = async () => {
    if (!activeSession) return;
    const counts = (activeSession.items || [])
      .filter((it: any) => countInputs[it.id] !== '' && countInputs[it.id] !== undefined)
      .map((it: any) => ({ item_id: it.id, product_id: it.product_id, counted_qty: Number(countInputs[it.id]) }));
    if (counts.length === 0) {
      toast.error('Enter at least one counted quantity.');
      return;
    }
    try {
      const res = await api.post<any>(`/api/or/cycle-counts/${activeSession.id}/submit`, { counts });
      toast.success(
        res.status === 'PENDING_APPROVAL'
          ? 'Counts submitted — variance exceeds threshold, awaiting owner approval.'
          : 'Cycle count completed and stock adjusted.'
      );
      setActiveSession(res);
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleApproveCycle = async (id: number) => {
    try {
      const res = await api.post<any>(`/api/or/cycle-counts/${id}/approve`);
      toast.success('Cycle count approved and stock adjusted');
      setActiveSession(res);
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleApplyPreset = async (business_type: string) => {
    try {
      await api.post('/api/or/apply-preset', { business_type });
      toast.success(`Applied ${business_type} preset`);
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleUpdateConfig = async (patch: Record<string, any>) => {
    try {
      await api.put('/api/or/config', patch);
      toast.success('OR settings updated');
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleAddObligation = async () => {
    try {
      await api.post('/api/or/obligations', {
        name: obForm.name,
        amount_usd: Number(obForm.amount_usd),
        frequency: obForm.frequency,
        due_day: Number(obForm.due_day) || 1,
        category: obForm.category,
      });
      toast.success('Fixed obligation added');
      setObForm({ name: '', amount_usd: '', frequency: 'monthly', due_day: '1', category: 'opex' });
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleDeleteObligation = async (id: number) => {
    try {
      await api.del(`/api/or/obligations/${id}`);
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="animate-spin text-text-3" size={28} />
      </div>
    );
  }

  // Paid Add-On Gate UI for unlicensed tenants
  if (!status?.licensed) {
    return (
      <div className="max-w-3xl mx-auto py-12 space-y-6">
        <Card className="p-8 text-center space-y-5">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-primary-soft text-primary flex items-center justify-center">
            <Lock size={28} />
          </div>
          <div className="space-y-2">
            <Badge variant="warning">Paid Add-On</Badge>
            <h1 className="text-2xl font-bold text-text">{t('or_locked_title', 'OmniPulse OR — Paid Add-On Module')}</h1>
            <p className="text-sm text-text-2 max-w-xl mx-auto">{t('or_locked_body')}</p>
          </div>
          <div className="grid sm:grid-cols-3 gap-3 text-start pt-2">
            <div className="p-4 rounded-xl border border-border bg-surface-2 space-y-1">
              <div className="font-semibold text-sm flex items-center gap-1.5"><Wallet size={15} /> Owner Draw Caps</div>
              <p className="text-xs text-text-3">Enforce daily/monthly cash & goods caps by survival mode.</p>
            </div>
            <div className="p-4 rounded-xl border border-border bg-surface-2 space-y-1">
              <div className="font-semibold text-sm flex items-center gap-1.5"><Truck size={15} /> PO Cash-Lock</div>
              <p className="text-xs text-text-3">Reserve cash for supplier deliveries and auto-release unused funds.</p>
            </div>
            <div className="p-4 rounded-xl border border-border bg-surface-2 space-y-1">
              <div className="font-semibold text-sm flex items-center gap-1.5"><ClipboardCheck size={15} /> 5-Min Cycle Count</div>
              <p className="text-xs text-text-3">Daily blind ABC & anomaly counts with variance approval.</p>
            </div>
          </div>
          <p className="text-xs text-text-3 pt-2">{t('or_locked_cta')}</p>
        </Card>
      </div>
    );
  }

  const settlements = briefing?.settlements;
  const sp = briefing?.spendable;
  const cfg = configData?.config || briefing?.config;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('or_title', 'OmniPulse OR')}
        subtitle={t('or_subtitle')}
        actions={
          <div className="flex items-center gap-2">
            {cfg && (
              <Badge variant={MODE_VARIANT[cfg.survival_mode] || 'warning'}>
                {cfg.survival_mode} · {cfg.business_type}
              </Badge>
            )}
            <Button variant="secondary" onClick={handleRunPipeline} disabled={runningPipeline}>
              <RefreshCw size={15} className={runningPipeline ? 'animate-spin' : ''} />
              {t('or_run_pipeline', 'Refresh Briefing')}
            </Button>
          </div>
        }
      />

      <Tabs
        value={tab}
        onChange={(v) => setTab(v as TabKey)}
        items={[
          { value: 'briefing', label: t('or_tab_briefing', 'Morning Briefing') },
          { value: 'bundle-ideas', label: t('bi_title') },
          { value: 'draws', label: t('or_tab_draws', 'Owner Draws') },
          { value: 'pos', label: t('or_tab_pos', 'PO Cash-Lock') },
          { value: 'cycle', label: t('or_tab_cycle', '5-Min Cycle Count') },
          ...(can('or.manage') ? [{ value: 'settings', label: t('or_tab_settings', 'Settings & Presets') }] : []),
        ]}
      />

      {/* TAB 1: MORNING BRIEFING */}
      {tab === 'bundle-ideas' && <BundleIdeas products={products} onSaved={loadAll} />}
      {tab === 'briefing' && sp && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label={t('or_free_spendable', 'Free Spendable Cash')}
              value={formatMoney(sp.free_spendable_cash_usd, USD)}
              icon={Wallet}
              className={sp.free_spendable_cash_usd < 0 ? 'border-danger' : ''}
            />
            <StatCard
              label={t('or_total_liquid', 'Total Liquid Cash')}
              value={formatMoney(sp.total_liquid_cash_usd, USD)}
              icon={Activity}
            />
            <StatCard
              label={t('or_opex_reserve', 'Locked OpEx Reserve')}
              value={formatMoney(sp.locked_opex_reserve_usd, USD)}
              icon={ShieldAlert}
            />
            <StatCard
              label={t('or_active_po_locks', 'Active PO Cash Locks')}
              value={formatMoney(sp.active_po_locks_usd, USD)}
              icon={Truck}
            />
          </div>
          {settlements && (
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                { key: 'or_owed_suppliers', aging: settlements.payable_aging },
                { key: 'or_customers_owe', aging: settlements.receivable_aging },
              ].map(({ key, aging }) => (
                <Card
                  key={key}
                  className="p-5 space-y-2"
                >
                  <h3 className="font-semibold">{t(key)}</h3>
                  <strong>{formatMoney(aging.total_usd, USD)}</strong>
                  <div className="text-xs text-text-3 space-y-1">
                    <p>{t('or_age_0_30')}: {formatMoney(aging.days_0_30, USD)}</p>
                    <p>{t('or_age_31_60')}: {formatMoney(aging.days_31_60, USD)}</p>
                    <p>{t('or_age_60_plus')}: {formatMoney(aging.days_60_plus, USD)}</p>
                    <p>{t('or_undated')}: {formatMoney(aging.undated, USD)}</p>
                  </div>
                </Card>
              ))}
            </div>
          )}
          {settlements && (
            <Card className="p-5 space-y-3">
              <h3 className="font-semibold">{t('or_debt_briefing')}</h3>
              <p>{t('or_payables_reserved')}: {formatMoney(sp.payables_reserve_usd, USD)}</p>
              {[
                { key: 'or_supplier_overdue', rows: settlements.briefing.overdue },
                { key: 'or_supplier_due_week', rows: settlements.briefing.due_week },
                { key: 'or_chase_customers', rows: settlements.briefing.chase },
              ].map(({ key, rows }) => (
                <div key={key}>
                  <h4 className="font-medium text-sm">{t(key)}</h4>
                  {rows.length === 0 && <p className="text-xs text-text-3">{t('or_no_debt_items')}</p>}
                  {rows.map((row: any, index: number) => (
                    <p
                      key={index}
                      className="text-sm"
                    >
                      {row.name} · {formatMoney(row.amount_usd, USD)} · {row.age_days === null ? t('or_undated') : t('or_debt_age').replace('{days}', String(row.age_days))}
                      {row.due_date && <span> · {t('or_invoice_due')}: {row.due_date}</span>}
                      {row.phone && <span> · {row.phone}</span>}
                    </p>
                  ))}
                </div>
              ))}
            </Card>
          )}
          <div className="text-xs text-text-3 flex flex-wrap gap-4">
            <span>Drawer: <strong>{formatMoney(sp.drawer_balance_usd, USD)}</strong></span>
            <span>Safe/Bank: <strong>{formatMoney(sp.savings_balance_usd + sp.bank_balance_usd, USD)}</strong></span>
            <span>Min Float: <strong>{formatMoney(sp.min_drawer_float_usd, USD)}</strong></span>
            <span>{t('or_bills_per_day', 'Bills')}: <strong>{formatMoney(sp.daily_opex_burn_usd, USD)}/day</strong></span>
            <span>{t('or_draws_per_day', 'Owner draws')}: <strong>{formatMoney(sp.avg_daily_owner_draws_usd || 0, USD)}/day</strong></span>
            <span>{t('or_profit_per_day', 'Gross profit')}: <strong>{formatMoney(sp.avg_daily_gross_profit_usd || 0, USD)}/day</strong></span>
            <span>
              {t('or_runway_days', 'Runway')}:{' '}
              <strong>{sp.runway_days != null ? `${sp.runway_days}d` : t('or_runway_covered', 'profit covers bills')}</strong>
            </span>
          </div>

          <Card className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-text flex items-center gap-2">
                <Activity size={16} /> Morning Action Queue
              </h3>
              <span className="text-xs text-text-3">
                {briefing?.open_anomalies_count || 0} open stock anomalies
              </span>
            </div>
            {(briefing?.actions || []).length === 0 ? (
              <p className="text-sm text-text-3 py-4 text-center">No urgent actions today. Click Refresh Briefing to recompute.</p>
            ) : (
              <div className="space-y-2">
                {briefing.actions.map((a: any) => (
                  <div key={a.id} className="flex items-start justify-between gap-3 p-3 rounded-lg border border-border bg-surface-2">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <Badge variant={a.priority === 'CRITICAL' ? 'danger' : a.priority === 'HIGH' ? 'warning' : 'neutral'}>
                          {a.priority}
                        </Badge>
                        <span className="font-medium text-sm text-text">{a.title}</span>
                      </div>
                      {a.details && <p className="text-xs text-text-3">{a.details}</p>}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button size="sm" variant="secondary" onClick={() => handleActionStatus(a.id, 'DONE')}>
                        <CheckCircle2 size={14} />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => handleActionStatus(a.id, 'DISMISSED')}>
                        <XCircle size={14} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* TAB 2: OWNER DRAWS */}
      {tab === 'draws' && (
        <div className="space-y-5">
          <div className="flex flex-wrap justify-between items-center gap-3">
            <div className="text-sm text-text-2">
              {drawsData.usage?.policy && (
                <>
                  Today: <strong>{formatMoney(drawsData.usage.cash_today, USD)}</strong> / {formatMoney(drawsData.usage.policy.max_daily_cash, USD)} cash ·{' '}
                  <strong>{formatMoney(drawsData.usage.goods_today, USD)}</strong> / {formatMoney(drawsData.usage.policy.max_daily_goods_cost, USD)} goods ·{' '}
                  Month: <strong>{formatMoney(drawsData.usage.total_month, USD)}</strong> / {formatMoney(drawsData.usage.policy.max_monthly_total, USD)}
                </>
              )}
            </div>
            {can('or.owner_draw') && (
              <Button onClick={() => setDrawModalOpen(true)}>
                <Plus size={15} /> {t('or_record_draw', 'Record Owner Draw')}
              </Button>
            )}
          </div>

          <Card className="p-4 bg-surface-2 flex flex-wrap items-center justify-between gap-3 text-xs text-text-2">
            <div>
              <strong>Unified Tracking:</strong> All cash outflows with category <code>owner_withdrawal</code> in Cash Flow Register (historical + new) are counted automatically.
              {drawsData.usage?.owner_customer ? (
                <>
                  {' '}Owner Goods Customer: <strong>{drawsData.usage.owner_customer.name}</strong> (Balance:{' '}
                  <strong>{formatMoney(drawsData.usage.owner_customer.balance, USD)}</strong> · All-time Goods at Cost:{' '}
                  <strong>{formatMoney(drawsData.usage.owner_customer.goods_cost_all_time, USD)}</strong>).
                </>
              ) : (
                <> Select a <strong>Business Owner Customer</strong> in <em>Settings &amp; Presets</em> to automatically count POS goods taken by the owner at cost.</>
              )}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-text-3 text-xs uppercase">
                <tr>
                  <th className="p-3 text-start">Date</th>
                  <th className="p-3 text-start">Type</th>
                  <th className="p-3 text-end">Cash</th>
                  <th className="p-3 text-end">Goods (Cost)</th>
                  <th className="p-3 text-end">Total</th>
                  <th className="p-3 text-start">Source / Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {drawsData.draws.length === 0 ? (
                  <tr><td colSpan={6} className="p-6 text-center text-text-3">No owner draws recorded yet.</td></tr>
                ) : (
                  drawsData.draws.map((d: any, idx: number) => (
                    <tr key={`${d.source || 'or'}-${d.id}-${idx}`}>
                      <td className="p-3">{d.draw_date}</td>
                      <td className="p-3">
                        <Badge variant="neutral">{d.draw_type}</Badge>
                        {d.source === 'cash_flow' && <Badge variant="warning" className="ms-1.5">Cash Register</Badge>}
                        {d.source === 'owner_customer_sale' && <Badge variant="success" className="ms-1.5">Owner Customer</Badge>}
                      </td>
                      <td className="p-3 text-end">{formatMoney(d.cash_amount, USD)}</td>
                      <td className="p-3 text-end">{formatMoney(d.goods_cost_total, USD)}</td>
                      <td className="p-3 text-end font-semibold">{formatMoney(d.total_draw_value, USD)}</td>
                      <td className="p-3">
                        <span className="text-xs text-text-2">{d.cash_source || '—'}</span>
                        {d.exceeded_cap ? (
                          <Badge variant="danger" className="ms-2">Cap Override: {d.override_reason}</Badge>
                        ) : d.override_reason ? (
                          <span className="text-xs text-text-3 ms-2">{d.override_reason}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {/* TAB 3: PO CASH-LOCK */}
      {tab === 'pos' && (
        <div className="space-y-5">
          <div className="flex flex-wrap justify-between items-center gap-2">
            <div className="text-sm text-text-2">
              Active PO Cash Locks: <strong>{formatMoney(sp?.active_po_locks_usd || 0, USD)}</strong> · Free Spendable Cash: <strong>{formatMoney(sp?.free_spendable_cash_usd || 0, USD)}</strong>
            </div>
            <div className="flex items-center gap-2">
              {can('or.po_lock') && (
                <Button variant="secondary" onClick={handleRunOptimizer} disabled={optLoading}>
                  <Activity size={15} className={optLoading ? 'animate-spin' : ''} /> Run MILP Optimizer
                </Button>
              )}
              {can('or.po_lock') && (
                <Button onClick={() => setPoModalOpen(true)}>
                  <Plus size={15} /> {t('or_new_po', 'New PO Commitment')}
                </Button>
              )}
            </div>
          </div>

          {optSolution && (
            <Card className="p-5 space-y-4 border-primary">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-sm text-text">Dynamic MILP Restock & Cash Plan</h3>
                    <Badge variant="neutral">{optSolution.solver} · {optSolution.solve_time_ms}ms</Badge>
                    <Badge variant={MODE_VARIANT[optSolution.survival_mode] || 'warning'}>
                      {optSolution.survival_mode} · {optSolution.horizon_days}d
                    </Badge>
                  </div>
                  <p className="text-xs text-text-3">
                    Order Value: <strong>{formatMoney(optSolution.total_order_value_usd, USD)}</strong> ·
                    Cash: <strong>{formatMoney(optSolution.total_cash_used_usd, USD)}</strong> ·
                    Credit: <strong>{formatMoney(optSolution.total_credit_used_usd, USD)}</strong>
                    {optSolution.total_debt_paydown_usd > 0 && (
                      <> · Debt Paydown: <strong>{formatMoney(optSolution.total_debt_paydown_usd, USD)}</strong></>
                    )} ·
                    Est. Profit: <strong>{formatMoney(optSolution.expected_gross_profit_usd, USD)}</strong>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {(optSolution.supplier_plans || []).length > 0 && (
                    <Button size="sm" onClick={handleApplyOptimizer} disabled={optLoading}>
                      Create Draft POs ({optSolution.supplier_plans.length})
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setOptSolution(null)}>Dismiss</Button>
                </div>
              </div>

              {(optSolution.binding_constraints || []).length > 0 && (
                <div className="space-y-1.5">
                  {optSolution.binding_constraints.map((b: any, i: number) => (
                    <div key={i} className="text-xs px-3 py-2 rounded-lg bg-surface-2 border border-border flex items-center gap-2">
                      <Badge variant={b.code === 'CASH_BUDGET' ? 'warning' : 'neutral'}>{b.code}</Badge>
                      <span className="text-text-2">{b.message}</span>
                    </div>
                  ))}
                </div>
              )}

              {(optSolution.supplier_plans || []).length > 0 && (
                <div className="space-y-3">
                  {optSolution.supplier_plans.map((plan: any) => (
                    <div key={plan.supplier_id} className="p-3 rounded-lg border border-border bg-surface-2 space-y-2">
                      <div className="flex flex-wrap justify-between items-center text-sm">
                        <span className="font-semibold">{plan.supplier_name}</span>
                        <span className="text-xs text-text-2">
                          {plan.payment_plan} · Cash {formatMoney(plan.cash_payment_usd, USD)} · Credit {formatMoney(plan.credit_payment_usd, USD)}
                          {plan.debt_paydown_usd > 0 ? ` · Pay Debt ${formatMoney(plan.debt_paydown_usd, USD)}` : ''}
                        </span>
                      </div>
                      <div className="text-xs text-text-3 space-y-1">
                        {plan.items.map((it: any) => (
                          <div key={it.product_id} className="flex justify-between">
                            <span>[{it.abc_class}] {it.name} — {it.ordered_qty} units ({it.packs_to_order} × {it.pack_factor})</span>
                            <span>{formatMoney(it.line_cost_usd, USD)} (est. profit {formatMoney(it.expected_profit_usd, USD)})</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-text-3 text-xs uppercase">
                <tr>
                  <th className="p-3 text-start">PO #</th>
                  <th className="p-3 text-start">Supplier</th>
                  <th className="p-3 text-start">Expected</th>
                  <th className="p-3 text-start">Plan</th>
                  <th className="p-3 text-end">Estimated</th>
                  <th className="p-3 text-end">Locked Cash</th>
                  <th className="p-3 text-start">Status</th>
                  <th className="p-3 text-end">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {poList.length === 0 ? (
                  <tr><td colSpan={8} className="p-6 text-center text-text-3">No PO commitments yet.</td></tr>
                ) : (
                  poList.map((po: any) => (
                    <tr key={po.id}>
                      <td className="p-3 font-mono text-xs">{po.po_number || `#${po.id}`}</td>
                      <td className="p-3 font-medium">{po.supplier_name || `#${po.supplier_id}`}</td>
                      <td className="p-3">{po.expected_delivery_date}</td>
                      <td className="p-3 text-xs">{po.payment_plan}</td>
                      <td className="p-3 text-end">{formatMoney(po.estimated_order_total, USD)}</td>
                      <td className="p-3 text-end font-semibold">{formatMoney(po.locked_cash_amount, USD)}</td>
                      <td className="p-3"><Badge variant={PO_STATUS_VARIANT[po.status] || 'neutral'}>{po.status}</Badge></td>
                      <td className="p-3 text-end space-x-1.5">
                        {po.status === 'DRAFT' && can('or.po_lock') && (
                          <Button size="sm" onClick={() => handleApprovePo(po.id)}>Approve & Lock</Button>
                        )}
                        {(po.status === 'APPROVED_LOCKED' || po.status === 'PARTIALLY_RECEIVED') && can('or.po_lock') && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => openReceiveModal(po)}
                          >
                            Receive
                          </Button>
                        )}
                        {(po.status === 'DRAFT' || po.status === 'APPROVED_LOCKED') && can('or.po_lock') && (
                          <Button size="sm" variant="ghost" onClick={() => handleCancelPo(po.id)}>Cancel</Button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {/* TAB 4: 5-MINUTE CYCLE COUNT */}
      {tab === 'cycle' && (
        <div className="space-y-5">
          <div className="flex justify-between items-center">
            <div className="text-sm text-text-2">
              Blind counting hides system stock until submission. Variances above <strong>{cfg?.variance_alert_pct ?? 5}%</strong> require owner approval.
            </div>
            <Button onClick={handleGenerateCycleCount}>
              <Plus size={15} /> {t('or_generate_count', 'Generate Morning Count')}
            </Button>
          </div>

          {activeSession && (
            <Card className="p-5 space-y-4 border-primary">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-text">
                    Session #{activeSession.id} · {activeSession.session_date} ({activeSession.session_type})
                  </h3>
                  <Badge variant={activeSession.status === 'COMPLETED' ? 'success' : activeSession.status === 'PENDING_APPROVAL' ? 'warning' : 'neutral'}>
                    {activeSession.status}
                  </Badge>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setActiveSession(null)}>Close</Button>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-text-3 text-xs uppercase">
                  <tr>
                    <th className="p-2.5 text-start">Product</th>
                    <th className="p-2.5 text-start">Reason</th>
                    <th className="p-2.5 text-end">Physical Count</th>
                    {activeSession.status !== 'OPEN' && activeSession.status !== 'IN_PROGRESS' && (
                      <>
                        <th className="p-2.5 text-end">System</th>
                        <th className="p-2.5 text-end">Variance</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(activeSession.items || []).map((it: any) => (
                    <tr key={it.id}>
                      <td className="p-2.5 font-medium">
                        {it.product_name || `#${it.product_id}`}
                        {it.barcode && <span className="text-xs text-text-3 ms-2">{it.barcode}</span>}
                      </td>
                      <td className="p-2.5"><Badge variant="neutral">{it.priority_reason}</Badge></td>
                      <td className="p-2.5 text-end">
                        {activeSession.status === 'OPEN' || activeSession.status === 'IN_PROGRESS' ? (
                          <Input
                            type="number"
                            className="w-28 ms-auto text-end"
                            value={countInputs[it.id] ?? ''}
                            onChange={(e) => setCountInputs((m) => ({ ...m, [it.id]: e.target.value }))}
                          />
                        ) : (
                          <span>{it.counted_qty ?? '—'}</span>
                        )}
                      </td>
                      {activeSession.status !== 'OPEN' && activeSession.status !== 'IN_PROGRESS' && (
                        <>
                          <td className="p-2.5 text-end">{it.system_qty_snapshot}</td>
                          <td className="p-2.5 text-end font-semibold">{it.variance_qty} ({formatMoney(it.variance_cost || 0, USD)})</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex justify-end gap-2">
                {(activeSession.status === 'OPEN' || activeSession.status === 'IN_PROGRESS') && (
                  <Button onClick={handleSubmitCounts}>Submit Blind Counts</Button>
                )}
                {activeSession.status === 'PENDING_APPROVAL' && can('or.manage') && (
                  <Button onClick={() => handleApproveCycle(activeSession.id)}>Approve & Adjust Stock</Button>
                )}
              </div>
            </Card>
          )}

          <div className="grid lg:grid-cols-2 gap-4">
            <Card className="p-4 space-y-3">
              <h3 className="font-semibold text-sm">Recent Cycle Count Sessions</h3>
              {sessions.length === 0 ? (
                <p className="text-xs text-text-3">No sessions yet.</p>
              ) : (
                <div className="space-y-2">
                  {sessions.map((s: any) => (
                    <div key={s.id} className="flex items-center justify-between p-2.5 rounded-lg border border-border">
                      <div>
                        <div className="text-sm font-medium">{s.session_date} · {s.total_items_planned} items</div>
                        <div className="text-xs text-text-3">{s.session_type} · Variance: {formatMoney(s.total_variance_cost || 0, USD)}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={s.status === 'COMPLETED' ? 'success' : s.status === 'PENDING_APPROVAL' ? 'warning' : 'neutral'}>{s.status}</Badge>
                        <Button size="sm" variant="secondary" onClick={() => openSession(s.id)}>Open</Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-4 space-y-3">
              <h3 className="font-semibold text-sm flex items-center gap-1.5">
                <AlertTriangle size={15} /> Open Stock Anomalies ({anomalies.length})
              </h3>
              {anomalies.length === 0 ? (
                <p className="text-xs text-text-3">No open anomalies. Negative-stock sales or shelf-empty flags appear here automatically.</p>
              ) : (
                <div className="space-y-2">
                  {anomalies.map((a: any) => (
                    <div key={a.id} className="flex items-center justify-between p-2.5 rounded-lg border border-border text-sm">
                      <div>
                        <div className="font-medium">{a.product_name || `#${a.product_id}`}</div>
                        <div className="text-xs text-text-3">Stock: {a.current_stock} · {a.anomaly_type}</div>
                      </div>
                      <Badge variant="danger">{a.status}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* TAB 5: SETTINGS & PRESETS */}
      {tab === 'settings' && configData && (
        <div className="space-y-6">
          <Card className="p-5 space-y-4">
            <h3 className="font-semibold text-sm flex items-center gap-1.5"><Sliders size={15} /> Industry Presets</h3>
            <p className="text-xs text-text-3">Apply recommended defaults for your vertical (you can fine-tune every threshold below).</p>
            <div className="flex flex-wrap gap-2">
              {(['RETAIL', 'RESTAURANT', 'SERVICE', 'HYBRID'] as const).map((bt) => (
                <Button
                  key={bt}
                  variant={configData.config.business_type === bt ? 'primary' : 'secondary'}
                  onClick={() => handleApplyPreset(bt)}
                >
                  {bt}
                </Button>
              ))}
            </div>
            <div className="grid sm:grid-cols-3 gap-4 pt-2">
              <div>
                <label className="text-xs font-medium text-text-2">Min Drawer Float (USD)</label>
                <Input
                  type="number"
                  defaultValue={configData.config.min_drawer_float}
                  onBlur={(e) => handleUpdateConfig({ min_drawer_float: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-text-2">Daily Cycle Count Limit</label>
                <Input
                  type="number"
                  defaultValue={configData.config.cycle_count_daily_limit}
                  onBlur={(e) => handleUpdateConfig({ cycle_count_daily_limit: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-text-2">Variance Alert Threshold (%)</label>
                <Input
                  type="number"
                  defaultValue={configData.config.variance_alert_pct}
                  onBlur={(e) => handleUpdateConfig({ variance_alert_pct: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="pt-3 border-t border-border">
              <label className="text-xs font-medium text-text-2">Business Owner Customer (Goods Draw Account)</label>
              <p className="text-xs text-text-3 mb-1.5">
                Pick the customer account used when the owner takes goods via POS. All historical and future sales to this customer are counted automatically at cost as Owner Goods Draws.
              </p>
              <Select
                value={configData.config.owner_stakeholder_id ? String(configData.config.owner_stakeholder_id) : ''}
                onChange={(e) =>
                  handleUpdateConfig({
                    owner_stakeholder_id: e.target.value ? Number(e.target.value) : null,
                  })
                }
                options={[
                  { value: '', label: 'None (Not linked)' },
                  ...customers.map((c) => ({ value: String(c.id), label: `${c.name} (Balance: ${formatMoney(c.balance || 0, USD)})` })),
                ]}
              />
            </div>
          </Card>

          <Card className="p-5 space-y-4">
            <h3 className="font-semibold text-sm">{t('or_supplier_terms')}</h3>
            <p className="text-xs text-text-3">{t('or_supplier_terms_hint')}</p>
            <label className="block text-xs font-medium">
              {t('or_payables_horizon')}
              <Input
                type="number"
                min={0}
                max={3650}
                disabled={!can('or.manage')}
                defaultValue={configData.config.payables_reserve_days ?? 7}
                onBlur={(e) => handleUpdateConfig({ payables_reserve_days: Number(e.target.value) })}
              />
            </label>
            {(configData.suppliers || []).map((supplier: any) => (
              <label
                key={supplier.id}
                className="block text-xs font-medium"
              >
                {supplier.name}
                <Input
                  type="number"
                  min={0}
                  max={3650}
                  disabled={!can('or.manage')}
                  defaultValue={supplier.payment_terms_days}
                  onBlur={async (e) => {
                    try {
                      await api.put('/api/or/suppliers/' + supplier.id + '/terms', { payment_terms_days: Number(e.target.value) });
                      await loadAll();
                    } catch (error: any) { toast.error(error.message || t('or_terms_save_failed')); }
                  }}
                />
              </label>
            ))}
          </Card>
          <Card className="p-5 space-y-4">
            <h3 className="font-semibold text-sm">Fixed Obligations (OpEx Reserve & Runway)</h3>
            <div className="grid sm:grid-cols-5 gap-2">
              <Input placeholder="Rent, Electricity..." value={obForm.name} onChange={(e) => setObForm({ ...obForm, name: e.target.value })} />
              <Input type="number" placeholder="USD Amount" value={obForm.amount_usd} onChange={(e) => setObForm({ ...obForm, amount_usd: e.target.value })} />
              <Select
                value={obForm.frequency}
                onChange={(e) => setObForm({ ...obForm, frequency: e.target.value })}
                options={[
                  { value: 'daily', label: 'Daily' },
                  { value: 'weekly', label: 'Weekly' },
                  { value: 'monthly', label: 'Monthly' },
                  { value: 'yearly', label: 'Yearly' },
                ]}
              />
              <Input type="number" placeholder="Due Day" value={obForm.due_day} onChange={(e) => setObForm({ ...obForm, due_day: e.target.value })} />
              <Button onClick={handleAddObligation}><Plus size={14} /> Add</Button>
            </div>
            <div className="divide-y divide-border">
              {(configData.obligations || []).map((o: any) => (
                <div key={o.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <span className="font-medium">{o.name}</span>
                    <span className="text-xs text-text-3 ms-2">{o.frequency} · Day {o.due_day}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold">{formatMoney(o.amount_usd, USD)}</span>
                    <Button size="sm" variant="ghost" onClick={() => handleDeleteObligation(o.id)}>Delete</Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* MODAL: RECORD OWNER DRAW */}
      <Modal open={drawModalOpen} onClose={() => setDrawModalOpen(false)} title={t('or_record_draw', 'Record Owner Draw')}>
        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-text-2">Cash Amount (USD)</label>
              <Input type="number" value={drawForm.cash_amount} onChange={(e) => setDrawForm({ ...drawForm, cash_amount: e.target.value })} placeholder="0.00" />
            </div>
            <div>
              <label className="text-xs font-medium text-text-2">Cash Account</label>
              <Select
                value={drawForm.account_id}
                onChange={(e) => setDrawForm({ ...drawForm, account_id: e.target.value })}
                options={[
                  { value: '', label: 'Default Cash Drawer' },
                  ...accounts.map((a) => ({ value: String(a.id), label: `${a.name} (${formatMoney(a.balance_usd, USD)})` })),
                ]}
              />
            </div>
          </div>

          <div className="space-y-2 pt-2 border-t border-border">
            <label className="text-xs font-medium text-text-2">Optional Goods / Shelf Items (Valued at Cost)</label>
            <div className="flex gap-2">
              <Select
                value={drawForm.product_id}
                onChange={(e) => setDrawForm({ ...drawForm, product_id: e.target.value })}
                options={[
                  { value: '', label: 'Select product...' },
                  ...products.slice(0, 200).map((p) => ({ value: String(p.id), label: `${p.name} (cost $${Number(p.cost || 0).toFixed(2)})` })),
                ]}
              />
              <Input type="number" className="w-24" value={drawForm.item_qty} onChange={(e) => setDrawForm({ ...drawForm, item_qty: e.target.value })} />
              <Button variant="secondary" onClick={handleAddDrawItem}>Add</Button>
            </div>
            {drawItems.length > 0 && (
              <div className="space-y-1 text-xs">
                {drawItems.map((it, idx) => (
                  <div key={idx} className="flex justify-between bg-surface-2 px-2.5 py-1.5 rounded">
                    <span>{it.name} × {it.quantity}</span>
                    <span>{formatMoney(it.quantity * it.cost, USD)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-text-2">Override Reason (required if exceeding cap)</label>
            <Input value={drawForm.override_reason} onChange={(e) => setDrawForm({ ...drawForm, override_reason: e.target.value })} placeholder="Optional unless over cap" />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setDrawModalOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmitDraw}>Save Draw</Button>
          </div>
        </div>
      </Modal>

      {/* MODAL: NEW PO COMMITMENT */}
      <Modal open={poModalOpen} onClose={() => setPoModalOpen(false)} title={t('or_new_po', 'New PO Commitment')}>
        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-text-2">Supplier</label>
            <Select
              value={poForm.supplier_id}
              onChange={(e) => setPoForm({ ...poForm, supplier_id: e.target.value })}
              options={[
                { value: '', label: 'Select supplier...' },
                ...suppliers.map((s) => ({ value: String(s.id), label: s.name })),
              ]}
            />
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-text-2">Expected Delivery Date</label>
              <Input type="date" value={poForm.expected_delivery_date} onChange={(e) => setPoForm({ ...poForm, expected_delivery_date: e.target.value })} />
            </div>
            <div>
              <label className="text-xs font-medium text-text-2">Payment Plan</label>
              <Select
                value={poForm.payment_plan}
                onChange={(e) => setPoForm({ ...poForm, payment_plan: e.target.value })}
                options={[
                  { value: 'CASH_ON_DELIVERY', label: 'Cash on Delivery (100% Lock)' },
                  { value: 'SPLIT', label: 'Split (Partial Lock)' },
                  { value: 'CREDIT', label: 'Credit (No Cash Lock)' },
                ]}
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-text-2">Estimated Order Total (USD)</label>
            <Input type="number" value={poForm.estimated_order_total} onChange={(e) => setPoForm({ ...poForm, estimated_order_total: e.target.value })} placeholder="0.00" />
          </div>
          <div>
            <label className="text-xs font-medium text-text-2">Notes</label>
            <Input value={poForm.notes} onChange={(e) => setPoForm({ ...poForm, notes: e.target.value })} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setPoModalOpen(false)}>Cancel</Button>
            <Button onClick={handleCreatePo}>Create Draft PO</Button>
          </div>
        </div>
      </Modal>

      {/* MODAL: RECEIVE PO */}
      <Modal open={!!receiveModalPo} onClose={() => setReceiveModalPo(null)} title={`Receive ${receiveModalPo?.po_number || ''}`}>
        {receiveModalPo && (receiveModalPo.items || []).length === 0 && (
          <div className="space-y-4">
            <div className="p-3 rounded-lg border border-warning/40 bg-warning-soft text-xs text-text">
              {t('or_receive_amount_only', 'This PO has no item lines. Record the delivery in Purchases → New Purchase and choose this PO under "Settle Locked PO": stock, cash, the supplier balance and this lock then update together. To drop the order without a delivery, cancel the PO instead.')}
            </div>
            <p className="text-xs text-text-3">
              Locked Cash: <strong>{formatMoney(receiveModalPo.locked_cash_amount, USD)}</strong>
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setReceiveModalPo(null)}>{t('or_close', 'Close')}</Button>
            </div>
          </div>
        )}
        {receiveModalPo && (receiveModalPo.items || []).length > 0 && (
          <div className="space-y-4">
            <p className="text-xs text-text-3">
              Locked Cash: <strong>{formatMoney(receiveModalPo.locked_cash_amount, USD)}</strong>. {t('or_receive_hint', 'Enter what actually arrived. Stock, product cost, the supplier balance and the cash lock all follow these lines.')}
            </p>
            <div className="max-h-64 overflow-auto border border-border rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-surface-2 text-text-3">
                  <tr>
                    <th className="p-2 text-start">{t('or_product', 'Product')}</th>
                    <th className="p-2 text-end">{t('or_ordered', 'Ordered')}</th>
                    <th className="p-2 text-end">{t('or_received_qty', 'Received now')}</th>
                    <th className="p-2 text-end">{t('or_unit_cost', 'Unit cost (USD)')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(receiveModalPo.items || []).map((it: any) => (
                    <tr key={it.id}>
                      <td className="p-2">{it.product_name || `#${it.product_id}`}</td>
                      <td className="p-2 text-end">{Number(it.ordered_qty)}{Number(it.received_qty || 0) > 0 ? ` (${Number(it.received_qty)} in)` : ''}</td>
                      <td className="p-2 text-end">
                        <Input type="number" min={0} className="w-20 ms-auto" value={receiveLines[it.id]?.qty ?? ''}
                          onChange={(e) => setReceiveLines({ ...receiveLines, [it.id]: { ...(receiveLines[it.id] || { cost: '' }), qty: e.target.value } })} />
                      </td>
                      <td className="p-2 text-end">
                        <Input type="number" min={0} className="w-24 ms-auto" value={receiveLines[it.id]?.cost ?? ''}
                          onChange={(e) => setReceiveLines({ ...receiveLines, [it.id]: { ...(receiveLines[it.id] || { qty: '' }), cost: e.target.value } })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid sm:grid-cols-2 gap-3 items-end">
              <div className="text-sm">
                {t('or_delivery_total', 'Delivery total')}: <strong>{formatMoney(receiveTotal, USD)}</strong>
              </div>
              <div>
                <label className="text-xs font-medium text-text-2">{t('or_cash_paid_now', 'Cash paid now (USD)')}</label>
                <Input type="number" min={0} value={receiveForm.actual_cash_paid} onChange={(e) => setReceiveForm({ ...receiveForm, actual_cash_paid: e.target.value })} />
              </div>
            </div>
            <Checkbox
              className="text-xs"
              checked={receiveForm.partial}
              onChange={(e) => setReceiveForm({ ...receiveForm, partial: e.target.checked })}
              label={t('or_receive_partial', 'More deliveries expected (keep the PO open with the rest of its lock)')}
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setReceiveModalPo(null)}>Cancel</Button>
              <Button onClick={handleReceivePo}>Confirm Receiving</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
