import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Player, PlayerStats } from '../types';
import { getAllPlayers, addPlayer, createGame, getPlayerByName, getPlayerStats } from '../database/storage';

const NewGameScreen = () => {
  const navigate = useNavigate();
  const [players, setPlayers] = useState<Player[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerType, setNewPlayerType] = useState<'permanent' | 'guest'>('guest');
  const [error, setError] = useState('');
  const [showGuests, setShowGuests] = useState(false);
  const [showForecast, setShowForecast] = useState(false);
  const [playerStats, setPlayerStats] = useState<PlayerStats[]>([]);

  useEffect(() => {
    loadPlayers();
  }, []);

  const loadPlayers = () => {
    setPlayers(getAllPlayers());
    setPlayerStats(getPlayerStats());
  };

  // Separate permanent and guest players
  const permanentPlayers = players.filter(p => p.type === 'permanent');
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

  const selectAll = () => {
    if (selectedIds.size === players.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(players.map(p => p.id)));
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
    // If adding a guest, expand the guests section
    if (newPlayerType === 'guest') {
      setShowGuests(true);
    }
  };

  const handleStartGame = () => {
    if (selectedIds.size < 2) {
      setError('Select at least 2 players');
      return;
    }
    
    const game = createGame(Array.from(selectedIds));
    navigate(`/live-game/${game.id}`);
  };

  // Get stats for a player
  const getStatsForPlayer = (playerId: string): PlayerStats | undefined => {
    return playerStats.find(s => s.playerId === playerId);
  };

  // Generate forecast with matched expected profit and sentence
  const generateForecast = (stats: PlayerStats | undefined, playerName: string): { expected: number; sentence: string } => {
    // New player - no data
    if (!stats || stats.gamesPlayed === 0) {
      const newPlayerSentences = [
        `🆕 ${playerName} מגיע בלי היסטוריה - הכל פתוח! מזל מתחילים או טעות מתחילים? רק הלילה יגלה`,
        `🎲 שחקן חדש בזירה! ${playerName} יכול להפתיע לטוב או לרע - אין לנו מושג מה יקרה`,
        `👀 ${playerName} הוא חידה עטופה בתעלומה. בלי נתונים, בלי תחזית - רק הרגשת בטן`,
        `🐣 טירון על השולחן! ${playerName} עדיין לא נחשף לחוקי המשחק האמיתיים. יתחיל בגדול או יפול קשה?`,
        `❓ ${playerName} הוא סימן שאלה ענק. יכול להיות הכוכב של הלילה או התרומה הגדולה`,
        `🎭 פנים חדשות! ${playerName} מביא אנרגיה לא ידועה - מסוכן או קורבן קל?`,
        `🌟 ${playerName} עולה לבמה בפעם הראשונה. האם זו תהיה הופעת בכורה מרשימה או אסון על הבמה?`,
        `🎪 ${playerName} נכנס למעגל הקסמים. מה שיקרה הלילה יכתוב את ההיסטוריה שלו`,
      ];
      return {
        expected: 0,
        sentence: newPlayerSentences[Math.floor(Math.random() * newPlayerSentences.length)]
      };
    }

    const { avgProfit, currentStreak, winPercentage, biggestWin, biggestLoss, gamesPlayed, totalProfit } = stats;
    const random = Math.random();
    
    // 12% chance for SURPRISE prediction (against the trend)
    const isSurprise = random < 0.12;
    
    // Calculate base expected profit
    let expected = Math.round(avgProfit);
    
    // Adjust based on streak
    if (currentStreak >= 2) expected = Math.round(expected * 1.2);
    if (currentStreak <= -2) expected = Math.round(expected * 0.8);
    
    // Big winner with good track record
    if (avgProfit > 50) {
      if (isSurprise) {
        // Predict bad night for usually good player
        expected = Math.round(-Math.abs(avgProfit) * 0.5);
        const surpriseSentences = [
          `⚠️ ${playerName} תמיד מנצח, אבל משהו באוויר אומר שהלילה יהיה שונה. גם לאלופים יש לילות קשים - והלילה נראה כזה`,
          `🔄 ${playerName} רגיל לשלוט, אבל הכוכבים מסמנים הפתעה. בניגוד להיסטוריה המרשימה - תחושת בטן אומרת שהיום קשה`,
          `🌙 ${playerName} הוא מכונת רווחים, אבל אפילו מכונות מתקלקלות. הלילה יכול להיות הלילה שהמזל מסתובב`,
          `💫 ${playerName} עם ממוצע רווח של ${Math.round(avgProfit)}₪, אבל התחזית הלילה? הפתעה שלילית באופק. לפעמים הסטטיסטיקה משקרת`,
          `🎲 כולם יודעים ש${playerName} מנצח, אבל הלילה מרגיש אחרת. תחזית אמיצה: הפסד בניגוד לכל ההיגיון`,
        ];
        return { expected, sentence: surpriseSentences[Math.floor(Math.random() * surpriseSentences.length)] };
      }
      
      const winnerSentences = [
        `🔥 ${playerName} הוא הסיוט של השולחן! ממוצע רווח של ${Math.round(avgProfit)}₪ למשחק - פשוט מכונת כסף. תתכוננו להפסיד`,
        `👑 ${playerName} הוא המלך הבלתי מעורער. עם ${Math.round(winPercentage)}% נצחונות, השאלה היא לא אם ירוויח אלא כמה`,
        `🦈 התראת כריש! ${playerName} מריח דם ובא לטרוף. ${gamesPlayed} משחקים של שליטה - תחביאו את הארנקים`,
        `💰 ${playerName} הוא הבנקאי הלא רשמי של הקבוצה. כבר הרוויח ${Math.round(totalProfit)}₪ בסך הכל - והלילה ימשיך את המגמה`,
        `🏆 ${playerName} פשוט ברמה אחרת. ניצחון אחרי ניצחון, ${currentStreak > 0 ? `עם ${currentStreak} נצחונות ברצף` : 'עם עקביות מפחידה'}. תתכוננו`,
        `⚔️ ${playerName} הוא לוחם ותיק עם ידיים מנצחות. הרווח הממוצע שלו (${Math.round(avgProfit)}₪) אומר הכל - זה לא מזל, זה כישרון`,
        `🎯 ${playerName} יורה ופוגע. אחוזי הניצחון שלו (${Math.round(winPercentage)}%) הופכים אותו למסוכן ביותר הלילה`,
        `💎 ${playerName} הפך את הפוקר לעסק רווחי. עם הרקורד שלו, הלילה צפוי להיות עוד יום משכורת`,
      ];
      return { expected, sentence: winnerSentences[Math.floor(Math.random() * winnerSentences.length)] };
    }
    
    // Good winner (avg 20-50)
    if (avgProfit > 20) {
      if (isSurprise) {
        expected = Math.round(-avgProfit * 0.7);
        const surpriseSentences = [
          `🔄 ${playerName} בדרך כלל ברווח, אבל הלילה מרגיש אחרת. תחושת בטן: הפסד מפתיע באופק`,
          `⚠️ ${playerName} עם ממוצע חיובי, אבל משהו ישתנה הלילה. התחזית הלא קונבנציונלית: ירידה`,
        ];
        return { expected, sentence: surpriseSentences[Math.floor(Math.random() * surpriseSentences.length)] };
      }
      
      const goodWinnerSentences = [
        `📈 ${playerName} במגמת עלייה יציבה! ממוצע של ${Math.round(avgProfit)}₪ למשחק - לא הכי גדול אבל עקבי ומסוכן`,
        `🎯 ${playerName} עושה כסף בשקט בלי להתרברב. ${Math.round(winPercentage)}% נצחונות - שחקן חכם שכדאי לשים עליו עין`,
        `💵 ${playerName} הוא סוג השחקן שלא שמים לב אליו עד שמגלים שהוא לקח את כל הכסף. צפי: רווח נאה`,
        `🌱 ${playerName} צומח בכל משחק! עם ${gamesPlayed} משחקים תחת החגורה ומגמה חיובית, הלילה נראה מבטיח`,
        `✨ ${playerName} הוכיח את עצמו עם ${Math.round(totalProfit)}₪ רווח כולל. לא מפציץ, אבל בהחלט מרוויח`,
      ];
      return { expected, sentence: goodWinnerSentences[Math.floor(Math.random() * goodWinnerSentences.length)] };
    }
    
    // Big loser (avg < -50)
    if (avgProfit < -50) {
      if (isSurprise) {
        // Predict good night for usually bad player
        expected = Math.round(Math.abs(avgProfit) * 0.6);
        const surpriseSentences = [
          `✨ ${playerName} תמיד מפסיד, אבל הלילה הכל משתנה! תחושה חזקה שזה יהיה הלילה של הקאמבק הגדול`,
          `🌈 ${playerName} עם ממוצע הפסד של ${Math.round(Math.abs(avgProfit))}₪, אבל בניגוד לכל ההיגיון - הלילה הוא ינצח!`,
          `🦋 ${playerName} היה הזחל של הקבוצה, אבל הלילה הוא יהפוך לפרפר! תחזית מפתיעה: רווח משמעותי`,
          `🚀 ${playerName} נמצא בתחתית הטבלה, אבל משהו באוויר אומר שהלילה הכל מתהפך. תתכוננו להפתעה!`,
          `💫 ${playerName} הפסיד ${Math.round(Math.abs(totalProfit))}₪ בסך הכל, אבל הכוכבים מסמנים מהפך. הלילה של הנקמה!`,
        ];
        return { expected, sentence: surpriseSentences[Math.floor(Math.random() * surpriseSentences.length)] };
      }
      
      const loserSentences = [
        `💸 ${playerName} הוא ראש מחלקת התרומות של הקבוצה! ממוצע הפסד של ${Math.round(Math.abs(avgProfit))}₪ - תודה על המימון`,
        `🏧 ${playerName} הוא הכספומט הרשמי של הערב. כבר תרם ${Math.round(Math.abs(totalProfit))}₪ לקבוצה - והלילה ימשיך`,
        `🎁 ${playerName} הוא הספונסר האהוב על כולם! עם ${Math.round(100 - winPercentage)}% הפסדים, הוא הסיבה שיש משקאות`,
        `📉 ${playerName} מתמיד בירידה. ${gamesPlayed} משחקים של הפסדים עקביים - לפחות הוא אמין`,
        `😇 ${playerName} ממן את החלומות של כולם! ממוצע הפסד של ${Math.round(Math.abs(avgProfit))}₪ - גיבור אמיתי`,
        `🕳️ ${playerName} כבר בבור של ${Math.round(Math.abs(totalProfit))}₪. הלילה? כנראה יחפור עוד קצת`,
        `💔 ${playerName} והפוקר - סיפור אהבה חד צדדי. הוא אוהב את המשחק, המשחק לא אוהב אותו בחזרה`,
        `🌧️ ${playerName} מביא את העננים איתו. עם רצף של הפסדים, השמש לא צפויה לזרוח הלילה`,
      ];
      return { expected, sentence: loserSentences[Math.floor(Math.random() * loserSentences.length)] };
    }
    
    // Moderate loser (avg -20 to -50)
    if (avgProfit < -20) {
      if (isSurprise) {
        expected = Math.round(Math.abs(avgProfit) * 0.8);
        const surpriseSentences = [
          `🌈 ${playerName} בדרך כלל מפסיד, אבל הלילה יש תחושה של מהפך! אולי סוף סוף המזל יחייך`,
          `✨ ${playerName} מגיע עם היסטוריה בינונית, אבל משהו מיוחד באוויר. תחזית: הפתעה חיובית!`,
        ];
        return { expected, sentence: surpriseSentences[Math.floor(Math.random() * surpriseSentences.length)] };
      }
      
      const moderateLoserSentences = [
        `📉 ${playerName} במגמת ירידה עקבית. ממוצע של ${Math.round(Math.abs(avgProfit))}₪ הפסד - לא נורא אבל גם לא טוב`,
        `🎢 ${playerName} על רכבת הרים שרק יורדת. ${Math.round(winPercentage)}% נצחונות זה לא מספיק`,
        `🌧️ ${playerName} חי תחת ענן אפור. הפסד ממוצע של ${Math.round(Math.abs(avgProfit))}₪ - והלילה לא נראה שונה`,
        `💭 ${playerName} חולם על ימים טובים יותר, אבל הסטטיסטיקה מראה תמונה אחרת. צפי: הפסד קל עד בינוני`,
        `🤔 ${playerName} צריך לשנות אסטרטגיה. עם ${gamesPlayed} משחקים של תוצאות בינוניות-שליליות, הלילה לא צפוי להיות שונה`,
      ];
      return { expected, sentence: moderateLoserSentences[Math.floor(Math.random() * moderateLoserSentences.length)] };
    }
    
    // Hot winning streak (3+)
    if (currentStreak >= 3) {
      expected = Math.round(Math.max(avgProfit * 1.3, 30));
      const hotStreakSentences = [
        `🔥 ${playerName} על רצף לוהט! ${currentStreak} נצחונות ברצף - היד חמה והלילה צפוי להמשיך את המגמה!`,
        `⚡ ${playerName} בלתי ניתן לעצירה! אחרי ${currentStreak} נצחונות, הביטחון בשמיים והכסף זורם`,
        `🚀 ${playerName} בדרך לירח! ${currentStreak} משחקים ברצף של הצלחה - מי יעצור אותו?`,
        `💥 ${playerName} פיצוץ של הצלחה! הרצף של ${currentStreak} נצחונות הופך אותו למועמד מספר 1 לרווח גדול`,
        `🌋 ${playerName} כמו הר געש פעיל - ${currentStreak} נצחונות והלבה עדיין זורמת! צפי: עוד ניצחון`,
      ];
      return { expected, sentence: hotStreakSentences[Math.floor(Math.random() * hotStreakSentences.length)] };
    }
    
    // Winning streak (2)
    if (currentStreak >= 2) {
      expected = Math.round(Math.max(avgProfit * 1.15, 15));
      const streakSentences = [
        `📈 ${playerName} על גל חיובי! ${currentStreak} נצחונות ברצף יוצרים מומנטום - הלילה נראה מבטיח`,
        `✌️ ${playerName} עם ${currentStreak} נצחונות ברצף! השאלה אם ימשיך את המגמה או שהמזל יסתובב`,
        `🎰 ${playerName} על רצף! המזל לצידו לאחרונה ואין סיבה שזה ישתנה הלילה`,
        `💪 ${playerName} בונה מומנטום! ${currentStreak} נצחונות ברצף והביטחון עולה. צפי: רווח`,
      ];
      return { expected, sentence: streakSentences[Math.floor(Math.random() * streakSentences.length)] };
    }
    
    // Bad losing streak (3+)
    if (currentStreak <= -3) {
      expected = Math.round(Math.min(avgProfit * 1.3, -30));
      const badStreakSentences = [
        `😱 ${playerName} ברצף הפסדים קשה! ${Math.abs(currentStreak)} הפסדים ברצף - האם זה הלילה של המהפך או עוד אסון?`,
        `🆘 ${playerName} זקוק לניצחון בדחיפות! ${Math.abs(currentStreak)} הפסדים ברצף שוחקים את הביטחון והארנק`,
        `🌑 ${playerName} בתקופה חשוכה. ${Math.abs(currentStreak)} הפסדים ברצף ואין אור בקצה המנהרה`,
        `💀 ${playerName} ברצף הפסדים אכזרי! ${Math.abs(currentStreak)} משחקים של כאב - הלילה לא נראה טוב יותר`,
        `❄️ ${playerName} בתקופת קרח עמוקה. ${Math.abs(currentStreak)} הפסדים ברצף - מתי ההפשרה?`,
      ];
      return { expected, sentence: badStreakSentences[Math.floor(Math.random() * badStreakSentences.length)] };
    }
    
    // Losing streak (2)
    if (currentStreak <= -2) {
      expected = Math.round(Math.min(avgProfit * 1.1, -10));
      const loseStreakSentences = [
        `😰 ${playerName} עם ${Math.abs(currentStreak)} הפסדים ברצף. מגיע לו קאמבק, אבל האם זה יקרה הלילה?`,
        `📉 ${playerName} במגמת ירידה. ${Math.abs(currentStreak)} הפסדים אחרונים לא מבשרים טובות`,
        `🍀 ${playerName} צריך קצת מזל! אחרי ${Math.abs(currentStreak)} הפסדים, השאלה אם הלילה יביא שינוי`,
        `🌧️ ${playerName} תחת ענן. ${Math.abs(currentStreak)} הפסדים ברצף והתחזית לא אופטימית`,
      ];
      return { expected, sentence: loseStreakSentences[Math.floor(Math.random() * loseStreakSentences.length)] };
    }
    
    // High win rate but neutral profit
    if (winPercentage > 60 && avgProfit >= -20 && avgProfit <= 20) {
      expected = Math.round(avgProfit + 15);
      const highWinRateSentences = [
        `📊 ${playerName} מנצח הרבה (${Math.round(winPercentage)}%) אבל ברווחים קטנים. הלילה יכול להיות הפריצה הגדולה`,
        `🎯 ${playerName} עם אחוזי ניצחון גבוהים! ${Math.round(winPercentage)}% - הסטטיסטיקה לצידו גם הלילה`,
        `⚖️ ${playerName} מנצח יותר מפסיד (${Math.round(winPercentage)}%), אז למרות הממוצע הנמוך - הסיכויים טובים`,
      ];
      return { expected, sentence: highWinRateSentences[Math.floor(Math.random() * highWinRateSentences.length)] };
    }
    
    // Low win rate but neutral profit
    if (winPercentage < 40 && avgProfit >= -20 && avgProfit <= 20) {
      expected = Math.round(avgProfit - 10);
      const lowWinRateSentences = [
        `🎲 ${playerName} עם אחוזי ניצחון נמוכים (${Math.round(winPercentage)}%). הסטטיסטיקה לא לטובתו הלילה`,
        `📉 ${playerName} מפסיד יותר ממנצח. ${Math.round(winPercentage)}% נצחונות זה לא הרבה - צפי: הפסד קל`,
        `💭 ${playerName} מאמין בנסים עם ${Math.round(winPercentage)}% נצחונות. האם הלילה יהיה הנס?`,
      ];
      return { expected, sentence: lowWinRateSentences[Math.floor(Math.random() * lowWinRateSentences.length)] };
    }
    
    // Experienced player
    if (gamesPlayed >= 10 && avgProfit >= -20 && avgProfit <= 20) {
      const experiencedSentences = [
        `🎖️ ${playerName} ותיק מנוסה עם ${gamesPlayed} משחקים! יודע את כל הטריקים. ממוצע קרוב לאפס - יכול ללכת לכל כיוון`,
        `🧠 ${playerName} צבר ניסיון ב-${gamesPlayed} משחקים. הרקורד מעורב, אבל הניסיון שווה משהו`,
        `⚔️ ${playerName} לוחם ותיק! ${gamesPlayed} קרבות מאחוריו עם תוצאות מעורבות. הלילה? סימן שאלה`,
      ];
      return { expected, sentence: experiencedSentences[Math.floor(Math.random() * experiencedSentences.length)] };
    }
    
    // Few games played
    if (gamesPlayed <= 3) {
      const newishSentences = [
        `🌱 ${playerName} עדיין בתחילת הדרך עם ${gamesPlayed} משחקים. מעט נתונים, הרבה אי-ודאות`,
        `📝 ${playerName} עם מעט ניסיון (${gamesPlayed} משחקים). עדיין לומד את המשחק - יכול להפתיע לטוב או לרע`,
        `🔍 ${playerName} תחת תצפית! רק ${gamesPlayed} משחקים - קשה לחזות לאן זה הולך`,
      ];
      return { expected, sentence: newishSentences[Math.floor(Math.random() * newishSentences.length)] };
    }
    
    // Truly neutral player - break even
    const neutralSentences = [
      `⚖️ ${playerName} מאוזן לחלוטין! ממוצע קרוב לאפס - הלילה יכול להיות רווח או הפסד, חמישים חמישים`,
      `🎭 ${playerName} הוא הקלף הפראי של הערב! עם ממוצע של ${Math.round(avgProfit)}₪, אי אפשר לדעת מה יקרה`,
      `🤷 ${playerName} יכול ללכת לכל כיוון! ${gamesPlayed} משחקים עם תוצאות מעורבות - הלילה יכול להפתיע`,
      `🔮 ${playerName} קשה לחזות! ממוצע קרוב לאפס (${Math.round(avgProfit)}₪) אומר שהכל פתוח`,
      `🎲 ${playerName} הוא ההגרלה של הערב! עם רקורד מעורב, כל תוצאה אפשרית`,
      `🌊 ${playerName} זורם עם הזרם. לפעמים למעלה, לפעמים למטה - הלילה? תלוי ברוח`,
      `☁️ ${playerName} לא שמש ולא גשם. ממוצע אפסי אומר שהלילה יכול להיות כל דבר`,
      `🎯 ${playerName} לפעמים פוגע, לפעמים מפספס. עם ${Math.round(winPercentage)}% נצחונות - הכל פתוח`,
    ];
    return { expected, sentence: neutralSentences[Math.floor(Math.random() * neutralSentences.length)] };
  };

  // Generate forecasts for all selected players
  const generateForecasts = () => {
    const forecasts = Array.from(selectedIds).map(playerId => {
      const player = players.find(p => p.id === playerId);
      if (!player) return null;
      
      const stats = getStatsForPlayer(playerId);
      const { expected, sentence } = generateForecast(stats, player.name);
      
      return {
        player,
        expected,
        sentence,
        gamesPlayed: stats?.gamesPlayed || 0
      };
    }).filter(Boolean) as { player: Player; expected: number; sentence: string; gamesPlayed: number }[];

    // Sort by expected profit (winners first)
    return forecasts.sort((a, b) => b.expected - a.expected);
  };

  // Share forecast to WhatsApp
  const shareForecast = () => {
    const forecasts = generateForecasts();
    const today = new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'short' });
    
    let message = `🔮 *תחזית פוקר - ${today}*\n\n`;
    
    forecasts.forEach((f, index) => {
      const emoji = f.expected > 20 ? '🟢' : f.expected < -20 ? '🔴' : '⚪';
      const profitStr = f.expected >= 0 ? `+₪${f.expected}` : `-₪${Math.abs(f.expected)}`;
      message += `${emoji} *${f.player.name}*: ${profitStr}\n`;
      message += `   ${f.sentence}\n\n`;
    });

    message += `\n🃏 Good luck everyone!`;

    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  };

  const handleShowForecast = () => {
    if (selectedIds.size < 2) {
      setError('Select at least 2 players');
      return;
    }
    setShowForecast(true);
  };

  // Render player tile
  const renderPlayerTile = (player: Player) => (
    <div
      key={player.id}
      onClick={() => togglePlayer(player.id)}
      style={{
        padding: '0.6rem 0.5rem',
        borderRadius: '12px',
        fontSize: '1rem',
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <div>
          <h1 className="page-title" style={{ fontSize: '1.5rem', marginBottom: '0.1rem' }}>New Game</h1>
          <p className="page-subtitle" style={{ fontSize: '0.8rem' }}>Select players</p>
        </div>
        {players.length > 0 && (
          <button className="btn btn-sm btn-secondary" onClick={selectAll} style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }}>
            {selectedIds.size === players.length ? 'Deselect All' : 'Select All'}
          </button>
        )}
      </div>

      {error && (
        <div style={{ background: 'rgba(239, 68, 68, 0.1)', padding: '0.5rem', borderRadius: '6px', marginBottom: '0.5rem', borderLeft: '3px solid var(--danger)' }}>
          <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: 0 }}>{error}</p>
        </div>
      )}

      {/* Permanent Players */}
      <div className="card" style={{ padding: '0.75rem', marginBottom: '0.75rem' }}>
        {permanentPlayers.length === 0 && guestPlayers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '1rem' }}>
            <div style={{ fontSize: '2rem' }}>👥</div>
            <p style={{ margin: '0.5rem 0 0.25rem', fontWeight: '500' }}>No players yet</p>
            <p className="text-muted" style={{ fontSize: '0.8rem', margin: 0 }}>Add players to get started</p>
          </div>
        ) : (
          <>
            {permanentPlayers.length > 0 && (
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
                gap: '0.75rem'
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
            marginTop: permanentPlayers.length > 0 ? '0.75rem' : '0',
            padding: '0.5rem',
            border: '2px dashed var(--border)',
            borderRadius: '8px',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontSize: '0.85rem',
            cursor: 'pointer'
          }}
        >
          + Add Player
        </button>
      </div>

      {/* Guest Players Section */}
      {guestPlayers.length > 0 && (
        <div className="card" style={{ padding: '0.75rem', marginBottom: '0.75rem' }}>
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
              👤 Guest Players ({guestPlayers.length})
            </span>
            <span style={{ fontSize: '1.2rem', color: 'var(--text-muted)' }}>
              {showGuests ? '▲' : '▼'}
            </span>
          </button>
          
          {showGuests && (
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
              gap: '0.75rem',
              marginTop: '0.75rem'
            }}>
              {guestPlayers.map(renderPlayerTile)}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
        <button 
          className="btn btn-secondary btn-lg"
          onClick={handleShowForecast}
          disabled={selectedIds.size < 2}
          style={{ padding: '0.875rem', flex: '1' }}
        >
          🔮 Forecast
        </button>
        <button 
          className="btn btn-primary btn-lg"
          onClick={handleStartGame}
          disabled={selectedIds.size < 2}
          style={{ padding: '0.875rem', flex: '2' }}
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
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setNewPlayerType('guest')}
                  style={{
                    flex: 1,
                    padding: '0.6rem',
                    borderRadius: '8px',
                    border: newPlayerType === 'guest' ? '2px solid var(--primary)' : '2px solid var(--border)',
                    background: newPlayerType === 'guest' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: newPlayerType === 'guest' ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    fontWeight: '600',
                    fontSize: '0.9rem'
                  }}
                >
                  👤 Guest
                </button>
                <button
                  type="button"
                  onClick={() => setNewPlayerType('permanent')}
                  style={{
                    flex: 1,
                    padding: '0.6rem',
                    borderRadius: '8px',
                    border: newPlayerType === 'permanent' ? '2px solid var(--primary)' : '2px solid var(--border)',
                    background: newPlayerType === 'permanent' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: newPlayerType === 'permanent' ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    fontWeight: '600',
                    fontSize: '0.9rem'
                  }}
                >
                  ⭐ Permanent
                </button>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
                {newPlayerType === 'guest' 
                  ? 'Guest players appear in a separate section' 
                  : 'Permanent players always appear in the main list'}
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
                const { player, expected, sentence, gamesPlayed } = forecast;
                const isWinner = expected > 20;
                const isLoser = expected < -20;
                
                return (
                  <div 
                    key={player.id}
                    style={{
                      padding: '0.75rem',
                      marginBottom: '0.5rem',
                      borderRadius: '10px',
                      background: isWinner 
                        ? 'rgba(34, 197, 94, 0.1)' 
                        : isLoser 
                          ? 'rgba(239, 68, 68, 0.1)' 
                          : 'rgba(100, 100, 100, 0.1)',
                      borderLeft: `4px solid ${isWinner ? 'var(--success)' : isLoser ? 'var(--danger)' : 'var(--text-muted)'}`
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                      <span style={{ fontWeight: '600', fontSize: '1rem' }}>
                        {index === 0 && expected > 0 && '👑 '}
                        {player.name}
                      </span>
                      <span style={{ 
                        fontWeight: '700', 
                        fontSize: '1rem',
                        color: isWinner ? 'var(--success)' : isLoser ? 'var(--danger)' : 'var(--text)'
                      }}>
                        {expected >= 0 ? '+' : ''}₪{expected}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                      {sentence}
                    </div>
                    {gamesPlayed > 0 && (
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.25rem', opacity: 0.7 }}>
                        Based on {gamesPlayed} game{gamesPlayed > 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center', marginBottom: '1rem' }}>
              ⚠️ Forecast based on historical averages. Actual results may vary! 🎲
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
