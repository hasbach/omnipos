import React from 'react';
import { Card, CardBody, CardHeader, Field, Select, Switch } from '../../components/ui';
import { Globe, Moon, Sun } from 'lucide-react';
import { useI18n } from '../../intl/index';
import { useTheme } from '../../hooks/useTheme';
import type { Language } from '../../intl/index';

export function AppearanceSection() {
  const { t, lang, setLang } = useI18n();
  const [isDarkMode, setIsDarkMode] = useTheme();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 text-text-2">
          <Globe size={18} />
          <h3 className="text-sm font-semibold">{t('set_nav_appearance')}</h3>
        </div>
      </CardHeader>
      <CardBody>
        <div className="flex flex-col gap-4">
          <Field label={t('set_language')} className="max-w-xs">
            <Select
              value={lang}
              onChange={(e) => setLang(e.target.value as Language)}
              options={[
                { value: 'en', label: 'English (US)' },
                { value: 'ar', label: 'العربية' },
                { value: 'fr', label: 'Français' },
              ]}
            />
          </Field>

          <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-border bg-surface-2 p-3">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-input)] bg-primary text-on-primary">
                {isDarkMode ? <Moon size={17} /> : <Sun size={17} />}
              </span>
              <div>
                <p className="text-sm font-medium text-text">{t('set_dark_mode')}</p>
                <p className="text-xs text-text-3">{t('set_dark_mode_help')}</p>
              </div>
            </div>
            <Switch checked={isDarkMode} onChange={setIsDarkMode} />
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

export default AppearanceSection;
