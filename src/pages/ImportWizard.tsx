import React, { useCallback, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader, Card, CardBody, useToast } from '../components/ui';
import { useI18n } from '../intl/index';
import { api } from '../lib/api';
import { useSettings } from '../lib/useSettings';
import { Stepper } from './import/Stepper';
import { EntityStep } from './import/EntityStep';
import { UploadStep } from './import/UploadStep';
import { MappingStep } from './import/MappingStep';
import { ReviewStep } from './import/ReviewStep';
import type { ImportMode, ImportResponse } from './import/ReviewStep';
import { ResultStep } from './import/ResultStep';
import { downloadImportTemplate } from './import/template';
import type { ParsedSheet } from './import/parse';
import { tf } from './import/tf';
import {
  autoMapHeaders,
  fieldsForEntity,
  loadLearnedMapping,
  saveLearnedMapping,
  normalizeHeader,
  type ImportEntity,
} from './import/fields';

const STEPS = ['entity', 'upload', 'mapping', 'review', 'result'] as const;
type Step = (typeof STEPS)[number];

const ROW_LIMIT = 20000;

function isValidEntity(v: string | null): v is ImportEntity {
  return v === 'products' || v === 'customers' || v === 'suppliers';
}

export default function ImportWizard() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { priceLevelsEnabled } = useSettings();
  const [searchParams] = useSearchParams();

  const initialEntity: ImportEntity = isValidEntity(searchParams.get('entity')) ? (searchParams.get('entity') as ImportEntity) : 'products';

  const [step, setStep] = useState<Step>('entity');
  const [entity, setEntity] = useState<ImportEntity>(initialEntity);
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [mode, setMode] = useState<ImportMode>('upsert');

  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<ImportResponse | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);

  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResponse | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const stepIndex = STEPS.indexOf(step);
  const stepLabels = useMemo(
    () => [
      { key: 'entity', label: t('imp_step_entity', 'What to import') },
      { key: 'upload', label: t('imp_step_upload', 'Upload') },
      { key: 'mapping', label: t('imp_step_mapping', 'Map columns') },
      { key: 'review', label: t('imp_step_review', 'Review') },
      { key: 'result', label: t('imp_step_result', 'Done') },
    ],
    [t],
  );

  const resetWizard = (keepEntity = true) => {
    setStep('entity');
    if (!keepEntity) setEntity('products');
    setSheet(null);
    setFileName('');
    setMapping({});
    setMode('upsert');
    setDryRunResult(null);
    setDryRunError(null);
    setImportResult(null);
    setImportError(null);
  };

  const buildCanonicalRows = useCallback(
    (s: ParsedSheet, map: Record<string, string | null>) => {
      const fields = fieldsForEntity(entity);
      return s.rows.map((row) => {
        const out: Record<string, any> = {};
        for (const f of fields) {
          const header = map[f.key];
          if (!header) continue;
          out[f.key] = row.cells[header];
        }
        return out;
      });
    },
    [entity],
  );

  const runDryRun = useCallback(
    async (activeSheet: ParsedSheet, activeMapping: Record<string, string | null>, activeMode: ImportMode) => {
      if (activeSheet.rows.length > ROW_LIMIT) {
        setDryRunResult(null);
        setDryRunError(null);
        setDryRunLoading(false);
        return;
      }
      setDryRunLoading(true);
      setDryRunError(null);
      try {
        const rows = buildCanonicalRows(activeSheet, activeMapping);
        const userId = (() => {
          try {
            return sessionStorage.getItem('currentCashierId') || undefined;
          } catch {
            return undefined;
          }
        })();
        const res = await api.post<ImportResponse>(`/api/import/${entity}`, {
          rows,
          mode: activeMode,
          dry_run: true,
          user_id: userId,
        });
        setDryRunResult(res);
      } catch (err: any) {
        setDryRunResult(null);
        setDryRunError(tf(t('imp_run_dry_run_error', 'Could not check the file: {message}'), { message: err?.message || '' }));
      } finally {
        setDryRunLoading(false);
      }
    },
    [buildCanonicalRows, entity, t],
  );

  const handleParsed = (parsedSheet: ParsedSheet, name: string) => {
    setSheet(parsedSheet);
    setFileName(name);
    const fields = fieldsForEntity(entity);
    const learned = loadLearnedMapping(entity);
    const headerToField = autoMapHeaders(parsedSheet.headers, fields, learned);
    const fieldToHeader: Record<string, string | null> = {};
    for (const f of fields) fieldToHeader[f.key] = null;
    for (const [header, fieldKey] of Object.entries(headerToField)) {
      if (fieldKey) fieldToHeader[fieldKey] = header;
    }
    setMapping(fieldToHeader);
    setStep('mapping');
  };

  const goToReview = () => {
    if (!sheet) return;
    // Remember this mapping (normalized header -> field key) for next time.
    const fields = fieldsForEntity(entity);
    const learned = loadLearnedMapping(entity);
    for (const f of fields) {
      const header = mapping[f.key];
      if (header) {
        learned[normalizeHeader(header)] = f.key;
      }
    }
    saveLearnedMapping(entity, learned);

    setStep('review');
    setDryRunResult(null);
    runDryRun(sheet, mapping, mode);
  };

  const handleModeChange = (nextMode: ImportMode) => {
    setMode(nextMode);
    if (sheet) runDryRun(sheet, mapping, nextMode);
  };

  const handleImport = async () => {
    if (!sheet) return;
    setImporting(true);
    setImportError(null);
    try {
      const rows = buildCanonicalRows(sheet, mapping);
      const userId = (() => {
        try {
          return sessionStorage.getItem('currentCashierId') || undefined;
        } catch {
          return undefined;
        }
      })();
      const res = await api.post<ImportResponse>(`/api/import/${entity}`, {
        rows,
        mode,
        dry_run: false,
        user_id: userId,
      });
      setImportResult(res);
      window.dispatchEvent(
        new CustomEvent('pos-sync', { detail: { type: entity === 'products' ? 'PRODUCTS_UPDATED' : 'STAKEHOLDERS_UPDATED' } }),
      );
      toast.success(t('imp_result_title', 'Import complete'));
      setStep('result');
    } catch (err: any) {
      setImportError(tf(t('imp_run_import_error', 'Could not import the file: {message}'), { message: err?.message || '' }));
      setStep('result');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t('imp_title', 'Import data')} subtitle={t('imp_subtitle', 'Bring products, customers or suppliers in from a spreadsheet.')} />

      <div className="mb-4">
        <Stepper steps={stepLabels} currentIndex={stepIndex} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <Card>
          <CardBody>
            {step === 'entity' && (
              <EntityStep
                entity={entity}
                onSelect={(e) => setEntity(e)}
                onDownloadTemplate={() => downloadImportTemplate(t, lang, priceLevelsEnabled)}
                onContinue={() => setStep('upload')}
              />
            )}

            {step === 'upload' && <UploadStep entity={entity} onBack={() => setStep('entity')} onParsed={handleParsed} />}

            {step === 'mapping' && sheet && (
              <MappingStep
                entity={entity}
                sheet={sheet}
                mapping={mapping}
                onMappingChange={setMapping}
                onBack={() => setStep('upload')}
                onContinue={goToReview}
              />
            )}

            {step === 'review' && sheet && (
              <ReviewStep
                entity={entity}
                sheet={sheet}
                mode={mode}
                onModeChange={handleModeChange}
                loading={dryRunLoading}
                result={dryRunResult}
                error={dryRunError}
                onBack={() => setStep('mapping')}
                onImport={handleImport}
                importing={importing}
                rowLimit={ROW_LIMIT}
              />
            )}

            {step === 'result' && (
              <ResultStep
                entity={entity}
                result={importResult}
                error={importError}
                onGoToProducts={() => navigate('/dashboard/products')}
                onGoToStakeholders={() => navigate('/dashboard/stakeholders')}
                onImportAnother={() => resetWizard(false)}
              />
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
