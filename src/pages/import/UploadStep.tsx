import importLocale from '../../intl/locales/import';
import React, { useCallback, useRef, useState } from 'react';
import { Upload, FileSpreadsheet, X } from 'lucide-react';
import { Button, Card, CardBody, Select } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { parseSpreadsheetFile, type ParsedSheet, type ParsedWorkbook } from './parse';
import { normalizeHeader, type ImportEntity } from './fields';
import { tf } from './tf';

export interface UploadStepProps {
  entity: ImportEntity;
  onBack: () => void;
  onParsed: (sheet: ParsedSheet, fileName: string) => void;
}

const SHEET_TITLE_KEYS: Record<ImportEntity, string> = {
  products: 'imp_sheet_products',
  customers: 'imp_sheet_customers',
  suppliers: 'imp_sheet_suppliers',
};
const ENTITY_SHEET_NAMES: Record<ImportEntity, string[]> = {
  products: ['products', 'product', 'items', 'منتجات', 'مواد', 'produits'],
  customers: ['customers', 'customer', 'clients', 'زبائن', 'عملاء'],
  suppliers: ['suppliers', 'supplier', 'vendors', 'موردين', 'fournisseurs'],
};

// The template names its sheets in the language it was downloaded in ("المنتجات", "Clients", …), so
// accept every language's template sheet title — otherwise an Arabic template would preselect sheet 0
// (Products) even when the user is importing customers.
function pickDefaultSheet(entity: ImportEntity, workbook: ParsedWorkbook): number {
  const locales = importLocale as unknown as Record<string, Record<string, string>>;
  const wanted = new Set(ENTITY_SHEET_NAMES[entity].map((n) => normalizeHeader(n)));
  for (const lang of Object.keys(locales)) {
    const title = locales[lang]?.[SHEET_TITLE_KEYS[entity]];
    if (title) wanted.add(normalizeHeader(title));
  }
  const idx = workbook.sheets.findIndex((sh) => wanted.has(normalizeHeader(sh.name)));
  return idx >= 0 ? idx : 0;
}

export function UploadStep({ entity, onBack, onParsed }: UploadStepProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setParsing(true);
      setWorkbook(null);
      try {
        const wb = await parseSpreadsheetFile(file);
        if (!wb.sheets.length) {
          setError(t('imp_upload_no_sheets', 'No data found in this file.'));
          setParsing(false);
          return;
        }
        setFileName(file.name);
        setWorkbook(wb);
        setSheetIndex(pickDefaultSheet(entity, wb));
      } catch {
        setError(t('imp_upload_parse_error', 'Could not read this file. Make sure it is a valid Excel or CSV file.'));
      } finally {
        setParsing(false);
      }
    },
    [entity, t],
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = '';
  };

  const reset = () => {
    setWorkbook(null);
    setFileName('');
    setError(null);
  };

  const selectedSheet = workbook?.sheets[sheetIndex];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-text">{t('imp_upload_title', 'Upload your file')}</h2>
        <p className="text-xs text-text-3">{t('imp_upload_desc', 'Drag and drop, or choose a .xlsx, .xls or .csv file.')}</p>
      </div>

      {!workbook ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={[
            'flex flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border-2 border-dashed p-10 text-center transition-colors duration-150',
            dragOver ? 'border-primary bg-primary-soft' : 'border-border bg-surface',
          ].join(' ')}
        >
          <Upload size={26} className="text-text-3" aria-hidden="true" />
          <p className="text-sm font-medium text-text">{t('imp_upload_drop', 'Drop your file here')}</p>
          <p className="text-xs text-text-3">{t('imp_upload_or', 'or')}</p>
          <Button variant="secondary" onClick={() => inputRef.current?.click()} loading={parsing}>
            {t('imp_upload_browse', 'Choose a file')}
          </Button>
          <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onPick} />
          <p className="mt-1 text-[11px] text-text-3">{t('imp_upload_accepted', 'Accepted formats: .xlsx, .xls, .csv')}</p>
          {error && <p className="text-xs font-medium text-danger">{error}</p>}
        </div>
      ) : (
        <Card>
          <CardBody className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <FileSpreadsheet size={18} className="shrink-0 text-primary" aria-hidden="true" />
                <span className="truncate text-sm font-medium text-text">{fileName}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={reset}>
                <X size={14} /> {t('imp_upload_replace_file', 'Choose a different file')}
              </Button>
            </div>

            {workbook.sheets.length > 1 && (
              <div className="max-w-xs space-y-1">
                <p className="text-xs text-text-3">{t('imp_upload_choose_sheet', 'This file has several sheets — choose the one to import.')}</p>
                <Select
                  value={String(sheetIndex)}
                  onChange={(e) => setSheetIndex(Number(e.target.value))}
                  options={workbook.sheets.map((s, i) => ({ value: String(i), label: s.name }))}
                />
              </div>
            )}

            {selectedSheet && (
              <p className="text-xs text-text-2">
                {tf(t('imp_upload_rows_found', '{count} rows found'), { count: selectedSheet.rows.length })}
              </p>
            )}
          </CardBody>
        </Card>
      )}

      <div className="flex justify-between">
        <Button variant="secondary" onClick={onBack}>
          {t('imp_back', 'Back')}
        </Button>
        <Button variant="primary" disabled={!selectedSheet || !selectedSheet.rows.length} onClick={() => selectedSheet && onParsed(selectedSheet, fileName)}>
          {t('imp_continue', 'Continue')}
        </Button>
      </div>
    </div>
  );
}

export default UploadStep;
