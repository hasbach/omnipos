import React, { useEffect, useState } from 'react';
import {
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Textarea,
  Select,
  Switch,
  Button,
  IconButton,
  Badge,
  useToast,
  useConfirm,
  Modal,
  EmptyState,
  Skeleton,
} from '../../components/ui';
import { Printer as PrinterIcon, Plus, Edit2, Trash2, Wifi, ScanLine, RefreshCw, CheckCircle2, Zap } from 'lucide-react';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';

// Printer type kept local (matches server/db.ts columns) — src/types.ts's Printer is a simpler
// legacy shape without the Arabic printing fields, so we don't reuse it here.
type PrinterRow = {
  id?: number;
  name: string;
  type: 'receipt' | 'kitchen' | 'bar';
  connection: 'usb' | 'network' | 'bluetooth';
  address: string;
  is_default: number;
  paper_width: number;
  enabled: number;
  arabic_codepage?: number | null;
  arabic_encoding?: 'cp864' | 'cp1256';
};

export interface PrintersSectionProps {
  settings: Record<string, string>;
  onSaved: () => void;
}

function fromSettings(s: Record<string, string>) {
  return {
    receipt_footer: s.receipt_footer || '',
    show_receipt_dialog: s.show_receipt_dialog !== '0',
  };
}

const TYPE_VARIANT: Record<string, 'info' | 'warning' | 'primary'> = { receipt: 'info', kitchen: 'warning', bar: 'primary' };

