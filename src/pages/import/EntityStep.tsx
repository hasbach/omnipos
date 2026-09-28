import React from 'react';
import { Package, Users, Truck, Download } from 'lucide-react';
import { Card, CardBody, Button } from '../../components/ui';
import { useI18n } from '../../intl/index';
import type { ImportEntity } from './fields';

export interface EntityStepProps {
  entity: ImportEntity;
  onSelect: (entity: ImportEntity) => void;
  onDownloadTemplate: () => void;
  onContinue: () => void;
}

const ENTITY_ICONS: Record<ImportEntity, React.ComponentType<{ size?: number; className?: string }>> = {
  products: Package,
  customers: Users,
  suppliers: Truck,
};

export function EntityStep({ entity, onSelect, onDownloadTemplate, onContinue }: EntityStepProps) {
  const { t } = useI18n();

  const options: { value: ImportEntity; titleKey: string; titleFallback: string; descKey: string; descFallback: string }[] = [
    { value: 'products', titleKey: 'imp_entity_products', titleFallback: 'Products', descKey: 'imp_entity_products_desc', descFallback: 'Names, barcodes, pricing, stock and reorder points.' },
    { value: 'customers', titleKey: 'imp_entity_customers', titleFallback: 'Customers', descKey: 'imp_entity_customers_desc', descFallback: 'Contacts, price level, credit limit and opening balance.' },
    { value: 'suppliers', titleKey: 'imp_entity_suppliers', titleFallback: 'Suppliers', descKey: 'imp_entity_suppliers_desc', descFallback: 'Contacts and opening balance.' },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {options.map((opt) => {
          const Icon = ENTITY_ICONS[opt.value];
          const active = entity === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onSelect(opt.value)}
              className={[
                'rounded-[var(--radius-card)] border p-4 text-start transition-colors duration-150 cursor-pointer',
                active ? 'border-primary bg-primary-soft' : 'border-border bg-surface hover:bg-surface-2',
              ].join(' ')}
            >
              <span className={['flex h-9 w-9 items-center justify-center rounded-md', active ? 'bg-primary text-on-primary' : 'bg-surface-2 text-text-2'].join(' ')}>
                <Icon size={18} />
              </span>
              <p className="mt-3 text-sm font-semibold text-text">{t(opt.titleKey, opt.titleFallback)}</p>
              <p className="mt-1 text-xs text-text-3">{t(opt.descKey, opt.descFallback)}</p>
            </button>
          );
        })}
      </div>

      <Card>
        <CardBody className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-medium text-text">{t('imp_download_template', 'Download template')}</p>
            <p className="text-xs text-text-3">{t('imp_download_template_desc', 'An Excel file with the right columns, an example row, and instructions in your language.')}</p>
          </div>
          <Button variant="secondary" onClick={onDownloadTemplate}>
            <Download size={16} /> {t('imp_download_template', 'Download template')}
          </Button>
        </CardBody>
      </Card>

      <div className="flex justify-end">
        <Button variant="primary" onClick={onContinue}>
          {t('imp_continue', 'Continue')}
        </Button>
      </div>
    </div>
  );
}

export default EntityStep;
