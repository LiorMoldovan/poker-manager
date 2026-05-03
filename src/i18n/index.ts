export { LanguageProvider, useTranslation, LanguageContext } from './LanguageContext';
export type { Language } from './LanguageContext';
export type { TranslationKey } from './translations';

import type { TranslationKey } from './translations';

// Translate a chip-color name. The 6 default English colors (White/Red/Blue/
// Green/Black/Yellow) are translated to the active language; user-customized
// color names pass through unchanged so they aren't broken.
export function translateChipColor(
  color: string,
  t: (key: TranslationKey) => string,
): string {
  if (!color) return color;
  const key = color.trim().toLowerCase();
  switch (key) {
    case 'white':  return t('chips.color.white');
    case 'red':    return t('chips.color.red');
    case 'blue':   return t('chips.color.blue');
    case 'green':  return t('chips.color.green');
    case 'black':  return t('chips.color.black');
    case 'yellow': return t('chips.color.yellow');
    default:       return color;
  }
}
