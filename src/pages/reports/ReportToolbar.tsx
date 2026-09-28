import React from 'react';
import { FileSpreadsheet, FileText, Printer } from 'lucide-react';
import { Button } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { printReport } from './exportUtils';

export interface ReportToolbarProps {
  title: string;
  onExportExcel?: () => void;
  onExportPdf?: () => void;
  children?: React.ReactNode;
  className?: string;
}

/** A small per-table header: title on the start side, filter slot + export/print actions on the end side. */
export function ReportToolbar({ title, onExportExcel, onExportPdf, children, className = '' }: ReportToolbarProps) {
  const { t } = useI18n();
  return (
    <div className={['flex flex-wrap items-center justify-between gap-2 print:hidden', className].join(' ')}>
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {onExportExcel && (
          <Button variant="secondary" size="sm" onClick={onExportExcel}>
            <FileSpreadsheet size={14} /> {t('rep_export_excel', 'Excel')}
          </Button>
        )}
        {onExportPdf && (
          <Button variant="secondary" size="sm" onClick={onExportPdf}>
            <FileText size={14} /> {t('rep_export_pdf', 'PDF')}
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={printReport}>
          <Printer size={14} /> {t('rep_print', 'Print')}
        </Button>
      </div>
    </div>
  );
}

export default ReportToolbar;
