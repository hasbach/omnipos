import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Calculator,
  CalendarCheck,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Lock,
  Printer,
  Zap,
} from 'lucide-react';
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  Field,
  Modal,
  PageHeader,
  Select,
  Tabs,
  Textarea,
  useConfirm,
  useToast,
} from '../components/ui';
import { useI18n } from '../intl/index';
import { formatMoney, formatDate, userRoleLabel } from '../lib/format';
import { translateServerError } from '../lib/serverErrors';
import { api } from '../lib/api';
import { DenominationCounter } from './finance/DenominationCounter';
import { SettlementDetailDrawer } from './settlement/SettlementDetailDrawer';
import { printXReport as printXReportDoc } from './settlement/printXReport';
import { effectiveOf } from './settlement/types';

interface Currency {
  id?: number;
  code: string;
  symbol: string;
  rate: number;
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

interface AppUser {
  id: number;
  name: string;
  role: string;
}

interface CashierShift {
  id: number;
  user_name: string;
  cash_sales: number;
  expected_cash: number;
  actual_cash: number;
  difference: number;
  date: string;
  opening_balance?: number;
  total_purchases?: number;
  cash_purchases?: number;
  total_cash_in?: number;
  cash_in?: number;
  total_cash_out?: number;
  cash_out?: number;
  closing_balance?: number;
  notes?: string;
}

interface DailyReport {
  id: number;
  date: string;
  closing_balance: number;
  actual_balance: number;
  difference: number;
  user_name: string;
  opening_balance?: number;
  total_sales?: number;
  total_refunds?: number;
  total_purchases?: number;
  total_cash_in?: number;
  total_cash_out?: number;
  notes?: string;
  // Added by the settlement-detail API (effective = after admin corrections).
  adjustments_total?: number;
  corrected_actual_balance?: number | null;
  effective_actual?: number;
  effective_expected?: number;
  effective_difference?: number;
  corrections_count?: number;
  changed_after_close?: boolean;
}

interface YearlyReport {
  id: number;
  year: number;
  total_sales: number;
  total_purchases: number;
  total_profit: number;
  user_name: string;
  notes?: string;
}

// Only USD (rate 1) is safe as a hardcoded fallback — the local-currency (e.g. LBP) rate must
// come from the tenant's own configured rate, fetched below, or a cash-out / settlement done
// before that fetch resolves would silently convert the counted drawer cash at a stale guessed
// rate instead of the real one.
const DEFAULT_CURRENCIES: Currency[] = [{ code: 'USD', symbol: '$', rate: 1 }];

export default function Settlement() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();

  const [dailyReports, setDailyReports] = useState<DailyReport[]>([]);
  const [yearlyReports, setYearlyReports] = useState<YearlyReport[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);
  const parsedCashierId = parseInt(sessionStorage.getItem('currentCashierId') || '');
  const [selectedUserId, setSelectedUserId] = useState<number>(isNaN(parsedCashierId) ? 0 : parsedCashierId);
  const [currencies, setCurrencies] = useState<Currency[]>(DEFAULT_CURRENCIES);
  const [actualBalances, setActualBalances] = useState<Record<string, string>>(
    DEFAULT_CURRENCIES.reduce((acc, c) => ({ ...acc, [c.code]: '' }), {} as Record<string, string>),
  );
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'daily' | 'yearly'>('daily');
  const [cashierShifts, setCashierShifts] = useState<CashierShift[]>([]);
  const [businessName, setBusinessName] = useState('');

