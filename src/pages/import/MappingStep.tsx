import React, { useEffect, useMemo } from 'react';
import { Button, Select, Badge } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { fieldsForEntity, type ImportEntity } from './fields';
import type { ParsedSheet } from './parse';
import { tf } from './tf';

export interface MappingStepProps {
  entity: ImportEntity;
  sheet: ParsedSheet;
  /** field key -> header (or null = ignored/unmapped) */
  mapping: Record<string, string | null>;
  onMappingChange: (mapping: Record<string, string | null>) => void;
  onBack: () => void;
  onContinue: () => void;
}

const IGNORE = '__ignore__';

export function MappingStep({ entity, sheet, mapping, onMappingChange, onBack, onContinue }: MappingStepProps) {
  const { t } = useI18n();
  const fields = useMemo(() => fieldsForEntity(entity), [entity]);

  const setField = (fieldKey: string, header: string | null) => {
    // A header can only be assigned to one field — clear it from any other field first.
    const next: Record<string, string | null> = {};
    for (const f of fields) {
      next[f.key] = mapping[f.key] === header && header !== null ? null : mapping[f.key] ?? null;
    }
    next[fieldKey] = header;
    onMappingChange(next);
  };

  const usedHeaders = new Set(Object.values(mapping).filter(Boolean) as string[]);

  const missingRequired = fields.filter((f) => f.required && !mapping[f.key]);

  const previewRows = sheet.rows.slice(0, 5);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-text">{t('imp_mapping_title', 'Map your columns')}</h2>
        <p className="text-xs text-text-3">{t('imp_mapping_desc', "Match each field to a column from your file. We matched what we could — check the rest.")}</p>
      </div>

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-border">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-surface-2 text-xs text-text-3">
            <tr>
              <th className="px-3 py-2 text-start">{t('imp_mapping_field', 'Field')}</th>
              <th className="px-3 py-2 text-start">{t('imp_mapping_column', 'Your column')}</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => {
              const value = mapping[f.key] ?? '';
              const unmapped = f.required && !value;
              return (
                <tr key={f.key} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-text">{t(f.labelKey, f.labelFallback)}</span>
                      {f.required && (
                        <Badge variant={unmapped ? 'danger' : 'neutral'}>{t('imp_mapping_required', 'Required')}</Badge>
                      )}
                    </div>
                    {f.hintKey && <p className="mt-0.5 text-[11px] text-text-3">{t(f.hintKey, f.hintFallback || '')}</p>}
                  </td>
                  <td className="px-3 py-2">
                    <Select
                      className="max-w-xs"
                      invalid={unmapped}
                      value={value || IGNORE}
                      onChange={(e) => setField(f.key, e.target.value === IGNORE ? null : e.target.value)}
                      options={[
                        { value: IGNORE, label: t('imp_mapping_ignore', 'Ignore') },
                        ...sheet.headers.map((h) => ({
                          value: h,
                          label: h,
                          disabled: usedHeaders.has(h) && mapping[f.key] !== h,
                        })),
                      ]}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {missingRequired.length > 0 && (
        <p className="text-xs font-medium text-danger">
          {tf(t('imp_mapping_unmapped_required', '{count} required field(s) still need a column.'), { count: missingRequired.length })}
        </p>
      )}

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
          {t('imp_mapping_preview_title', 'Preview (first 5 rows)')}
        </h3>
        {previewRows.length === 0 || fields.every((f) => !mapping[f.key]) ? (
          <p className="text-xs text-text-3">{t('imp_mapping_preview_empty', 'Map at least one column to see a preview.')}</p>
        ) : (
          <div className="max-h-64 overflow-auto rounded-[var(--radius-card)] border border-border">
            <table className="w-full border-collapse text-xs">
              <thead className="bg-surface-2 text-text-3">
                <tr>
                  {fields.filter((f) => mapping[f.key]).map((f) => (
                    <th key={f.key} className="whitespace-nowrap px-2 py-1.5 text-start">{t(f.labelKey, f.labelFallback)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row) => (
                  <tr key={row.sheetRow} className="border-t border-border">
                    {fields.filter((f) => mapping[f.key]).map((f) => (
                      <td key={f.key} className="px-2 py-1.5 text-text">{String(row.cells[mapping[f.key] as string] ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex justify-between">
        <Button variant="secondary" onClick={onBack}>
          {t('imp_back', 'Back')}
        </Button>
        <Button variant="primary" disabled={missingRequired.length > 0} onClick={onContinue}>
          {t('imp_continue', 'Continue')}
        </Button>
      </div>
    </div>
  );
}

export default MappingStep;
