import React, { useState } from 'react';
import { Lock, Pencil, Plus, Tags } from 'lucide-react';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, IconButton, Input, Modal, Switch, useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { translateServerError } from '../../lib/serverErrors';
import { usePermissions } from '../../lib/usePermissions';
import { CATEGORIES, CATEGORY_TYPES, builtinCategoryLabel } from '../cashflow/common';
import { useCashFlowCategories, type CategoryDirection, type CustomCashFlowCategory } from '../cashflow/useCashFlowCategories';

const DIRECTIONS: CategoryDirection[] = ['in', 'out', 'both'];

function useDirectionLabel() {
  const { t } = useI18n();
  return (d: CategoryDirection) =>
    d === 'in' ? t('cfc_dir_in', 'Cash in') : d === 'out' ? t('cfc_dir_out', 'Cash out') : t('cfc_dir_both', 'Both');
}

function DirectionBadge({ direction }: { direction: CategoryDirection }) {
  const label = useDirectionLabel();
  return <Badge variant={direction === 'in' ? 'success' : direction === 'out' ? 'danger' : 'info'}>{label(direction)}</Badge>;
}

/** In / Out / Both segmented control (radio group, keyboard friendly, RTL safe). */
function DirectionPicker({ value, onChange, disabled }: { value: CategoryDirection; onChange: (d: CategoryDirection) => void; disabled?: boolean }) {
  const label = useDirectionLabel();
  return (
    <div role="radiogroup" className="inline-flex overflow-hidden rounded-[var(--radius-input)] border border-border">
      {DIRECTIONS.map((d) => {
        const active = d === value;
        return (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(d)}
            className={[
              'px-3 py-1.5 text-sm font-medium transition-colors duration-150 cursor-pointer',
              'border-s border-border first:border-s-0',
              active ? 'bg-primary text-white' : 'bg-surface text-text-2 hover:bg-surface-2',
              disabled ? 'cursor-not-allowed opacity-50' : '',
            ].join(' ')}
          >
            {label(d)}
          </button>
        );
      })}
    </div>
  );
}

