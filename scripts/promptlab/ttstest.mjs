// Asserts the Hebrew TTS text pipeline. Covers both entry points:
//   fixHebrewForTTS — neural engines (Gemini / ElevenLabs), digits kept
//   prepareTTSText  — legacy engines (Edge / browser), digits spelled out
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [resolve(here, 'ttsbuild.mjs')], { stdio: 'inherit' });

const { fixHebrewForTTS, prepareTTSText } = await import(
  resolve(here, 'out', 'tts.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:')
);

let pass = 0;
const failures = [];

const check = (label, actual, { has = [], hasNot = [] }) => {
  const missing = has.filter(s => !actual.includes(s));
  const present = hasNot.filter(s => actual.includes(s));
  if (missing.length || present.length) {
    failures.push({ label, actual, missing, present });
  } else {
    pass++;
  }
};

const neural = (label, input, expect) => check(`[neural] ${label}`, fixHebrewForTTS(input), expect);
const legacy = (label, input, expect) => check(`[legacy] ${label}`, prepareTTSText(input), expect);

// ── Gender agreement on counts already written as words ────────────────────
neural('masculine count + feminine noun', 'שגיא כבר עם שלושה קניות הערב', {
  has: ['שלוש קניות'], hasNot: ['שלושה קניות'],
});
neural('feminine count + masculine noun', 'רצף של שלוש נצחונות', {
  has: ['שלושה נצחונות'], hasNot: ['שלוש נצחונות'],
});
neural('construct masculine → feminine', 'שני קניות בלבד', {
  has: ['שתי קניות'], hasNot: ['שני קניות'],
});
neural('five feminine', 'חמישה פעמים הערב', { has: ['חמש פעמים'] });
neural('nine masculine', 'תשע הפסדים ברצף', { has: ['תשעה הפסדים'] });
neural('prefixed count', 'הגיע לשלושה קניות', { has: ['לשלוש קניות'] });
neural('teens are not corrupted', 'שלוש עשרה קניות הערב', { has: ['שלוש עשרה קניות'] });
neural('correct text is left alone', 'חמש קניות ושלושה משחקים', {
  has: ['חמש קניות', 'שלושה משחקים'],
});

// ── Construct form fires on nouns, and only on nouns ───────────────────────
neural('construct before feminine noun', 'שתיים קניות הערב', { has: ['שתי קניות'] });
neural('construct before masculine noun', 'שניים משחקים ברצף', { has: ['שני משחקים'] });
neural('fraction keeps standalone form', 'כבר שתיים וחצי קניות', {
  has: ['שתיים וחצי'], hasNot: ['שתי וחצי'],
});
neural('non-noun keeps standalone form', 'ממוצע שתיים לערב', {
  has: ['שתיים לערב'], hasNot: ['שתי לערב'],
});

// ── Name pronunciation ─────────────────────────────────────────────────────
neural('bare name gets nikud', 'סגל מוביל הערב', { has: ['סֶגַל'], hasNot: ['סגאל'] });
neural('prefixed name gets nikud', 'הפער בין ליאור לסגל', { has: ['לסֶגַל'] });
neural('conjunction prefix', 'ליכטר וסגל ראש בראש', { has: ['וסֶגַל'] });
neural('common word is not touched', 'הסגל של הקבוצה', { has: ['הסגל'], hasNot: ['הסֶגַל'] });

// ── Digit shapes ───────────────────────────────────────────────────────────
neural('rank hyphen → ordinal', 'הוא במקום ה-10 בטבלה', {
  has: ['העשירי'], hasNot: ['ה-10'],
});
neural('rank hyphen mid-range', 'עלה למקום ה-6', { has: ['השישי'] });
neural('thousands separator', 'רווח של 1,200 שקלים', { has: ['1200'], hasNot: ['1,200'] });
neural('half with feminine noun', 'כבר 2.5 קניות', {
  has: ['שתיים וחצי קניות'], hasNot: ['שתי וחצי', 'נקודה'],
});
neural('other decimal', 'ממוצע 3.2 לערב', { has: ['שלוש נקודה שתיים'] });
neural('negative reads as word', 'סיים עם -50 שקלים', { has: ['מינוס 50'] });

// ── Legacy path still spells everything out ────────────────────────────────
legacy('digits → feminine words', '5 קניות הערב', { has: ['חמש קניות'] });
legacy('digits → masculine words', '3 משחקים', { has: ['שלושה משחקים'] });
legacy('thousands stay one number', 'רווח של 1,200 שקלים', {
  has: ['אלף'], hasNot: ['אחד מאתיים'],
});
legacy('rank ordinal survives', 'במקום ה-10', { has: ['העשירי'] });
legacy('word-gender safety net', 'שלושה קניות', { has: ['שלוש קניות'] });
legacy('name nikud survives', 'סגל עם 2 קניות', { has: ['סֶגַל', 'שתי קניות'] });

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${failures.length} failed\n`);
for (const f of failures) {
  console.log(`FAIL ${f.label}`);
  console.log(`  got: ${f.actual}`);
  if (f.missing.length) console.log(`  missing: ${f.missing.join(' | ')}`);
  if (f.present.length) console.log(`  should not contain: ${f.present.join(' | ')}`);
}
process.exit(failures.length ? 1 : 0);
