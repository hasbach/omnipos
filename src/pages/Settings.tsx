import React, { useEffect, useState } from 'react';
import { Store, Tag, Coins, Printer, Globe, Shield } from 'lucide-react';
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

type SectionKey = 'general' | 'pricing' | 'currencies' | 'printers' | 'appearance' | 'updates';

export default function Settings({ onShowUpdate }: { onShowUpdate: () => void }) {
  const { t } = useI18n();
  const [section, setSection] = useState<SectionKey>('general');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [tenant, setTenant] = useState<Tenant | null>(null);

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

  const NAV: { key: SectionKey; label: string; icon: typeof Store }[] = [
    { key: 'general', label: t('set_nav_general'), icon: Store },
    { key: 'pricing', label: t('set_nav_pricing'), icon: Tag },
    { key: 'currencies', label: t('set_nav_currencies'), icon: Coins },
    { key: 'printers', label: t('set_nav_printers'), icon: Printer },
    { key: 'appearance', label: t('set_nav_appearance'), icon: Globe },
    { key: 'updates', label: t('set_nav_updates'), icon: Shield },
  ];

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
                  active ? 'bg-primary-soft text-primary' : 'text-text-2 hover:bg-surface-2 hover:text-text',
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
        </div>
      </div>
    </div>
  );
}
