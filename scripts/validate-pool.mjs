/**
 * Deterministic Poker Logic Validator
 * Checks all pool questions for poker mistakes WITHOUT using AI
 * 
 * Catches:
 * - Hands that form straights/flushes/full houses not recognized
 * - Impossible card combinations (duplicates)
 * - Betting action inconsistencies
 * - Missing amounts, placeholder text
 * - English terms
 * - Unrealistic chip amounts
 */

import { readFileSync, writeFileSync } from 'fs';

const POOL_PATH = './public/training-pool.json';
const pool = JSON.parse(readFileSync(POOL_PATH, 'utf-8'));

// Card parsing utilities
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
const SUITS = { '♠': 'spades', '♣': 'clubs', '♥': 'hearts', '♦': 'diamonds', '♤': 'spades', '♧': 'clubs', '♡': 'hearts', '♢': 'diamonds' };
const SUIT_CHARS = Object.keys(SUITS);

function parseCards(text) {
  if (!text) return [];
  const cards = [];
  // Match patterns like "A♠", "10♦", "K♣", etc.
  const regex = /(10|[2-9JQKA])\s*([♠♣♥♦♤♧♡♢])/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    cards.push({ rank: match[1], suit: match[2], value: RANK_VALUES[match[1]] });
  }
  return cards;
}

function extractBoardCards(situation) {
  // Look for board/flop/turn/river descriptions
  const cards = parseCards(situation);
  return cards;
}

function hasStraight(cards) {
  if (cards.length < 5) return false;
  const values = [...new Set(cards.map(c => c.value))].sort((a, b) => a - b);
  // Check for A-low straight (A,2,3,4,5)
  if (values.includes(14)) values.unshift(1);
  
  for (let i = 0; i <= values.length - 5; i++) {
    let consecutive = 1;
    for (let j = i + 1; j < values.length && consecutive < 5; j++) {
      if (values[j] === values[j-1] + 1) consecutive++;
      else if (values[j] !== values[j-1]) break;
    }
    if (consecutive >= 5) return true;
  }
  
  // Also check any 5-card window
  for (let i = 0; i <= values.length - 5; i++) {
    if (values[i + 4] - values[i] === 4) {
      const window = values.slice(i, i + 5);
      if (new Set(window).size === 5) return true;
    }
  }
  
  return false;
}

function hasFlush(cards) {
  if (cards.length < 5) return false;
  const suitCounts = {};
  cards.forEach(c => {
    const suitName = SUITS[c.suit] || c.suit;
    suitCounts[suitName] = (suitCounts[suitName] || 0) + 1;
  });
  return Object.values(suitCounts).some(count => count >= 5);
}

function hasFlushDraw(cards) {
  if (cards.length < 4) return false;
  const suitCounts = {};
  cards.forEach(c => {
    const suitName = SUITS[c.suit] || c.suit;
    suitCounts[suitName] = (suitCounts[suitName] || 0) + 1;
  });
  return Object.values(suitCounts).some(count => count === 4);
}

function hasStraightDraw(cards) {
  const values = [...new Set(cards.map(c => c.value))].sort((a, b) => a - b);
  if (values.includes(14)) values.unshift(1);
  
  // Check for 4 cards within a span of 4 (open-ended) or 5 (gutshot)
  for (let i = 0; i <= values.length - 4; i++) {
    const span = values[i + 3] - values[i];
    if (span === 3) return 'oesd'; // Open-ended
    if (span === 4) return 'gutshot';
  }
  return false;
}

function hasThreeOfAKind(cards) {
  const rankCounts = {};
  cards.forEach(c => { rankCounts[c.rank] = (rankCounts[c.rank] || 0) + 1; });
  return Object.values(rankCounts).some(count => count >= 3);
}

function hasTwoPair(cards) {
  const rankCounts = {};
  cards.forEach(c => { rankCounts[c.rank] = (rankCounts[c.rank] || 0) + 1; });
  const pairs = Object.values(rankCounts).filter(count => count >= 2).length;
  return pairs >= 2;
}

function hasFullHouse(cards) {
  const rankCounts = {};
  cards.forEach(c => { rankCounts[c.rank] = (rankCounts[c.rank] || 0) + 1; });
  const counts = Object.values(rankCounts);
  return counts.some(c => c >= 3) && counts.filter(c => c >= 2).length >= 2;
}

function hasFourOfAKind(cards) {
  const rankCounts = {};
  cards.forEach(c => { rankCounts[c.rank] = (rankCounts[c.rank] || 0) + 1; });
  return Object.values(rankCounts).some(count => count >= 4);
}

function hasPair(cards) {
  const rankCounts = {};
  cards.forEach(c => { rankCounts[c.rank] = (rankCounts[c.rank] || 0) + 1; });
  return Object.values(rankCounts).some(count => count >= 2);
}

