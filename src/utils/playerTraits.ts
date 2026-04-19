import type { PlayerTraits } from '../types';
import { getPlayerTraitsByName } from '../database/storage';

// Seed data for initial migration — these get written to DB on first load
export const SEED_TRAITS: Record<string, PlayerTraits> = {
  'ליאור': { job: 'הייטק', team: 'מכבי הרצליה', style: ['מחושב'], quirks: ['מנצח עם מעט קניות', 'שחקן אסטרטגי'] },
  'אייל': { job: 'פיננסים', team: 'הפועל פתח תקווה', style: ['אגרסיבי', 'בלופר'], quirks: ['אמרגן הקבוצה', 'מתאם את המשחקים', 'הולך למשחקים של הפועל פתח תקווה למרות שלא באמת אוהד'] },
  'ארז': { job: 'מהנדס בטיחות', style: ['מחושב', 'אגרסיבי'], quirks: ['צנח חופשי', 'מהנדס בטיחות שמסתכן'] },
  'אורן': { job: 'מס הכנסה', team: 'הפועל כפר סבא', style: ['אגרסיבי', 'מזלן'], quirks: ['אבא לתינוק חדש', 'תמיד עייף', 'טוען שאין לו מזל'] },
  'ליכטר': { job: 'רואה חשבון', team: 'הפועל כפר סבא', style: ['בלופר', 'אגרסיבי'], quirks: ['אוהב נרגילה'] },
  'סגל': { job: 'בוחן תוכנה', nickname: 'איוון סטיבן', style: ['שמרני'], quirks: ['תמיד יוצא באפס', 'לאחרונה התחיל להפסיד', 'שחקן הכי שמרני בשולחן'] },
  'תומר': { team: 'הפועל פתח תקווה', style: ['מזלן'], quirks: ['מהלכים מוזרים', 'אוהב חטיפים ועוגות', 'אף אחד לא מבין את המשחק שלו'] },
  'פיליפ': { job: 'מנהל מוצר', team: 'באיירן מינכן', style: ['בלופר', 'מזלן', 'רגשי'], quirks: ['מחפש עסקאות מפוקפקות', 'רגשי על השולחן'] },
  'אסף': { team: 'מכבי תל אביב', style: ['מחושב', 'אגרסיבי'], quirks: ['אבא לתינוק חדש'] },
  'פבל': { job: 'IT', style: ['רגשי', 'בלופר', 'מזלן'], quirks: ['אוהב לעשן', 'מכוניות מרוץ'] },
  'מלמד': { job: 'הייטק', style: ['מחושב'], quirks: ['משחק כדורעף', 'משחק פוקר כמו מחשבון'] },
};

export function getTraitsForPlayer(playerName: string): PlayerTraits | undefined {
  return getPlayerTraitsByName(playerName);
}

export const generateTraitMessages = (playerName: string): string[] => {
  const traits = getPlayerTraitsByName(playerName);
  if (!traits) return [];
  const msgs: string[] = [];
  const name = playerName;

  if (traits.job) {
    msgs.push(`${name} עובד ב${traits.job}, אבל הערב העבודה לא עוזרת`);
    msgs.push(`איש ה${traits.job} מקבל תוצאות לא צפויות הערב`);
  }
  if (traits.team) {
    msgs.push(`${name} אוהד ${traits.team}, הערב שניהם באותו מצב`);
    msgs.push(`${traits.team} ו${name} עם מסורת משותפת של ציפיות גבוהות`);
  }
  if (traits.nickname) {
    msgs.push(`${traits.nickname} קנה עוד אחד, מישהו יבדוק שזה באמת ${name}?`);
  }
  if (traits.style.length > 0) {
    const style = traits.style[0];
    msgs.push(`${name} ה${style} של השולחן, הערב הסגנון לא עובד`);
    if (traits.style.includes('בלופר')) {
      msgs.push(`הבלפן הרשמי של השולחן, הערב אפילו הבלוף לא עובד`);
    }
    if (traits.style.includes('אגרסיבי')) {
      msgs.push(`${name} אגרסיבי כרגיל, הערב רק אגרסיבי עם הארנק`);
    }
    if (traits.style.includes('שמרני')) {
      msgs.push(`השמרן של השולחן יצא מהכלוב, מה קרה ${name}?`);
    }
    if (traits.style.includes('מחושב')) {
      msgs.push(`${name} מחשב הכל, חוץ מהסיכוי שלו הערב`);
    }
  }
  if (traits.quirks.length > 0) {
    for (const quirk of traits.quirks.slice(0, 2)) {
      msgs.push(`${name} — ${quirk}, והערב זה לא משנה`);
    }
  }
  return msgs;
};