  // End-of-day stepper
  const [step, setStep] = useState(1);
  const [countMode, setCountMode] = useState<'denomination' | 'direct'>('denomination');
  const [yearlyModalOpen, setYearlyModalOpen] = useState(false);
  const [yearlyNotes, setYearlyNotes] = useState('');
  const [submittingCashOut, setSubmittingCashOut] = useState(false);
  const [submittingSettlement, setSubmittingSettlement] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [dailyRes, yearlyRes, summaryRes, usersRes, shiftsRes, currenciesRes] = await Promise.all([
        api.get<DailyReport[]>('/api/reports/daily'),
        api.get<YearlyReport[]>('/api/reports/yearly'),
        api.get<Summary>('/api/cash-flow/summary'),
        api.get<AppUser[]>('/api/users'),
        api.get<CashierShift[]>('/api/tenant/cashier-shifts'),
        api.get<Currency[]>('/api/currencies'),
      ]);
      setDailyReports(dailyRes || []);
      setYearlyReports(yearlyRes || []);
      setSummary(summaryRes || null);
      if (usersRes) {
        setUsers(usersRes);
        setSelectedUserId((prev) => (usersRes.length > 0 && !prev ? usersRes[0].id : prev));
      }
      setCashierShifts(shiftsRes || []);
      if (Array.isArray(currenciesRes) && currenciesRes.length > 0) {
        setCurrencies(currenciesRes);
        // Merge in any newly-seen currency codes without wiping amounts already typed in.
        setActualBalances((prev) => {
          const merged = { ...prev };
          currenciesRes.forEach((c) => {
            if (!(c.code in merged)) merged[c.code] = '';
          });
          return merged;
        });
      }
    } catch (err: any) {
      toast.error(translateServerError(err, t) || String(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    // For the printed X-report footer — the business's own name, not the app's.
    api
      .get<any>('/api/settings')
      .then((data) => data?.store_name && setBusinessName(data.store_name))
      .catch(() => {});
  }, []);

  const totalActualUSD = (Object.entries(actualBalances) as [string, string][]).reduce((sum, [code, val]) => {
    if (!val) return sum;
    const currency = currencies.find((c) => c.code === code);
    return sum + parseFloat(val) / (currency?.rate || 1);
  }, 0);

  const selectedUser = users.find((u) => u.id === selectedUserId);
  const isAdmin = selectedUser?.role === 'admin';

  const manualNet = summary ? summary.totalIn - summary.totalOut : 0;

  const buildNotesWithBreakdown = () =>
    notes +
    (Object.entries(actualBalances).some(([, v]) => v)
      ? ` [Breakdown: ${Object.entries(actualBalances)
          .filter(([, v]) => v)
          .map(([c, v]) => `${v} ${c}`)
          .join(', ')}]`
      : '');

  // Cash Out: saves shift snapshot, keeps transactions/order numbers
  const handleCashOut = async () => {
    if (totalActualUSD <= 0) {
      const ok = await confirm({
        title: t('fin_stl_confirm_cash_out_zero_title', 'Cash out with zero balance?'),
        description: t('fin_stl_confirm_cash_out_zero_desc', 'You are about to cash out with no counted cash. Continue?'),
        variant: 'primary',
        confirmLabel: t('fin_continue', 'Continue'),
      });
      if (!ok) return;
    } else {
      const ok = await confirm({
        title: t('fin_stl_confirm_cash_out_title', 'Confirm Cash Out'),
        description: t('fin_stl_confirm_cash_out_desc', 'This records a shift snapshot for the current cashier. Transactions and order numbers are kept.'),
        variant: 'primary',
        confirmLabel: t('fin_stl_cash_out', 'Cash Out'),
      });
      if (!ok) return;
    }

    setSubmittingCashOut(true);
    try {
      const data = await api.post<any>('/api/tenant/cashout', {
        user_id: selectedUserId,
        opening_balance: summary?.openingBalance || 0,
        actual_cash: totalActualUSD,
        notes: buildNotesWithBreakdown(),
      });

      setActualBalances(currencies.reduce((acc, c) => ({ ...acc, [c.code]: '' }), {} as Record<string, string>));
      setNotes('');
      setStep(1);
      fetchData();
      toast.success(t('fin_stl_cash_out_done', 'Cash out complete. Shift recorded.'));

      const printIt = await confirm({
        title: t('fin_stl_cash_out_done', 'Cash out complete. Shift recorded.'),
        description: t('fin_stl_print_receipt_q', 'Print the receipt?'),
        variant: 'primary',
        confirmLabel: t('fin_print', 'Print'),
        cancelLabel: t('fin_close', 'Close'),
      });
      if (printIt) printXReport(data.shift, t('fin_xr_cash_out', 'CASH OUT'));
    } catch (err: any) {
      toast.error(translateServerError(err, t) || String(err));
    } finally {
      setSubmittingCashOut(false);
    }
  };

  // Complete Settlement (Admin only): full archival + order number reset
  const handleDailySettlement = async () => {
    if (!isAdmin || !summary) {
      toast.error(t('fin_stl_admin_required', 'Only admin users can perform a complete settlement.'));
      return;
    }

    // Local calendar date for the printed receipt — the server decides the authoritative
    // stored date itself (see localToday() in server/routes.ts), this is display-only.
    const localDate = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().split('T')[0];

    const report = {
      date: localDate,
      user_id: selectedUserId,
      opening_balance: summary.openingBalance,
      total_sales: summary.totalSales,
      total_refunds: summary.totalRefunds,
      total_purchases: summary.totalPurchases,
      total_cash_in: summary.totalIn,
      total_cash_out: summary.totalOut,
      closing_balance: summary.expectedBalance,
      actual_balance: totalActualUSD,
      notes,
    };

    // Per-currency counted cash; the server computes and stores the whole closing atomically.
    const counted = currencies
      .filter((c) => actualBalances[c.code])
      .map((c) => ({ currency: c.code, amount: parseFloat(actualBalances[c.code]) || 0, rate: c.rate || 1 }));

    setSubmittingSettlement(true);
    try {
      const settleData = await api.post<any>('/api/tenant/settlement', { user_id: selectedUserId, counted, notes });

      setActualBalances(currencies.reduce((acc, c) => ({ ...acc, [c.code]: '' }), {} as Record<string, string>));
      setNotes('');
      setStep(1);
      fetchData();

      if (settleData && settleData.cloudPurged === false) {
        toast.error(settleData.warning || t('fin_stl_cloud_warning_default', 'Settlement completed locally, but the cloud copy could not be cleared. Reconnect to the internet and run the settlement again, otherwise the settled sales may reappear.'), {
          title: t('fin_stl_cloud_warning_title', 'Cloud sync warning'),
          duration: 10000,
        });
      }

      toast.success(t('fin_stl_settlement_done', 'Settlement saved. All data has been archived and order numbering reset.'));
      const printIt = await confirm({
        title: t('fin_stl_settlement_done', 'Settlement saved. All data has been archived and order numbering reset.'),
        description: t('fin_stl_print_xreport_q', 'Print the X-Report?'),
        variant: 'primary',
        confirmLabel: t('fin_print', 'Print'),
        cancelLabel: t('fin_close', 'Close'),
      });
      if (printIt) printXReport(report, t('fin_xr_end_of_day', 'END OF DAY'));
    } catch (err: any) {
      toast.error(translateServerError(err, t) || String(err));
    } finally {
      setSubmittingSettlement(false);
    }
  };

  const handleYearlySettlement = async () => {
    const year = new Date().getFullYear();
    try {
      await api.post('/api/reports/yearly', { year, notes: yearlyNotes });
      setYearlyModalOpen(false);
      setYearlyNotes('');
      fetchData();
      toast.success(t('fin_stl_yearly_generated', 'Yearly settlement generated successfully.'));
    } catch (err: any) {
      toast.error(translateServerError(err, t) || String(err));
    }
  };

  const printXReport = (report: any, title: string = t('fin_xr_daily_report', 'DAILY X-REPORT'), corrections?: any[]) =>
    printXReportDoc(report, { t, lang, title, businessName, corrections });

  // History-row print: fetch the corrections so the receipt lists them alongside the effective totals.
  const printHistoryRow = async (r: DailyReport) => {
    let corrections: any[] = [];
    try {
      const d = await api.get<any>(`/api/settlements/${r.id}`);
      corrections = d?.corrections || [];
    } catch {
      /* print without the corrections list */
    }
    printXReport(r, undefined, corrections);
  };

  const shiftColumns: DataTableColumn<CashierShift>[] = [
    { key: 'user_name', header: t('fin_stl_cashier', 'Cashier') },
    { key: 'cash_sales', header: t('fin_stl_sales', 'Sales'), align: 'end', render: (r) => <span className="num">{formatMoney(r.cash_sales, { code: 'USD', symbol: '$' })}</span> },
    { key: 'expected_cash', header: t('fin_stl_expected', 'Expected'), align: 'end', render: (r) => <span className="num">{formatMoney(r.expected_cash, { code: 'USD', symbol: '$' })}</span> },
    { key: 'actual_cash', header: t('fin_stl_actual', 'Actual'), align: 'end', render: (r) => <span className="num">{formatMoney(r.actual_cash, { code: 'USD', symbol: '$' })}</span> },
    {
      key: 'difference',
      header: t('fin_stl_diff', 'Difference'),
      align: 'end',
      render: (r) => (
        <span className={['num font-semibold', r.difference === 0 ? 'text-text-3' : r.difference > 0 ? 'text-success' : 'text-danger'].join(' ')}>
          {r.difference > 0 ? '+' : ''}
          {formatMoney(r.difference, { code: 'USD', symbol: '$' })}
        </span>
      ),
    },
    {
      key: 'action',
      header: t('fin_action', 'Action'),
      render: (r) => (
        <Button variant="ghost" size="sm" onClick={() => printXReport(r, 'CASH OUT')}>
          <Printer size={14} />
        </Button>
      ),
    },
  ];

  const historyColumns: DataTableColumn<DailyReport>[] = [
    {
      key: 'date',
      header: t('fin_today', 'Date'),
      sortable: true,
      render: (r) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{r.date}</span>
          {(r.corrections_count ?? 0) > 0 && <Badge variant="primary">{t('sd_badge_corrected', 'Corrected')}</Badge>}
          {r.changed_after_close && <Badge variant="warning">{t('sd_badge_changed', 'Changed after closing')}</Badge>}
        </span>
      ),
    },
    { key: 'closing_balance', header: t('fin_stl_expected', 'Expected'), align: 'end', sortValue: (r) => effectiveOf(r).expected, render: (r) => <span className="num">{formatMoney(effectiveOf(r).expected, { code: 'USD', symbol: '$' })}</span> },
    { key: 'actual_balance', header: t('fin_stl_actual', 'Actual'), align: 'end', sortValue: (r) => effectiveOf(r).actual, render: (r) => <span className="num">{formatMoney(effectiveOf(r).actual, { code: 'USD', symbol: '$' })}</span> },
    {
      key: 'difference',
      header: t('fin_stl_diff', 'Difference'),
      align: 'end',
      sortValue: (r) => effectiveOf(r).difference,
      render: (r) => {
        const d = effectiveOf(r).difference;
        return (
          <span className={['num font-semibold', Math.abs(d) < 0.005 ? 'text-text-3' : d > 0 ? 'text-success' : 'text-danger'].join(' ')}>
            {d > 0 ? '+' : ''}
            {formatMoney(d, { code: 'USD', symbol: '$' })}
          </span>
        );
      },
    },
    { key: 'user_name', header: t('fin_user', 'User') },
    {
      key: 'action',
      header: t('fin_action', 'Action'),
      render: (r) => (
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('sd_print', 'Print X-Report')}
          onClick={(e) => {
            e.stopPropagation();
            printHistoryRow(r);
          }}
        >
          <Printer size={14} />
        </Button>
      ),
    },
  ];

  const yearlyColumns: DataTableColumn<YearlyReport>[] = [
    { key: 'year', header: t('fin_stl_year', 'Year'), render: (r) => <span className="text-lg font-bold">{r.year}</span> },
    { key: 'total_sales', header: t('fin_stl_total_sales', 'Total Sales'), align: 'end', render: (r) => <span className="num font-semibold text-success">{formatMoney(r.total_sales, { code: 'USD', symbol: '$' })}</span> },
    { key: 'total_purchases', header: t('fin_stl_total_purchases', 'Total Purchases'), align: 'end', render: (r) => <span className="num font-semibold text-danger">{formatMoney(r.total_purchases, { code: 'USD', symbol: '$' })}</span> },
    { key: 'total_profit', header: t('fin_stl_net_profit', 'Net Profit'), align: 'end', render: (r) => <span className="num font-bold">{formatMoney(r.total_profit, { code: 'USD', symbol: '$' })}</span> },
    { key: 'user_name', header: t('fin_user', 'User') },
    { key: 'notes', header: t('fin_notes', 'Notes'), render: (r) => <span className="italic text-text-3">{r.notes || '—'}</span> },
  ];

  const stepItems = [
    { n: 1, label: t('fin_stl_step_review', 'Review Totals') },
    { n: 2, label: t('fin_stl_step_count', 'Count Cash') },
    { n: 3, label: t('fin_stl_step_confirm', 'Notes & Confirm') },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t('fin_stl_title', 'Settlement & Reports')}
        subtitle={t('fin_stl_subtitle', 'Close the day or year and audit your finances.')}
        actions={
          <Tabs
            items={[
              { value: 'daily', label: t('fin_stl_daily', 'Daily') },
              { value: 'yearly', label: t('fin_stl_yearly', 'Yearly') },
            ]}
            value={activeTab}
            onChange={(v) => setActiveTab(v as 'daily' | 'yearly')}
          />
        }
      />

      {activeTab === 'daily' ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <div className="lg:col-span-1">
            <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)]">
              <h2 className="mb-4 flex items-center gap-2 text-base font-semibold text-text">
                <CalendarCheck size={18} className="text-success" /> {t('fin_stl_end_of_day', 'End of Day')}
              </h2>

              {/* Stepper indicator */}
              <div className="mb-5 flex items-center gap-1">
                {stepItems.map((s, i) => (
                  <React.Fragment key={s.n}>
                    <div className="flex flex-1 flex-col items-center gap-1">
                      <div
                        className={[
                          'flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold',
                          step === s.n
                            ? 'bg-primary text-on-primary'
                            : step > s.n
                              ? 'bg-success text-white'
                              : 'bg-surface-2 text-text-3',
                        ].join(' ')}
                      >
                        {step > s.n ? <Check size={14} /> : s.n}
                      </div>
                      <span className={['text-center text-[11px] font-medium', step === s.n ? 'text-text' : 'text-text-3'].join(' ')}>{s.label}</span>
                    </div>
                    {i < stepItems.length - 1 && <div className={['mb-4 h-px flex-1', step > s.n ? 'bg-success' : 'bg-border'].join(' ')} />}
                  </React.Fragment>
                ))}
              </div>

              {!summary ? (
                <div className="py-12 text-center text-sm italic text-text-3">{t('fin_loading', 'Loading…')}</div>
              ) : step === 1 ? (
                <div className="flex flex-col gap-4">
                  <p className="text-xs text-text-3">{t('fin_stl_step1_desc', 'Review today’s register activity before counting the drawer.')}</p>
                  <div className="rounded-[var(--radius-card)] border border-border bg-surface-2 p-4">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-[0.04em] text-text-3">{t('fin_stl_expected_balance', 'Expected Balance')}</span>
                    <span className="num text-3xl font-bold text-text">{formatMoney(summary.expectedBalance, { code: 'USD', symbol: '$' })}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="flex justify-between rounded-md bg-surface-2 px-2 py-1.5"><span className="text-text-3">{t('fin_stl_sales', 'Sales')}</span><span className="num font-semibold text-success">+{formatMoney(summary.totalSales, { code: 'USD', symbol: '$' })}</span></div>
                    <div className="flex justify-between rounded-md bg-surface-2 px-2 py-1.5"><span className="text-text-3">{t('fin_stl_refunds', 'Refunds')}</span><span className="num font-semibold text-danger">-{formatMoney(summary.totalRefunds, { code: 'USD', symbol: '$' })}</span></div>
                    <div className="flex justify-between rounded-md bg-surface-2 px-2 py-1.5"><span className="text-text-3">{t('fin_stl_purchases', 'Purchases')}</span><span className="num font-semibold text-danger">-{formatMoney(summary.totalPurchases, { code: 'USD', symbol: '$' })}</span></div>
                    <div className="flex justify-between rounded-md bg-surface-2 px-2 py-1.5"><span className="text-text-3">{t('fin_stl_manual', 'Manual In/Out')}</span><span className={['num font-semibold', manualNet >= 0 ? 'text-success' : 'text-danger'].join(' ')}>{manualNet >= 0 ? '+' : ''}{formatMoney(manualNet, { code: 'USD', symbol: '$' })}</span></div>
                  </div>
                  <Field label={t('fin_stl_cashier', 'Cashier')}>
                    <Select value={String(selectedUserId)} disabled options={users.map((u) => ({ value: String(u.id), label: `${u.name} (${userRoleLabel(u.role, t)})` }))} />
                  </Field>
                  <Button variant="primary" className="w-full" onClick={() => setStep(2)}>
                    {t('fin_continue', 'Continue')} <ChevronRight size={15} className="rtl:rotate-180" />
                  </Button>
                </div>
              ) : step === 2 ? (
                <div className="flex flex-col gap-4">
                  <p className="text-xs text-text-3">{t('fin_stl_step2_desc', 'Count the physical cash in the drawer, or enter totals directly.')}</p>

                  <div className="flex gap-2 rounded-[var(--radius-input)] border border-border bg-surface-2 p-1 text-xs font-semibold">
                    <button type="button" onClick={() => setCountMode('denomination')} className={['flex-1 cursor-pointer rounded-md py-1.5 uppercase tracking-[0.04em]', countMode === 'denomination' ? 'bg-primary text-on-primary' : 'text-text-3'].join(' ')}>
                      <Calculator size={13} className="me-1 inline" /> {t('fin_stl_denomination_count', 'Denomination count')}
                    </button>
                    <button type="button" onClick={() => setCountMode('direct')} className={['flex-1 cursor-pointer rounded-md py-1.5 uppercase tracking-[0.04em]', countMode === 'direct' ? 'bg-primary text-on-primary' : 'text-text-3'].join(' ')}>
                      {t('fin_stl_enter_directly', 'Enter total directly')}
                    </button>
                  </div>

                  {currencies.map((c) => (
                    <div key={c.code} className="rounded-[var(--radius-card)] border border-border p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-[0.04em] text-text-2">{c.code}</span>
                      </div>
                      {countMode === 'denomination' ? (
                        <DenominationCounter
                          currency={c}
                          onTotalChange={(total) => setActualBalances((prev) => ({ ...prev, [c.code]: total ? String(total) : '' }))}
                        />
                      ) : (
                        <input
                          type="number"
                          step="0.01"
                          placeholder="0.00"
                          className="num h-10 w-full rounded-[var(--radius-input)] border border-border bg-surface px-3 text-end text-lg outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                          value={actualBalances[c.code] ?? ''}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => setActualBalances((prev) => ({ ...prev, [c.code]: e.target.value }))}
                        />
                      )}
                    </div>
                  ))}

                  <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-dashed border-primary/40 bg-primary-soft px-3 py-2.5">
                    <span className="text-xs font-bold uppercase text-primary">{t('fin_total_usd', 'Total (USD)')}</span>
                    <span className="num text-lg font-bold text-text">{formatMoney(totalActualUSD, { code: 'USD', symbol: '$' })}</span>
                  </div>

                  <div className="flex gap-2">
                    <Button variant="secondary" className="flex-1" onClick={() => setStep(1)}>
                      <ChevronLeft size={15} className="rtl:rotate-180" /> {t('fin_back', 'Back')}
                    </Button>
                    <Button variant="primary" className="flex-1" onClick={() => setStep(3)}>
                      {t('fin_continue', 'Continue')} <ChevronRight size={15} className="rtl:rotate-180" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <p className="text-xs text-text-3">{t('fin_stl_step3_desc', 'Add any notes, then confirm to record this shift.')}</p>

                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-md bg-surface-2 px-3 py-2">
                      <span className="block text-[10px] uppercase text-text-3">{t('fin_stl_expected', 'Expected')}</span>
                      <span className="num font-semibold">{formatMoney(summary.expectedBalance, { code: 'USD', symbol: '$' })}</span>
                    </div>
                    <div className="rounded-md bg-surface-2 px-3 py-2">
                      <span className="block text-[10px] uppercase text-text-3">{t('fin_stl_actual', 'Actual')}</span>
                      <span className="num font-semibold">{formatMoney(totalActualUSD, { code: 'USD', symbol: '$' })}</span>
                    </div>
                  </div>
                  <div className={['flex items-center justify-between rounded-md px-3 py-2', Math.abs(totalActualUSD - summary.expectedBalance) < 0.01 ? 'bg-success-soft' : 'bg-danger-soft'].join(' ')}>
                    <span className="text-xs font-bold uppercase text-text-2">{t('fin_stl_diff', 'Difference')}</span>
                    <span className={['num font-bold', Math.abs(totalActualUSD - summary.expectedBalance) < 0.01 ? 'text-success' : 'text-danger'].join(' ')}>
                      {totalActualUSD - summary.expectedBalance >= 0 ? '+' : ''}
                      {formatMoney(totalActualUSD - summary.expectedBalance, { code: 'USD', symbol: '$' })}
                    </span>
                  </div>

                  <Field label={t('fin_notes', 'Notes')}>
                    <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('fin_stl_notes_placeholder', 'Any discrepancies or notes…')} rows={3} />
                  </Field>

                  <div className="flex gap-2">
                    <Button variant="secondary" className="flex-1" onClick={() => setStep(2)}>
                      <ChevronLeft size={15} className="rtl:rotate-180" /> {t('fin_back', 'Back')}
                    </Button>
                  </div>

                  <div className="flex flex-col gap-2 border-t border-border pt-4">
                    <Button variant="secondary" loading={submittingCashOut} onClick={handleCashOut} className="w-full">
                      <LogOut size={16} /> {t('fin_stl_cash_out', 'Cash Out')}
                    </Button>
                    <p className="text-center text-[11px] text-text-3">{t('fin_stl_cash_out_desc', 'Resets today’s sales summary but keeps order numbers. Use this for a shift change.')}</p>

                    {isAdmin ? (
                      <>
                        <Button variant="success" loading={submittingSettlement} onClick={async () => {
                          const ok = await confirm({
                            title: t('fin_stl_confirm_settlement_title', 'Complete Settlement'),
                            description: t('fin_stl_confirm_settlement_desc', 'This will archive all transactions and reset order numbering. This action cannot be undone.'),
                            confirmText: 'SETTLE',
                            confirmLabel: t('fin_stl_complete_settlement', 'Complete Settlement'),
                          });
                          if (ok) handleDailySettlement();
                        }} className="w-full">
                          <CheckCircle2 size={16} /> {t('fin_stl_complete_settlement', 'Complete Settlement')}
                        </Button>
                        <p className="text-center text-[11px] text-text-3">{t('fin_stl_complete_settlement_desc', 'Archives all data and resets order numbers. Admin only.')}</p>
                      </>
                    ) : (
                      <div className="flex w-full items-center justify-center gap-2 rounded-[var(--radius-input)] border border-border bg-surface-2 py-3 text-text-3">
                        <Lock size={15} />
                        <span className="text-xs font-semibold uppercase tracking-[0.04em]">{t('fin_stl_admin_only', 'Admin only — Complete Settlement')}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-5 lg:col-span-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold text-text">{t('fin_stl_shifts_title', "Today's Cashier Shifts")}</h3>
              <DataTable columns={shiftColumns} data={cashierShifts} rowKey={(r) => r.id} loading={loading} emptyTitle={t('fin_stl_shifts_empty', 'No shifts recorded today')} />
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-text">{t('fin_stl_history_title', 'Settlement History')}</h3>
              <DataTable columns={historyColumns} data={dailyReports} rowKey={(r) => r.id} loading={loading} searchable onRowClick={(r) => setDetailId(r.id)} emptyTitle={t('fin_stl_history_empty', 'No reports found')} />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col items-center gap-4 rounded-[var(--radius-card)] border border-border bg-surface p-8 text-center shadow-[var(--shadow-card)]">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-on-primary shadow-lg">
              <Zap size={32} />
            </div>
            <div className="max-w-md">
              <h2 className="text-xl font-bold text-text">{t('fin_stl_yearly_title', 'Yearly Closing')}</h2>
              <p className="mt-1 text-sm text-text-3">{t('fin_stl_yearly_desc', 'Generate a comprehensive financial report for the current year. This calculates total sales, purchases, and net profit.')}</p>
            </div>
            <Button variant="primary" size="lg" onClick={() => setYearlyModalOpen(true)}>
              {t('fin_stl_generate_report', 'Generate {year} Report').replace('{year}', String(new Date().getFullYear()))}
            </Button>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-text">{t('fin_stl_yearly_history', 'Yearly Reports History')}</h3>
            <DataTable columns={yearlyColumns} data={yearlyReports} rowKey={(r) => r.id} loading={loading} emptyTitle={t('fin_stl_yearly_empty', 'No yearly reports found')} />
          </div>
        </div>
      )}

      <SettlementDetailDrawer reportId={detailId} onClose={() => setDetailId(null)} onChanged={fetchData} businessName={businessName} />

      <Modal
        open={yearlyModalOpen}
        onClose={() => setYearlyModalOpen(false)}
        title={t('fin_stl_yearly_notes_prompt', 'Notes for the yearly settlement')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setYearlyModalOpen(false)}>{t('fin_cancel', 'Cancel')}</Button>
            <Button variant="primary" onClick={handleYearlySettlement}>{t('fin_confirm', 'Confirm')}</Button>
          </>
        }
      >
        <Textarea value={yearlyNotes} onChange={(e) => setYearlyNotes(e.target.value)} placeholder={t('fin_stl_yearly_notes_placeholder', 'Optional notes…')} rows={4} />
      </Modal>
    </div>
  );
}
