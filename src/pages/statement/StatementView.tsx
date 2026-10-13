import React, { useEffect, useState } from 'react';
import { Printer, FileDown, FileSpreadsheet } from 'lucide-react';
import { Button, DateRangePicker, Skeleton, Tabs, useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { resolveDateRangePreset, partyDisplayName, type DateRange } from '../../lib/format';
import { api } from '../../lib/api';
import { exportRowsToExcel } from '../reports/exportUtils';
import { printStatementHtml, saveStatementPdf } from './printStatement';

type Mode = 'open' | 'activity';
type Format = 'a4' | 'receipt';

export interface StatementViewProps {
  stakeholder: { id: number; name: string; type: string; balance: number };
}

const RECEIPT_ROW_WARNING = 200;
// POST /api/print/statement answers 404 both for "no receipt printer" and "unknown party"; only the
// former (stable code, not the English message) falls back to the 80 mm HTML page via the print dialog.
const NO_RECEIPT_PRINTER = 'no_receipt_printer';
const money2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const pad2 = (n: number) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  return r.text();
}

function query(mode: Mode, range: DateRange, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({ mode, ...(mode === 'activity' ? { from: range.from, to: range.to } : {}), ...extra });
  return p.toString();
}

export function StatementView({ stakeholder }: StatementViewProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(stakeholder.balance < -0.005 ? 'open' : 'activity');
  const [range, setRange] = useState<DateRange>(() => resolveDateRangePreset('this_month'));
  const [format, setFormat] = useState<Format>('a4');
  const [html, setHtml] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);

  useEffect(() => {
    setMode(stakeholder.balance < -0.005 ? 'open' : 'activity');
  }, [stakeholder.id]);

  const htmlUrl = (f: Format) => `/api/reports/statement/${stakeholder.id}/html?${query(mode, range, { format: f })}`;

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setReceiptError(null);
    fetch(htmlUrl(format))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((h) => !cancelled && setHtml(h))
      .catch(() => { if (!cancelled) { setHtml(''); toast.error(t('stm_load_failed', 'Could not load the statement')); } });
    if (mode === 'activity') {
      api.get<{ activity?: { rows: unknown[] } }>(`/api/reports/statement/${stakeholder.id}?${query(mode, range)}`)
        .then((d) => !cancelled && setRowCount(d.activity?.rows.length ?? 0))
        .catch(() => !cancelled && setRowCount(0));
    } else {
      setRowCount(0);
    }
    return () => { cancelled = true; };
  }, [stakeholder.id, mode, range.from, range.to, format]);

  const a4Html = async () => (format === 'a4' && html ? html : fetchText(htmlUrl('a4')));

  const printA4 = async () => {
    setBusy(true);
    try { await printStatementHtml(await a4Html()); }
    catch (e: any) { toast.error(`${t('stm_print_failed', 'Printing failed')}: ${e?.message || e}`); }
    finally { setBusy(false); }
  };

  const handlePrint = async () => {
    if (format === 'a4') return printA4();
    setBusy(true);
    setReceiptError(null);
    try {
      const body = { stakeholderId: stakeholder.id, mode, ...(mode === 'activity' ? { from: range.from, to: range.to } : {}) };
      const res = await fetch('/api/print/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const err = res.ok ? null : await res.json().catch(() => null);
      if (res.status === 404 && err?.code === NO_RECEIPT_PRINTER) {
        // No ESC/POS receipt printer configured: print the 80 mm HTML layout through Windows.
        await printStatementHtml(html || (await fetchText(htmlUrl('receipt'))));
      } else if (!res.ok) {
        throw new Error(err?.error || String(res.status));
      } else {
        toast.success(t('stm_receipt_sent', 'Statement sent to the receipt printer'));
      }
    } catch (e: any) {
      setReceiptError(e?.message || String(e));
      toast.error(`${t('stm_print_failed', 'Printing failed')}: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  // Activity mode only: the movements as a spreadsheet (same columns as the printed table).
  const handleExcel = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const doc = await api.get<any>(`/api/reports/statement/${stakeholder.id}?${query('activity', range)}`);
      const rows = doc.activity.rows as any[];
      const L = doc.labels;
      exportRowsToExcel(rows, [
        { key: 'date', header: L.date, value: (r) => r.date_label },
        { key: 'ref', header: L.ref, value: (r) => r.reference },
        { key: 'desc', header: L.description, value: (r) => (r.original_label ? `${r.label} (${r.original_label})` : r.label) },
        { key: 'debit', header: L.debit, value: (r) => (r.debit ? money2(r.debit) : ''), align: 'right' },
        { key: 'credit', header: L.credit, value: (r) => (r.credit ? money2(r.credit) : ''), align: 'right' },
        { key: 'balance', header: L.balance, value: (r) => money2(r.balance), align: 'right' },
      ], {
        fileName: `statement-${partyDisplayName(stakeholder.name, t)}-${range.from}-${range.to}`,
        title: `${L.title} — ${L.accountActivity}`,
        subtitle: `${doc.party.name} · ${doc.activity.from_label} – ${doc.activity.to_label}`,
        businessName: doc.business.name,
      });
    } catch (e: any) {
      toast.error(`${t('stm_load_failed', 'Could not load the statement')}: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  const handlePdf = async () => {
    setBusy(true);
    try {
      const day = localDay();
      const saved = await saveStatementPdf(await a4Html(), `statement-${partyDisplayName(stakeholder.name, t)}-${day}.pdf`);
      if (saved) toast.success(`${t('stm_pdf_saved', 'PDF saved')}: ${saved}`);
    } catch (e: any) {
      toast.error(`${t('stm_print_failed', 'Printing failed')}: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          items={[{ value: 'open', label: t('stm_mode_open', 'Unpaid orders') }, { value: 'activity', label: t('stm_mode_activity', 'Account activity') }]}
          value={mode}
          onChange={(v) => setMode(v as Mode)}
        />
        {mode === 'activity' && (
          <>
            <DateRangePicker value={range} onChange={(r) => setRange(r)} />
            <Button variant="ghost" size="sm" onClick={() => setRange({ from: '2000-01-01', to: resolveDateRangePreset('today').to })}>
              {t('stm_all_dates', 'All')}
            </Button>
          </>
        )}
        <div className="ms-auto flex items-center gap-2">
          <Tabs
            items={[{ value: 'a4', label: t('stm_format_a4', 'A4') }, { value: 'receipt', label: t('stm_format_receipt', 'Receipt') }]}
            value={format}
            onChange={(v) => setFormat(v as Format)}
          />
          <Button variant="secondary" size="sm" onClick={handlePrint} disabled={busy || !html}>
            <Printer size={14} /> {t('stm_print', 'Print')}
          </Button>
          <Button variant="secondary" size="sm" onClick={handlePdf} disabled={busy || html === null}>
            <FileDown size={14} /> {t('stm_save_pdf', 'Save PDF')}
          </Button>
          {mode === 'activity' && (
            <Button variant="secondary" size="sm" onClick={handleExcel} disabled={busy}>
              <FileSpreadsheet size={14} /> {t('stm_export_excel', 'Excel')}
            </Button>
          )}
        </div>
      </div>

      {format === 'receipt' && rowCount > RECEIPT_ROW_WARNING && (
        <p className="text-sm text-accent">{t('stm_long_for_receipt', 'This statement has {n} movements — A4 is easier to read.').replace('{n}', String(rowCount))}</p>
      )}
      {receiptError && (
        <div className="flex items-center gap-2 text-sm text-danger">
          <span>{receiptError}</span>
          <Button variant="secondary" size="sm" onClick={printA4} disabled={busy}>{t('stm_print_as_a4', 'Print as A4')}</Button>
        </div>
      )}

      {html === null ? (
        <Skeleton className="h-[60vh] w-full" />
      ) : (
        <iframe
          title={t('stm_print', 'Print')}
          srcDoc={html}
          sandbox=""
          className={`h-[65vh] rounded-md border border-border bg-white ${format === 'receipt' ? 'mx-auto w-[340px]' : 'w-full'}`}
        />
      )}
    </div>
  );
}

export default StatementView;
