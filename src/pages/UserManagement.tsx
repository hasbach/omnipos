import React, { useEffect, useState } from 'react';
import { Plus, Edit2, Trash2, Eye, EyeOff, UserX, UserCheck } from 'lucide-react';
import {
  PageHeader,
  DataTable,
  Modal,
  Field,
  Input,
  Select,
  Badge,
  Button,
  IconButton,
  useToast,
  useConfirm,
} from '../components/ui';
import type { DataTableColumn } from '../components/ui';
import { useI18n } from '../intl/index';
import { api } from '../lib/api';

interface UserRow {
  id: number;
  name: string;
  role: string;
  pin: string;
  active?: number;
}

const isActive = (u: { active?: number }) => Number(u.active ?? 1) !== 0;

const ROLE_VARIANT: Record<string, 'primary' | 'info' | 'neutral' | 'warning'> = {
  admin: 'primary',
  manager: 'info',
  accountant: 'warning',
};

export default function UserManagement() {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();

  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<UserRow> | null>(null);
  const [saving, setSaving] = useState(false);
  const [showPin, setShowPin] = useState(false);

  const fetchUsers = () => {
    setLoading(true);
    return api
      .get<UserRow[]>('/api/users', { include_inactive: '1' })
      .then(setUsers)
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const pinValid = (pin: string) => /^[0-9]{4,6}$/.test(pin);

  const handleSave = async () => {
    if (!editing || !editing.name?.trim()) return;
    const pin = editing.pin || '0000';
    if (!pinValid(pin)) return;
    setSaving(true);
    try {
      const payload = { name: editing.name.trim(), role: editing.role || 'staff', pin };
      if (editing.id) {
        await api.put(`/api/users/${editing.id}`, payload);
      } else {
        await api.post('/api/users', payload);
      }
      toast.success(t('usr_toast_saved'));
      setEditing(null);
      fetchUsers();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (u: UserRow) => {
    const ok = await confirm({
      title: t('usr_delete_confirm_title'),
      description: t('usr_delete_confirm_desc').replace('{name}', u.name),
    });
    if (!ok) return;
    try {
      await api.del(`/api/users/${u.id}`);
      toast.success(t('usr_toast_deleted'));
      fetchUsers();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const handleToggleActive = async (u: UserRow) => {
    const enable = !isActive(u);
    if (!enable) {
      const ok = await confirm({
        title: t('usr_disable_confirm_title', 'Disable this user?'),
        description: t('usr_disable_confirm_desc', '{name} will no longer be able to sign in or be picked as a cashier. Their invoices, shifts and logs stay. You can enable them again at any time.').replace('{name}', u.name),
        confirmLabel: t('usr_disable', 'Disable'),
      });
      if (!ok) return;
    }
    try {
      await api.put(`/api/users/${u.id}/active`, { active: enable });
      toast.success(enable ? t('usr_toast_enabled', 'User enabled.') : t('usr_toast_disabled', 'User disabled.'));
      fetchUsers();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const roleLabel = (role: string) => t(`usr_role_${role}`, role);

  const columns: DataTableColumn<UserRow>[] = [
    {
      key: 'name',
      header: t('usr_col_name'),
      sortable: true,
      render: (u) => (
        <span className={['font-medium', isActive(u) ? 'text-text' : 'text-text-3 line-through'].join(' ')}>{u.name}</span>
      ),
    },
    {
      key: 'role',
      header: t('usr_col_role'),
      sortable: true,
      render: (u) => <Badge variant={ROLE_VARIANT[u.role] || 'neutral'}>{roleLabel(u.role)}</Badge>,
    },
    {
      key: 'active',
      header: t('usr_col_status', 'Status'),
      sortable: true,
      render: (u) => isActive(u)
        ? <Badge variant="success">{t('usr_status_active', 'Active')}</Badge>
        : <Badge variant="neutral">{t('usr_status_disabled', 'Disabled')}</Badge>,
    },
    {
      key: 'actions',
      header: '',
      align: 'end',
      width: 124,
      render: (u) => (
        <div className="flex justify-end gap-1">
          <IconButton aria-label={t('stk_edit')} size="sm" onClick={() => { setEditing(u); setShowPin(false); }}>
            <Edit2 size={15} />
          </IconButton>
          <IconButton
            aria-label={isActive(u) ? t('usr_disable', 'Disable') : t('usr_enable', 'Enable')}
            title={isActive(u) ? t('usr_disable', 'Disable') : t('usr_enable', 'Enable')}
            size="sm"
            onClick={() => handleToggleActive(u)}
          >
            {isActive(u) ? <UserX size={15} /> : <UserCheck size={15} />}
          </IconButton>
          <IconButton aria-label={t('usr_delete')} size="sm" onClick={() => handleDelete(u)}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      ),
    },
  ];

  const pin = editing?.pin || '';
  const pinError = pin.length > 0 && !pinValid(pin) ? t('usr_pin_invalid') : undefined;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('usr_title')}
        subtitle={t('usr_subtitle')}
        actions={
          <Button variant="primary" onClick={() => { setEditing({ name: '', role: 'staff', pin: '0000' }); setShowPin(false); }}>
            <Plus size={16} /> {t('usr_add')}
          </Button>
        }
      />

      <DataTable
        columns={columns}
        data={users}
        rowKey={(u) => u.id}
        loading={loading}
        searchable
        emptyTitle={t('usr_no_results_title')}
        emptyDescription={t('usr_no_results_desc')}
        defaultPageSize={25}
      />

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? t('usr_edit_user') : t('usr_new_user')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>{t('usr_cancel')}</Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!editing?.name?.trim() || !pinValid(editing?.pin || '0000')}
              onClick={handleSave}
            >
              {t('usr_save')}
            </Button>
          </>
        }
      >
        {editing && (
          <div className="flex flex-col gap-4">
            <Field label={t('usr_field_name')} required>
              <Input autoFocus value={editing.name || ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label={t('usr_field_role')} helper={t(`usr_role_${editing.role || 'staff'}_desc`)}>
              <Select
                value={editing.role || 'staff'}
                onChange={(e) => setEditing({ ...editing, role: e.target.value })}
                options={[
                  { value: 'admin', label: `${t('usr_role_admin')} — ${t('usr_role_admin_desc')}` },
                  { value: 'manager', label: `${t('usr_role_manager')} — ${t('usr_role_manager_desc')}` },
                  { value: 'staff', label: `${t('usr_role_staff')} — ${t('usr_role_staff_desc')}` },
                  { value: 'cashier', label: `${t('usr_role_cashier')} — ${t('usr_role_cashier_desc')}` },
                  { value: 'accountant', label: `${t('usr_role_accountant')} — ${t('usr_role_accountant_desc')}` },
                ]}
              />
            </Field>
            <Field label={t('usr_field_pin')} helper={!pinError ? t('usr_pin_help') : undefined} error={pinError}>
              <Input
                type={showPin ? 'text' : 'password'}
                inputMode="numeric"
                maxLength={6}
                placeholder={t('usr_pin_placeholder')}
                className="text-center font-mono tracking-[0.5em]"
                value={editing.pin || ''}
                onChange={(e) => setEditing({ ...editing, pin: e.target.value.replace(/[^0-9]/g, '') })}
                endAdornment={
                  <button type="button" className="cursor-pointer" aria-label={showPin ? t('usr_pin_hide') : t('usr_pin_show')} onClick={() => setShowPin((v) => !v)}>
                    {showPin ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                }
              />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
