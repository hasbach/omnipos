import React, { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Download } from 'lucide-react';
import { Button, StatCard, Select, DataTable, Badge, type DataTableColumn } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { fieldsForEntity, type ImportEntity } from './fields';
import type { ParsedSheet } from './parse';
import { tf } from './tf';

export interface ImportIssue {
  row: number;
  field?: string;
  message: string;
  code: string;
}

export interface ImportResultRow {
  row: number;
  action: 'create' | 'update' | 'skip' | 'error';
  id?: number;
  key?: string;
}

export interface ImportResponse {
  entity: string;
  dry_run: boolean;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  results: ImportResultRow[];
}

export type ImportMode = 'create_only' | 'upsert';

export interface ReviewStepProps {
  entity: ImportEntity;
  sheet: ParsedSheet;
  mode: ImportMode;
  onModeChange: (mode: ImportMode) => void;
  loading: boolean;
  result: ImportResponse | null;
  error: string | null;
  onBack: () => void;
  onImport: () => void;
  importing: boolean;
  rowLimit: number;
}

interface DisplayRow {
  row: number;
  sheetRow: number;
  key: string;
  action: 'create' | 'update' | 'skip' | 'error';
  hasError: boolean;
  hasWarning: boolean;
  messages: { code: string; text: string; field?: string }[];
}

type StatusFilter = 'all' | 'create' | 'update' | 'skip' | 'error' | 'warning';

