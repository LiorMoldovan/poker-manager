import { createContext, useContext, useState, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import { translations, type TranslationKey } from './translations';
import { getSettings } from '../database/storage';

type Language = 'he' | 'en';

interface LanguageContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  isRTL: boolean;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: 'he',
  setLanguage: () => {},
  t: (key: TranslationKey) => translations.he[key] || key,
  isRTL: true,
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => getSettings().language || 'he');

  useEffect(() => {
    const handler = () => {
      const lang = getSettings().language || 'he';
      setLanguageState(lang);
    };
    window.addEventListener('supabase-cache-updated', handler);
    return () => window.removeEventListener('supabase-cache-updated', handler);
  }, []);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
  }, []);

  const value = useMemo<LanguageContextValue>(() => {
    const dict = translations[language];
    return {
      language,
      setLanguage,
      isRTL: language === 'he',
      t: (key: TranslationKey, params?: Record<string, string | number>) => {
        let text = dict[key] || translations.he[key] || key;
        if (params) {
          for (const [k, v] of Object.entries(params)) {
            text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
          }
        }
        return text;
      },
    };
  }, [language, setLanguage]);

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useTranslation() {
  return useContext(LanguageContext);
}

export { LanguageContext };
export type { Language };
