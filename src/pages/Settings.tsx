import React, { useEffect, useState } from 'react';
import { Store, Tag, Coins, Printer, Globe, Shield, AlertTriangle, Network, KeyRound, Tags } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/ui';
import { useI18n } from '../intl/index';
import { api } from '../lib/api';
import type { Tenant } from '../types';
import { GeneralSection } from './settings/GeneralSection';
import { SalesPricingSection } from './settings/SalesPricingSection';
import { CurrenciesSection } from './settings/CurrenciesSection';
import { PrintersSection } from './settings/PrintersSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { UpdatesSection } from './settings/UpdatesSection';
import { DataResetSection } from './settings/DataResetSection';
import { ConnectionsSection } from './settings/ConnectionsSection';
import { RolesSection } from './settings/RolesSection';
import { CashFlowCategoriesSection } from './settings/CashFlowCategoriesSection';
import { usePermissions } from '../lib/usePermissions';

type SectionKey = 'general' | 'pricing' | 'currencies' | 'printers' | 'appearance' | 'updates' | 'connections' | 'cfcategories' | 'roles' | 'reset';

export default function Settings({ onShowUpdate }: { onShowUpdate: () => void }) {
  const { t } = useI18n();
  const [requested, setSection] = useState<SectionKey>('general');
  const { isAdmin, can } = usePermissions();
  const canManage = can('settings.manage');
  const canReset = can('data.reset');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [tenant, setTenant] = useState<Tenant | null>(null);
  // Ctrl+Shift+O (Electron) deep-links here with ?section=connections.
  const [searchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('section') === 'connections' && window.electronAPI?.connections) setSection('connections');
  }, [searchParams]);

  const fetchSettings = () => api.get<Record<string, string>>('/api/settings').then(setSettings).catch(() => {});

  useEffect(() => {
    fetchSettings();
    api.get<Tenant>('/api/auth/me').then(setTenant).catch(() => {});

    const handleSync = (e: any) => {
      if (e.detail?.type === 'SETTINGS_UPDATED') fetchSettings();
    };
    window.addEventListener('pos-sync', handleSync);
    return () => window.removeEventListener('pos-sync', handleSync);
  }, []);

  // The page is open to everyone (appearance / language); every other section needs its permission.
  const NAV: { key: SectionKey; label: string; icon: typeof Store; danger?: boolean }[] = [
    ...(canManage ? [
      { key: 'general' as SectionKey, label: t('set_nav_general'), icon: Store },
      { key: 'pricing' as SectionKey, label: t('set_nav_pricing'), icon: Tag },
      { key: 'currencies' as SectionKey, label: t('set_nav_currencies'), icon: Coins },
      { key: 'printers' as SectionKey, label: t('set_nav_printers'), icon: Printer },
      { key: 'cfcategories' as SectionKey, label: t('set_nav_cf_categories', 'Cash flow categories'), icon: Tags },
    ] : []),
    { key: 'appearance', label: t('set_nav_appearance'), icon: Globe },
    ...(canManage ? [{ key: 'updates' as SectionKey, label: t('set_nav_updates'), icon: Shield }] : []),
    ...(canManage && window.electronAPI?.connections ? [{ key: 'connections' as SectionKey, label: t('set_nav_connections'), icon: Network }] : []),
    ...(isAdmin ? [{ key: 'roles' as SectionKey, label: t('set_nav_roles'), icon: KeyRound }] : []),
    ...(canReset ? [{ key: 'reset' as SectionKey, label: t('set_nav_reset'), icon: AlertTriangle, danger: true }] : []),
  ];
  // A section the role can't open (e.g. after a permission change) falls back to the first allowed one.
  const section: SectionKey = NAV.some((n) => n.key === requested) ? requested : (NAV[0]?.key ?? 'appearance');

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('set_title')} subtitle={t('set_subtitle')} />

      <div className="flex flex-col gap-4 md:flex-row">
        <nav className="flex shrink-0 flex-row gap-1 overflow-x-auto md:w-52 md:flex-col md:overflow-visible">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = section === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setSection(item.key)}
                className={[
                  'flex shrink-0 items-center gap-2 rounded-[var(--radius-input)] px-3 py-2 text-start text-sm font-medium transition-colors duration-150 cursor-pointer',
                  item.danger
                    ? active ? 'bg-danger-soft text-danger' : 'text-danger hover:bg-danger-soft'
                    : active ? 'bg-primary-soft text-primary' : 'text-text-2 hover:bg-surface-2 hover:text-text',
                ].join(' ')}
              >
                <Icon size={16} />
                <span className="whitespace-nowrap">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1">
          {section === 'general' && <GeneralSection settings={settings} onSaved={fetchSettings} />}
          {section === 'pricing' && <SalesPricingSection settings={settings} onSaved={fetchSettings} />}
          {section === 'currencies' && <CurrenciesSection />}
          {section === 'printers' && <PrintersSection settings={settings} onSaved={fetchSettings} />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'updates' && <UpdatesSection tenant={tenant} onShowUpdate={onShowUpdate} />}
          {section === 'connections' && <ConnectionsSection />}
          {section === 'cfcategories' && canManage && <CashFlowCategoriesSection />}
          {section === 'roles' && isAdmin && <RolesSection />}
          {section === 'reset' && <DataResetSection />}
        </div>
      </div>
    </div>
  );
}