export function ReviewStep({ entity, sheet, mode, onModeChange, loading, result, error, onBack, onImport, importing, rowLimit }: ReviewStepProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<StatusFilter>('all');

  // Show the column's name in the user's language, not the internal field key ("price").
  const fieldLabel = (key: string) => {
    const f = fieldsForEntity(entity).find((x) => x.key === key);
    return f ? t(f.labelKey, f.labelFallback) : key;
  };
  const translateIssue = (issue: ImportIssue) => t(`imp_code_${issue.code}`, issue.message) || issue.message;

  const displayRows = useMemo<DisplayRow[]>(() => {
    if (!result) return [];
    const errByRow = new Map<number, ImportIssue[]>();
    for (const e of result.errors) {
      if (!errByRow.has(e.row)) errByRow.set(e.row, []);
      errByRow.get(e.row)!.push(e);
    }
    const warnByRow = new Map<number, ImportIssue[]>();
    for (const w of result.warnings) {
      if (!warnByRow.has(w.row)) warnByRow.set(w.row, []);
      warnByRow.get(w.row)!.push(w);
    }

    return result.results.map((r): DisplayRow => {
      const errs = errByRow.get(r.row) || [];
      const warns = warnByRow.get(r.row) || [];
      const sheetRowInfo = sheet.rows[r.row - 1];
      return {
        row: r.row,
        sheetRow: sheetRowInfo ? sheetRowInfo.sheetRow : r.row,
        key: r.key || '',
        action: r.action,
        hasError: errs.length > 0,
        hasWarning: warns.length > 0,
        messages: [
          ...errs.map((e) => ({ code: e.code, text: translateIssue(e), field: e.field })),
          ...warns.map((w) => ({ code: w.code, text: translateIssue(w), field: w.field })),
        ],
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, sheet]);

  const filtered = useMemo(() => {
    if (filter === 'all') return displayRows;
    if (filter === 'warning') return displayRows.filter((r) => r.hasWarning && !r.hasError);
    return displayRows.filter((r) => r.action === filter);
  }, [displayRows, filter]);

  const columns = useMemo<DataTableColumn<DisplayRow>[]>(
    () => [
      { key: 'sheetRow', header: t('imp_review_col_row', 'Row'), width: 70, sortable: true, render: (r) => <span className="num text-text-3">{r.sheetRow}</span> },
      { key: 'key', header: t('imp_review_col_key', 'Name / barcode'), sortable: true, render: (r) => <span className="text-text">{r.key || '—'}</span> },
      {
        key: 'action',
        header: t('imp_review_col_action', 'Action'),
        width: 110,
        render: (r) => {
          const variant = r.action === 'error' ? 'danger' : r.action === 'create' ? 'success' : r.action === 'update' ? 'info' : 'neutral';
          const label =
            r.action === 'create'
              ? t('imp_action_create', 'Create')
              : r.action === 'update'
              ? t('imp_action_update', 'Update')
              : r.action === 'skip'
              ? t('imp_action_skip', 'Skip')
              : t('imp_action_error', 'Error');
          return <Badge variant={variant as any}>{label}</Badge>;
        },
      },
      {
        key: 'messages',
        header: t('imp_review_col_message', 'Message'),
        render: (r) =>
          r.messages.length ? (
            <div className="space-y-0.5">
              {r.messages.map((m, i) => (
                <p key={i} className={['text-xs', m.field ? '' : ''].join(' ')}>
                  <span className={r.hasError && i < r.messages.length ? 'text-text-2' : 'text-text-2'}>{m.text}</span>
                  {m.field && <span className="text-text-3"> ({fieldLabel(m.field)})</span>}
                </p>
              ))}
            </div>
          ) : (
            <span className="text-text-3">—</span>
          ),
      },
    ],
    [t],
  );

  const downloadErrorReport = () => {
    const problemRows = displayRows.filter((r) => r.hasError || r.hasWarning);
    if (!problemRows.length) return;
    const headers = [...sheet.headers, t('imp_review_col_message', 'Message')];
    const aoa: any[][] = [headers];
    for (const dr of problemRows) {
      const original = sheet.rows[dr.row - 1];
      const cells = sheet.headers.map((h) => (original ? original.cells[h] ?? '' : ''));
      aoa.push([...cells, dr.messages.map((m) => m.text).join(' | ')]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Problems');
    XLSX.writeFile(wb, `OmniPOS-import-errors-${entity}.xlsx`);
  };

  const hasErrors = (result?.errors.length || 0) > 0;
  const overLimit = sheet.rows.length > rowLimit;

  return (
    <div className="space-y-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-sm font-semibold text-text">{t('imp_review_title', 'Review before importing')}</h2>
          <p className="text-xs text-text-3">{t('imp_review_desc', 'We checked every row without changing anything yet. Fix any errors, then import.')}</p>
        </div>
        <div className="w-64 shrink-0 space-y-1">
          <label className="text-xs font-medium text-text-2">{t('imp_review_mode', 'Mode')}</label>
          <Select
            value={mode}
            onChange={(e) => onModeChange(e.target.value as ImportMode)}
            options={[
              { value: 'upsert', label: t('imp_review_mode_upsert', 'Add new and update existing') },
              { value: 'create_only', label: t('imp_review_mode_create_only', 'Add new only') },
            ]}
          />
        </div>
      </div>

      {overLimit && (
        <p className="rounded-[var(--radius-card)] border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
          {tf(t('imp_too_many_rows', 'This file has {count} rows. OmniPOS can import up to {limit} rows at once — please split it into smaller files.'), {
            count: sheet.rows.length,
            limit: rowLimit,
          })}
        </p>
      )}

      {error && <p className="rounded-[var(--radius-card)] border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

      {loading && <p className="text-sm text-text-3">{t('imp_review_checking', 'Checking your file…')}</p>}

      {result && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label={t('imp_review_stat_total', 'Rows')} value={result.total} />
            <StatCard label={t('imp_review_stat_create', 'To create')} value={result.results.filter((r) => r.action === 'create').length} />
            <StatCard label={t('imp_review_stat_update', 'To update')} value={result.results.filter((r) => r.action === 'update').length} />
            <StatCard label={t('imp_review_stat_skip', 'Skipped')} value={result.skipped} />
            <StatCard label={t('imp_review_stat_errors', 'Errors')} value={result.errors.length} />
            <StatCard label={t('imp_review_stat_warnings', 'Warnings')} value={result.warnings.length} />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Select
              className="w-48"
              value={filter}
              onChange={(e) => setFilter(e.target.value as StatusFilter)}
              options={[
                { value: 'all', label: t('imp_review_filter_all', 'All rows') },
                { value: 'create', label: t('imp_review_filter_create', 'Create') },
                { value: 'update', label: t('imp_review_filter_update', 'Update') },
                { value: 'skip', label: t('imp_review_filter_skip', 'Skip') },
                { value: 'error', label: t('imp_review_filter_error', 'Errors') },
                { value: 'warning', label: t('imp_review_filter_warning', 'Warnings') },
              ]}
            />
            <Button variant="ghost" size="sm" onClick={downloadErrorReport} disabled={!displayRows.some((r) => r.hasError || r.hasWarning)}>
              <Download size={14} /> {t('imp_download_error_report', 'Download error report')}
            </Button>
          </div>

          <DataTable
            columns={columns}
            data={filtered}
            rowKey={(r) => r.row}
            emptyTitle={t('ui_no_results', 'No results')}
            pageSizeOptions={[25, 50, 100]}
            defaultPageSize={25}
          />
        </>
      )}

      <div className="flex justify-between">
        <Button variant="secondary" onClick={onBack} disabled={importing}>
          {t('imp_back', 'Back')}
        </Button>
        <Button
          variant="primary"
          onClick={onImport}
          loading={importing}
          disabled={!result || hasErrors || overLimit || loading}
          title={hasErrors ? t('imp_import_disabled_errors', 'Fix all errors before importing') : undefined}
        >
          {tf(t('imp_import_button', 'Import {count} rows'), { count: result ? result.total - result.errors.length : 0 })}
        </Button>
      </div>
    </div>
  );
}

export default ReviewStep;
