import React from 'react';
import Fuse from 'fuse.js';
import {
  Search, User, CreditCard, Banknote, Package, Plus, Minus, Trash2, ArrowRight,
  Percent, Printer, CheckCircle2, Calendar, X, RotateCcw, RefreshCw, Clock
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { usePosContext } from '../context/PosContext';
import { CURRENCIES } from '../hooks/usePos';
import { Modal, Button, Field, Input, Textarea, Badge, IconButton } from './ui';
import { formatMoney, formatBalance, paymentMethodLabel, formatTime, formatDate, formatNumber, partyDisplayName } from '../lib/format';

const QUICK_CASH_STEPS = [5, 10, 20, 50, 100];

export default function PaymentModal() {
  const pos = usePosContext();
  const {
    products, sellableProducts, cart, barcodeInput, setBarcodeInput, isProcessing,
    currencies = CURRENCIES, selectedCurrency, showCheckout, setShowCheckout, payments, setPayments,
    paymentAmount, setPaymentAmount, paymentMethod, setPaymentMethod, paymentCurrency, setPaymentCurrency,
    showAddCustomerModal, newCustomerForm, setNewCustomerForm, isPriceChecker, setIsPriceChecker,
    lastTransaction, setLastTransaction, suggestions, setSuggestions,
    stakeholders, selectedStakeholder, selectedStakeholderObj, creditLimit, availableCredit,
    availableStoreCredit,
    historyDate, setHistoryDate, loadingHistory, selectedHistoryTransaction, setSelectedHistoryTransaction,
    showRefundModal, setShowRefundModal, refundQuantities, setRefundQuantities,
    refundMethod, setRefundMethod,
    tenant, showUpdateModal, setShowUpdateModal, updateVersion, isUpdating, users, currentUser,
    handleInstallUpdate, scheduleForm, setScheduleForm, handleScheduleUpdate,
    fetchDailyHistory, handleRefund, handleBarcodeSubmit,
    handleSuggestionClick, handleCheckout, printReceipt, totalUSD, dailyTransactions,
    showDailyHistory, setShowDailyHistory,
    t, lang, barcodeRef, showDebtModal, setShowDebtModal, handleReceiveDebt,
    terminalId, editingCustomerId, closeCustomerModal, handleCreateCustomer, isDarkMode,
  } = pos as any;
  // What is left of the customer's positive balance after the store-credit payments already added to
  // this sale — the button, the cap and the "available" hint must shrink as it's used.
  const creditLeft = Math.max(0, (availableStoreCredit || 0) - (payments || [])
    .filter((p: any) => p.method === 'store_credit')
    .reduce((sum: number, p: any) => sum + p.amount / (p.exchange_rate || 1), 0));

  // Format a transaction display ID as e.g. 'POS1-0024', falling back to '#id' for legacy records
  const formatTxId = (tx: any) =>
    tx.terminal_id && tx.terminal_sequence
      ? `${tx.terminal_id}-${String(tx.terminal_sequence).padStart(4, '0')}`
      : `#${tx.id}`;

  const paidUSD = payments.reduce((sum: number, p: any) => sum + (p.amount / p.exchange_rate), 0);
  const remainingUSD = totalUSD - paidUSD;
  const overpaidUSD = paidUSD - totalUSD;
  const isFullyPaid = remainingUSD <= 0.01;
  const isWalkIn = selectedStakeholder === 1;

  const buildTrimmedPayments = () => {
    let remaining = totalUSD;
    const trimmed: any[] = [];
    for (const p of payments) {
      const pUSD = p.amount / p.exchange_rate;
      if (p.method === 'credit') continue;
      if (remaining <= 0) break;
      if (pUSD <= remaining) {
        trimmed.push(p);
        remaining -= pUSD;
      } else {
        trimmed.push({ ...p, amount: remaining * p.exchange_rate });
        remaining = 0;
      }
    }
    return trimmed;
  };

  const creditPortionUSD = (() => {
    if (paymentMethod !== 'credit') return 0;
    const amt = parseFloat(paymentAmount) || 0;
    return amt / (paymentCurrency.rate || 1);
  })();
  const wouldExceedCredit = creditLimit > 0 && availableCredit != null && creditPortionUSD > availableCredit + 0.01;

  return (
    <>
      {/* Add/Edit Customer */}
      <Modal
        open={showAddCustomerModal}
        onClose={closeCustomerModal}
        size="sm"
        title={editingCustomerId !== null ? t('pos_edit_customer', 'Edit Customer') : t('pos_add_customer', 'Quick Add Customer')}
      >
        <form onSubmit={handleCreateCustomer} className="space-y-4">
          <Field label={t('pos_full_name', 'Full Name')} required>
            <Input autoFocus required value={newCustomerForm.name} onChange={e => setNewCustomerForm({ ...newCustomerForm, name: e.target.value })} />
          </Field>
          <Field label={t('pos_phone_number', 'Phone Number')}>
            <Input value={newCustomerForm.phone} onChange={e => setNewCustomerForm({ ...newCustomerForm, phone: e.target.value })} />
          </Field>
          <Field label={t('pos_email_optional', 'Email (Optional)')}>
            <Input type="email" value={newCustomerForm.email} onChange={e => setNewCustomerForm({ ...newCustomerForm, email: e.target.value })} />
          </Field>
          <Field label={t('pos_address_optional', 'Address (Optional)')}>
            <Textarea rows={2} value={newCustomerForm.address || ''} onChange={e => setNewCustomerForm({ ...newCustomerForm, address: e.target.value })} />
          </Field>
          <div className="flex gap-3 pt-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={closeCustomerModal}>{t('cancel', 'Cancel')}</Button>
            <Button type="submit" variant="primary" className="flex-1" loading={isProcessing} disabled={isProcessing}>
              {isProcessing ? t('pos_saving', 'Saving...') : t('pos_save_customer', 'Save Customer')}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Price Checker Overlay */}
      <AnimatePresence>
        {isPriceChecker && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-primary text-on-primary flex flex-col items-center justify-center p-12"
          >
            <button
              onClick={() => setIsPriceChecker(false)}
              className="absolute top-8 end-8 opacity-70 hover:opacity-100 cursor-pointer text-sm font-semibold"
            >
              {t('pos_close_esc', 'Close (Esc)')}
            </button>

            <div className="text-center space-y-8 w-full max-w-4xl relative">
              <h2 className="text-2xl font-bold tracking-wide opacity-70">{t('scan_barcode', 'Scan Barcode')}</h2>

              <div className="relative">
                <form onSubmit={handleBarcodeSubmit} className="relative">
                  <input
                    autoFocus
                    type="text"
                    className="w-full bg-transparent border-b-4 border-white/20 focus:border-white transition-all outline-none text-7xl font-bold text-center py-8 tracking-tight"
                    value={barcodeInput}
                    onChange={(e) => {
                      const val = e.target.value;
                      setBarcodeInput(val);
                      if (val.length > 1) {
                        const fuse = new Fuse(sellableProducts || products, { keys: ['name', 'barcode', 'barcodes', 'units.barcode'], threshold: 0.3 });
                        setSuggestions(fuse.search(val).map((r: any) => r.item).slice(0, 5));
                      } else {
                        setSuggestions([]);
                      }
                    }}
                  />
                </form>

                <AnimatePresence>
                  {suggestions.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="absolute start-0 end-0 top-full mt-4 bg-surface text-text rounded-2xl shadow-[var(--shadow-modal)] overflow-hidden z-50"
                    >
                      {suggestions.map((p: any) => {
                        const mu = (p.units || []).find((u: any) => u.barcode && u.barcode === barcodeInput.trim());
                        return (
                        <button
                          key={p.id}
                          onClick={() => handleSuggestionClick(p, mu ? mu.id : null)}
                          className="w-full flex items-center justify-between p-6 hover:bg-primary hover:text-on-primary transition-colors text-start border-b border-border last:border-none cursor-pointer"
                        >
                          <div className="text-xl font-bold">{p.name}{mu && <span className="ms-2 text-base opacity-80">{mu.name} ×{mu.factor}</span>}</div>
                          <div className="text-end">
                            <div className="text-2xl font-mono font-black num">${(mu ? mu.price : (p.price || 0)).toFixed(2)}</div>
                            {!mu && <div className="text-lg font-mono font-bold text-success num">{formatNumber(p.price_lbp || Math.round((p.price || 0) * 89500), { decimals: 0 })} LL</div>}
                          </div>
                        </button>
                        );
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {cart.length > 0 && (() => {
                const last = cart[cart.length - 1];
                return (
                  <motion.div
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    className="bg-surface text-text p-10 rounded-3xl shadow-2xl"
                  >
                    <h3 className="text-3xl font-bold mb-2">{last.name}</h3>
                    <p className="text-lg text-text-3 mb-6 font-mono">{last.barcode}</p>
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <p className="text-[10px] uppercase font-bold text-text-3 mb-1">{t('pos_tier_retail', 'Retail')}</p>
                        <p className="text-2xl font-black num">${(last.price || 0).toFixed(2)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase font-bold text-text-3 mb-1">{t('pos_tier_wholesale', 'Wholesale')}</p>
                        <p className="text-2xl font-black num">${(last.price_wholesale || last.price || 0).toFixed(2)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase font-bold text-text-3 mb-1">{t('pos_tier_super_wholesale', 'Super Wholesale')}</p>
                        <p className="text-2xl font-black num">${(last.price_super_wholesale || last.price_wholesale || last.price || 0).toFixed(2)}</p>
                      </div>
                    </div>
                    <div className="text-4xl font-black text-success tracking-tight mt-6 text-center num">
                      {formatNumber(last.price_lbp || Math.round((last.price || 0) * 89500), { decimals: 0 })} LL
                    </div>
                  </motion.div>
                );
              })()}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Daily History Overlay */}
      <Modal open={showDailyHistory} onClose={() => setShowDailyHistory(false)} size="full" title={t('pos_daily_order_history', 'Daily Order History')}>
        <div className="flex flex-col h-full -m-4 md:-m-4">
          <div className="p-4 border-b border-border flex justify-between items-center bg-surface-2 flex-wrap gap-3">
            <p className="text-sm text-text-3">{t('pos_history_subtitle', 'Review transactions and re-print receipts.')}</p>
            <div className="relative">
              <Calendar className="absolute start-3 top-1/2 -translate-y-1/2 text-text-3" size={16} />
              <input
                type="date"
                className="ps-10 pe-4 py-2 min-h-[40px] bg-surface border border-border rounded-xl font-semibold text-sm outline-none focus:border-primary transition-all text-text"
                value={historyDate}
                onChange={(e) => setHistoryDate(e.target.value)}
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            <div className="bg-surface rounded-2xl border border-border overflow-hidden">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="bg-surface-2 text-text-2 text-[10px] uppercase tracking-wide font-bold">
                    <th className="p-3 text-start">{t('pos_hist_id', 'ID')}</th>
                    <th className="p-3 text-start">{t('pos_hist_time', 'Time')}</th>
                    <th className="p-3 text-start">{t('pos_hist_customer', 'Customer')}</th>
                    <th className="p-3 text-start">{t('pos_hist_user', 'User')}</th>
                    <th className="p-3 text-end">{t('pos_hist_total', 'Total')}</th>
                    <th className="p-3 text-center">{t('pos_hist_type', 'Type')}</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {loadingHistory ? (
                    <tr><td colSpan={6} className="p-12 text-center text-text-3 italic">{t('pos_hist_loading', 'Loading history...')}</td></tr>
                  ) : dailyTransactions.length === 0 ? (
                    <tr><td colSpan={6} className="p-12 text-center text-text-3 italic">{t('pos_hist_no_transactions', 'No transactions found for this date.')}</td></tr>
                  ) : (
                    dailyTransactions.map((tr: any) => (
                      <tr
                        key={tr.id}
                        onClick={() => setSelectedHistoryTransaction(tr)}
                        className={`border-b border-border hover:bg-surface-2 transition-colors cursor-pointer ${selectedHistoryTransaction?.id === tr.id ? 'bg-primary-soft' : ''}`}
                      >
                        <td className="p-3 font-mono font-bold text-text">{formatTxId(tr)}</td>
                        <td className="p-3 text-text-3">{formatTime(tr.created_at, lang, { seconds: true })}</td>
                        <td className="p-3 font-semibold text-text">{tr.stakeholder_name ? partyDisplayName(tr.stakeholder_name, t) : t('pos_walk_in', 'Walk-in')}</td>
                        <td className="p-3 text-text-2">{tr.user_name || t('pos_hist_system', 'System')}</td>
                        <td className="p-3 text-end font-mono font-bold num text-text">${tr.total_amount.toFixed(2)}</td>
                        <td className="p-3 text-center">
                          <Badge variant={tr.type === 'refund' ? 'danger' : tr.type === 'purchase' ? 'info' : 'success'}>
                            {tr.type === 'sale' ? t('pos_type_sale', 'sale') : tr.type === 'refund' ? t('pos_type_refund', 'refund') : tr.type === 'purchase' ? t('pos_type_purchase', 'purchase') : tr.type}
                          </Badge>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="p-4 border-t border-border bg-surface-2 flex justify-between items-center flex-wrap gap-3">
            <div className="flex gap-3 items-center flex-wrap">
              <div className="text-sm font-bold text-text-3">
                {t('pos_total_transactions', 'Total Transactions: {count}', { count: dailyTransactions.length })}
              </div>
              {selectedHistoryTransaction && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={async () => {
                      const res = await fetch(`/api/transactions/${selectedHistoryTransaction.id}`);
                      if (res.ok) printReceipt(await res.json());
                    }}
                  >
                    <Printer size={14} /> {t('pos_print_receipt', 'Print Receipt')}
                  </Button>
                  {selectedHistoryTransaction.type === 'sale' && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={async () => {
                        const [res, refRes] = await Promise.all([
                          fetch(`/api/transactions/${selectedHistoryTransaction.id}`),
                          fetch(`/api/transactions/${selectedHistoryTransaction.id}/refundable`),
                        ]);
                        if (res.ok && refRes.ok) {
                          const full = await res.json();
                          const refundable = await refRes.json();
                          // One refund row per ORIGINAL LINE, in that line's unit (server /refundable).
                          full.refund_lines = refundable.lines || [];
                          setSelectedHistoryTransaction(full);
                          const initialRefunds: Record<number, number> = {};
                          full.refund_lines.forEach((l: any) => initialRefunds[l.item_id] = 0);
                          setRefundQuantities(initialRefunds);
                          setRefundMethod('cash');
                          setShowRefundModal(true);
                        }
                      }}
                    >
                      <RotateCcw size={14} /> {t('pos_process_refund', 'Process Refund')}
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div className="text-xl font-black font-mono num text-text">
              {t('pos_hist_total_label', 'Total:')} ${dailyTransactions.reduce((sum: number, tr: any) => sum + (tr.type === 'refund' || tr.type === 'purchase' ? -tr.total_amount : tr.total_amount), 0).toFixed(2)}
            </div>
          </div>
        </div>
      </Modal>

      {/* Refund Modal */}
      <Modal
        open={showRefundModal && !!selectedHistoryTransaction?.refund_lines}
        onClose={() => setShowRefundModal(false)}
        size="lg"
        title={t('pos_process_refund', 'Process Refund')}
      >
        {/* Children are evaluated even while the modal is closed, and a row picked from the history
            list has no `items` until the Refund button loads the full transaction — guard on items,
            not just on the selection, or selecting any history row crashes the POS. */}
        {Array.isArray(selectedHistoryTransaction?.refund_lines) && (
          <>
            <p className="text-sm text-text-3 mb-4">
              {t('pos_refund_subtitle', 'Select items and quantities to return for Transaction #{id}', { id: selectedHistoryTransaction.id })}
            </p>
            <div className="space-y-3 max-h-[50vh] overflow-y-auto">
              {(selectedHistoryTransaction.refund_lines || []).map((line: any) => {
                const qty = refundQuantities[line.item_id] || 0;
                const unitLabel = line.uom_name ? `${line.uom_name}${line.uom_factor > 1 ? ` ×${line.uom_factor}` : ''}` : '';
                return (
                <div key={line.item_id} className="flex items-center justify-between p-3 bg-surface-2 rounded-xl border border-border">
                  <div className="flex-1 min-w-0">
                    <h4 className="font-semibold text-text truncate">
                      {line.product_name || 'Product'}
                      {unitLabel && <span className="ms-2 text-xs font-bold text-primary">{unitLabel}</span>}
                    </h4>
                    <p className="text-xs text-text-3 font-mono">
                      {t('pos_purchased', 'Purchased: {qty} @ {price}', { qty: line.sold_qty, price: `$${Number(line.unit_price).toFixed(2)}` })}
                      {line.refunded_qty > 0 && ` · ${t('pos_refund_already', 'already returned {qty}', { qty: line.refunded_qty })}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center border border-border rounded-xl overflow-hidden bg-surface">
                      <button disabled={line.remaining_qty <= 0} onClick={() => setRefundQuantities((prev: any) => ({ ...prev, [line.item_id]: Math.max(0, (prev[line.item_id] || 0) - 1) }))} className="h-9 w-9 flex items-center justify-center hover:bg-primary hover:text-on-primary transition-colors cursor-pointer text-text disabled:opacity-30">
                        <Minus size={14} />
                      </button>
                      <span className="w-10 text-center font-mono font-bold num text-text">{qty}</span>
                      <button disabled={line.remaining_qty <= 0} onClick={() => setRefundQuantities((prev: any) => ({ ...prev, [line.item_id]: Math.min(line.remaining_qty, (prev[line.item_id] || 0) + 1) }))} className="h-9 w-9 flex items-center justify-center hover:bg-primary hover:text-on-primary transition-colors cursor-pointer text-text disabled:opacity-30">
                        <Plus size={14} />
                      </button>
                    </div>
                    <div className="w-20 text-end font-mono font-bold num text-danger">
                      -${(line.unit_refund * qty).toFixed(2)}
                    </div>
                  </div>
                </div>
                );
              })}
            </div>

            <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
              {(() => {
                const isWalkInRefund = !selectedHistoryTransaction.stakeholder_id
                  || stakeholders.find((s: any) => s.id === selectedHistoryTransaction.stakeholder_id)?.name === 'Walk-in Customer';
                return (
                  <div className="space-y-2">
                    <p className="text-[10px] font-bold uppercase text-text-3">{t('pos_refund_method', 'Refund method')}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={() => setRefundMethod('cash')} className={`py-2.5 min-h-[40px] rounded-lg text-[11px] font-bold uppercase border transition-all cursor-pointer ${refundMethod === 'cash' ? 'bg-primary text-on-primary border-primary' : 'text-text-2 border-border'}`}>{t('pos_cash', 'Cash')}</button>
                      <button
                        disabled={isWalkInRefund}
                        onClick={() => setRefundMethod('credit')}
                        className={`py-2.5 min-h-[40px] rounded-lg text-[11px] font-bold uppercase border transition-all cursor-pointer ${refundMethod === 'credit' ? 'bg-primary text-on-primary border-primary' : 'text-text-2 border-border'} ${isWalkInRefund ? 'opacity-30 cursor-not-allowed' : ''}`}
                      >
                        {t('pos_keep_on_account', 'Keep on customer account')}
                      </button>
                    </div>
                  </div>
                );
              })()}

              <div className="flex justify-between items-center">
                <span className="text-sm font-bold text-text-3 uppercase">{t('pos_total_refund_amount', 'Total Refund Amount')}</span>
                <span className="text-2xl font-black font-mono num text-danger">
                  -${(selectedHistoryTransaction.refund_lines || []).reduce((sum: number, l: any) =>
                    sum + l.unit_refund * (refundQuantities[l.item_id] || 0), 0).toFixed(2)}
                </span>
              </div>

              {selectedHistoryTransaction.stakeholder_id !== 1 && (() => {
                const s = stakeholders.find((x: any) => x.id === selectedHistoryTransaction.stakeholder_id);
                if (!s || s.name === 'Walk-in Customer') return null;
                const totalRefund = (selectedHistoryTransaction.refund_lines || []).reduce((sum: number, l: any) =>
                    sum + l.unit_refund * (refundQuantities[l.item_id] || 0), 0);
                const prevBal = s.balance || 0;
                const newBal = refundMethod === 'credit' ? prevBal + totalRefund : prevBal;
                const USD = { code: 'USD', symbol: '$' };
                const prev = formatBalance(prevBal, USD, t);
                const next = formatBalance(newBal, USD, t);
                return (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-border p-3 text-center">
                      <p className="text-[10px] font-bold uppercase text-text-3">{t('pos_previous_balance', 'Previous balance')}</p>
                      <p className={`num font-bold ${prev.variant === 'danger' ? 'text-danger' : prev.variant === 'success' ? 'text-success' : 'text-text-3'}`}>{prev.amount} {prev.label}</p>
                    </div>
                    <div className="rounded-xl border border-border p-3 text-center">
                      <p className="text-[10px] font-bold uppercase text-text-3">{t('pos_new_balance', 'New balance')}</p>
                      <p className={`num font-bold ${next.variant === 'danger' ? 'text-danger' : next.variant === 'success' ? 'text-success' : 'text-text-3'}`}>{next.amount} {next.label}</p>
                    </div>
                  </div>
                );
              })()}

              <div className="flex gap-3">
                <Button variant="secondary" className="flex-1" onClick={() => setShowRefundModal(false)}>{t('cancel', 'Cancel')}</Button>
                <Button
                  variant="danger"
                  className="flex-1"
                  onClick={handleRefund}
                  disabled={isProcessing || Object.values(refundQuantities).every((q: any) => q === 0)}
                  loading={isProcessing}
                >
                  {isProcessing ? t('pos_processing', 'Processing...') : t('pos_confirm_refund', 'Confirm Refund')} <RotateCcw size={16} />
                </Button>
              </div>
            </div>
          </>
        )}
      </Modal>

      {/* Checkout Modal */}
      <Modal
        open={showCheckout}
        onClose={() => setShowCheckout(false)}
        size="sm"
        title={lastTransaction ? t('pos_transaction_success', 'Transaction Success') : t('pos_finalize_payment', 'Finalize Payment')}
      >
        {lastTransaction ? (
          <div className="space-y-6">
            <p className="text-sm text-text-3">{t('pos_transaction_completed', 'Transaction #{id} completed', { id: lastTransaction.id })}</p>
            <div className="flex flex-col items-center justify-center py-8 text-success">
              <CheckCircle2 size={56} />
              <p className="mt-4 font-bold uppercase tracking-wide">{t('pos_payment_received', 'Payment Received')}</p>
            </div>
            {lastTransaction.stakeholder_id !== 1 && lastTransaction.balance_before != null && lastTransaction.balance_after != null && (() => {
              const USD = { code: 'USD', symbol: '$' };
              const prev = formatBalance(lastTransaction.balance_before, USD, t);
              const next = formatBalance(lastTransaction.balance_after, USD, t);
              return (
                <div className="grid grid-cols-2 gap-3 -mt-2">
                  <div className="rounded-xl border border-border p-3 text-center">
                    <p className="text-[10px] font-bold uppercase text-text-3">{t('pos_previous_balance', 'Previous balance')}</p>
                    <p className={`num font-bold ${prev.variant === 'danger' ? 'text-danger' : prev.variant === 'success' ? 'text-success' : 'text-text-3'}`}>{prev.amount} {prev.label}</p>
                  </div>
                  <div className="rounded-xl border border-border p-3 text-center">
                    <p className="text-[10px] font-bold uppercase text-text-3">{t('pos_new_balance', 'New balance')}</p>
                    <p className={`num font-bold ${next.variant === 'danger' ? 'text-danger' : next.variant === 'success' ? 'text-success' : 'text-text-3'}`}>{next.amount} {next.label}</p>
                  </div>
                </div>
              );
            })()}
            <div className="grid grid-cols-2 gap-3">
              <Button variant="primary" onClick={() => printReceipt(lastTransaction)}>
                <Printer size={18} /> {t('pos_print_receipt', 'Print Receipt')}
              </Button>
              <Button variant="secondary" onClick={() => { setLastTransaction(null); setShowCheckout(false); }}>
                {t('pos_new_sale', 'New Sale')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-text-3 mb-4">{t('pos_select_payment_method', 'Select payment method for {amount}', { amount: `$${totalUSD.toFixed(2)}` })}</p>
            <div className="space-y-4">
              <div className="p-4 bg-surface-2 rounded-xl flex justify-between items-center">
                <span className="text-xs font-bold text-text-3 uppercase tracking-wide">{t('pos_total_due', 'Total Due')}</span>
                <span className="text-2xl font-black font-mono num text-text">${totalUSD.toFixed(2)}</span>
              </div>

              {payments.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[10px] font-bold uppercase text-text-3">{t('pos_payments_added', 'Payments Added')}</p>
                  {payments.map((p: any, idx: number) => (
                    <div key={idx} className="flex justify-between items-center p-3 bg-surface-2 rounded-xl border border-border">
                      <div className="flex items-center gap-2">
                        {p.method === 'cash' ? <Banknote size={14} /> : <CreditCard size={14} />}
                        <span className="text-xs font-bold text-text">{paymentMethodLabel(p.method, t)}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-xs font-bold num text-text">{formatNumber(p.amount, { decimals: 0 })} {p.currency}</span>
                        <IconButton aria-label={t('pos_remove_payment', 'Remove payment')} size="sm" onClick={() => setPayments((prev: any) => prev.filter((_: any, i: number) => i !== idx))}>
                          <Trash2 size={12} />
                        </IconButton>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {!isFullyPaid && (
                <div className="p-5 bg-surface border-2 border-primary rounded-2xl space-y-4 shadow-lg">
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-bold uppercase tracking-wide text-text">{t('pos_remaining', 'Remaining')}</span>
                    <span className="text-xl font-black font-mono num text-danger">${remainingUSD.toFixed(2)}</span>
                  </div>

                  <div className={`grid gap-2 ${creditLeft > 0.005 ? 'grid-cols-4' : 'grid-cols-3'}`}>
                    <button onClick={() => setPaymentMethod('cash')} className={`py-2.5 min-h-[40px] rounded-lg text-[11px] font-bold uppercase border transition-all cursor-pointer ${paymentMethod === 'cash' ? 'bg-primary text-on-primary border-primary' : 'text-text-2 border-border'}`}>{t('pos_cash', 'Cash')}</button>
                    <button onClick={() => setPaymentMethod('card')} className={`py-2.5 min-h-[40px] rounded-lg text-[11px] font-bold uppercase border transition-all cursor-pointer ${paymentMethod === 'card' ? 'bg-primary text-on-primary border-primary' : 'text-text-2 border-border'}`}>{t('pos_card', 'Card')}</button>
                    <div className="relative group/credit">
                      <button
                        disabled={isWalkIn}
                        onClick={() => setPaymentMethod('credit')}
                        className={`w-full py-2.5 min-h-[40px] rounded-lg text-[11px] font-bold uppercase border transition-all cursor-pointer ${paymentMethod === 'credit' ? 'bg-primary text-on-primary border-primary' : 'text-text-2 border-border'} ${isWalkIn ? 'opacity-30 cursor-not-allowed' : ''}`}
                      >
                        {t('pos_credit', 'Credit')}
                      </button>
                      {isWalkIn && (
                        <div className="absolute bottom-full start-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-text text-bg text-[9px] font-bold rounded whitespace-nowrap z-50 opacity-0 group-hover/credit:opacity-100 transition-opacity pointer-events-none">
                          {t('pos_select_customer_first', 'Select a customer first')}
                        </div>
                      )}
                    </div>
                    {creditLeft > 0.005 && (
                      <button
                        onClick={() => {
                          setPaymentMethod('store_credit');
                          const usd = currencies.find((c: any) => c.code === 'USD') || paymentCurrency;
                          setPaymentCurrency(usd);
                          const capped = Math.min(creditLeft, remainingUSD);
                          setPaymentAmount(capped > 0 ? capped.toFixed(2) : '');
                        }}
                        className={`py-2.5 min-h-[40px] rounded-lg text-[10px] font-bold uppercase border transition-all cursor-pointer leading-tight ${paymentMethod === 'store_credit' ? 'bg-primary text-on-primary border-primary' : 'text-text-2 border-border'}`}
                      >
                        {t('pos_use_account_balance', 'Use account balance')}
                      </button>
                    )}
                  </div>

                  {creditLimit > 0 && (
                    <p className="text-[10px] text-text-3">{t('pos_available_credit', 'Available Credit')}: {formatMoney(availableCredit || 0, { code: 'USD', symbol: '$' })}</p>
                  )}
                  {wouldExceedCredit && (
                    <p className="text-[11px] font-semibold text-danger">{t('pos_credit_limit_warning', "This sale would exceed the customer's credit limit.")}</p>
                  )}
                  {paymentMethod === 'store_credit' && (
                    <p className="text-[10px] text-text-3">{t('pos_available_balance', 'Available balance: {amount}', { amount: formatMoney(creditLeft, { code: 'USD', symbol: '$' }) })}</p>
                  )}

                  {paymentMethod !== 'store_credit' && (
                    <div className="grid grid-cols-3 gap-2">
                      {currencies.map((c: any) => (
                        <button key={c.code} onClick={() => setPaymentCurrency(c)} className={`py-2 min-h-[36px] rounded-lg text-[10px] font-bold uppercase border transition-all cursor-pointer ${paymentCurrency.code === c.code ? 'bg-primary text-on-primary border-primary' : 'text-text-2 border-border'}`}>{c.code}</button>
                      ))}
                    </div>
                  )}

                  {/* Quick-cash shortcut amounts in the active payment currency */}
                  {paymentMethod !== 'store_credit' && (
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        onClick={() => setPaymentAmount((remainingUSD * paymentCurrency.rate).toFixed(paymentCurrency.code === 'USD' ? 2 : 0))}
                        className="px-2.5 py-1.5 min-h-[32px] rounded-md text-[10px] font-bold border border-border text-text-2 hover:border-primary hover:text-primary transition-all cursor-pointer"
                      >
                        {t('pos_remaining', 'Remaining')}
                      </button>
                      {QUICK_CASH_STEPS.map(stepUsd => {
                        // Quick-cash steps are defined in USD and converted to whatever currency is
                        // currently selected for this payment (rounded to a sensible display unit).
                        const converted = stepUsd * paymentCurrency.rate;
                        const rounded = paymentCurrency.rate > 100 ? Math.round(converted / 1000) * 1000 : Math.round(converted * 100) / 100;
                        return (
                          <button
                            key={stepUsd}
                            onClick={() => setPaymentAmount(String(rounded))}
                            className="px-2.5 py-1.5 min-h-[32px] rounded-md text-[10px] font-bold border border-border text-text-2 hover:border-primary hover:text-primary transition-all cursor-pointer num"
                          >
                            {paymentCurrency.symbol}{formatNumber(rounded, { decimals: 0 })}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div className="relative">
                    <input
                      type="number"
                      placeholder={t('pos_amount_in', 'Amount in {code}', { code: paymentCurrency.code })}
                      className="w-full p-4 min-h-[52px] bg-bg border border-border rounded-xl font-mono text-xl outline-none focus:border-primary transition-all num text-text"
                      value={paymentAmount}
                      onChange={(e) => setPaymentAmount(e.target.value)}
                    />
                    <button
                      onClick={() => {
                        let amt = parseFloat(paymentAmount);
                        if (paymentMethod === 'store_credit') amt = Math.min(amt || 0, creditLeft, remainingUSD);
                        if (amt > 0) {
                          setPayments((prev: any) => [...prev, { amount: amt, method: paymentMethod, currency: paymentCurrency.code, exchange_rate: paymentCurrency.rate }]);
                          setPaymentAmount('');
                          // The balance is used up (or the sale covered) — go back to cash for the rest.
                          if (paymentMethod === 'store_credit') setPaymentMethod('cash');
                        }
                      }}
                      className="absolute end-2 top-2 bottom-2 px-4 bg-primary text-on-primary rounded-lg font-bold uppercase text-[10px] tracking-wide cursor-pointer"
                    >
                      {t('pos_add', 'Add')}
                    </button>
                  </div>
                </div>
              )}

              {isFullyPaid && overpaidUSD > 0.01 && (
                <div className="p-4 bg-success-soft border-2 border-success/30 rounded-2xl space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-bold uppercase tracking-wide text-success">{t('pos_change_due', 'Change Due')}</span>
                    <span className="text-xl font-black font-mono num text-success">+${overpaidUSD.toFixed(2)}</span>
                  </div>
                  {isWalkIn ? (
                    <div className="space-y-2">
                      <div className="p-3 bg-accent-soft border border-accent/30 rounded-xl text-center">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-accent">{t('pos_walkin_no_credit_title', 'Walk-in — Credit Not Available')}</p>
                        <p className="text-xs text-text-2 mt-1">{t('pos_walkin_no_credit_body', 'Select a registered customer to credit their account.')}</p>
                      </div>
                      <Button variant="success" className="w-full" onClick={() => handleCheckout(buildTrimmedPayments())} disabled={isProcessing} loading={isProcessing}>
                        {t('pos_complete_and_change', 'Complete & Give Change {amount}', { amount: `$${overpaidUSD.toFixed(2)}` })}
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-[10px] font-bold text-text-2">{t('pos_how_handle_overpayment', 'How to handle overpayment?')}</p>
                      <div className="grid grid-cols-2 gap-2">
                        <Button variant="success" className="flex-col gap-1 h-auto py-3" onClick={() => handleCheckout(payments)} disabled={isProcessing}>
                          <span>{t('pos_credit_balance', 'Credit Balance')}</span>
                          <span className="opacity-80 text-[9px]">{t('pos_credit_to_account', '+{amount} to account', { amount: `$${overpaidUSD.toFixed(2)}` })}</span>
                        </Button>
                        <Button variant="secondary" className="flex-col gap-1 h-auto py-3" onClick={() => handleCheckout(buildTrimmedPayments())} disabled={isProcessing}>
                          <span>{t('pos_give_as_change', 'Give as Change')}</span>
                          <span className="opacity-80 text-[9px]">{t('pos_return_amount', 'Return {amount}', { amount: `$${overpaidUSD.toFixed(2)}` })}</span>
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {(!isFullyPaid || (isFullyPaid && overpaidUSD <= 0.01)) && (
                <button
                  disabled={!isFullyPaid || isProcessing}
                  onClick={() => handleCheckout(payments)}
                  className={`w-full py-5 min-h-[64px] rounded-2xl font-black uppercase tracking-wide text-lg shadow-xl transition-all active:scale-[0.98] cursor-pointer ${isFullyPaid ? 'bg-success text-white hover:opacity-90' : 'bg-surface-2 text-text-3 opacity-50 cursor-not-allowed'}`}
                >
                  {isProcessing ? t('pos_processing', 'Processing...') : isFullyPaid ? t('pos_complete_transaction', 'Complete Transaction') : t('pos_balance_remaining', 'Balance Remaining')}
                </button>
              )}
            </div>

            <button
              onClick={() => { setShowCheckout(false); setPayments([]); }}
              className="w-full py-3 mt-2 text-xs font-bold uppercase tracking-wide text-text-3 hover:text-text transition-opacity cursor-pointer"
            >
              {t('pos_cancel_sale', 'Cancel Sale')}
            </button>
          </>
        )}
      </Modal>

      {/* Debt Modal */}
      <Modal open={showDebtModal} onClose={() => !isProcessing && setShowDebtModal(false)} size="sm" title={t('pos_receive_debt_payment', 'Receive Debt Payment')}>
        <p className="text-xs text-text-3 font-semibold mb-4">
          {t('pos_customer_label', 'Customer: {name}', { name: partyDisplayName(stakeholders.find((s: any) => s.id === selectedStakeholder)?.name, t) })}
        </p>
        <div className="mb-4 p-4 bg-danger-soft text-danger rounded-xl border border-danger/20 text-center">
          <span className="text-[10px] font-bold uppercase tracking-wide block mb-1">{t('pos_current_balance', 'Current Balance')}</span>
          <span className="text-2xl font-mono font-black num">${Math.abs(stakeholders.find((s: any) => s.id === selectedStakeholder)?.balance || 0).toFixed(2)}</span>
        </div>
        <div className="space-y-4">
          <Field label={t('pos_payment_amount', 'Payment Amount')}>
            <Input
              autoFocus
              type="number"
              min="0.01"
              step="0.01"
              placeholder={t('pos_enter_amount', 'Enter amount...')}
              className="font-mono text-xl num"
              value={paymentAmount}
              onChange={e => setPaymentAmount(e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setPaymentMethod('cash')} className={`py-3 min-h-[44px] rounded-xl text-xs font-bold uppercase border transition-all cursor-pointer ${paymentMethod === 'cash' ? 'bg-primary text-on-primary border-primary' : 'text-text-2 border-border'}`}>{t('pos_cash', 'Cash')}</button>
            <button onClick={() => setPaymentMethod('card')} className={`py-3 min-h-[44px] rounded-xl text-xs font-bold uppercase border transition-all cursor-pointer ${paymentMethod === 'card' ? 'bg-primary text-on-primary border-primary' : 'text-text-2 border-border'}`}>{t('pos_card', 'Card')}</button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {currencies.map((c: any) => (
              <button key={c.code} onClick={() => setPaymentCurrency(c)} className={`py-2 min-h-[36px] rounded-lg text-[10px] font-bold uppercase border transition-all cursor-pointer ${paymentCurrency.code === c.code ? 'bg-primary text-on-primary border-primary' : 'text-text-2 border-border'}`}>{c.code}</button>
            ))}
          </div>

          <div className="flex gap-3 pt-2">
            <Button variant="secondary" className="flex-1" onClick={() => { setShowDebtModal(false); setPaymentAmount(''); }}>{t('cancel', 'Cancel')}</Button>
            <Button
              variant="success"
              className="flex-1"
              disabled={isProcessing || !paymentAmount || parseFloat(paymentAmount) <= 0}
              loading={isProcessing}
              onClick={() => { handleReceiveDebt(parseFloat(paymentAmount), paymentMethod, paymentCurrency); setPaymentAmount(''); }}
            >
              {isProcessing ? t('pos_processing', 'Processing') : t('pos_receive', 'Receive')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Update Modal */}
      <Modal open={showUpdateModal} onClose={() => !isUpdating && setShowUpdateModal(false)} size="sm">
        <div className="text-center space-y-6">
          <div className="w-16 h-16 bg-primary text-on-primary rounded-full flex items-center justify-center mx-auto">
            <RefreshCw size={32} className={isUpdating ? 'animate-spin' : ''} />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-black uppercase tracking-tight text-text">{t('pos_update_available', 'Update Available')}</h2>
            <p className="text-text-3 text-sm">{t('pos_update_body', 'A new version of OmniPOS ({version}) is ready to be installed. Your current version is {current}.', { version: updateVersion, current: tenant?.current_version })}</p>
          </div>

          {isUpdating ? (
            <div className="py-4 space-y-4">
              <div className="h-2 w-full bg-surface-2 rounded-full overflow-hidden">
                <motion.div initial={{ width: 0 }} animate={{ width: '100%' }} transition={{ duration: 2 }} className="h-full bg-primary" />
              </div>
              <p className="text-[10px] font-bold uppercase tracking-wide animate-pulse text-text-3">{t('pos_installing', 'Installing updates... Please wait')}</p>
            </div>
          ) : (
            <div className="space-y-4">
              <Button variant="primary" size="lg" className="w-full" onClick={handleInstallUpdate}>
                {t('pos_install_now', 'Install Now')} <ArrowRight size={18} className="rtl:rotate-180" />
              </Button>

              <div className="p-5 bg-surface-2 rounded-2xl border border-border space-y-3 text-start">
                <div className="flex items-center gap-2 text-[10px] font-bold uppercase text-text-3">
                  <Clock size={14} /> {t('pos_schedule_for_later', 'Schedule for later')}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input type="date" className="bg-surface border border-border rounded-lg p-2 text-xs outline-none focus:border-primary transition-all text-text" value={scheduleForm.date} onChange={e => setScheduleForm({ ...scheduleForm, date: e.target.value })} />
                  <input type="time" className="bg-surface border border-border rounded-lg p-2 text-xs outline-none focus:border-primary transition-all text-text" value={scheduleForm.time} onChange={e => setScheduleForm({ ...scheduleForm, time: e.target.value })} />
                </div>
                <Button variant="secondary" size="sm" className="w-full" onClick={handleScheduleUpdate}>{t('pos_confirm_schedule', 'Confirm Schedule')}</Button>
              </div>

              <button onClick={() => setShowUpdateModal(false)} className="text-[10px] font-bold uppercase tracking-wide text-text-3 hover:text-text transition-opacity cursor-pointer">
                {t('pos_remind_me_later', 'Remind me later')}
              </button>
            </div>
          )}
        </div>
      </Modal>

      {/* Footer Status */}
      <footer className="bg-primary text-on-primary p-2 px-4 flex justify-between items-center text-[10px] uppercase tracking-wide font-bold">
        <div className="flex gap-4">
          <span className="flex items-center gap-1"><div className="w-1.5 h-1.5 rounded-full bg-success"></div> {t('pos_database_online', 'Database Online')}</span>
          <span className="opacity-70">{t('pos_terminal_label', 'Terminal: {id}', { id: terminalId })}</span>
        </div>
        <div className="flex gap-4">
          <span className="opacity-70">{t('pos_user_label', 'User: {name}', { name: currentUser?.name || 'Admin' })}</span>
          <span>{formatDate(new Date(), lang)}</span>
        </div>
      </footer>
    </>
  );
}
