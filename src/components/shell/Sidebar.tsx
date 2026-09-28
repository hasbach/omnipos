import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  FileText,
  BarChart3,
  Activity,
  Package,
  ClipboardList,
  ShoppingCart,
  Users,
  Wallet,
  CalendarCheck,
  Shield,
  Settings as SettingsIcon,
  ChevronsLeft,
  ChevronsRight,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '../../intl/index';

export interface NavItem {
  key: string;
  icon: LucideIcon;
  path: string;
  end?: boolean;
}

export interface NavGroup {
  key: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  { key: 'shell_group_overview', items: [{ key: 'shell_nav_overview', icon: LayoutDashboard, path: '/dashboard', end: true }] },
  {
    key: 'shell_group_sales',
    items: [
      { key: 'shell_nav_invoices', icon: FileText, path: '/dashboard/invoices' },
      { key: 'shell_nav_daily_sales', icon: BarChart3, path: '/dashboard/daily-sales' },
      { key: 'shell_nav_live_monitor', icon: Activity, path: '/dashboard/live' },
    ],
  },
  {
    key: 'shell_group_inventory',
    items: [
      { key: 'shell_nav_products', icon: Package, path: '/dashboard/products' },
      { key: 'shell_nav_stock', icon: ClipboardList, path: '/dashboard/stock' },
    ],
  },
  {
    key: 'shell_group_purchasing',
    items: [
      { key: 'shell_nav_purchases', icon: ShoppingCart, path: '/dashboard/purchases' },
      { key: 'shell_nav_stakeholders', icon: Users, path: '/dashboard/stakeholders' },
    ],
  },
  {
    key: 'shell_group_finance',
    items: [
      { key: 'shell_nav_cash_flow', icon: Wallet, path: '/dashboard/cash-flow' },
      { key: 'shell_nav_settlement', icon: CalendarCheck, path: '/dashboard/settlement' },
    ],
  },
  { key: 'shell_group_reports', items: [{ key: 'shell_nav_reports', icon: BarChart3, path: '/dashboard/reports' }] },
  {
    key: 'shell_group_admin',
    items: [
      { key: 'shell_nav_users', icon: Shield, path: '/dashboard/users' },
      { key: 'shell_nav_user_logs', icon: ClipboardList, path: '/dashboard/logs' },
      { key: 'shell_nav_settings', icon: SettingsIcon, path: '/dashboard/settings' },
    ],
  },
];

const STORAGE_KEY = 'omnipos_sidebar_collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.end) return pathname === item.path;
  return pathname === item.path || pathname.startsWith(item.path + '/');
}

export function Sidebar() {
  const { t } = useI18n();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  return (
    <aside
      className={[
        'flex h-full flex-col border-e border-border bg-surface transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-60',
      ].join(' ')}
    >
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary font-bold text-on-primary">
          Ω
        </div>
        {!collapsed && <span className="truncate text-sm font-semibold tracking-tight text-text">{t('shell_version', 'OmniPOS')}</span>}
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto p-3 min-h-0">
        {NAV_GROUPS.map((group) => (
          <div key={group.key}>
            {!collapsed && (
              <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-3">
                {t(group.key)}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(location.pathname, item);
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    replace
                    title={collapsed ? t(item.key) : undefined}
                    className={[
                      'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors duration-150',
                      collapsed ? 'justify-center' : '',
                      active ? 'bg-primary-soft text-primary' : 'text-text-2 hover:bg-surface-2 hover:text-text',
                    ].join(' ')}
                  >
                    <item.icon size={18} aria-hidden="true" />
                    {!collapsed && <span className="truncate">{t(item.key)}</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? t('shell_expand_sidebar') : t('shell_collapse_sidebar')}
        className="flex h-11 shrink-0 cursor-pointer items-center justify-center gap-2 border-t border-border text-text-3 transition-colors duration-150 hover:bg-surface-2 hover:text-text"
      >
        {collapsed ? <ChevronsRight size={16} className="rtl:rotate-180" /> : <ChevronsLeft size={16} className="rtl:rotate-180" />}
      </button>
    </aside>
  );
}

export default Sidebar;
