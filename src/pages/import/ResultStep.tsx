import React from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Button, Card, CardBody } from '../../components/ui';
import { useI18n } from '../../intl/index';
import type { ImportEntity } from './fields';
import type { ImportResponse } from './ReviewStep';
import { tf } from './tf';

export interface ResultStepProps {
  entity: ImportEntity;
  result: ImportResponse | null;
  error: string | null;
  onGoToProducts: () => void;
  onGoToStakeholders: () => void;
  onImportAnother: () => void;
}

export function ResultStep({ entity, result, error, onGoToProducts, onGoToStakeholders, onImportAnother }: ResultStepProps) {
  const { t } = useI18n();
  const failed = !!error || !result;

  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <span className={['flex h-14 w-14 items-center justify-center rounded-full', failed ? 'bg-danger-soft text-danger' : 'bg-success-soft text-success'].join(' ')}>
        {failed ? <XCircle size={28} /> : <CheckCircle2 size={28} />}
      </span>

      <div>
        <h2 className="text-base font-semibold text-text">
          {failed ? t('imp_result_title_failed', 'Import failed') : t('imp_result_title', 'Import complete')}
        </h2>
        {result && !failed && (
          <p className="mt-1 text-sm text-text-3">
            {tf(t('imp_result_summary', '{created} created, {updated} updated, {skipped} skipped.'), {
              created: result.created,
              updated: result.updated,
              skipped: result.skipped,
            })}
          </p>
        )}
        {error && <p className="mt-1 max-w-md text-sm text-danger">{error}</p>}
      </div>

      {!failed && (
        <Card className="w-full max-w-sm">
          <CardBody className="flex flex-col gap-2">
            {entity === 'products' ? (
              <Button variant="secondary" onClick={onGoToProducts}>
                {t('imp_result_view_products', 'Go to Products')}
              </Button>
            ) : (
              <Button variant="secondary" onClick={onGoToStakeholders}>
                {t('imp_result_view_stakeholders', 'Go to Customers & Suppliers')}
              </Button>
            )}
          </CardBody>
        </Card>
      )}

      <Button variant="primary" onClick={onImportAnother}>
        {t('imp_result_import_another', 'Import another file')}
      </Button>
    </div>
  );
}

export default ResultStep;
