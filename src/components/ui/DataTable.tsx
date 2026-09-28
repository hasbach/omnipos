import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Checkbox } from './Checkbox';
import { SearchInput } from './SearchInput';
import { Select } from './Select';
import { EmptyState } from './EmptyState';
import { SkeletonTable } from './Skeleton';
import { useI18n } from '../../intl/index';

export interface DataTableColumn<T> {
  key: string;
  header: React.ReactNode;
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  /** Custom comparable value for sorting; defaults to row[key]. */
  sortValue?: (row: T) => string | number | Date | null | undefined;
  align?: 'start' | 'end' | 'center';
  width?: string | number;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: T[];
  rowKey: (row: T) => string | number;
  loading?: boolean;
  /** Enables the built-in search box (client-side, matches any column's rendered/sortValue string). */
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  onRowClick?: (row: T) => void;
  selectable?: boolean;
  selectedKeys?: Set<string | number>;
  onSelectedKeysChange?: (keys: Set<string | number>) => void;
  bulkActions?: (selected: T[], clearSelection: () => void) => React.ReactNode;
  /** Footer totals row, e.g. { total: '$1,234.00' } keyed by column key. */
  footerTotals?: Record<string, React.ReactNode>;
  pageSizeOptions?: number[];
  defaultPageSize?: number;
  className?: string;
}

const ALIGN_CLASSES: Record<NonNullable<DataTableColumn<any>['align']>, string> = {
  start: 'text-start',
  end: 'text-end num',
  center: 'text-center',
};

function defaultSortValue<T>(row: T, col: DataTableColumn<T>): string | number | Date | null | undefined {
  if (col.sortValue) return col.sortValue(row);
  const v = (row as any)[col.key];
  return v;
}

