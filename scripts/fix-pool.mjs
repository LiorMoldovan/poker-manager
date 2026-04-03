/**
 * Pool Fix Script — Fixes known issues and adds nearMiss flags
 * Run: node scripts/fix-pool.mjs
 */

import { readFileSync, writeFileSync } from 'fs';

const POOL_PATH = './public/training-pool.json';
const pool = JSON.parse(readFileSync(POOL_PATH, 'utf-8'));

let fixCount = 0;
let removeCount = 0;
let nearMissCount = 0;

// ═══════════ Fix: kg5am3 — placeholder text ═══════════
const kg5am3 = pool.scenarios.find(s => s.poolId === 'kg5am3');
if (kg5am3) {
  // Situation says "חצי קופה" — let's estimate: pot is ~2000 on the turn
  // with 3 spades on board and A♠ in hand, half pot call is reasonable
  kg5am3.options[1].text = 'קריאה 1,000';  // was "קריאה [סכום ההימור]"
  kg5am3.options[2].text = 'העלאה ל-3,000'; // was "העלאה [סכום]"
  // Fix situation to specify pot size
  kg5am3.situation = 'הגעת לטרן (הקלף הרביעי). על השולחן יש 3 קלפי פיק. יש לך אס פיק ו-5 לבבות. הקופה 2,000 והיריב מהמר 1,000.';
  console.log('✏️ Fixed kg5am3: replaced placeholder text with actual amounts');
  fixCount++;
}

// ═══════════ Fix: hnocjq — bluff as correct answer in home game ═══════════
const hnocjq = pool.scenarios.find(s => s.poolId === 'hnocjq');
if (hnocjq) {
  // In a home game, a big bluff (3000 into 1200) is too risky — players call.
  // But against a truly conservative player, it CAN work. Let's make the bluff a nearMiss
  // and change the correct answer to fold (cutting losses with nothing)
  // Actually, re-reading: it says the opponent is "שחקן שמרני שפוחד מאוד מהמלך שיצא בנהר"
  // In a home game, even conservative players might call with 7-pair or 8-pair for 3000.
  // The correct play with 4-5 (nothing) is actually fold.
  hnocjq.options[0].isCorrect = false; // Was: bet 3000 (correct)
  hnocjq.options[0].nearMiss = true;   // GTO-valid bluff
  hnocjq.options[0].explanation = 'במשחק מקצועי, הימור שמייצג את המלך הוא מהלך מעולה. אבל במשחק ביתי, גם שחקנים שמרנים נוטים לקרוא כשהם לא בטוחים — ולסכן 3,000 שקלים בלוף על קופה של 1,200 זו סכנה גדולה מדי.';
  hnocjq.options[2].isCorrect = true;  // Fold — cut losses
  hnocjq.options[2].explanation = 'אין לך כלום — 4 ו-5 בלי זוג, בלי סיכוי. במשחק ביתי, ויתור הוא הבחירה הנכונה כשהיד שלך ריקה והסיכון גבוה. לפעמים ויתור חכם חוסך לך כסף למצבים טובים יותר.';
  console.log('✏️ Fixed hnocjq: changed correct answer from big bluff to fold (home game)');
  fixCount++;
}

// ═══════════ Fix: 2rx4x4 — bottom-end straight overbet ═══════════
const rxq = pool.scenarios.find(s => s.poolId === '2rx4x4');
if (rxq) {
  // Board: 6♥ 7♥ 8♣ 9♦ 2♠, Hand: 5♠ 4♠ → straight 5-6-7-8-9
  // This is the BOTTOM end of the straight — any 10 beats it.
  // Overbet 9000 is risky against aggressive player who may have higher straight.
  // Correct answer should be a medium value bet, not a massive overbet.
  rxq.options[0].isCorrect = true;  // Bet 1,500 — reasonable value bet
  rxq.options[0].explanation = 'יש לך רצף, אבל הוא הנמוך ביותר האפשרי (5-9). כל שחקן עם 10 מנצח אותך. הימור ערך בינוני מאפשר לך להרוויח מידיים חלשות יותר בלי לסכן יותר מדי אם ליריב יש רצף גבוה יותר.';
  rxq.options[1].isCorrect = false; // Overbet 9,000 — too risky
  rxq.options[1].nearMiss = true;   // GTO-valid against certain ranges
  rxq.options[1].explanation = 'במשחק מקצועי, הימור ענק יכול לעבוד כי שחקנים מזהים שאתה מסתכן. אבל במשחק ביתי, שחקן אגרסיבי שאוהב לקרוא ישמח לשלם 9,000 אם יש לו 10 (רצף גבוה יותר). הרצף שלך הוא הנמוך ביותר — אל תשים את כל הכסף בסכנה.';
  console.log('✏️ Fixed 2rx4x4: bottom-end straight — changed from overbet to medium value bet');
  fixCount++;
}

