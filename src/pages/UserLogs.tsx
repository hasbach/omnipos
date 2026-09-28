import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { PageHeader, Toolbar, Select, DataTable, Badge, useToast } from '../components/ui';
import type { DataTableColumn } from '../components/ui';
import { useI18n } from '../intl/index';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';

interface LogRow {
  id: number;
  user_id: number | null;
  user_name: string | null;
  action: string;
  details: string;
  created_at: string;
}

export default function UserLogs() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [userFilter, setUserFilter] = useState('all');
  const [actionFilter, setActionFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    api
      .get<LogRow[]>('/api/logs')
      .then(setLogs)
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, []);

  const users = useMemo(() => {
    const map = new Map<string, string>();
    logs.forEach((l) => map.set(String(l.user_id ?? 'system'), l.user_name || t('log_system')));
    return Array.from(map.entries());
  }, [logs, t]);

  const actions = useMemo(() => Array.from(new Set(logs.map((l) => l.action))).sort(), [logs]);

  const filtered = useMemo(() => {
    return logs.filter((l) => {
      if (userFilter !== 'all' && String(l.user_id ?? 'system') !== userFilter) return false;
      if (actionFilter !== 'all' && l.action !== actionFilter) return false;
      const day = l.created_at?.slice(0, 10);
      if (dateFrom && day && day < dateFrom) return false;
      if (dateTo && day && day > dateTo) return false;
      return true;
    });
  }, [logs, userFilter, actionFilter, dateFrom, dateTo]);

  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const columns: DataTableColumn<LogRow>[] = [
    {
      key: 'created_at',
      header: t('log_col_timestamp'),
      sortable: true,
      width: 180,
      render: (l) => <span className="num text-xs text-text-3">{formatDateTime(l.created_at, lang)}</span>,
    },
    { key: 'user_name', header: t('log_col_user'), sortable: true, render: (l) => <span className="font-medium text-text">{l.user_name || t('log_system')}</span> },
    { key: 'action', header: t('log_col_action'), sortable: true, render: (l) => <Badge variant="primary">{l.action}</Badge> },
    {
      key: 'details',
      header: t('log_col_details'),
      render: (l) => {
        const isLong = (l.details || '').length > 80;
        const open = expanded.has(l.id);
        if (!isLong) return <span className="text-xs text-text-2">{l.details}</span>;
        return (
          <button
            type="button"
            onClick={() => toggleExpanded(l.id)}
            className="flex w-full cursor-pointer items-start gap-1 text-start text-xs text-text-2"
          >
            {open ? <ChevronDown size={13} className="mt-0.5 shrink-0" /> : <ChevronRight size={13} className="mt-0.5 shrink-0 rtl:rotate-180" />}
            <span className={open ? '' : 'truncate'}>{l.details}</span>
          </button>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('log_title')} subtitle={t('log_subtitle')} />

      <Toolbar>
        <Select
          value={userFilter}
          onChange={(e) => setUserFilter(e.target.value)}
          className="w-44"
          options={[{ value: 'all', label: t('log_all_users') }, ...users.map(([id, name]) => ({ value: id, label: name }))]}
        />
        <Select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="w-52"
          options={[{ value: 'all', label: t('log_all_actions') }, ...actions.map((a) => ({ value: a, label: a }))]}
        />
        <div className="flex items-center gap-1.5 text-xs text-text-3">
          <span>{t('log_from')}</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-9 rounded-[var(--radius-input)] border border-border bg-surface px-2 text-xs outline-none focus:border-primary"
          />
          <span>{t('log_to')}</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-9 rounded-[var(--radius-input)] border border-border bg-surface px-2 text-xs outline-none focus:border-primary"
          />
        </div>
      </Toolbar>

      <DataTable
        columns={columns}
        data={filtered}
        rowKey={(l) => l.id}
        loading={loading}
        searchable
        searchPlaceholder={t('log_search_placeholder')}
        emptyTitle={t('log_no_results_title')}
        emptyDescription={t('log_no_results_desc')}
        defaultPageSize={50}
        pageSizeOptions={[25, 50, 100]}
      />
    </div>
  );
}
