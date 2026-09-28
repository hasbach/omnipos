import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { translations as baseTranslations, Language } from '../i18n';

export type { Language };

// Each module in src/i18n/locales/*.ts default-exports { en: {...}, ar: {...}, fr: {...} }.
// Page agents add their own file here so string additions never conflict in one shared file.
const localeModules = import.meta.glob('./locales/*.ts', { eager: true }) as Record<
  string,
  { default: Record<string, Record<string, string>> }
>;

function buildDictionary(): Record<string, Record<string, string>> {
  const dict: Record<string, Record<string, string>> = { en: {}, ar: {}, fr: {} };

  // Start from the legacy src/i18n.ts translations so existing keys keep working via useI18n() too.
  for (const lang of Object.keys(baseTranslations) as Language[]) {
    dict[lang] = { ...dict[lang], ...(baseTranslations[lang] as Record<string, string>) };
  }

  for (const mod of Object.values(localeModules)) {
    const table = mod.default || {};
    for (const lang of Object.keys(table)) {
      dict[lang] = { ...(dict[lang] || {}), ...table[lang] };
    }
  }

  return dict;
}

const dictionary = buildDictionary();

export interface I18nContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: string, fallback?: string) => string;
  dir: 'ltr' | 'rtl';
}

const I18nContext = createContext<I18nContextValue | null>(null);

const RTL_LANGS: Language[] = ['ar'];

function readInitialLang(): Language {
  if (typeof window === 'undefined') return 'en';
  try {
    const stored = localStorage.getItem('omnipos_language');
    if (stored === 'en' || stored === 'ar' || stored === 'fr') return stored;
  } catch {
    /* ignore */
  }
  return 'en';
}

export function I18nProvider({
  children,
  language,
  onLanguageChange,
}: {
  children: React.ReactNode;
  /** Optional controlled language (e.g. Dashboard fetches it from /api/settings). */
  language?: Language;
  onLanguageChange?: (lang: Language) => void;
}) {
  const [internalLang, setInternalLang] = useState<Language>(() => language || readInitialLang());

  useEffect(() => {
    if (language && language !== internalLang) setInternalLang(language);
  }, [language]);

  const dir: 'ltr' | 'rtl' = RTL_LANGS.includes(internalLang) ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.dir = dir;
    document.documentElement.lang = internalLang;
  }, [dir, internalLang]);

  const setLang = useCallback(
    (next: Language) => {
      setInternalLang(next);
      try {
        localStorage.setItem('omnipos_language', next);
      } catch {
        /* ignore */
      }
      onLanguageChange?.(next);
    },
    [onLanguageChange],
  );

  const t = useCallback(
    (key: string, fallback?: string) => {
      const row = dictionary[internalLang] || {};
      const enRow = dictionary.en || {};
      return row[key] ?? enRow[key] ?? fallback ?? key;
    },
    [internalLang],
  );

  const value = useMemo<I18nContextValue>(() => ({ lang: internalLang, setLang, t, dir }), [internalLang, setLang, t, dir]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return ctx;
}