export function DataTable<T>({
  columns,
  data,
  rowKey,
  loading,
  searchable,
  searchPlaceholder,
  emptyTitle,
  emptyDescription,
  onRowClick,
  selectable,
  selectedKeys,
  onSelectedKeysChange,
  bulkActions,
  footerTotals,
  pageSizeOptions = [25, 50, 100],
  defaultPageSize = 25,
  className = '',
}: DataTableProps<T>) {
  const { t } = useI18n();
  const resolvedSearchPlaceholder = searchPlaceholder ?? t('ui_search_placeholder', 'Search…');
  const resolvedEmptyTitle = emptyTitle ?? t('ui_no_results', 'No results');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [internalSelected, setInternalSelected] = useState<Set<string | number>>(new Set());

  const selected = selectedKeys ?? internalSelected;
  const setSelected = onSelectedKeysChange ?? setInternalSelected;

  const filtered = useMemo(() => {
    if (!searchable || !search.trim()) return data;
    const q = search.trim().toLowerCase();
    return data.filter((row) =>
      columns.some((col) => {
        const val = col.render ? undefined : defaultSortValue(row, col);
        const text = val != null ? String(val) : '';
        return text.toLowerCase().includes(q);
      }) ||
      // Fall back to a full-row JSON scan so search still works with fully custom render() columns.
      JSON.stringify(row).toLowerCase().includes(q),
    );
  }, [data, columns, search, searchable]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return filtered;
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = defaultSortValue(a, col);
      const bv = defaultSortValue(b, col);
      if (av == null && bv == null) return 0;
      if (av == null) return -1;
      if (bv == null) return 1;
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
  }, [filtered, sortKey, sortDir, columns]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => sorted.slice((clampedPage - 1) * pageSize, clampedPage * pageSize),
    [sorted, clampedPage, pageSize],
  );

  const toggleSort = (col: DataTableColumn<T>) => {
    if (!col.sortable) return;
    if (sortKey !== col.key) {
      setSortKey(col.key);
      setSortDir('asc');
    } else if (sortDir === 'asc') {
      setSortDir('desc');
    } else {
      setSortKey(null);
    }
  };

  const allOnPageSelected = pageRows.length > 0 && pageRows.every((r) => selected.has(rowKey(r)));
  const someOnPageSelected = pageRows.some((r) => selected.has(rowKey(r)));

  const toggleAllOnPage = () => {
    const next = new Set(selected);
    if (allOnPageSelected) {
      pageRows.forEach((r) => next.delete(rowKey(r)));
    } else {
      pageRows.forEach((r) => next.add(rowKey(r)));
    }
    setSelected(next);
  };

  const toggleRow = (row: T) => {
    const key = rowKey(row);
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };

  const selectedRows = useMemo(
    () => data.filter((r) => selected.has(rowKey(r))),
    [data, selected, rowKey],
  );

  const clearSelection = () => setSelected(new Set());

  return (
    <div className={['flex flex-col gap-3', className].join(' ')}>
      {(searchable || (selectable && selected.size > 0 && bulkActions)) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {searchable && (
            <SearchInput
              value={search}
              onChange={(v) => {
                setSearch(v);
                setPage(1);
              }}
              placeholder={resolvedSearchPlaceholder}
              className="max-w-xs"
            />
          )}
          {selectable && selected.size > 0 && bulkActions && (
            <div className="flex items-center gap-2 rounded-[var(--radius-input)] border border-primary/30 bg-primary-soft px-3 py-1.5">
              <span className="text-xs font-medium text-primary">{t('ui_selected_count', '{count} selected').replace('{count}', String(selected.size))}</span>
              {bulkActions(selectedRows, clearSelection)}
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface-2">
            <tr>
              {selectable && (
                <th className="w-10 border-b border-border px-3 py-2.5">
                  <Checkbox
                    checked={allOnPageSelected}
                    indeterminate={someOnPageSelected && !allOnPageSelected}
                    onChange={toggleAllOnPage}
                    aria-label={t('ui_select_all_rows', 'Select all rows on this page')}
                  />
                </th>
              )}
              {columns.map((col) => (
                <th
                  key={col.key}
                  style={{ width: col.width }}
                  className={[
                    'border-b border-border px-3 py-2.5 text-xs font-semibold uppercase tracking-[0.04em] text-text-3',
                    ALIGN_CLASSES[col.align || 'start'],
                    col.sortable ? 'cursor-pointer select-none hover:text-text' : '',
                  ].join(' ')}
                  onClick={() => toggleSort(col)}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.header}
                    {col.sortable &&
                      (sortKey === col.key ? (
                        sortDir === 'asc' ? (
                          <ArrowUp size={12} />
                        ) : (
                          <ArrowDown size={12} />
                        )
                      ) : (
                        <ArrowUpDown size={12} className="opacity-40" />
                      ))}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length + (selectable ? 1 : 0)}>
                  <SkeletonTable cols={columns.length + (selectable ? 1 : 0)} />
                </td>
              </tr>
            ) : pageRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + (selectable ? 1 : 0)}>
                  <EmptyState title={resolvedEmptyTitle} description={emptyDescription} />
                </td>
              </tr>
            ) : (
              pageRows.map((row) => {
                const key = rowKey(row);
                return (
                  <tr
                    key={key}
                    onClick={() => onRowClick?.(row)}
                    className={[
                      'border-b border-border last:border-b-0 transition-colors duration-150',
                      onRowClick ? 'cursor-pointer hover:bg-surface-2' : '',
                      selected.has(key) ? 'bg-primary-soft/40' : '',
                    ].join(' ')}
                  >
                    {selectable && (
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={selected.has(key)} onChange={() => toggleRow(row)} aria-label={t('ui_select_row', 'Select row')} />
                      </td>
                    )}
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={['px-3 py-2.5 text-text h-9', ALIGN_CLASSES[col.align || 'start']].join(' ')}
                      >
                        {col.render ? col.render(row) : String((row as any)[col.key] ?? '')}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
          {footerTotals && pageRows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-border-strong bg-surface-2 font-semibold">
                {selectable && <td className="px-3 py-2.5" />}
                {columns.map((col) => (
                  <td key={col.key} className={['px-3 py-2.5 text-text', ALIGN_CLASSES[col.align || 'start']].join(' ')}>
                    {footerTotals[col.key] ?? ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {!loading && sorted.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-3">
          <div className="flex items-center gap-2">
            <span>{t('ui_rows_per_page', 'Rows per page')}</span>
            <Select
              value={String(pageSize)}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
              options={pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))}
              className="!h-8 w-20"
            />
          </div>
          <div className="flex items-center gap-3">
            <span>
              {t('ui_page_of', 'Page {page} of {total} ({rows} rows)')
                .replace('{page}', String(clampedPage))
                .replace('{total}', String(totalPages))
                .replace('{rows}', String(sorted.length))}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={clampedPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label={t('ui_previous_page', 'Previous page')}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-border disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed hover:bg-surface-2"
              >
                <ChevronLeft size={15} className="rtl:rotate-180" />
              </button>
              <button
                type="button"
                disabled={clampedPage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                aria-label={t('ui_next_page', 'Next page')}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-border disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed hover:bg-surface-2"
              >
                <ChevronRight size={15} className="rtl:rotate-180" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DataTable;
