import { createContext, useContext, useState, useMemo, useCallback, type ReactNode } from 'react';
import { translations, type TranslationKey } from './translations';

type Language = 'he' | 'en';

const LANG_STORAGE_KEY = 'poker_user_language';

function getStoredLanguage(): Language {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    if (stored === 'en' || stored === 'he') return stored;
  } catch { /* localStorage unavailable */ }
  return 'he';
}

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
  const [language, setLanguageState] = useState<Language>(getStoredLanguage);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    try { localStorage.setItem(LANG_STORAGE_KEY, lang); } catch { /* ignore */ }
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
