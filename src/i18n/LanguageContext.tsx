import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { translations, type TranslationKey } from './translations';
import { getSettings } from '../database/storage';

type Language = 'he' | 'en';

interface LanguageContextValue {
  language: Language;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  isRTL: boolean;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: 'he',
  t: (key: TranslationKey) => translations.he[key] || key,
  isRTL: true,
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const settings = getSettings();
  const language: Language = settings.language || 'he';

  const value = useMemo<LanguageContextValue>(() => {
    const dict = translations[language];
    return {
      language,
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
  }, [language]);

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