export function PrintersSection({ settings, onSaved }: PrintersSectionProps) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();

  const [receiptForm, setReceiptForm] = useState(() => fromSettings(settings));
  const [receiptSaving, setReceiptSaving] = useState(false);
  useEffect(() => setReceiptForm(fromSettings(settings)), [settings]);
  const receiptDirty = JSON.stringify(receiptForm) !== JSON.stringify(fromSettings(settings));

  const handleSaveReceipt = async () => {
    setReceiptSaving(true);
    try {
      await api.post('/api/settings', {
        receipt_footer: receiptForm.receipt_footer,
        show_receipt_dialog: receiptForm.show_receipt_dialog ? '1' : '0',
      });
      toast.success(t('set_saved_toast'));
      onSaved();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setReceiptSaving(false);
    }
  };

  const [printers, setPrinters] = useState<PrinterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingPrinter, setEditingPrinter] = useState<Partial<PrinterRow> | null>(null);
  const [saving, setSaving] = useState(false);
  const [scanResults, setScanResults] = useState<{ name: string; address: string }[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [showManualAddress, setShowManualAddress] = useState(false);
  const [actionId, setActionId] = useState<number | null>(null);

  const fetchPrinters = () => {
    setLoading(true);
    return api
      .get<PrinterRow[]>('/api/printers')
      .then((data) => setPrinters(Array.isArray(data) ? data : []))
      .catch(() => setPrinters([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchPrinters();
  }, []);

  const openNewPrinter = () => {
    setEditingPrinter({ name: '', type: 'receipt', connection: 'usb', address: '', paper_width: 80, is_default: 0, enabled: 1 });
    setScanResults([]);
    setShowManualAddress(false);
  };

  const handleSavePrinter = async () => {
    if (!editingPrinter?.name || !editingPrinter.type) return;
    setSaving(true);
    try {
      if (editingPrinter.id) {
        await api.put(`/api/printers/${editingPrinter.id}`, editingPrinter);
      } else {
        await api.post('/api/printers', editingPrinter);
      }
      toast.success(t('set_saved_toast'));
      setEditingPrinter(null);
      setScanResults([]);
      setShowManualAddress(false);
      fetchPrinters();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeletePrinter = async (p: PrinterRow) => {
    const ok = await confirm({
      title: t('set_printer_delete_title'),
      description: t('set_printer_delete_desc').replace('{name}', p.name),
    });
    if (!ok || !p.id) return;
    await api.del(`/api/printers/${p.id}`);
    toast.success(t('set_saved_toast'));
    fetchPrinters();
  };

  const handleTogglePrinter = async (p: PrinterRow) => {
    await api.put(`/api/printers/${p.id}`, { ...p, enabled: p.enabled ? 0 : 1 });
    fetchPrinters();
  };

  const handleTestPrint = async (p: PrinterRow) => {
    if (!p.id) return;
    setActionId(p.id);
    try {
      await api.post('/api/print/test', { printerId: p.id });
    } catch (err: any) {
      toast.error(t('set_toast_test_print_failed').replace('{error}', err.message));
    } finally {
      setActionId(null);
    }
  };

  const handleArabicTest = async (p: PrinterRow) => {
    if (!p.id) return;
    setActionId(p.id);
    try {
      await api.post('/api/print/arabic-test', { printerId: p.id });
    } catch (err: any) {
      toast.error(t('set_toast_arabic_test_failed').replace('{error}', err.message));
    } finally {
      setActionId(null);
    }
  };

  const handleOpenDrawer = async (p: PrinterRow) => {
    if (!p.id) return;
    setActionId(p.id);
    try {
      await api.post('/api/print/drawer-kick', { printerId: p.id });
    } catch (err: any) {
      toast.error(t('set_toast_drawer_failed').replace('{error}', err.message));
    } finally {
      setActionId(null);
    }
  };

  const handleScan = async () => {
    if (!editingPrinter?.connection || editingPrinter.connection === 'bluetooth') return;
    setIsScanning(true);
    setScanResults([]);
    try {
      const data = await api.get<{ printers: { name: string; address: string }[] }>('/api/printers/scan', {
        type: editingPrinter.connection,
      });
      setScanResults(Array.isArray(data.printers) ? data.printers : []);
    } catch {
      setScanResults([]);
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 text-text-2">
            <PrinterIcon size={18} />
            <h3 className="text-sm font-semibold">{t('set_receipt_footer')}</h3>
          </div>
          <Button variant="primary" size="sm" disabled={!receiptDirty} loading={receiptSaving} onClick={handleSaveReceipt}>
            {t('set_save')}
          </Button>
        </CardHeader>
        <CardBody>
          <div className="flex flex-col gap-4">
            <Field label={t('set_receipt_footer')}>
              <Input value={receiptForm.receipt_footer} onChange={(e) => setReceiptForm({ ...receiptForm, receipt_footer: e.target.value })} />
            </Field>
            <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-border bg-surface-2 p-3">
              <div className="pe-4">
                <p className="text-sm font-medium text-text">{t('set_show_receipt_dialog')}</p>
                <p className="text-xs text-text-3">{t('set_show_receipt_dialog_help')}</p>
              </div>
              <Switch
                checked={receiptForm.show_receipt_dialog}
                onChange={(v) => setReceiptForm({ ...receiptForm, show_receipt_dialog: v })}
              />
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 text-text-2">
            <PrinterIcon size={18} />
            <h3 className="text-sm font-semibold">{t('set_printers')}</h3>
          </div>
          <Button variant="primary" size="sm" onClick={openNewPrinter}>
            <Plus size={14} /> {t('set_add_printer')}
          </Button>
        </CardHeader>
        <CardBody>
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : printers.length === 0 ? (
            <EmptyState icon={PrinterIcon} title={t('set_printer_none_title')} description={t('set_printer_none_desc')} />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {printers.map((p) => (
                <div key={p.id} className={['rounded-[var(--radius-card)] border border-border p-4 flex flex-col gap-3', !p.enabled ? 'opacity-50' : ''].join(' ')}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={TYPE_VARIANT[p.type] || 'neutral'}>
                        {p.type === 'receipt' ? t('set_printer_type_receipt') : p.type === 'kitchen' ? t('set_printer_type_kitchen') : t('set_printer_type_bar')}
                      </Badge>
                      {p.is_default === 1 && <Badge variant="success">{t('set_currency_col_default')}</Badge>}
                    </div>
                    <Switch checked={!!p.enabled} onChange={() => handleTogglePrinter(p)} aria-label={t('set_printer_enabled')} />
                  </div>
                  <p className="text-sm font-semibold text-text">{p.name}</p>
                  <div className="flex flex-col gap-1 text-xs text-text-3 num">
                    <div>{t('set_printer_conn_label')}: <span className="capitalize">{p.connection}</span></div>
                    {p.address && <div className="truncate">{t('set_printer_addr_label')}: {p.address}</div>}
                    <div>{t('set_printer_paper_label')}: {p.paper_width}mm</div>
                    <div>
                      {t('set_printer_arabic_label')}:{' '}
                      {p.arabic_codepage != null
                        ? t('set_printer_arabic_value_text')
                            .replace('{page}', String(p.arabic_codepage))
                            .replace('{encoding}', p.arabic_encoding === 'cp1256' ? '1256' : '864')
                        : t('set_printer_arabic_value_image')}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <Button variant="secondary" size="sm" disabled={actionId === p.id} onClick={() => handleTestPrint(p)}>
                      <PrinterIcon size={13} /> {actionId === p.id ? t('set_printer_testing') : t('set_printer_test')}
                    </Button>
                    <Button variant="secondary" size="sm" disabled={actionId === p.id} title={t('set_printer_arabic_test_title')} onClick={() => handleArabicTest(p)}>
                      <PrinterIcon size={13} /> {t('set_printer_arabic_test')}
                    </Button>
                    {p.type === 'receipt' && (
                      <Button variant="secondary" size="sm" disabled={actionId === p.id} onClick={() => handleOpenDrawer(p)}>
                        <Zap size={13} /> {t('set_printer_open_drawer')}
                      </Button>
                    )}
                  </div>

                  <div className="flex gap-1.5 border-t border-border pt-2">
                    <IconButton aria-label={t('stk_edit')} size="sm" onClick={() => { setEditingPrinter({ ...p }); setScanResults([]); setShowManualAddress(false); }}>
                      <Edit2 size={15} />
                    </IconButton>
                    <IconButton aria-label={t('stk_delete')} size="sm" onClick={() => handleDeletePrinter(p)}>
                      <Trash2 size={15} />
                    </IconButton>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Modal
        open={!!editingPrinter}
        onClose={() => setEditingPrinter(null)}
        title={editingPrinter?.id ? t('set_edit_printer') : t('set_new_printer')}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditingPrinter(null)}>{t('stk_cancel')}</Button>
            <Button variant="primary" loading={saving} onClick={handleSavePrinter}>{t('set_printer_save')}</Button>
          </>
        }
      >
        {editingPrinter && (
          <div className="flex flex-col gap-4">
            <Field label={t('set_printer_name')}>
              <Input
                placeholder={t('set_printer_name_placeholder')}
                value={editingPrinter.name || ''}
                onChange={(e) => setEditingPrinter({ ...editingPrinter, name: e.target.value })}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label={t('set_printer_type')}>
                <Select
                  value={editingPrinter.type || 'receipt'}
                  onChange={(e) => setEditingPrinter({ ...editingPrinter, type: e.target.value as any })}
                  options={[
                    { value: 'receipt', label: t('set_printer_type_receipt') },
                    { value: 'kitchen', label: t('set_printer_type_kitchen') },
                    { value: 'bar', label: t('set_printer_type_bar') },
                  ]}
                />
              </Field>
              <Field label={t('set_printer_connection')}>
                <Select
                  value={editingPrinter.connection || 'usb'}
                  onChange={(e) => {
                    setEditingPrinter({ ...editingPrinter, connection: e.target.value as any, address: '' });
                    setScanResults([]);
                    setShowManualAddress(false);
                  }}
                  options={[
                    { value: 'usb', label: t('set_printer_connection_usb') },
                    { value: 'network', label: t('set_printer_connection_network') },
                    { value: 'bluetooth', label: t('set_printer_connection_bluetooth') },
                  ]}
                />
              </Field>
            </div>

            {editingPrinter.connection === 'bluetooth' ? (
              <Field label={t('set_printer_address_bluetooth')} helper={t('set_printer_address_bluetooth_help')}>
                <Input
                  placeholder="AA:BB:CC:DD:EE:FF"
                  className="font-mono"
                  value={editingPrinter.address || ''}
                  onChange={(e) => setEditingPrinter({ ...editingPrinter, address: e.target.value })}
                />
              </Field>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-text-2">
                    {editingPrinter.connection === 'network' ? t('set_printer_select_network') : t('set_printer_select_usb')}
                  </label>
                  {editingPrinter.address && <span className="truncate max-w-[180px] font-mono text-xs text-text-3">{editingPrinter.address}</span>}
                </div>

                <Button variant="secondary" disabled={isScanning} onClick={handleScan}>
                  {isScanning ? (
                    <>
                      <RefreshCw size={15} className="animate-spin" />
                      {editingPrinter.connection === 'network' ? t('set_printer_scanning_network') : t('set_printer_scanning')}
                    </>
                  ) : (
                    <>
                      <ScanLine size={15} />
                      {scanResults.length > 0
                        ? t('set_printer_scan_again')
                        : t('set_printer_scan').replace('{type}', editingPrinter.connection === 'network' ? t('set_printer_connection_network') : 'USB')}
                    </>
                  )}
                </Button>

                {!isScanning && scanResults.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs text-text-3">{t('set_printer_devices_found').replace('{count}', String(scanResults.length))}</p>
                    <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto pe-1">
                      {scanResults.map((r, i) => {
                        const resultAddress = editingPrinter.connection === 'usb' ? r.name : r.address;
                        const isSelected = editingPrinter.address === resultAddress;
                        return (
                          <button
                            key={i}
                            type="button"
                            onClick={() => setEditingPrinter({ ...editingPrinter, address: resultAddress, name: editingPrinter.name || r.name })}
                            className={[
                              'flex w-full items-center gap-2.5 rounded-[var(--radius-input)] border p-2.5 text-start transition-colors duration-150 cursor-pointer',
                              isSelected ? 'border-primary bg-primary-soft' : 'border-border bg-surface hover:border-border-strong',
                            ].join(' ')}
                          >
                            <span className={['flex h-7 w-7 shrink-0 items-center justify-center rounded-md', editingPrinter.connection === 'network' ? 'bg-info-soft text-info' : 'bg-accent-soft text-accent'].join(' ')}>
                              {editingPrinter.connection === 'network' ? <Wifi size={13} /> : <PrinterIcon size={13} />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <p className="truncate text-xs font-semibold text-text">{r.name}</p>
                              <p className="truncate font-mono text-[10px] text-text-3">{r.address}</p>
                            </span>
                            {isSelected && <CheckCircle2 size={15} className="shrink-0 text-success" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {!isScanning && scanResults.length === 0 && editingPrinter.address === '' && (
                  <p className="text-center text-xs text-text-3">{t('set_printer_no_devices')}</p>
                )}

                <button
                  type="button"
                  onClick={() => setShowManualAddress((v) => !v)}
                  className="cursor-pointer text-center text-xs text-text-3 transition-colors hover:text-text"
                >
                  {showManualAddress ? t('set_printer_manual_toggle_hide') : t('set_printer_manual_toggle_show')}
                </button>
                {showManualAddress && (
                  <Field helper={editingPrinter.connection === 'usb' ? t('set_printer_manual_usb_help') : undefined}>
                    <Input
                      placeholder={editingPrinter.connection === 'network' ? '192.168.1.100' : 'EPSON TM-T88V Receipt'}
                      className="font-mono"
                      value={editingPrinter.address || ''}
                      onChange={(e) => setEditingPrinter({ ...editingPrinter, address: e.target.value })}
                    />
                  </Field>
                )}
              </div>
            )}

            <Field label={t('set_printer_paper_width')}>
              <div className="grid grid-cols-2 gap-2">
                {[58, 80].map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setEditingPrinter({ ...editingPrinter, paper_width: w })}
                    className={[
                      'cursor-pointer rounded-[var(--radius-input)] border p-2.5 text-sm font-semibold transition-colors duration-150',
                      editingPrinter.paper_width === w ? 'border-primary bg-primary text-on-primary' : 'border-border bg-surface hover:border-border-strong',
                    ].join(' ')}
                  >
                    {w}mm
                  </button>
                ))}
              </div>
            </Field>

            <Field label={t('set_printer_arabic')}>
              <div className="grid grid-cols-2 gap-2">
                {([['image', t('set_printer_arabic_image')], ['text', t('set_printer_arabic_text')]] as const).map(([mode, label]) => {
                  const active = mode === 'text' ? editingPrinter.arabic_codepage != null : editingPrinter.arabic_codepage == null;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setEditingPrinter({ ...editingPrinter, arabic_codepage: mode === 'text' ? editingPrinter.arabic_codepage ?? 22 : null })}
                      className={[
                        'cursor-pointer rounded-[var(--radius-input)] border p-2.5 text-sm font-semibold transition-colors duration-150',
                        active ? 'border-primary bg-primary text-on-primary' : 'border-border bg-surface hover:border-border-strong',
                      ].join(' ')}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {editingPrinter.arabic_codepage == null ? (
                <p className="mt-1.5 text-xs text-text-3">{t('set_printer_arabic_image_help')}</p>
              ) : (
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <Field label={t('set_printer_arabic_codepage')}>
                    <Input
                      type="number"
                      min={0}
                      max={255}
                      value={editingPrinter.arabic_codepage ?? ''}
                      onChange={(e) => setEditingPrinter({ ...editingPrinter, arabic_codepage: e.target.value === '' ? 0 : Number(e.target.value) })}
                    />
                  </Field>
                  <Field label={t('set_printer_arabic_encoding')}>
                    <Select
                      value={editingPrinter.arabic_encoding || 'cp864'}
                      onChange={(e) => setEditingPrinter({ ...editingPrinter, arabic_encoding: e.target.value as any })}
                      options={[
                        { value: 'cp864', label: '864' },
                        { value: 'cp1256', label: '1256' },
                      ]}
                    />
                  </Field>
                  <p className="col-span-2 text-xs text-text-3">{t('set_printer_arabic_codepage_help')}</p>
                </div>
              )}
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-border bg-surface-2 p-3">
                <span className="text-sm text-text">{t('set_printer_default_for_type')}</span>
                <Switch checked={editingPrinter.is_default === 1} onChange={(v) => setEditingPrinter({ ...editingPrinter, is_default: v ? 1 : 0 })} />
              </div>
              <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-border bg-surface-2 p-3">
                <span className="text-sm text-text">{t('set_printer_enabled')}</span>
                <Switch checked={editingPrinter.enabled !== 0} onChange={(v) => setEditingPrinter({ ...editingPrinter, enabled: v ? 1 : 0 })} />
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default PrintersSection;