// ═══════════ Add nearMiss flags to ALL scenarios ═══════════
for (const s of pool.scenarios) {
  for (const opt of s.options) {
    if (opt.isCorrect) continue;
    if (opt.nearMiss) continue; // Already set
    
    const text = (opt.text + ' ' + (opt.explanation || '')).toLowerCase();
    const situation = (s.situation || '').toLowerCase();
    
    // Heuristic: mark as nearMiss if the wrong answer involves:
    // 1. A professional-style play (bluff, check-raise, representing)
    let isNearMiss = false;
    
    // Raise/re-raise on a draw — GTO semi-bluff, bad in home game
    if (text.includes('העלאה') && (text.includes('בלוף') || text.includes('ייצג') || text.includes('מייצג') || text.includes('הפחיד') || text.includes('לייצג'))) {
      isNearMiss = true;
    }
    
    // Check-raise — sophisticated play, doesn't work well in home games
    if (text.includes('צ\'ק-רייז') || text.includes('צ\'ק ואז להעלות') || (text.includes('צ\'ק') && text.includes('להעלות'))) {
      isNearMiss = true;
    }
    
    // Big bluff — GTO valid, but players call in home games
    if ((text.includes('בלוף') || text.includes('להבריח') || text.includes('מנסה לגנוב')) && !text.includes('קטן')) {
      isNearMiss = true;
    }
    
    // Fold a decent hand due to GTO considerations (folding top pair, medium pair when facing aggression)
    // This is harder to detect — skip for now
    
    // Overbet as bluff
    if (text.includes('הימור ענק') && text.includes('נראה כמו')) {
      isNearMiss = true;
    }
    
    // Professional-level reads: "representing", "image", "table image"
    if (text.includes('מייצג') || text.includes('לייצג') || text.includes('דימוי')) {
      isNearMiss = true;
    }
    
    // Semi-bluff raise
    if ((text.includes('סיכוי') || text.includes('משיכה') || text.includes('דרו')) && text.includes('העלאה')) {
      isNearMiss = true;
    }
    
    // Explanation says "in professional poker" or "GTO"
    if (text.includes('מקצועי') || text.includes('gto') || text.includes('טורניר')) {
      isNearMiss = true;
    }
    
    if (isNearMiss) {
      opt.nearMiss = true;
      nearMissCount++;
    }
  }
}

// ═══════════ Remove broken scenarios (if any) ═══════════
const toRemove = new Set();
for (const s of pool.scenarios) {
  // Check for structural issues
  const correctCount = s.options.filter(o => o.isCorrect).length;
  if (correctCount !== 1) {
    console.log(`🗑 Removing ${s.poolId}: ${correctCount} correct answers`);
    toRemove.add(s.poolId);
    removeCount++;
  }
  if (s.options.length !== 3) {
    console.log(`🗑 Removing ${s.poolId}: ${s.options.length} options`);
    toRemove.add(s.poolId);
    removeCount++;
  }
}

// Build corrected pool
const correctedScenarios = pool.scenarios.filter(s => !toRemove.has(s.poolId));
const correctedPool = {
  generatedAt: new Date().toISOString(),
  totalScenarios: correctedScenarios.length,
  byCategory: {},
  scenarios: correctedScenarios,
};
correctedScenarios.forEach(s => {
  correctedPool.byCategory[s.categoryId] = (correctedPool.byCategory[s.categoryId] || 0) + 1;
});

writeFileSync(POOL_PATH, JSON.stringify(correctedPool, null, 2));
console.log(`\n${'='.repeat(50)}`);
console.log(`Pool fixed and saved to ${POOL_PATH}`);
console.log(`  Fixed: ${fixCount} questions`);
console.log(`  Removed: ${removeCount} questions`);
console.log(`  nearMiss flags added: ${nearMissCount}`);
console.log(`  Total scenarios: ${correctedPool.totalScenarios}`);
