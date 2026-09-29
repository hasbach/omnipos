import React, { useEffect, useMemo, useState } from 'react';
import { Lock, RotateCcw } from 'lucide-react';
import { Button, Card, Checkbox, EmptyState, Skeleton, useConfirm, useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { DEFAULT_ROLE_PERMISSIONS, EDITABLE_ROLES, PERMISSION_GROUPS, ROLES, permLabelKey } from '../../lib/permissions';
import { refreshPermissions, usePermissions } from '../../lib/usePermissions';

type Matrix = Record<string, string[]>;

const cloneMatrix = (m: Matrix): Matrix => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v]]));
const sameMatrix = (a: Matrix, b: Matrix) =>
  EDITABLE_ROLES.every((r) => {
    const x = [...(a[r] || [])].sort().join('|');
    const y = [...(b[r] || [])].sort().join('|');
    return x === y;
  });

/** Settings -> Roles & permissions: roles as columns, permissions (grouped by area) as rows. Admin only. */
export function RolesSection() {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const { ready, isAdmin } = usePermissions();

  const [saved, setSaved] = useState<Matrix | null>(null);
  const [draft, setDraft] = useState<Matrix | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .get<{ roles: Matrix }>('/api/permissions')
      .then((res) => {
        setSaved(cloneMatrix(res.roles));
        setDraft(cloneMatrix(res.roles));
      })
      .catch((err) => toast.error(err.message));
  }, [isAdmin]);

  const dirty = useMemo(() => !!saved && !!draft && !sameMatrix(saved, draft), [saved, draft]);

  if (ready && !isAdmin) {
    return <Card><EmptyState title={t('perm_no_access_title')} description={t('perm_admin_only')} /></Card>;
  }
  if (!draft) {
    return <Card><div className="p-6"><Skeleton className="h-64 w-full" /></div></Card>;
  }

  const has = (role: string, key: string) => role === 'admin' || draft[role]?.includes(key);
  const set = (role: string, keys: string[], on: boolean) =>
    setDraft((d) => {
      if (!d) return d;
      const cur = new Set(d[role] || []);
      keys.forEach((k) => (on ? cur.add(k) : cur.delete(k)));
      return { ...d, [role]: Array.from(cur) };
    });

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload: Matrix = {};
      EDITABLE_ROLES.forEach((r) => (payload[r] = draft[r] || []));
      const res = await api.post<{ roles: Matrix }>('/api/permissions', { role_permissions: payload });
      setSaved(cloneMatrix(res.roles));
      setDraft(cloneMatrix(res.roles));
      refreshPermissions();
      toast.success(t('perm_saved'));
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    const ok = await confirm({ title: t('perm_reset_confirm_title'), description: t('perm_reset_confirm_desc') });
    if (ok) setDraft(cloneMatrix(DEFAULT_ROLE_PERMISSIONS));
  };

  return (
    <Card>
      <div className="flex flex-col gap-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-text">{t('perm_title')}</h2>
            <p className="text-sm text-text-3">{t('perm_subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            {dirty && <span className="text-xs font-medium text-warning">{t('perm_unsaved')}</span>}
            <Button variant="secondary" onClick={handleReset}>
              <RotateCcw size={15} /> {t('perm_reset')}
            </Button>
            <Button variant="primary" loading={saving} disabled={!dirty} onClick={handleSave}>
              {t('perm_save')}
            </Button>
          </div>
        </div>

        <p className="flex items-center gap-2 text-xs text-text-3">
          <Lock size={13} aria-hidden="true" /> {t('perm_admin_locked')}
        </p>

        <div className="overflow-x-auto rounded-[var(--radius-input)] border border-border">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="bg-surface-2">
                <th scope="col" className="sticky start-0 z-10 bg-surface-2 px-3 py-2.5 text-start text-xs font-semibold uppercase tracking-wide text-text-3">
                  {t('perm_col_permission')}
                </th>
                {ROLES.map((role) => (
                  <th key={role} scope="col" className="px-3 py-2.5 text-center text-xs font-semibold text-text-2">
                    <span className="inline-flex items-center gap-1">
                      {role === 'admin' && <Lock size={12} aria-hidden="true" />}
                      {t(`usr_role_${role}`, role)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSION_GROUPS.map((group) => (
                <React.Fragment key={group.area}>
                  <tr className="bg-surface-2/60">
                    <th scope="rowgroup" className="sticky start-0 z-10 bg-surface-2 px-3 py-2 text-start text-xs font-bold uppercase tracking-wide text-text">
                      {t(`perm_area_${group.area}`)}
                    </th>
                    {ROLES.map((role) => {
                      if (role === 'admin') return <td key={role} className="bg-surface-2" />;
                      const all = group.keys.every((k) => has(role, k));
                      const some = group.keys.some((k) => has(role, k));
                      return (
                        <td key={role} className="bg-surface-2 px-3 py-2 text-center">
                          <Checkbox
                            className="justify-center"
                            checked={all}
                            indeterminate={some && !all}
                            aria-label={`${t('perm_toggle_all').replace('{group}', t(`perm_area_${group.area}`))} — ${t(`usr_role_${role}`, role)}`}
                            onChange={(e) => set(role, group.keys, e.target.checked)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                  {group.keys.map((key) => (
                    <tr key={key} className="border-t border-border hover:bg-surface-2/40">
                      <th scope="row" className="sticky start-0 z-10 bg-surface px-3 py-2 text-start font-normal text-text">
                        {t(permLabelKey(key), key)}
                      </th>
                      {ROLES.map((role) => (
                        <td key={role} className="px-3 py-2 text-center">
                          <Checkbox
                            className="justify-center"
                            checked={has(role, key)}
                            disabled={role === 'admin'}
                            aria-label={`${t(permLabelKey(key), key)} — ${t(`usr_role_${role}`, role)}`}
                            onChange={(e) => set(role, [key], e.target.checked)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

export default RolesSection;