function hasDuplicateCards(cards) {
  const seen = new Set();
  for (const c of cards) {
    const key = `${c.rank}${SUITS[c.suit] || c.suit}`;
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return false;
}

function bestHandRank(cards) {
  if (cards.length < 5) return 'incomplete';
  if (hasFourOfAKind(cards)) return 'four_of_a_kind';
  if (hasFullHouse(cards)) return 'full_house';
  if (hasFlush(cards) && hasStraight(cards)) return 'straight_flush';
  if (hasFlush(cards)) return 'flush';
  if (hasStraight(cards)) return 'straight';
  if (hasThreeOfAKind(cards)) return 'three_of_a_kind';
  if (hasTwoPair(cards)) return 'two_pair';
  if (hasPair(cards)) return 'pair';
  return 'high_card';
}

const HAND_RANK_ORDER = {
  'straight_flush': 8,
  'four_of_a_kind': 7,
  'full_house': 6,
  'flush': 5,
  'straight': 4,
  'three_of_a_kind': 3,
  'two_pair': 2,
  'pair': 1,
  'high_card': 0,
  'incomplete': -1,
};

const HAND_NAMES_HEB = {
  'straight_flush': 'סטרייט פלאש',
  'four_of_a_kind': 'פור',
  'full_house': 'פול האוס',
  'flush': 'צבע',
  'straight': 'סטרייט',
  'three_of_a_kind': 'שלישייה',
  'two_pair': 'זוג כפול',
  'pair': 'זוג',
  'high_card': 'קלף גבוה',
};

// Main validation
const issues = [];

pool.scenarios.forEach((s, idx) => {
  const scenarioIssues = [];
  
  // 1. Structure checks
  if (s.options.length !== 3) scenarioIssues.push(`❌ ${s.options.length} options (need 3)`);
  const correctCount = s.options.filter(o => o.isCorrect).length;
  if (correctCount !== 1) scenarioIssues.push(`❌ ${correctCount} correct answers (need 1)`);
  if (!s.situation || s.situation.length < 20) scenarioIssues.push(`⚠️ Very short situation`);
  if (!s.yourCards) scenarioIssues.push(`❌ Missing yourCards`);
  
  // 2. Placeholder text
  const allText = s.situation + ' ' + s.options.map(o => o.text + ' ' + (o.explanation || '')).join(' ');
  if (allText.includes('[סכום]') || allText.includes('[סכום ההימור]')) scenarioIssues.push(`❌ Placeholder text found`);
  
  // 3. English terms
  const engTerms = ['equity', 'EV ', 'SPR', ' range', 'c-bet', 'semi-bluff', 'value bet', 'fold equity', 'implied odds', 'pot odds', 'ICM', 'GTO', 'bluff catcher'];
  engTerms.forEach(t => {
    if (allText.toLowerCase().includes(t.toLowerCase())) scenarioIssues.push(`⚠️ English term: "${t.trim()}"`);
  });
  
  // 4. Dollar references
  if (allText.includes('$') || allText.includes('דולר')) scenarioIssues.push(`❌ Dollar reference`);
  
  // 5. Parse cards for poker logic
  const handCards = parseCards(s.yourCards);
  const allCards = extractBoardCards(s.situation);
  
  // Combine hand + all cards mentioned in situation
  // The situation text contains both hand cards and board cards
  // yourCards are explicitly stated, board cards are in the situation
  const boardCards = allCards.filter(ac => !handCards.some(hc => hc.rank === ac.rank && SUITS[hc.suit] === SUITS[ac.suit]));
  const combinedCards = [...handCards, ...boardCards];
  
  // 5a. Duplicate cards
  const dupe = hasDuplicateCards(combinedCards);
  if (dupe) scenarioIssues.push(`❌ Duplicate card: ${dupe}`);
  
  // 5b. Check actual hand strength
  if (combinedCards.length >= 5) {
    const hand = bestHandRank(combinedCards);
    const handRank = HAND_RANK_ORDER[hand];
    const handName = HAND_NAMES_HEB[hand] || hand;
    
    // Check if situation mentions the hand is weak/risky but actually it's strong
    const correctOpt = s.options.find(o => o.isCorrect);
    const correctText = (correctOpt?.text || '').toLowerCase();
    const correctExpl = (correctOpt?.explanation || '');
    
    // Flag: has straight or better but correct answer is fold/check
    if (handRank >= 4 && correctText.includes('ויתור')) {
      scenarioIssues.push(`🚨 CRITICAL: Player has ${handName} but correct answer is FOLD!`);
    }
    
    // Flag: has flush or better but situation says "risky" or "dangerous"
    if (handRank >= 5) {
      if (s.situation.includes('מסוכן') || s.situation.includes('מפחיד')) {
        scenarioIssues.push(`🚨 CRITICAL: Player has ${handName} but situation says board is dangerous FOR THEM`);
      }
    }
    
    // Flag: has straight but mentioned as "draw" or "need one more card"
    if (hand === 'straight' && (allText.includes('חסר קלף') || allText.includes('סיכוי') || allText.includes('ציפייה'))) {
      scenarioIssues.push(`🚨 CRITICAL: Player already HAS a straight but text suggests they're drawing to it`);
    }
    
    // Flag: has flush but text says "flush draw"
    if (hand === 'flush' && (allText.includes('חסר קלף לצבע') || allText.includes('סיכוי לצבע'))) {
      scenarioIssues.push(`🚨 CRITICAL: Player already HAS a flush but text suggests they're drawing to it`);
    }
    
    // Flag: very strong hand (trips+) but correct answer suggests weakness
    if (handRank >= 3 && correctExpl.includes('חלשה') && !correctExpl.includes('לא חלשה')) {
      scenarioIssues.push(`⚠️ Player has ${handName} but explanation says hand is weak`);
    }
    
    // Info: log hand for manual review
    if (handRank >= 4) {
      scenarioIssues.push(`ℹ️ Strong hand detected: ${handName} (${combinedCards.map(c=>c.rank+c.suit).join(' ')})`);
    }
  }
  
  // 6. Betting logic checks
  s.options.forEach(o => {
    // Call without amount
    if (o.text.includes('קריאה') && !/\d/.test(o.text)) {
      scenarioIssues.push(`⚠️ "${o.text}" — call without amount`);
    }
    // Raise without amount
    if (o.text.includes('העלאה') && !/\d/.test(o.text)) {
      scenarioIssues.push(`⚠️ "${o.text}" — raise without amount`);
    }
    // Bet without amount
    if (o.text === 'הימור' || (o.text.includes('הימור') && !/\d/.test(o.text) && !o.text.includes('הימור ערך'))) {
      // Only flag if it's just "הימור" without a number
      if (!/\d/.test(o.text)) scenarioIssues.push(`⚠️ "${o.text}" — bet without amount`);
    }
  });
  
  // 7. Check for home-game context issues
  const correctOpt = s.options.find(o => o.isCorrect);
  if (correctOpt) {
    const ct = correctOpt.text + ' ' + (correctOpt.explanation || '');
    // Correct answer relies on sophisticated opponent reads
    if (ct.includes('מייצג') || ct.includes('representation') || ct.includes('הדימוי')) {
      scenarioIssues.push(`⚠️ Correct answer relies on opponent reading ability — may not work in home game`);
    }
    // Correct answer is a big bluff
    if ((ct.includes('בלוף') || ct.includes('bluff')) && (ct.includes('אול-אין') || ct.includes('all-in'))) {
      scenarioIssues.push(`⚠️ Correct answer is all-in bluff — risky for home game where players call`);
    }
  }
  
  // 8. Short/missing explanations
  s.options.forEach(o => {
    if (!o.explanation || o.explanation.length < 15) {
      scenarioIssues.push(`⚠️ Short explanation for option ${o.id}: "${o.explanation || '(empty)'}"`);
    }
  });
  
  if (scenarioIssues.length > 0) {
    issues.push({
      idx,
      poolId: s.poolId,
      category: s.categoryId,
      cards: s.yourCards,
      situation: s.situation.substring(0, 100),
      correctAnswer: s.options.find(o => o.isCorrect)?.text,
      issues: scenarioIssues,
    });
  }
});

// Report
const critical = issues.filter(i => i.issues.some(x => x.includes('CRITICAL')));
const warnings = issues.filter(i => !i.issues.some(x => x.includes('CRITICAL')) && i.issues.some(x => x.includes('❌') || x.includes('⚠️')));
const info = issues.filter(i => i.issues.every(x => x.includes('ℹ️')));

console.log(`\n${'='.repeat(60)}`);
console.log(`POOL VALIDATION REPORT`);
console.log(`${'='.repeat(60)}`);
console.log(`Total scenarios: ${pool.scenarios.length}`);
console.log(`🚨 CRITICAL issues: ${critical.length}`);
console.log(`⚠️  Warnings: ${warnings.length}`);
console.log(`ℹ️  Info (strong hands): ${info.length}`);

if (critical.length > 0) {
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`🚨 CRITICAL ISSUES (must fix):`);
  critical.forEach(i => {
    console.log(`\n  [${i.poolId}] ${i.category}`);
    console.log(`  Cards: ${i.cards}`);
    console.log(`  Situation: ${i.situation}...`);
    console.log(`  Correct: ${i.correctAnswer}`);
    i.issues.forEach(x => console.log(`    ${x}`));
  });
}

if (warnings.length > 0) {
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`⚠️ WARNINGS:`);
  warnings.forEach(i => {
    console.log(`\n  [${i.poolId}] ${i.category}`);
    console.log(`  Cards: ${i.cards}`);
    console.log(`  Correct: ${i.correctAnswer}`);
    i.issues.filter(x => !x.includes('ℹ️')).forEach(x => console.log(`    ${x}`));
  });
}

if (info.length > 0) {
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`ℹ️ Strong hands detected (verify correct answer makes sense):`);
  info.forEach(i => {
    console.log(`  [${i.poolId}] ${i.cards} → ${i.issues[0]}`);
  });
}

// Write full report
writeFileSync('./pool-validation-report.json', JSON.stringify({ critical, warnings, info, total: pool.scenarios.length }, null, 2));
console.log(`\nFull report saved to pool-validation-report.json`);
