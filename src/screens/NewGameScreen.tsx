import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Player, PlayerType, PlayerStats } from '../types';
import { getAllPlayers, addPlayer, createGame, getPlayerByName, getPlayerStats } from '../database/storage';

// Default location options
const LOCATION_OPTIONS = ['ליאור', 'סגל', 'ליכטר', 'אייל'];

const NewGameScreen = () => {
  const navigate = useNavigate();
  const [players, setPlayers] = useState<Player[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerType, setNewPlayerType] = useState<PlayerType>('guest');
  const [error, setError] = useState('');
  const [showPermanentGuests, setShowPermanentGuests] = useState(false);
  const [showGuests, setShowGuests] = useState(false);
  const [showForecast, setShowForecast] = useState(false);
  const [playerStats, setPlayerStats] = useState<PlayerStats[]>([]);
  const [gameLocation, setGameLocation] = useState<string>('');
  const [customLocation, setCustomLocation] = useState<string>('');

  useEffect(() => {
    loadPlayers();
  }, []);

  const loadPlayers = () => {
    setPlayers(getAllPlayers());
    setPlayerStats(getPlayerStats());
  };

  // Separate players by type
  const permanentPlayers = players.filter(p => p.type === 'permanent');
  const permanentGuestPlayers = players.filter(p => p.type === 'permanent_guest');
  const guestPlayers = players.filter(p => p.type === 'guest');

  const togglePlayer = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  // Select/Deselect only permanent players (dynamically based on player.type === 'permanent')
  const selectAll = () => {
    // Get IDs of players with type 'permanent' only
    const permanentIds = new Set(permanentPlayers.map(p => p.id));
    const allPermanentSelected = permanentPlayers.length > 0 && 
      permanentPlayers.every(p => selectedIds.has(p.id));
    
    if (allPermanentSelected) {
      // All permanent are selected - deselect ONLY permanent players
      setSelectedIds(prev => {
        const newSet = new Set<string>();
        // Keep only non-permanent selections
        prev.forEach(id => {
          if (!permanentIds.has(id)) {
            newSet.add(id);
          }
        });
        return newSet;
      });
    } else {
      // Select ONLY permanent players (replace current selection)
      setSelectedIds(new Set(permanentPlayers.map(p => p.id)));
    }
  };

  const handleAddPlayer = () => {
    const trimmedName = newPlayerName.trim();
    if (!trimmedName) {
      setError('Please enter a name');
      return;
    }
    
    if (getPlayerByName(trimmedName)) {
      setError('Player already exists');
      return;
    }

    const newPlayer = addPlayer(trimmedName, newPlayerType);
    setPlayers([...players, newPlayer]);
    setSelectedIds(new Set([...selectedIds, newPlayer.id]));
    setNewPlayerName('');
    setNewPlayerType('guest');
    setShowAddPlayer(false);
    setError('');
    // Expand the relevant section when adding
    if (newPlayerType === 'guest') {
      setShowGuests(true);
    } else if (newPlayerType === 'permanent_guest') {
      setShowPermanentGuests(true);
    }
  };

  const handleStartGame = () => {
    if (selectedIds.size < 2) {
      setError('Select at least 2 players');
      return;
    }
    
    // Use custom location if "other" is selected, otherwise use selected location
    const location = gameLocation === 'other' ? customLocation.trim() : gameLocation;
    const game = createGame(Array.from(selectedIds), location || undefined);
    navigate(`/live-game/${game.id}`);
  };

  // Get stats for a player
  const getStatsForPlayer = (playerId: string): PlayerStats | undefined => {
    return playerStats.find(s => s.playerId === playerId);
  };

  // ============ FORECAST SENTENCE POOLS ============
  
  // New player sentences (no historical data) - creative and fun
  const newPlayerSentences = [
    `🆕 {name} נכנס לזירה בלי תיק עבר - הכל אפשרי הלילה!`,
    `🎲 שחקן מסתורי מצטרף! {name} יכול להיות הכוכב או הבדיחה של הערב`,
    `👀 {name} - פרצוף חדש, קלפים חדשים, אין לנו מושג מה יהיה`,
    `🐣 טירון על השולחן! {name} עוד לא יודע מה מחכה לו`,
    `❓ {name} הוא תעלומה עטופה בבלאף - נראה מה יוציא מהשרוול`,
    `🎭 פנים חדשות באולם! {name} מביא אווירה לא צפויה`,
    `🌟 {name} עולה לבמה - הלילה הזה יכתוב את הפרק הראשון שלו`,
    `🎪 ברוכים הבאים ל-{name}! בלי היסטוריה, יש רק עתיד`,
    `🔮 {name} עדיין לא גרם לאף אחד לבכות או לצחוק - הלילה זה ישתנה`,
    `🎰 {name} מסובב את הגלגל בפעם הראשונה - שיהיה בהצלחה!`,
    `🦄 {name} נחשף לפוקר כמו לאור השמש - בהתחלה מסנוור, אחר כך מתרגל`,
    `🧩 {name} הוא החלק החסר בפאזל - או שהוא ישלים אותו או יהרוס הכל`,
    `🚀 {name} משגר את הקריירה שלו הלילה - נראה אם זו שיגור מוצלח`,
    `🎬 תחילת הסרט של {name} - עדיין לא יודעים אם זה קומדיה או טרגדיה`,
    `🌈 {name} בא עם תקוות גדולות - נראה אם המציאות תשתף פעולה`,
  ];

  // Surprise sentences - when prediction goes AGAINST history
  const surpriseWinSentences = [
    `🎲 הפתעה! {name} עם היסטוריה של הפסד ({avgProfit}₪ ממוצע), אבל הלילה משהו באוויר אומר שזה הזמן שלו!`,
    `🌟 נגד כל הסיכויים! {name} בדרך כלל מפסיד, אבל יש תחושה שהלילה הקלפים יסתדרו`,
    `🔄 הגלגל מסתובב! {name} עם {lossPercent}% הפסדים בהיסטוריה, אבל התחזית שלנו אומרת: הפתעה!`,
    `✨ קסם בדרך? {name} רגיל להפסיד, אבל משהו מיוחד עומד לקרות הלילה`,
    `🦋 מטמורפוזה! {name} עם עבר לא מזהיר ({gamesPlayed} משחקים, רוב הפסדים) יכול להפוך הכל`,
    `🎯 תחזית מפתיעה! למרות ממוצע של {avgProfit}₪, {name} עשוי לעשות קאמבק גדול`,
    `🌪️ רוח שינוי! {name} סבל מספיק - הלילה התחזית מנבאת הפתעה חיובית`,
    `🎁 מתנה מהשמיים? {name} לא רגיל לנצח, אבל הלילה יכול להיות שונה לגמרי`,
    `🔮 נגד הסטטיסטיקה! {name} עם רקע של הפסדים, אבל האינטואיציה אומרת: הפתעה`,
    `💫 פעם ראשונה לכל דבר! {name} שרגיל להפסיד, עשוי סוף סוף לטעום ניצחון`,
    `🎰 הימור על האאוטסיידר! {name} לא הכי מוצלח ({winPercent}% נצחונות), אבל הלילה יכול להפתיע`,
    `🌅 שחר חדש? {name} עם היסטוריה עגומה של {totalProfit}₪, אבל אולי הלילה הכל ישתנה`,
  ];

  const surpriseLossSentences = [
    `⚡ הפתעה! {name} רגיל לנצח ({avgProfit}₪ ממוצע), אבל הלילה משהו לא מסתדר...`,
    `🌧️ עננים באופק! {name} עם {winPercent}% נצחונות, אבל התחזית מראה סערה בדרך`,
    `🎭 פלוט טוויסט! {name} המנצחן הגדול ({gamesPlayed} משחקים מוצלחים) עלול להיכשל הלילה`,
    `📉 נפילה צפויה? {name} שבדרך כלל מרוויח, עשוי לגלות שהמזל התהפך`,
    `🔮 תחזית מפתיעה! למרות היסטוריה של רווח, {name} עשוי להתאכזב הלילה`,
    `⚠️ אזהרה לאלוף! {name} עם ממוצע חיובי של {avgProfit}₪, אבל הלילה נראה מסוכן`,
    `🎲 הקוביות לא לצידו! {name} רגיל להרוויח {avgProfit}₪, אבל הלילה יש תחושה אחרת`,
    `💨 הרוח משתנה! {name} המנצח המסורתי ({winPercent}% הצלחה) עלול להיתקל בקיר`,
    `🌀 סחרור בדרך? {name} עם הרקורד היפה שלו עשוי לחטוף הפתעה לא נעימה`,
    `🃏 הג'וקר יוצא! {name} שתמיד בפלוס, עלול לגלות שהלילה הקלפים נגדו`,
    `🦅 נפילה מהפסגה? {name} רגיל לשלוט ({avgProfit}₪ ממוצע) אבל הלילה יש ספקות`,
    `🎪 הקרקס מתהפך! {name} האמין שלו ({totalProfit}₪ רווח כולל) עלול לחטוף מפח נפש`,
  ];

  // Regular sentences based on expected outcome (with historical data references)
  const bigWinnerSentences = [
    `🔥 {name} בדרך לכבוש! עם ממוצע של {avgProfit}₪ ב-{gamesPlayed} משחקים, הוא המועמד לכתר`,
    `👑 {name} מגיע כאשר הכל לטובתו! {winPercent}% נצחונות בהיסטוריה - הלילה לא יהיה שונה`,
    `💰 {name} הוא מכונת כסף! רווח כולל של {totalProfit}₪ והלילה ימשיך להוסיף`,
    `🦈 {name} מריח דם! עם הממוצע שלו ({avgProfit}₪), הוא בא לקצור`,
    `⭐ {name} בשיא הכושר! {gamesPlayed} משחקים של ניסיון אומרים: רווח גדול בדרך`,
    `🎯 {name} מכוון ישר לפסגה! {winPercent}% הצלחה זה לא מקרי`,
    `🏆 {name} בא לקחת את הכסף! עם רקורד כזה ({avgProfit}₪ ממוצע), מי יעצור אותו?`,
    `💎 {name} הוא יהלום! {totalProfit}₪ רווח כולל והלילה עוד יהלום מצטרף`,
    `🚀 {name} בטיסה! ממוצע של {avgProfit}₪ והלילה ממשיכים למעלה`,
    `🎰 {name} פוגע בג'קפוט! עם {winPercent}% נצחונות, הסיכויים לצידו`,
    `🌟 {name} זורח הלילה! ב-{gamesPlayed} משחקים הוכיח שהוא יודע לנצח`,
    `⚡ {name} חשמלי! רווח ממוצע של {avgProfit}₪ אומר: זה הזמן שלו`,
  ];

  const goodWinnerSentences = [
    `📈 {name} במגמת עלייה! {gamesPlayed} משחקים של נתונים מראים שהלילה יהיה טוב`,
    `✨ {name} נראה מבטיח! ממוצע של {avgProfit}₪ מרמז על רווח נאה`,
    `💵 {name} עושה כסף יפה! עם {winPercent}% נצחונות, הלילה ימשיך את המגמה`,
    `🎖️ {name} עם סיכויים טובים! {gamesPlayed} משחקים בנו לו בסיס חזק`,
    `🌱 {name} צומח יפה! ממוצע של {avgProfit}₪ והלילה עוד צמיחה`,
    `🎯 {name} בכיוון הנכון! ההיסטוריה ({totalProfit}₪ רווח) תומכת בו`,
    `📊 {name} עם הנתונים לצידו! {winPercent}% הצלחה זה סימן טוב`,
    `🌈 {name} רואה קשת! עם {avgProfit}₪ ממוצע, הסיום יהיה יפה`,
    `🎪 {name} מופיע יפה! {gamesPlayed} הופעות קודמות מבטיחות עוד אחת טובה`,
    `💫 {name} בכוכב עולה! הממוצע שלו ({avgProfit}₪) מדבר בעד עצמו`,
  ];

  const slightWinnerSentences = [
    `📊 {name} צפוי לרווח צנוע - לא רקטה אבל בפלוס! (ממוצע: {avgProfit}₪)`,
    `⚖️ {name} קרוב לאיזון עם נטייה לטוב. {winPercent}% נצחונות תומכים`,
    `🎲 {name} עם יתרון קל - {gamesPlayed} משחקים מראים מגמה חיובית`,
    `✌️ {name} צפוי לסיים בפלוס קטן - לא עשיר אבל מרוצה`,
    `🌤️ {name} תחת שמיים בהירים - רווח קטן צפוי לפי הנתונים`,
    `📈 {name} עם עלייה צנועה - ממוצע של {avgProfit}₪ מצביע על פלוס`,
    `🎯 {name} בכיוון טוב - לא מרהיב אבל חיובי`,
    `💚 {name} בירוק קל - {winPercent}% הצלחה נותנת תקווה`,
  ];

  const neutralSentences = [
    `⚖️ {name} על הקצה! יכול ללכת לכל כיוון עם ממוצע של {avgProfit}₪`,
    `🎭 {name} הוא הקלף הפראי! {winPercent}% נצחונות = 50-50 לכל כיוון`,
    `🤷 {name} בדיוק באמצע - {gamesPlayed} משחקים לא מספרים לאן זה הולך`,
    `☁️ {name} בערפל - התחזית לא ברורה עם ממוצע קרוב לאפס`,
    `🔮 {name} קשה לקרוא! הנתונים ({avgProfit}₪ ממוצע) לא מכריעים`,
    `🎲 {name} מסובב את הגלגל - יכול לנחות על כל מספר`,
    `⚡ {name} בין שמיים וארץ - {winPercent}% הצלחה זה בדיוק אמצע`,
    `🌊 {name} גולש על הגל - לאן הים יוביל? תלוי במזל`,
    `🎪 {name} על החבל הדק - איזון מושלם, אי אפשר לחזות`,
  ];

  const slightLoserSentences = [
    `📉 {name} עם נטייה להפסד קטן - {avgProfit}₪ ממוצע לא משקר`,
    `🌧️ {name} תחת ענן קל - {lossPercent}% הפסדים מרמזים על לילה בינוני`,
    `💭 {name} במינוס קל צפוי - {gamesPlayed} משחקים מראים מגמה`,
    `🎲 {name} עם רוח נגדית קלה - ממוצע של {avgProfit}₪ לא מבטיח`,
    `📊 {name} צפוי להפסד צנוע - לא דרמטי אבל כואב`,
    `⛅ {name} תחת עננים - {winPercent}% נצחונות לא מספיק`,
    `🎭 {name} עם מסכה עצובה - הפסד קטן באופק`,
    `💨 {name} נגד הרוח - ממוצע של {avgProfit}₪ לא לטובתו`,
  ];

  const moderateLoserSentences = [
    `📉 {name} צפוי להפסד! ממוצע של {avgProfit}₪ ב-{gamesPlayed} משחקים לא מבטיח`,
    `🌧️ {name} תחת סערה! {lossPercent}% הפסדים בהיסטוריה - הלילה לא שונה`,
    `💸 {name} יתרום לקופה! עם רקורד כזה ({totalProfit}₪), הכסף זורם החוצה`,
    `😕 {name} בכיוון הלא נכון - {gamesPlayed} משחקים של הוכחות`,
    `🎢 {name} בירידה! ממוצע של {avgProfit}₪ לא משאיר הרבה תקווה`,
    `🌪️ {name} נסחף! {winPercent}% נצחונות לא מספיקים הלילה`,
    `💔 {name} והפוקר - סיפור מורכב. הלילה עוד פרק עצוב`,
    `📊 {name} עם הנתונים נגדו - {lossPercent}% הפסדים מדברים`,
    `🎭 {name} בתפקיד המפסיד - ממוצע {avgProfit}₪ לא יציל`,
    `⛈️ {name} בסערה! {gamesPlayed} משחקים של היסטוריה לא טובה`,
  ];

  const bigLoserSentences = [
    `💸 {name} יממן את כולם הלילה! ממוצע של {avgProfit}₪ מספר הכל`,
    `🏧 {name} כמו כספומט! {totalProfit}₪ הפסד כולל וזה לא נגמר`,
    `📉 {name} בנפילה חופשית! {lossPercent}% הפסדים - מסלול ידוע`,
    `💔 {name} והפוקר - טרגדיה קלאסית. הלילה עוד פרק`,
    `🌪️ {name} בעין הסערה! עם ממוצע של {avgProfit}₪, הארנק רועד`,
    `😓 {name} יחפור עמוק! {gamesPlayed} משחקים של כאב והלילה עוד אחד`,
    `🎰 {name} משחק נגד עצמו! {winPercent}% נצחונות זה כמעט אפס`,
    `💰 {name} המשקיע הגרוע! {totalProfit}₪ הפסד כולל וממשיך`,
    `🎭 {name} בתפקיד הקורבן - ממוצע של {avgProfit}₪ לא ישנה`,
    `📊 {name} עם הסטטיסטיקה נגדו - {lossPercent}% הפסדים מחכים`,
    `🌧️ {name} תחת מבול! {gamesPlayed} משחקים ורק {winPercent}% הצלחה`,
    `⚠️ {name} בסכנה! ההיסטוריה ({avgProfit}₪ ממוצע) לא משקרת`,
  ];

  // Helper to fill in template with stats
  const fillTemplate = (template: string, name: string, stats: PlayerStats): string => {
    return template
      .replace(/{name}/g, name)
      .replace(/{avgProfit}/g, String(Math.round(stats.avgProfit)))
      .replace(/{winPercent}/g, String(Math.round(stats.winPercentage)))
      .replace(/{lossPercent}/g, String(Math.round(100 - stats.winPercentage)))
      .replace(/{gamesPlayed}/g, String(stats.gamesPlayed))
      .replace(/{totalProfit}/g, String(Math.round(stats.totalProfit)))
      .replace(/{streak}/g, String(Math.abs(stats.currentStreak)));
  };

  // Pick random sentence from pool, avoiding already used ones
  const pickUniqueSentence = (pool: string[], usedSentences: Set<string>, name: string, stats?: PlayerStats): string => {
    const availablePool = pool.filter(s => !usedSentences.has(s));
    const selectedPool = availablePool.length > 0 ? availablePool : pool;
    const template = selectedPool[Math.floor(Math.random() * selectedPool.length)];
    
    if (stats) {
      return fillTemplate(template, name, stats);
    }
    return template.replace(/{name}/g, name);
  };

  // Generate forecasts for all selected players (balanced to sum to zero)
  const generateForecasts = () => {
    const usedSentences = new Set<string>();
    const SURPRISE_RATE = 0.40; // 40% chance of surprise prediction
    
    // Step 1: Get initial raw expected profits
    const rawForecasts = Array.from(selectedIds).map(playerId => {
      const player = players.find(p => p.id === playerId);
      if (!player) return null;
      
      const stats = getStatsForPlayer(playerId);
      let rawExpected = 0;
      let isSurprise = false;
      let historyDirection: 'winner' | 'loser' | 'neutral' = 'neutral';
      
      if (stats && stats.gamesPlayed > 0) {
        rawExpected = stats.avgProfit;
        // Determine historical direction
        if (stats.avgProfit > 10) historyDirection = 'winner';
        else if (stats.avgProfit < -10) historyDirection = 'loser';
        
        // 40% chance for surprise (flip the prediction)
        if (Math.random() < SURPRISE_RATE && historyDirection !== 'neutral') {
          isSurprise = true;
          // Flip the expected value
          rawExpected = -rawExpected * (0.5 + Math.random() * 0.5); // 50-100% of flipped value
        } else {
          // Regular prediction - adjust based on streak
          if (stats.currentStreak >= 2) rawExpected *= 1.2;
          if (stats.currentStreak <= -2) rawExpected *= 0.8;
        }
      }
      
      return {
        player,
        stats,
        rawExpected: Math.round(rawExpected),
        gamesPlayed: stats?.gamesPlayed || 0,
        isSurprise,
        historyDirection
      };
    }).filter(Boolean) as { 
      player: Player; 
      stats: PlayerStats | undefined; 
      rawExpected: number; 
      gamesPlayed: number;
      isSurprise: boolean;
      historyDirection: 'winner' | 'loser' | 'neutral';
    }[];
    
    // Step 2: Calculate total imbalance
    const totalRaw = rawForecasts.reduce((sum, f) => sum + f.rawExpected, 0);
    
    // Step 3: Distribute imbalance proportionally to balance to zero
    const totalAbsolute = rawForecasts.reduce((sum, f) => sum + Math.abs(f.rawExpected) + 10, 0);
    
    const balancedForecasts = rawForecasts.map(f => {
      const weight = (Math.abs(f.rawExpected) + 10) / totalAbsolute;
      const adjustment = -totalRaw * weight;
      const balancedExpected = Math.round(f.rawExpected + adjustment);
      
      // Generate unique sentence
      let sentence: string;
      
      if (!f.stats || f.stats.gamesPlayed === 0) {
        // New player
        sentence = pickUniqueSentence(newPlayerSentences, usedSentences, f.player.name);
      } else if (f.isSurprise) {
        // Surprise prediction!
        if (f.historyDirection === 'loser' && balancedExpected > 0) {
          // Historical loser predicted to win
          sentence = pickUniqueSentence(surpriseWinSentences, usedSentences, f.player.name, f.stats);
        } else if (f.historyDirection === 'winner' && balancedExpected < 0) {
          // Historical winner predicted to lose
          sentence = pickUniqueSentence(surpriseLossSentences, usedSentences, f.player.name, f.stats);
        } else {
          // Fallback to regular
          sentence = pickUniqueSentence(
            balancedExpected > 0 ? goodWinnerSentences : moderateLoserSentences,
            usedSentences, f.player.name, f.stats
          );
        }
      } else {
        // Regular prediction based on expected value
        let pool: string[];
        if (balancedExpected > 40) pool = bigWinnerSentences;
        else if (balancedExpected > 15) pool = goodWinnerSentences;
        else if (balancedExpected > 5) pool = slightWinnerSentences;
        else if (balancedExpected >= -5) pool = neutralSentences;
        else if (balancedExpected >= -15) pool = slightLoserSentences;
        else if (balancedExpected >= -40) pool = moderateLoserSentences;
        else pool = bigLoserSentences;
        
        sentence = pickUniqueSentence(pool, usedSentences, f.player.name, f.stats);
      }
      
      // Mark template as used
      usedSentences.add(sentence);
      
      return {
        player: f.player,
        expected: balancedExpected,
        sentence,
        gamesPlayed: f.gamesPlayed,
        isSurprise: f.isSurprise
      };
    });

    // Sort by expected profit (winners first)
    return balancedForecasts.sort((a, b) => b.expected - a.expected);
  };

  // Share forecast to WhatsApp
  const shareForecast = () => {
    const forecasts = generateForecasts();
    const today = new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'short' });
    
    let message = `🔮 *תחזית פוקר - ${today}*\n\n`;
    
    forecasts.forEach((f) => {
      const emoji = f.isSurprise ? '🎲' : (f.expected > 20 ? '🟢' : f.expected < -20 ? '🔴' : '⚪');
      const profitStr = f.expected >= 0 ? `+₪${f.expected}` : `-₪${Math.abs(f.expected)}`;
      message += `${emoji} *${f.player.name}*: ${profitStr}\n`;
      message += `   ${f.sentence}\n\n`;
    });

    message += `\n🃏 בהצלחה לכולם!`;

    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  };

  const handleShowForecast = () => {
    if (selectedIds.size < 2) {
      setError('Select at least 2 players');
      return;
    }
    setShowForecast(true);
  };

  // Render player tile - balanced size
  const renderPlayerTile = (player: Player) => (
    <div
      key={player.id}
      onClick={() => togglePlayer(player.id)}
      style={{
        padding: '0.5rem 0.4rem',
        borderRadius: '10px',
        fontSize: '0.9rem',
        fontWeight: '600',
        cursor: 'pointer',
        border: selectedIds.has(player.id) ? '2px solid var(--primary)' : '2px solid var(--border)',
        background: selectedIds.has(player.id) ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
        color: selectedIds.has(player.id) ? 'var(--primary)' : 'var(--text)',
        transition: 'all 0.15s ease',
        textAlign: 'center'
      }}
    >
      {selectedIds.has(player.id) && '✓ '}{player.name}
    </div>
  );

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <h1 className="page-title" style={{ fontSize: '1.25rem', margin: 0 }}>New Game</h1>
        {permanentPlayers.length > 0 && (
          <button className="btn btn-sm btn-secondary" onClick={selectAll} style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}>
            {permanentPlayers.every(p => selectedIds.has(p.id)) ? 'Deselect All' : 'Select All'}
          </button>
        )}
      </div>

      {error && (
        <div style={{ background: 'rgba(239, 68, 68, 0.1)', padding: '0.5rem', borderRadius: '6px', marginBottom: '0.5rem', borderLeft: '3px solid var(--danger)' }}>
          <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: 0 }}>{error}</p>
        </div>
      )}

      {/* Permanent Players */}
      <div className="card" style={{ padding: '0.6rem', marginBottom: '0.6rem' }}>
        {permanentPlayers.length === 0 && permanentGuestPlayers.length === 0 && guestPlayers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '0.75rem' }}>
            <div style={{ fontSize: '1.5rem' }}>👥</div>
            <p style={{ margin: '0.25rem 0', fontWeight: '500', fontSize: '0.9rem' }}>No players yet</p>
          </div>
        ) : (
          <>
            {permanentPlayers.length > 0 && (
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
                gap: '0.5rem'
              }}>
                {permanentPlayers.map(renderPlayerTile)}
              </div>
            )}
          </>
        )}

        <button 
          onClick={() => setShowAddPlayer(true)}
          style={{
            width: '100%',
            marginTop: permanentPlayers.length > 0 ? '0.6rem' : '0',
            padding: '0.4rem',
            border: '2px dashed var(--border)',
            borderRadius: '6px',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontSize: '0.8rem',
            cursor: 'pointer'
          }}
        >
          + Add Player
        </button>
      </div>

      {/* Guests Section */}
      {permanentGuestPlayers.length > 0 && (
        <div className="card" style={{ padding: '0.6rem', marginBottom: '0.6rem' }}>
          <button
            onClick={() => setShowPermanentGuests(!showPermanentGuests)}
            style={{
              width: '100%',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              color: 'var(--text)'
            }}
          >
            <span style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-muted)' }}>
              🏠 אורח ({permanentGuestPlayers.length})
            </span>
            <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>
              {showPermanentGuests ? '▲' : '▼'}
            </span>
          </button>
          
          {showPermanentGuests && (
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
              gap: '0.5rem',
              marginTop: '0.5rem'
            }}>
              {permanentGuestPlayers.map(renderPlayerTile)}
            </div>
          )}
        </div>
      )}

      {/* Occasional Players Section */}
      {guestPlayers.length > 0 && (
        <div className="card" style={{ padding: '0.6rem', marginBottom: '0.6rem' }}>
          <button
            onClick={() => setShowGuests(!showGuests)}
            style={{
              width: '100%',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              color: 'var(--text)'
            }}
          >
            <span style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-muted)' }}>
              👤 מזדמן ({guestPlayers.length})
            </span>
            <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>
              {showGuests ? '▲' : '▼'}
            </span>
          </button>
          
          {showGuests && (
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
              gap: '0.5rem',
              marginTop: '0.5rem'
            }}>
              {guestPlayers.map(renderPlayerTile)}
            </div>
          )}
        </div>
      )}

      {/* Location Selector */}
      <div className="card" style={{ padding: '0.6rem', marginBottom: '0.6rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', marginRight: '0.2rem' }}>📍 מיקום:</span>
          {LOCATION_OPTIONS.map(loc => (
            <button
              key={loc}
              onClick={() => { setGameLocation(gameLocation === loc ? '' : loc); setCustomLocation(''); }}
              style={{
                padding: '0.25rem 0.4rem',
                borderRadius: '6px',
                fontSize: '0.7rem',
                border: gameLocation === loc ? '2px solid var(--primary)' : '1px solid var(--border)',
                background: gameLocation === loc ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                color: gameLocation === loc ? 'var(--primary)' : 'var(--text-muted)',
                cursor: 'pointer'
              }}
            >
              {loc}
            </button>
          ))}
          <button
            onClick={() => setGameLocation(gameLocation === 'other' ? '' : 'other')}
            style={{
              padding: '0.25rem 0.4rem',
              borderRadius: '6px',
              fontSize: '0.7rem',
              border: gameLocation === 'other' ? '2px solid var(--primary)' : '1px solid var(--border)',
              background: gameLocation === 'other' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
              color: gameLocation === 'other' ? 'var(--primary)' : 'var(--text-muted)',
              cursor: 'pointer'
            }}
          >
            אחר
          </button>
        </div>
        {gameLocation === 'other' && (
          <input
            type="text"
            value={customLocation}
            onChange={(e) => setCustomLocation(e.target.value)}
            placeholder="הזן מיקום..."
            style={{
              marginTop: '0.4rem',
              width: '100%',
              padding: '0.4rem',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--text)',
              fontSize: '0.8rem'
            }}
          />
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <button 
          className="btn btn-secondary"
          onClick={handleShowForecast}
          disabled={selectedIds.size < 2}
          style={{ padding: '0.6rem', flex: '1', fontSize: '0.85rem' }}
        >
          🔮 Forecast
        </button>
        <button 
          className="btn btn-primary"
          onClick={handleStartGame}
          disabled={selectedIds.size < 2}
          style={{ padding: '0.6rem', flex: '2', fontSize: '0.9rem' }}
        >
          🎰 Start Game ({selectedIds.size})
        </button>
      </div>

      {/* Add Player Modal */}
      {showAddPlayer && (
        <div className="modal-overlay" onClick={() => setShowAddPlayer(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Add New Player</h3>
              <button className="modal-close" onClick={() => setShowAddPlayer(false)}>×</button>
            </div>
            <div className="input-group">
              <label className="label">Player Name</label>
              <input
                type="text"
                className="input"
                placeholder="Enter name"
                value={newPlayerName}
                onChange={e => setNewPlayerName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddPlayer()}
                autoFocus
              />
            </div>
            
            {/* Player Type Toggle */}
            <div className="input-group">
              <label className="label">Player Type</label>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => setNewPlayerType('permanent')}
                  style={{
                    flex: 1,
                    minWidth: '80px',
                    padding: '0.5rem',
                    borderRadius: '8px',
                    border: newPlayerType === 'permanent' ? '2px solid var(--primary)' : '2px solid var(--border)',
                    background: newPlayerType === 'permanent' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: newPlayerType === 'permanent' ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    fontWeight: '600',
                    fontSize: '0.75rem'
                  }}
                >
                  ⭐ Permanent
                </button>
                <button
                  type="button"
                  onClick={() => setNewPlayerType('permanent_guest')}
                  style={{
                    flex: 1,
                    minWidth: '80px',
                    padding: '0.5rem',
                    borderRadius: '8px',
                    border: newPlayerType === 'permanent_guest' ? '2px solid var(--text-muted)' : '2px solid var(--border)',
                    background: newPlayerType === 'permanent_guest' ? 'rgba(100, 100, 100, 0.15)' : 'var(--surface)',
                    color: newPlayerType === 'permanent_guest' ? 'var(--text)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    fontWeight: '600',
                    fontSize: '0.75rem'
                  }}
                >
                  🏠 אורח
                </button>
                <button
                  type="button"
                  onClick={() => setNewPlayerType('guest')}
                  style={{
                    flex: 1,
                    minWidth: '80px',
                    padding: '0.5rem',
                    borderRadius: '8px',
                    border: newPlayerType === 'guest' ? '2px solid var(--primary)' : '2px solid var(--border)',
                    background: newPlayerType === 'guest' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: newPlayerType === 'guest' ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    fontWeight: '600',
                    fontSize: '0.75rem'
                  }}
                >
                  👤 מזדמן
                </button>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
                {newPlayerType === 'permanent' && 'רשימה ראשית - חברי הקבוצה הקבועים'}
                {newPlayerType === 'permanent_guest' && 'אורח קבוע שמגיע לעתים קרובות'}
                {newPlayerType === 'guest' && 'שחקן מזדמן שמגיע לפעמים'}
              </p>
            </div>

            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setShowAddPlayer(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleAddPlayer}>
                Add Player
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Forecast Modal */}
      {showForecast && (
        <div className="modal-overlay" onClick={() => setShowForecast(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxHeight: '80vh', overflow: 'auto' }}>
            <div className="modal-header">
              <h3 className="modal-title">🔮 Tonight's Forecast</h3>
              <button className="modal-close" onClick={() => setShowForecast(false)}>×</button>
            </div>
            
            <div style={{ marginBottom: '1rem' }}>
              {generateForecasts().map((forecast, index) => {
                const { player, expected, sentence, gamesPlayed, isSurprise } = forecast;
                const isWinner = expected > 20;
                const isLoser = expected < -20;
                
                return (
                  <div 
                    key={player.id}
                    style={{
                      padding: '0.75rem',
                      marginBottom: '0.5rem',
                      borderRadius: '10px',
                      background: isSurprise
                        ? 'rgba(139, 92, 246, 0.15)'
                        : isWinner 
                          ? 'rgba(34, 197, 94, 0.1)' 
                          : isLoser 
                            ? 'rgba(239, 68, 68, 0.1)' 
                            : 'rgba(100, 100, 100, 0.1)',
                      borderLeft: `4px solid ${isSurprise ? '#8B5CF6' : isWinner ? 'var(--success)' : isLoser ? 'var(--danger)' : 'var(--text-muted)'}`
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                      <span style={{ fontWeight: '600', fontSize: '1rem' }}>
                        {index === 0 && expected > 0 && '👑 '}
                        {isSurprise && '🎲 '}
                        {player.name}
                      </span>
                      <span style={{ 
                        fontWeight: '700', 
                        fontSize: '1rem',
                        color: isSurprise ? '#8B5CF6' : isWinner ? 'var(--success)' : isLoser ? 'var(--danger)' : 'var(--text)'
                      }}>
                        {expected >= 0 ? '+' : ''}₪{expected}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                      {sentence}
                    </div>
                    {gamesPlayed > 0 && (
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.25rem', opacity: 0.7 }}>
                        מבוסס על {gamesPlayed} משחק{gamesPlayed > 1 ? 'ים' : ''}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center', marginBottom: '1rem' }}>
              ⚠️ התחזית מבוססת על היסטוריה ומזל - התוצאות עשויות להפתיע! 🎲
            </p>

            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setShowForecast(false)}>
                Close
              </button>
              <button className="btn btn-primary" onClick={shareForecast}>
                📤 Share to WhatsApp
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NewGameScreen;
