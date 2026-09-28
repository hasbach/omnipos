import React from 'react';
import { useLocation } from 'react-router-dom';
import { Moon, Sun, ExternalLink, Globe } from 'lucide-react';
import { useI18n } from '../../intl/index';
import type { Language } from '../../i18n';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';

const TITLE_ROUTES: { prefix: string; key: string; exact?: boolean }[] = [
  { prefix: '/dashboard', key: 'shell_nav_overview', exact: true },
  { prefix: '/dashboard/invoices', key: 'shell_nav_invoices' },
  { prefix: '/dashboard/daily-sales', key: 'shell_nav_daily_sales' },
  { prefix: '/dashboard/live', key: 'shell_nav_live_monitor' },
  { prefix: '/dashboard/products', key: 'shell_nav_products' },
  { prefix: '/dashboard/stock', key: 'shell_nav_stock' },
  { prefix: '/dashboard/purchases', key: 'shell_nav_purchases' },
  { prefix: '/dashboard/stakeholders', key: 'shell_nav_stakeholders' },
  { prefix: '/dashboard/cash-flow', key: 'shell_nav_cash_flow' },
  { prefix: '/dashboard/settlement', key: 'shell_nav_settlement' },
  { prefix: '/dashboard/reports', key: 'shell_nav_reports' },
  { prefix: '/dashboard/users', key: 'shell_nav_users' },
  { prefix: '/dashboard/logs', key: 'shell_nav_user_logs' },
  { prefix: '/dashboard/import', key: 'shell_nav_import' },
  { prefix: '/dashboard/settings', key: 'shell_nav_settings' },
  { prefix: '/dashboard/ui-kit', key: 'ui_kit_title' },
];

function titleKeyFor(pathname: string): string {
  if (pathname === '/dashboard' || pathname === '/dashboard/') return 'shell_nav_overview';
  const match = TITLE_ROUTES.filter((r) => !r.exact && pathname.startsWith(r.prefix)).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  )[0];
  return match?.key || 'shell_nav_overview';
}

export interface TopBarProps {
  isDarkMode: boolean;
  onToggleTheme: (dark: boolean) => void;
  onOpenPos: () => void;
}

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'ar', label: 'العربية' },
  { value: 'fr', label: 'Français' },
];

export function TopBar({ isDarkMode, onToggleTheme, onOpenPos }: TopBarProps) {
  const { t, lang, setLang } = useI18n();
  const location = useLocation();
  const titleKey = titleKeyFor(location.pathname);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-5">
      <h1 className="truncate text-base font-semibold text-text">{t(titleKey)}</h1>

      <div className="flex shrink-0 items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Globe size={15} className="text-text-3" aria-hidden="true" />
          <Select
            aria-label={t('shell_language')}
            value={lang}
            onChange={(e) => setLang(e.target.value as Language)}
            options={LANGUAGE_OPTIONS}
            className="!h-8 w-28"
          />
        </div>

        <Button
          variant="ghost"
          size="sm"
          aria-label={isDarkMode ? t('shell_theme_light') : t('shell_theme_dark')}
          onClick={() => onToggleTheme(!isDarkMode)}
        >
          {isDarkMode ? <Sun size={16} /> : <Moon size={16} />}
        </Button>

        <Button variant="primary" size="sm" onClick={onOpenPos}>
          <ExternalLink size={15} />
          {t('shell_open_pos')}
        </Button>
      </div>
    </header>
  );
}

export default TopBar;
