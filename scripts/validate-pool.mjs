const GH = process.env.GH_TOKEN;

async function getGitHubFile(path) {
  const resp = await fetch(`https://api.github.com/repos/LiorMoldovan/poker-manager/contents/${path}`, {
    headers: { Authorization: `token ${GH}` }
  });
  const d = await resp.json();
  return JSON.parse(Buffer.from(d.content, 'base64').toString());
}

const VALID_SUITS = ['♠', '♥', '♦', '♣'];
const VALID_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const VALID_CATEGORIES = [
  'זוג עליון על לוח מסוכן', 'לתפוס בלוף', 'הרבה שחקנים בקופה', 'זוגות בינוניים',
  'פתיחה לפני הפלופ', 'מישהו העלה לפניך', 'יד חזקה על לוח מסוכן', 'משחק איטי',
  'חסר קלף לצבע', 'המשך הימור', "צ'ק ואז העלאה", 'קופות עם העלאה חוזרת',
  'לחיצה ובידוד', 'הגנה מהבליינד', 'גודל הערימה', 'ניצול מיקום', 'הימור ענק',
  'חיפוש שלישייה', 'חסר קלף לסדרה', 'פספסת את הקלף', 'ידיים שנראות טוב אבל מסוכנות',
  'זוג שני', 'סחיטת ערך', 'האם כדאי לקרוא?', 'אחוזים וסיכויים', 'נכון או לא'
];

function parseCard(str) {
  str = str.trim();
  for (const suit of VALID_SUITS) {
    if (str.endsWith(suit)) {
      const rank = str.slice(0, -1);
      if (VALID_RANKS.includes(rank)) return { rank, suit, raw: str };
    }
  }
  return null;
}

function parseCards(text) {
  if (!text) return [];
  const cards = [];
  const parts = text.split(/[\s,.-]+/);
  for (const p of parts) {
    const c = parseCard(p);
    if (c) cards.push(c);
  }
  return cards;
}

function extractBoardCards(situation) {
  const boardPatterns = [
    /(?:הלוח|הפלופ|הטרן|הנהר|הבורד|board|flop|turn|river)[\s:]*(?:הוא|מגיע|מראה|:)?\s*((?:[2-9JQKA]|10)[♠♥♦♣][\s,-]*(?:[2-9JQKA]|10)[♠♥♦♣][\s,-]*(?:[2-9JQKA]|10)[♠♥♦♣](?:[\s,-]*(?:[2-9JQKA]|10)[♠♥♦♣])*)/gi
  ];
  const cards = [];
  for (const pat of boardPatterns) {
    let m;
    while ((m = pat.exec(situation)) !== null) {
      cards.push(...parseCards(m[1]));
    }
  }
  return cards;
}

console.log('═══ Fetching pool ═══');
const pool = await getGitHubFile('public/training-pool.json');
const scenarios = pool.scenarios || [];
console.log(`Pool: ${scenarios.length} scenarios\n`);

const issues = {
  missingFields: [],
  wrongOptionCount: [],
  noCorrectAnswer: [],
  multipleCorrect: [],
  shekelMention: [],
  invalidCategory: [],
  duplicateCards: [],
  duplicateIds: [],
  missingYourCards: [],
  cardsInSituation: [],
  emptyExplanation: [],
  tooLongSituation: []
};

const idSet = new Set();
let totalIssues = 0;

for (const sc of scenarios) {
  const scIssues = [];

  // Duplicate ID
  if (idSet.has(sc.id)) {
    issues.duplicateIds.push(sc.id);
    scIssues.push('duplicate ID');
  }
  idSet.add(sc.id);

  // Missing fields
  if (!sc.situation || !sc.options) {
    issues.missingFields.push(sc.id);
    scIssues.push('missing fields');
    continue;
  }

  // Invalid category
  if (!VALID_CATEGORIES.includes(sc.category)) {
    issues.invalidCategory.push({ id: sc.id, cat: sc.category });
    scIssues.push(`invalid category: ${sc.category}`);
  }

  // Option count
  if (sc.options.length !== 3) {
    issues.wrongOptionCount.push({ id: sc.id, count: sc.options.length });
    scIssues.push(`${sc.options.length} options`);
  }

  // Correct answer count
  const correctCount = sc.options.filter(o => o.isCorrect).length;
  if (correctCount === 0) {
    issues.noCorrectAnswer.push(sc.id);
    scIssues.push('no correct answer');
  }
  if (correctCount > 1) {
    issues.multipleCorrect.push(sc.id);
    scIssues.push('multiple correct');
  }

  // Shekel mentions
  const allText = sc.situation + sc.options.map(o => `${o.text} ${o.explanation || ''}`).join(' ');
  if (allText.includes('שקל') || allText.includes('₪')) {
    issues.shekelMention.push(sc.id);
    scIssues.push('shekel mention');
  }

  // Missing yourCards (skip for true/false)
  if (sc.category !== 'נכון או לא' && (!sc.yourCards || sc.yourCards.trim() === '')) {
    issues.missingYourCards.push(sc.id);
    scIssues.push('missing yourCards');
  }

  // Duplicate cards (yourCards vs board)
  if (sc.yourCards) {
    const handCards = parseCards(sc.yourCards);
    const boardCards = extractBoardCards(sc.situation);
    const allCards = [...handCards, ...boardCards];
    const cardStrings = allCards.map(c => c.raw);
    const uniqueCards = new Set(cardStrings);
    if (uniqueCards.size < cardStrings.length) {
      issues.duplicateCards.push({ id: sc.id, cards: cardStrings.filter((c, i) => cardStrings.indexOf(c) !== i) });
      scIssues.push('duplicate cards');
    }
  }

  // Empty explanations
  for (const opt of sc.options) {
    if (!opt.explanation || opt.explanation.trim().length < 5) {
      issues.emptyExplanation.push({ id: sc.id, optId: opt.id });
      scIssues.push(`empty explanation for ${opt.id}`);
      break;
    }
  }

  // Too long situation
  if (sc.situation.length > 300) {
    issues.tooLongSituation.push({ id: sc.id, len: sc.situation.length });
    scIssues.push(`situation too long (${sc.situation.length} chars)`);
  }

  if (scIssues.length > 0) totalIssues++;
}

