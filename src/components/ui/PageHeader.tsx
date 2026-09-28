import React from 'react';
import { ChevronRight } from 'lucide-react';
import { useI18n } from '../../intl/index';

export interface Breadcrumb {
  label: string;
  href?: string;
}

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  breadcrumbs?: Breadcrumb[];
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, breadcrumbs, actions, className = '' }: PageHeaderProps) {
  let breadcrumbLabel = 'Breadcrumb';
  try {
    breadcrumbLabel = useI18n().t('ui_breadcrumb', 'Breadcrumb');
  } catch {
    /* PageHeader can be used outside I18nProvider in rare cases. */
  }
  return (
    <div className={['flex flex-col gap-2 pb-4 sm:flex-row sm:items-center sm:justify-between', className].join(' ')}>
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav className="mb-1 flex items-center gap-1 text-xs text-text-3" aria-label={breadcrumbLabel}>
            {breadcrumbs.map((b, i) => (
              <React.Fragment key={i}>
                {i > 0 && <ChevronRight size={12} className="rtl:rotate-180" aria-hidden="true" />}
                {b.href ? (
                  <a href={b.href} className="hover:text-text hover:underline">
                    {b.label}
                  </a>
                ) : (
                  <span>{b.label}</span>
                )}
              </React.Fragment>
            ))}
          </nav>
        )}
        <h1 className="text-xl font-semibold text-text truncate">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-text-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export default PageHeader;