/** Settings -> Cash flow categories: built-ins (read-only) plus the tenant's own categories. */
export function CashFlowCategoriesSection() {
  const { t } = useI18n();
  const toast = useToast();
  const { can } = usePermissions();
  const cats = useCashFlowCategories();
  const canManage = can('settings.manage');

  const [name, setName] = useState('');
  const [direction, setDirection] = useState<CategoryDirection>('out');
  const [adding, setAdding] = useState(false);
  const [nameError, setNameError] = useState('');
  const [dirError, setDirError] = useState('');

  const [editing, setEditing] = useState<CustomCashFlowCategory | null>(null);
  const [editName, setEditName] = useState('');
  const [editDirection, setEditDirection] = useState<CategoryDirection>('out');
  const [editNameError, setEditNameError] = useState('');
  const [editDirError, setEditDirError] = useState('');
  const [saving, setSaving] = useState(false);

  if (!canManage) {
    return <Card><EmptyState title={t('perm_no_access_title', 'No access')} description={t('cfc_no_access', 'Only an administrator can manage cash flow categories.')} /></Card>;
  }

  const showError = (err: any, setName_: (m: string) => void, setDir_: (m: string) => void) => {
    const msg = translateServerError(err, t) || err?.message || String(err);
    if (err?.field === 'direction') setDir_(msg);
    else if (err?.field === 'name') setName_(msg);
    else toast.error(msg);
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setNameError('');
    setDirError('');
    setAdding(true);
    try {
      await api.post('/api/cash-flow/categories', { name, direction });
      toast.success(t('cfc_created', 'Category added.'));
      setName('');
      await cats.reload();
    } catch (err: any) {
      showError(err, setNameError, setDirError);
    } finally {
      setAdding(false);
    }
  };

  const toggleActive = async (c: CustomCashFlowCategory, active: boolean) => {
    try {
      await api.put(`/api/cash-flow/categories/${c.id}`, { active });
      await cats.reload();
    } catch (err: any) {
      toast.error(translateServerError(err, t) || err?.message || String(err));
    }
  };

  const openEdit = (c: CustomCashFlowCategory) => {
    setEditing(c);
    setEditName(c.name);
    setEditDirection(c.direction);
    setEditNameError('');
    setEditDirError('');
  };

  const saveEdit = async () => {
    if (!editing) return;
    setEditNameError('');
    setEditDirError('');
    setSaving(true);
    try {
      await api.put(`/api/cash-flow/categories/${editing.id}`, { name: editName, direction: editDirection });
      toast.success(t('cfc_saved', 'Category updated.'));
      setEditing(null);
      await cats.reload();
    } catch (err: any) {
      showError(err, setEditNameError, setEditDirError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 text-text-2">
            <Tags size={18} />
            <h3 className="text-sm font-semibold">{t('cfc_title', 'Cash flow categories')}</h3>
          </div>
        </CardHeader>
        <CardBody>
          <p className="mb-4 text-sm text-text-3">{t('cfc_subtitle', 'Add your own categories for cash in and cash out. Built-in categories cannot be changed.')}</p>

          <h4 className="mb-2 text-sm font-semibold text-text">{t('cfc_custom', 'Your categories')}</h4>
          {cats.custom.length === 0 ? (
            <p className="mb-3 rounded-[var(--radius-input)] border border-dashed border-border px-3 py-4 text-center text-sm text-text-3">
              {t('cfc_empty', 'No custom categories yet. Add one below.')}
            </p>
          ) : (
            <ul className="mb-3 flex flex-col divide-y divide-border rounded-[var(--radius-input)] border border-border">
              {cats.custom.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <span className={['min-w-0 flex-1 truncate text-sm font-medium', c.active ? 'text-text' : 'text-text-3'].join(' ')}>{c.name}</span>
                  <DirectionBadge direction={c.direction} />
                  <Switch checked={c.active} onChange={(v) => toggleActive(c, v)} aria-label={`${t('cfc_active', 'Active')}: ${c.name}`} label={t('cfc_active', 'Active')} />
                  <IconButton size="sm" aria-label={t('cfc_edit', 'Edit category')} title={t('cfc_edit', 'Edit category')} onClick={() => openEdit(c)}>
                    <Pencil size={15} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <p className="mb-4 text-xs text-text-3">{t('cfc_hidden_hint', 'Hidden categories are not offered for new movements, but old movements keep them.')}</p>

          <form onSubmit={add} className="flex flex-col gap-3 rounded-[var(--radius-input)] border border-border bg-surface-2 p-3" aria-label={t('cfc_add', 'Add category')}>
            <div className="flex flex-wrap items-start gap-3">
              <Field label={t('cfc_name', 'Name')} error={nameError || undefined} className="min-w-[14rem] flex-1">
                <Input
                  value={name}
                  maxLength={40}
                  onChange={(e) => { setName(e.target.value); setNameError(''); }}
                  placeholder={t('cfc_name_placeholder', 'e.g. Rent, Delivery fees, Tips')}
                />
              </Field>
              <Field label={t('cfc_direction', 'Used for')} error={dirError || undefined}>
                <DirectionPicker value={direction} onChange={(d) => { setDirection(d); setDirError(''); }} />
              </Field>
            </div>
            <div>
              <Button type="submit" size="sm" loading={adding} disabled={!name.trim()}>
                <Plus size={14} /> {t('cfc_add', 'Add category')}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 text-text-2">
            <Lock size={16} />
            <h3 className="text-sm font-semibold">{t('cfc_builtin', 'Built-in categories')}</h3>
          </div>
        </CardHeader>
        <CardBody>
          <ul className="flex flex-col divide-y divide-border rounded-[var(--radius-input)] border border-border">
            {CATEGORIES.map((key) => {
              const d = CATEGORY_TYPES[key];
              const dir: CategoryDirection = d.length === 2 ? 'both' : d[0];
              return (
                <li key={key} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <Lock size={14} className="shrink-0 text-text-3" aria-label={t('cfc_builtin_locked', 'Built-in, cannot be edited')} />
                  <span className="min-w-0 flex-1 truncate text-sm text-text-2">{builtinCategoryLabel(key, t)}</span>
                  <DirectionBadge direction={dir} />
                </li>
              );
            })}
          </ul>
        </CardBody>
      </Card>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={t('cfc_edit_title', 'Edit category')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>{t('cfc_cancel', 'Cancel')}</Button>
            <Button variant="primary" loading={saving} disabled={!editName.trim()} onClick={saveEdit}>{t('cfc_save', 'Save')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label={t('cfc_name', 'Name')} error={editNameError || undefined}>
            <Input value={editName} maxLength={40} onChange={(e) => { setEditName(e.target.value); setEditNameError(''); }} />
          </Field>
          <Field label={t('cfc_direction', 'Used for')} error={editDirError || undefined}>
            <DirectionPicker value={editDirection} onChange={(d) => { setEditDirection(d); setEditDirError(''); }} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
