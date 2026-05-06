// Hebrew gender-aware verb conjugation.
//
// Hebrew verbs change form based on the subject's gender — "ניצח" (won,
// male) vs "ניצחה" (won, female). Players have a `gender` field on the
// `Player` row, so we can produce the right form per player instead of
// the lazy "ניצח/ה" slash-form (which the user has explicitly asked us
// to stop using everywhere).
//
// Usage in any string-emitting code:
//   import { verbForName } from './hebrewGender';
//   const verb = verbForName('won', playerName, language);
//   t('home.trivia.mostWins', { name, verb, count });
//
// In translations, `{verb}` is just another placeholder. English keeps
// the same key shape — verbs are gender-invariant in English, so the
// helper returns the same form for both genders.

import type { PlayerGender } from '../types';
import type { Language } from '../i18n';
import { getAllPlayers } from '../database/storage';

// Looks up a player's gender by display name. Falls back to 'male'
// when the player isn't in the roster (guests sometimes appear in
// trivia / leaderboards without a Player row, and 'male' is the
// statistical default in this group). Caller can pre-resolve gender
// itself if it has the Player object handy — that avoids the lookup.
export function getPlayerGender(name: string | null | undefined): PlayerGender {
  if (!name) return 'male';
  const trimmed = name.trim();
  if (!trimmed) return 'male';
  const player = getAllPlayers().find(p => p.name === trimmed);
  return player?.gender ?? 'male';
}

// Verb table. Add new entries here when a new gendered string shows
// up in the codebase — keeps every conjugation in one auditable place.
//
// Keys are semantic (what the verb MEANS), not Hebrew literal strings,
// so the same `verb('won', …)` call works for present tense in
// Hebrew AND past tense in English without the caller knowing or
// caring which language is active.
//
// English forms are intentionally unisex; the columns exist only so
// the type stays symmetric with Hebrew.
type VerbForms = { male: string; female: string };
type LangVerbs = Record<VerbKey, VerbForms>;

const VERB_KEYS = [
  'won',         // ניצח / ניצחה
  'lost',        // הפסיד / הפסידה
  'joined',      // הצטרף / הצטרפה
  'sent',        // שלח / שלחה
  'opened',      // פתח / פתחה
  'confirmed',   // אישר / אישרה — RSVP yes
  'willUpdate',  // יעדכן / תעדכן — RSVP maybe
  'declined',    // סירב / סירבה — RSVP no
  'invited',     // מוזמן / מוזמנת — passive participle (invited to ...)
  'updateImp',   // עדכן / עדכני — imperative ("let us know")
  'completeImp', // השלם / השלימי — imperative ("complete the vote")
] as const;

export type VerbKey = typeof VERB_KEYS[number];

const VERBS: Record<Language, LangVerbs> = {
  he: {
    won:        { male: 'ניצח',    female: 'ניצחה' },
    lost:       { male: 'הפסיד',   female: 'הפסידה' },
    joined:     { male: 'הצטרף',   female: 'הצטרפה' },
    sent:       { male: 'שלח',     female: 'שלחה' },
    opened:     { male: 'פתח',     female: 'פתחה' },
    confirmed:   { male: 'אישר',    female: 'אישרה' },
    willUpdate:  { male: 'יעדכן',   female: 'תעדכן' },
    declined:    { male: 'סירב',    female: 'סירבה' },
    invited:     { male: 'מוזמן',   female: 'מוזמנת' },
    updateImp:   { male: 'עדכן',    female: 'עדכני' },
    completeImp: { male: 'השלם',    female: 'השלימי' },
  },
  en: {
    won:        { male: 'won',         female: 'won' },
    lost:       { male: 'lost',        female: 'lost' },
    joined:     { male: 'joined',      female: 'joined' },
    sent:       { male: 'sent',        female: 'sent' },
    opened:     { male: 'opened',      female: 'opened' },
    confirmed:   { male: 'confirmed',   female: 'confirmed' },
    willUpdate:  { male: 'will update', female: 'will update' },
    declined:    { male: 'declined',    female: 'declined' },
    invited:     { male: 'invited',     female: 'invited' },
    updateImp:   { male: 'let us know', female: 'let us know' },
    completeImp: { male: 'complete',    female: 'complete' },
  },
};

// Direct conjugation when you already have the gender on hand
// (e.g. you're iterating Player rows). Prefer this over `verbForName`
// to avoid the player-roster lookup.
export function verb(key: VerbKey, gender: PlayerGender, language: Language = 'he'): string {
  return VERBS[language][key][gender];
}

// Convenience: name → verb. Used at almost every callsite because we
// usually only have the display name, not the Player object.
export function verbForName(
  key: VerbKey,
  name: string | null | undefined,
  language: Language = 'he',
): string {
  return verb(key, getPlayerGender(name), language);
}
