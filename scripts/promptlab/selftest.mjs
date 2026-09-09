// Feeds the checker known-bad and known-good sentences so a change to the
// rules can't silently stop catching the thing it was written for.
import { writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const OUT = 'scripts/promptlab/out';
const L = 'ZSELFTEST';

const prompt = [
  '📏 קנה מידה של הקבוצה: ניצחון חציוני 85 ש"ח, ניצחון גדול מתחיל ב-248 ש"ח, רצף נחשב ארוך מ-4 נצחונות ומעלה',
  '══ פלוני (זכר) ══',
  'היסטוריה כוללת: 50 משחקים',
  '⭐ טבלת חציון שני 2026: מקום #5, הניצחון הגדול ביותר בחציון שני 2026: ‎+379',
  'שיא אישי כל הזמנים (הניצחון הגדול ביותר שלו אי־פעם): ‎+703',
  'זווית מוצעת: כלום',
].join('\n');

const cases = [
  ['superlative on a 3-win streak', 'רוכב על רצף של שלושה נצחונות מרשימים לקראת הערב', true],
  ['superlative on a below-bar win', 'רשם ניצחון אדיר של 70 שקלים במשחק האחרון', true],
  ['bare שיא on the half-year best', 'אחרי שקבע שיא של 379 שקלים הוא מגיע בטוח בעצמו', true],
  ['spelled-out numeral', 'עם מאתיים ארבעים וחמישה משחקים הוא המנוסה בחבורה', true],
  ['sign collision', 'ממוצע ‎+-4 בכל הזמנים מלווה אותו לשולחן', true],
  ['legit superlative on a big number', 'עם רווח דמיוני של 14,165 שקלים הוא מוביל בכל הזמנים', false],
  ['period-scoped record', 'שיא חציוני של 379 שקלים נרשם לו במשחק האחרון', false],
  ['plain factual line', 'רשם ניצחון של 70 שקלים במשחק האחרון ועלה למקום החמישי', false],
  // Real false positives the first live run produced.
  ['"historical average" is not a superlative', 'ממוצע חציוני של 115 שקלים, פי כמה מהממוצע ההיסטורי שלו', false],
  ['"first time in history" is not a superlative', 'המפגש הזה יפגיש לראשונה בהיסטוריה את סמי ומאור בולו', false],
  ['superlative on a strong per-game average', 'המארח מחזיק בממוצע ביתי מרשים של 109 שקלים למשחק', false],
  ['adjective attaches to the big number in range', 'רצף שלושה נצחונות, כולל שיא חציוני מרשים של 379 שקלים', false],
  ['"negative records" is not a record claim', 'סגל רשם שיאים שליליים במשחק האחרון עם 18 שקלים בלבד', false],
  ['superlative modifying consistency, not the amount', 'שומר על יציבות מרשימה אחרי ניצחון של 33 שקלים במשחק האחרון', false],
];

let bad = 0;
for (const [name, sentence, shouldFail] of cases) {
  writeFileSync(`${OUT}/${L}.call1.m.prompt.txt`, prompt, 'utf8');
  writeFileSync(`${OUT}/${L}.call1.m.raw.txt`, 'live', 'utf8');
  writeFileSync(`${OUT}/${L}.result.json`, JSON.stringify([{ name: 'פלוני', highlight: '', sentence, preGameTeaser: '' }]), 'utf8');

  let out = '';
  try {
    out = execSync('node scripts/promptlab/check.mjs', { encoding: 'utf8' });
  } catch (e) {
    out = e.stdout || '';
  }
  const flagged = out.includes(`${L}.result.json`);
  const ok = flagged === shouldFail;
  if (!ok) bad++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${shouldFail ? 'should flag  ' : 'should accept'}  ${name}`);
}

for (const f of readdirSync(OUT).filter(x => x.startsWith(L))) unlinkSync(`${OUT}/${f}`);
console.log(bad ? `\n${bad} checker case(s) wrong` : '\nchecker behaves correctly on all cases');
process.exit(bad ? 1 : 0);