console.log('═══ Validation Results ═══\n');
console.log(`Total scenarios: ${scenarios.length}`);
console.log(`Scenarios with issues: ${totalIssues}`);
console.log();

const issueTypes = [
  ['Missing fields', issues.missingFields.length],
  ['Wrong option count (!= 3)', issues.wrongOptionCount.length],
  ['No correct answer', issues.noCorrectAnswer.length],
  ['Multiple correct answers', issues.multipleCorrect.length],
  ['Shekel mentions', issues.shekelMention.length],
  ['Invalid category', issues.invalidCategory.length],
  ['Duplicate cards (hand vs board)', issues.duplicateCards.length],
  ['Duplicate IDs', issues.duplicateIds.length],
  ['Missing yourCards', issues.missingYourCards.length],
  ['Empty explanation', issues.emptyExplanation.length],
  ['Too long situation (>300 chars)', issues.tooLongSituation.length],
];

for (const [name, count] of issueTypes) {
  const status = count === 0 ? '✅' : '❌';
  console.log(`  ${status} ${name}: ${count}`);
}

// Print details for non-zero issues
console.log('\n═══ Details ═══');
if (issues.wrongOptionCount.length > 0) {
  console.log('\nWrong option counts:');
  issues.wrongOptionCount.forEach(i => console.log(`  ${i.id}: ${i.count} options`));
}
if (issues.noCorrectAnswer.length > 0) {
  console.log('\nNo correct answer:');
  issues.noCorrectAnswer.forEach(id => {
    const sc = scenarios.find(s => s.id === id);
    console.log(`  ${id}: ${sc?.situation?.slice(0, 60)}...`);
  });
}
if (issues.multipleCorrect.length > 0) {
  console.log('\nMultiple correct:');
  issues.multipleCorrect.forEach(id => console.log(`  ${id}`));
}
if (issues.shekelMention.length > 0) {
  console.log('\nShekel mentions:');
  issues.shekelMention.forEach(id => {
    const sc = scenarios.find(s => s.id === id);
    const text = sc.situation + sc.options.map(o => o.text + ' ' + (o.explanation||'')).join(' ');
    const match = text.match(/.{0,30}(?:שקל|₪).{0,30}/);
    console.log(`  ${id}: ...${match?.[0]}...`);
  });
}
if (issues.invalidCategory.length > 0) {
  console.log('\nInvalid categories:');
  issues.invalidCategory.forEach(i => console.log(`  ${i.id}: "${i.cat}"`));
}
if (issues.duplicateCards.length > 0) {
  console.log('\nDuplicate cards:');
  issues.duplicateCards.forEach(i => console.log(`  ${i.id}: ${i.cards.join(', ')}`));
}
if (issues.missingYourCards.length > 0) {
  console.log('\nMissing yourCards:');
  issues.missingYourCards.slice(0, 10).forEach(id => {
    const sc = scenarios.find(s => s.id === id);
    console.log(`  ${id} (${sc?.category}): ${sc?.situation?.slice(0, 60)}...`);
  });
  if (issues.missingYourCards.length > 10) console.log(`  ... and ${issues.missingYourCards.length - 10} more`);
}
if (issues.emptyExplanation.length > 0) {
  console.log('\nEmpty explanations:');
  issues.emptyExplanation.slice(0, 5).forEach(i => console.log(`  ${i.id} option ${i.optId}`));
  if (issues.emptyExplanation.length > 5) console.log(`  ... and ${issues.emptyExplanation.length - 5} more`);
}
if (issues.tooLongSituation.length > 0) {
  console.log('\nToo long situations:');
  issues.tooLongSituation.slice(0, 5).forEach(i => console.log(`  ${i.id}: ${i.len} chars`));
  if (issues.tooLongSituation.length > 5) console.log(`  ... and ${issues.tooLongSituation.length - 5} more`);
}

// Category distribution
console.log('\n═══ Category Distribution ═══');
const catDist = {};
scenarios.forEach(s => { catDist[s.category] = (catDist[s.category] || 0) + 1; });
Object.entries(catDist).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
  console.log(`  ${count.toString().padStart(3)} ${cat}`);
});

// Player name coverage
const names = ['ליאור','אייל','חרדון','דן מאן','אורן','מלמד','סגל','תומר','פאבל','פיליפ','ליכטר'];
const withNames = scenarios.filter(s => names.some(n => s.situation.includes(n))).length;
console.log(`\nPlayer name coverage: ${withNames}/${scenarios.length} (${(withNames/scenarios.length*100).toFixed(1)}%)`);

const nameDist = {};
names.forEach(n => { nameDist[n] = scenarios.filter(s => s.situation.includes(n)).length; });
Object.entries(nameDist).sort((a, b) => b[1] - a[1]).forEach(([name, count]) => {
  console.log(`  ${count.toString().padStart(3)} ${name}`);
});

console.log(`\n${totalIssues === 0 ? '✅ ALL VALIDATIONS PASSED' : `❌ ${totalIssues} scenarios with issues`}`);
