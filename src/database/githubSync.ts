/**
 * GitHub Sync Module
 * Handles uploading and downloading poker data to/from GitHub
 * 
 * Sync behavior:
 * - Admin uploads full data after game end, deletion, or player changes
 * - Users pull from cloud when remote is newer; completed games merge by id (local-only completed are kept)
 * - Players are synced: types, names, additions from cloud are authoritative
 * - Version tracking prevents unnecessary syncs
 */

import { Player, Game, GamePlayer, PendingForecast, TrainingPool, TrainingAnswersFile, TrainingInsightsFile, PoolScenario } from '../types';
import { getEmbeddedToken } from './embeddedToken';
import { ChronicleEntry, GraphInsightsEntry } from './storage';
import { USE_SUPABASE } from './config';
import { supabase } from './supabaseClient';
import { getGroupId } from './supabaseCache';

// GitHub repository info
export const GITHUB_OWNER = 'LiorMoldovan';
export const GITHUB_REPO = 'poker-manager';
const GITHUB_FILE_PATH = 'public/sync-data.json';
const GITHUB_BACKUP_PATH = 'public/full-backup.json';  // Full backup file
const GITHUB_TRAINING_PATH = 'public/training-data.json';  // Training progress (admin only)
export const GITHUB_ACTIVITY_PATH = 'public/activity-log.json';  // User activity log
export const GITHUB_TRAINING_POOL_PATH = 'public/training-pool.json';
export const GITHUB_TRAINING_ANSWERS_PATH = 'public/training-answers.json';
export const GITHUB_TRAINING_INSIGHTS_PATH = 'public/training-insights.json';
export const GITHUB_BRANCH = 'main';

// Storage keys
const GITHUB_TOKEN_KEY = 'poker_github_token';
const LAST_SYNCED_VERSION_KEY = 'poker_last_synced_version';

// Sync data structure
export interface SyncData {
  players: Player[];
  games: Game[];
  gamePlayers: GamePlayer[];
  lastUpdated: string;
  updatedBy: string;
  chronicleProfiles?: Record<string, ChronicleEntry>;
  graphInsights?: Record<string, GraphInsightsEntry>;
  pendingForecast?: PendingForecast | null;
}

// Get stored GitHub token
export const getGitHubToken = (): string | null => {
  return localStorage.getItem(GITHUB_TOKEN_KEY);
};

// Get effective token (stored or embedded based on role)
export const getEffectiveToken = (useMemberSyncToken: boolean = false): string | null => {
  // First check localStorage (admin configured token)
  const storedToken = getGitHubToken();
  if (storedToken) {
    return storedToken;
  }
  
  // If memberSync role, use embedded token
  if (useMemberSyncToken) {
    const embeddedToken = getEmbeddedToken();
    if (embeddedToken) {
      return embeddedToken;
    }
  }
  
  return null;
};

// Save GitHub token
export const saveGitHubToken = (token: string): void => {
  localStorage.setItem(GITHUB_TOKEN_KEY, token);
};

// Remove GitHub token
export const removeGitHubToken = (): void => {
  localStorage.removeItem(GITHUB_TOKEN_KEY);
};

// Get last synced version
const getLastSyncedVersion = (): string | null => {
  return localStorage.getItem(LAST_SYNCED_VERSION_KEY);
};

// Save last synced version
const saveLastSyncedVersion = (version: string): void => {
  localStorage.setItem(LAST_SYNCED_VERSION_KEY, version);
};

export const fetchFromGitHub = async (): Promise<SyncData | null> => {
  try {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}?ref=${GITHUB_BRANCH}`;
    
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
    };
    const token = getEffectiveToken(true);
    if (token) {
      headers['Authorization'] = `token ${token}`;
    }

    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      if (response.status === 404) {
        console.log('Sync file not found on GitHub - first sync needed');
        return null;
      }
      throw new Error(`GitHub fetch failed: ${response.status}`);
    }
    
    const fileInfo = await response.json();
    
    // Decode base64 content (GitHub returns with newlines, need to remove them)
    // Also properly handle UTF-8 characters (Hebrew names)
    const base64Clean = fileInfo.content.replace(/\n/g, '');
    const binaryString = atob(base64Clean);
    // Convert binary string to UTF-8
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const content = new TextDecoder('utf-8').decode(bytes);
    const data = JSON.parse(content);
    
    console.log('Fetched from GitHub:', data.lastUpdated, 'games:', data.games?.length);
    return data as SyncData;
  } catch (error) {
    console.error('Error fetching from GitHub:', error);
    return null;
  }
};

// Upload data to GitHub (requires auth token)
export const uploadToGitHub = async (
  token: string,
  data: SyncData
): Promise<{ success: boolean; message: string }> => {
  try {
    // First, get the current file SHA (needed for updates)
    const getFileUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
    
    let fileSha: string | undefined;
    
    const getResponse = await fetch(getFileUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    });
    
    if (getResponse.ok) {
      const fileInfo = await getResponse.json();
      fileSha = fileInfo.sha;
    }
    
    // Prepare the content
    const content = JSON.stringify(data, null, 2);
    const contentBase64 = btoa(unescape(encodeURIComponent(content)));
    
    // Create or update the file
    const putResponse = await fetch(getFileUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `Sync poker data - ${new Date().toLocaleString()}`,
        content: contentBase64,
        sha: fileSha,
        branch: GITHUB_BRANCH,
      }),
    });
    
    if (!putResponse.ok) {
      const error = await putResponse.json();
      throw new Error(error.message || 'Upload failed');
    }
    
    // Save our own version so we don't re-sync our own upload
    saveLastSyncedVersion(data.lastUpdated);
    
    return { success: true, message: 'Data synced to cloud!' };
  } catch (error) {
    console.error('Error uploading to GitHub:', error);
    return { 
      success: false, 
      message: error instanceof Error ? error.message : 'Upload failed' 
    };
  }
};

// Full backup data structure (includes everything)
export interface FullBackupData {
  id: string;
  date: string;
  type: 'auto' | 'manual';
  trigger?: 'friday' | 'game-end';
  players: Player[];
  games: Game[];
  gamePlayers: GamePlayer[];
  chipValues: unknown[];
  settings: unknown;
  uploadedAt?: string;
}

export const fetchBackupFromGitHub = async (): Promise<FullBackupData | null> => {
  try {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_BACKUP_PATH}?ref=${GITHUB_BRANCH}`;
    const headers: Record<string, string> = { 'Accept': 'application/vnd.github.v3+json' };
    const token = getEffectiveToken(true);
    if (token) headers['Authorization'] = `token ${token}`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`GitHub fetch failed: ${response.status}`);
    }

    const fileInfo = await response.json();
    const base64Clean = fileInfo.content.replace(/\n/g, '');
    const binaryString = atob(base64Clean);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const content = new TextDecoder('utf-8').decode(bytes);
    const data = JSON.parse(content);

    console.log('Fetched backup from GitHub:', data.games?.length, 'games');
    return data as FullBackupData;
  } catch (error) {
    console.error('Error fetching backup from GitHub:', error);
    return null;
  }
};

// Upload full backup to GitHub (separate from sync data)
export const uploadBackupToGitHub = async (
  backup: FullBackupData,
  useMemberSyncToken: boolean = false
): Promise<{ success: boolean; message: string }> => {
  const token = getEffectiveToken(useMemberSyncToken);
  
  if (!token) {
    return { success: false, message: 'No GitHub token - backup saved locally only' };
  }

  try {
    // Get the current file SHA (needed for updates)
    const getFileUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_BACKUP_PATH}`;
    
    let fileSha: string | undefined;
    
    const getResponse = await fetch(getFileUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    });
    
    if (getResponse.ok) {
      const fileInfo = await getResponse.json();
      fileSha = fileInfo.sha;
    }
    
    // Add upload timestamp
    const backupWithTimestamp = {
      ...backup,
      uploadedAt: new Date().toISOString(),
    };
    
    // Prepare the content
    const content = JSON.stringify(backupWithTimestamp, null, 2);
    const contentBase64 = btoa(unescape(encodeURIComponent(content)));
    
    // Create or update the file
    const putResponse = await fetch(getFileUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `Full backup - ${new Date().toLocaleString()}`,
        content: contentBase64,
        sha: fileSha,
        branch: GITHUB_BRANCH,
      }),
    });
    
    if (!putResponse.ok) {
      const error = await putResponse.json();
      throw new Error(error.message || 'Backup upload failed');
    }
    
    console.log('✅ Full backup uploaded to GitHub');
    return { success: true, message: 'Backup also saved to cloud!' };
  } catch (error) {
    console.error('Error uploading backup to GitHub:', error);
    return { 
      success: false, 
      message: error instanceof Error ? error.message : 'Cloud backup failed (local backup saved)' 
    };
  }
};

// Get current local data for sync
// IMPORTANT: Only includes COMPLETED games to prevent test/incomplete games from being synced
export const getLocalSyncData = (): SyncData => {
  const players: Player[] = JSON.parse(localStorage.getItem('poker_players') || '[]');
  const allGames: Game[] = JSON.parse(localStorage.getItem('poker_games') || '[]');
  const allGamePlayers: GamePlayer[] = JSON.parse(localStorage.getItem('poker_game_players') || '[]');
  
  // Filter to only completed games
  const completedGames = allGames.filter(g => g.status === 'completed');
  const completedGameIds = new Set(completedGames.map(g => g.id));
  
  // Only include gamePlayers for completed games
  const completedGamePlayers = allGamePlayers.filter(gp => completedGameIds.has(gp.gameId));
  
  // Include AI-generated chronicle profiles
  const chronicleRaw = localStorage.getItem('poker_chronicle_profiles');
  const chronicleProfiles: Record<string, ChronicleEntry> | undefined = chronicleRaw ? JSON.parse(chronicleRaw) : undefined;
  
  // Include AI-generated graph insights
  const graphInsightsRaw = localStorage.getItem('poker_graph_insights');
  const graphInsights: Record<string, GraphInsightsEntry> | undefined = graphInsightsRaw ? JSON.parse(graphInsightsRaw) : undefined;
  
  console.log(`Sync data: ${completedGames.length} completed games (${allGames.length - completedGames.length} incomplete games excluded)`);
  
  const pendingForecastRaw = localStorage.getItem('poker_pending_forecast');
  const pendingForecast: PendingForecast | null = pendingForecastRaw ? JSON.parse(pendingForecastRaw) : null;

  return {
    players,
    games: completedGames,
    gamePlayers: completedGamePlayers,
    lastUpdated: new Date().toISOString(),
    updatedBy: 'admin',
    chronicleProfiles,
    graphInsights,
    pendingForecast,
  };
};

const gamePlayerRowKey = (gp: GamePlayer): string => `${gp.gameId}|${gp.id}`;

/** Merge remote completed games with local-only completed + in-progress games (live / chip_entry). */
const replaceGamesWithRemote = (
  remoteData: SyncData
): { gamesChanged: number; deletedGames: number; newPlayers: number; playersChanged: number; reattachedLocalCompleted: number } => {
  const localGames: Game[] = JSON.parse(localStorage.getItem('poker_games') || '[]');
  const localGamePlayers: GamePlayer[] = JSON.parse(localStorage.getItem('poker_game_players') || '[]');
  const localPlayers: Player[] = JSON.parse(localStorage.getItem('poker_players') || '[]');

  const remoteGameIds = new Set(remoteData.games.map(g => g.id));
  const localGameIds = new Set(localGames.map(g => g.id));

  const localOnlyCompleted = localGames.filter(g => g.status === 'completed' && !remoteGameIds.has(g.id));
  const localIncomplete = localGames.filter(g => g.status === 'live' || g.status === 'chip_entry');
  const localOnlyGameIds = new Set(localOnlyCompleted.map(g => g.id));
  const extraGamePlayers = localGamePlayers.filter(gp => localOnlyGameIds.has(gp.gameId));

  const seenGpKeys = new Set<string>();
  const allGamePlayersForPlayerSync: GamePlayer[] = [];
  for (const gp of remoteData.gamePlayers) {
    const k = gamePlayerRowKey(gp);
    if (!seenGpKeys.has(k)) {
      seenGpKeys.add(k);
      allGamePlayersForPlayerSync.push(gp);
    }
  }
  for (const gp of extraGamePlayers) {
    const k = gamePlayerRowKey(gp);
    if (!seenGpKeys.has(k)) {
      seenGpKeys.add(k);
      allGamePlayersForPlayerSync.push(gp);
    }
  }

  const newGamesCount = remoteData.games.filter(g => !localGameIds.has(g.id)).length;
  const deletedGames = 0;

  const localPlayerByName = new Map(localPlayers.map(p => [p.name.toLowerCase(), p]));

  let newPlayers = 0;
  let playersChanged = 0;
  const syncedPlayerNames = new Set<string>();

  // First pass: sync players referenced in gamePlayers (remote + local-only completed)
  for (const gp of allGamePlayersForPlayerSync) {
    const playerNameLower = gp.playerName.toLowerCase();
    
    if (syncedPlayerNames.has(playerNameLower)) {
      continue;
    }
    syncedPlayerNames.add(playerNameLower);
    
    const localPlayer = localPlayerByName.get(playerNameLower);
    const remotePlayer = remoteData.players.find(p => p.name.toLowerCase() === playerNameLower);
    
    if (localPlayer) {
      if (localPlayer.id !== gp.playerId) {
        localPlayer.id = gp.playerId;
        playersChanged++;
      }
      if (remotePlayer?.type && localPlayer.type !== remotePlayer.type) {
        localPlayer.type = remotePlayer.type;
        playersChanged++;
      }
      if (remotePlayer?.gender && localPlayer.gender !== remotePlayer.gender) {
        localPlayer.gender = remotePlayer.gender;
        playersChanged++;
      }
    } else {
      localPlayers.push({
        id: gp.playerId,
        name: gp.playerName,
        createdAt: remotePlayer?.createdAt || new Date().toISOString(),
        type: remotePlayer?.type || 'permanent',
        gender: remotePlayer?.gender || 'male',
      });
      localPlayerByName.set(playerNameLower, localPlayers[localPlayers.length - 1]);
      newPlayers++;
    }
  }
  
  // Second pass: sync ALL players from remote (covers players without completed games)
  for (const remotePlayer of remoteData.players) {
    const nameKey = remotePlayer.name.toLowerCase();
    if (syncedPlayerNames.has(nameKey)) {
      continue;
    }
    syncedPlayerNames.add(nameKey);
    
    const localPlayer = localPlayerByName.get(nameKey);
    if (localPlayer) {
      if (localPlayer.id !== remotePlayer.id) {
        localPlayer.id = remotePlayer.id;
        playersChanged++;
      }
      if (remotePlayer.type && localPlayer.type !== remotePlayer.type) {
        localPlayer.type = remotePlayer.type;
        playersChanged++;
      }
      if (remotePlayer.gender && localPlayer.gender !== remotePlayer.gender) {
        localPlayer.gender = remotePlayer.gender;
        playersChanged++;
      }
    } else {
      localPlayers.push({
        id: remotePlayer.id,
        name: remotePlayer.name,
        createdAt: remotePlayer.createdAt || new Date().toISOString(),
        type: remotePlayer.type || 'permanent',
        gender: remotePlayer.gender || 'male',
      });
      newPlayers++;
    }
  }
  
  const localGameMap = new Map(localGames.map(g => [g.id, g]));
  const mergedCompleted: Game[] = remoteData.games.map(remoteGame => {
    const localGame = localGameMap.get(remoteGame.id);
    if (localGame) {
      if (!remoteGame.aiSummary && localGame.aiSummary) {
        remoteGame.aiSummary = localGame.aiSummary;
      }
      if (!remoteGame.forecastComment && localGame.forecastComment) {
        remoteGame.forecastComment = localGame.forecastComment;
      }
    }
    return remoteGame;
  });

  for (const g of localOnlyCompleted) {
    mergedCompleted.push({ ...g });
  }

  mergedCompleted.sort((a, b) => {
    const tb = new Date(b.date || b.createdAt).getTime();
    const ta = new Date(a.date || a.createdAt).getTime();
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });

  const mergedGames = [...mergedCompleted, ...localIncomplete];

  const mergedGpKeys = new Set(remoteData.gamePlayers.map(gamePlayerRowKey));
  const mergedGamePlayers: GamePlayer[] = [...remoteData.gamePlayers];
  for (const gp of extraGamePlayers) {
    const k = gamePlayerRowKey(gp);
    if (!mergedGpKeys.has(k)) {
      mergedGpKeys.add(k);
      mergedGamePlayers.push(gp);
    }
  }

  localStorage.setItem('poker_players', JSON.stringify(localPlayers));
  localStorage.setItem('poker_games', JSON.stringify(mergedGames));
  localStorage.setItem('poker_game_players', JSON.stringify(mergedGamePlayers));
  
  // Sync chronicle profiles from cloud (cloud is authoritative)
  if (remoteData.chronicleProfiles) {
    localStorage.setItem('poker_chronicle_profiles', JSON.stringify(remoteData.chronicleProfiles));
  }
  
  // Sync graph insights from cloud (cloud is authoritative)
  if (remoteData.graphInsights) {
    localStorage.setItem('poker_graph_insights', JSON.stringify(remoteData.graphInsights));
  }

  // Sync pending forecast from cloud (always use cloud version — admin is authoritative)
  if (remoteData.pendingForecast) {
    localStorage.setItem('poker_pending_forecast', JSON.stringify(remoteData.pendingForecast));
  } else {
    localStorage.removeItem('poker_pending_forecast');
  }

  const gamesChanged = newGamesCount + localOnlyCompleted.length;

  return {
    gamesChanged,
    deletedGames,
    newPlayers,
    playersChanged,
    reattachedLocalCompleted: localOnlyCompleted.length,
  };
};

// Sync from cloud - full replacement, but only if version is different
export const syncFromCloud = async (): Promise<{
  success: boolean;
  message: string;
  synced: boolean;
  gamesChanged?: number;
  playersChanged?: number;
}> => {
  if (USE_SUPABASE) {
    return { success: true, message: 'Supabase mode — data synced via Realtime', synced: false };
  }
  try {
    const remoteData = await fetchFromGitHub();
    
    if (!remoteData) {
      console.log('No remote data available');
      return { success: true, message: 'No cloud data available yet', synced: false };
    }
    
    const lastSyncedVersion = getLastSyncedVersion();
    const localSyncData = getLocalSyncData();
    const localCompletedCount = localSyncData.games.length;
    const remoteCompletedCount = remoteData.games?.length || 0;

    console.log('Sync check - local version:', lastSyncedVersion, 'remote version:', remoteData.lastUpdated);
    console.log(`Local: ${localCompletedCount} completed games, Remote: ${remoteCompletedCount} completed games`);
    
    // If local has more completed games than remote, push local data up
    // This handles the case where a game was saved locally but sync failed (e.g. no reception)
    if (localCompletedCount > remoteCompletedCount) {
      console.log(`Local has ${localCompletedCount - remoteCompletedCount} more games than cloud - pushing local data up`);
      const token = getEffectiveToken(true);
      if (token) {
        await uploadToGitHub(token, localSyncData);
        console.log('✅ Pushed local data to cloud');
      }
      return { success: true, message: `${localCompletedCount - remoteCompletedCount} new games pushed to cloud`, synced: true, gamesChanged: 0 };
    }

    const localCompletedIds = new Set(localSyncData.games.map(g => g.id));
    const localHasEveryRemoteGame = remoteData.games.every(g => localCompletedIds.has(g.id));

    if (
      lastSyncedVersion === remoteData.lastUpdated
      && remoteCompletedCount <= localCompletedCount
      && localHasEveryRemoteGame
    ) {
      console.log('Already synced to latest version');
      return { success: true, message: 'Already up to date', synced: false };
    }

    if (!localHasEveryRemoteGame) {
      console.log('Sync: same version or count but local is missing remote game ids — merging');
    }
    
    console.log('New version available - syncing...');

    const mergeResult = replaceGamesWithRemote(remoteData);
    const { gamesChanged, deletedGames, newPlayers, playersChanged, reattachedLocalCompleted } = mergeResult;
    console.log('Sync result - gamesChanged:', gamesChanged, 'deleted:', deletedGames, 'newPlayers:', newPlayers, 'playersChanged:', playersChanged, 'reattachedLocal:', reattachedLocalCompleted);

    if (reattachedLocalCompleted > 0) {
      const token = getEffectiveToken(true);
      if (token) {
        const uploadResult = await uploadToGitHub(token, getLocalSyncData());
        if (!uploadResult.success) {
          saveLastSyncedVersion(remoteData.lastUpdated);
        }
      } else {
        saveLastSyncedVersion(remoteData.lastUpdated);
      }
    } else {
      saveLastSyncedVersion(remoteData.lastUpdated);
    }
    
    const totalPlayerChanges = newPlayers + playersChanged;
    let message = '';
    if (gamesChanged === 0 && totalPlayerChanges === 0) {
      message = 'Synced (no changes)';
    } else {
      const parts: string[] = [];
      if (gamesChanged > 0) {
        if (deletedGames > 0) {
          parts.push(`${gamesChanged} games updated`);
        } else {
          parts.push(`${gamesChanged} new games`);
        }
      }
      if (newPlayers > 0) {
        parts.push(`${newPlayers} new players`);
      }
      if (playersChanged > 0) {
        parts.push(`${playersChanged} players updated`);
      }
      message = parts.join(', ');
    }

    if (reattachedLocalCompleted > 0) {
      const note = `שוחזרו ${reattachedLocalCompleted} משחק(ים) שהיו רק במכשיר (לא בקובץ הענן)`;
      message = message ? `${message} — ${note}` : note;
    }

    return {
      success: true,
      message,
      synced: true,
      gamesChanged,
      playersChanged: totalPlayerChanges,
    };
  } catch (error) {
    console.error('Sync error:', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Sync failed',
      synced: false,
    };
  }
};

// Upload current data to cloud (for admin or memberSync)
export const syncToCloud = async (useMemberSyncToken: boolean = false): Promise<{
  success: boolean;
  message: string;
}> => {
  if (USE_SUPABASE) {
    return { success: true, message: 'Supabase mode — data persisted via cache' };
  }
  const token = getEffectiveToken(useMemberSyncToken);
  
  if (!token) {
    return { success: false, message: 'No GitHub token configured' };
  }
  
  const data = getLocalSyncData();
  return await uploadToGitHub(token, data);
};

// ════════════════════════════════════════════════════════════
// TRAINING DATA SYNC (Admin only)
// ════════════════════════════════════════════════════════════

const TRAINING_STORAGE_KEY = 'poker_training_progress';

export const uploadTrainingToGitHub = async (): Promise<{ success: boolean; message: string }> => {
  const token = getEffectiveToken(false);
  if (!token) {
    return { success: false, message: 'No GitHub token' };
  }

  const raw = localStorage.getItem(TRAINING_STORAGE_KEY);
  if (!raw) {
    return { success: false, message: 'No training data to sync' };
  }

  try {
    const trainingData = JSON.parse(raw);
    const payload = {
      ...trainingData,
      lastSynced: new Date().toISOString(),
    };

    const getFileUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_TRAINING_PATH}`;
    let fileSha: string | undefined;

    const getResponse = await fetch(getFileUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (getResponse.ok) {
      const fileInfo = await getResponse.json();
      fileSha = fileInfo.sha;
    }

    const content = JSON.stringify(payload, null, 2);
    const contentBase64 = btoa(unescape(encodeURIComponent(content)));

    const putResponse = await fetch(getFileUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `Training data sync - ${new Date().toLocaleString()}`,
        content: contentBase64,
        sha: fileSha,
        branch: GITHUB_BRANCH,
      }),
    });

    if (!putResponse.ok) {
      const error = await putResponse.json();
      throw new Error(error.message || 'Training upload failed');
    }

    console.log('✅ Training data synced to GitHub');
    return { success: true, message: 'Training data saved to cloud' };
  } catch (error) {
    console.error('Error uploading training data:', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Training sync failed',
    };
  }
};

export const fetchTrainingFromGitHub = async (): Promise<Record<string, unknown> | null> => {
  try {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_TRAINING_PATH}?ref=${GITHUB_BRANCH}`;
    const headers: Record<string, string> = { 'Accept': 'application/vnd.github.v3+json' };
    const tkn = getEffectiveToken(true);
    if (tkn) headers['Authorization'] = `token ${tkn}`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`GitHub fetch failed: ${response.status}`);
    }

    const fileInfo = await response.json();
    const base64Clean = fileInfo.content.replace(/\n/g, '');
    const binaryString = atob(base64Clean);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const content = new TextDecoder('utf-8').decode(bytes);
    return JSON.parse(content);
  } catch (error) {
    console.error('Error fetching training data from GitHub:', error);
    return null;
  }
};

const TRAINING_LAST_SYNC_KEY = 'poker_training_last_sync';
const TRAINING_SYNCED_DECISIONS_KEY = 'poker_training_synced_decisions';
const SYNC_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
const MIN_NEW_DECISIONS_TO_SYNC = 30;

export const restoreTrainingFromGitHub = async (): Promise<{ success: boolean; restored: boolean; message: string }> => {
  try {
    const remoteData = await fetchTrainingFromGitHub();

    const localRaw = localStorage.getItem(TRAINING_STORAGE_KEY);
    const localData = localRaw ? JSON.parse(localRaw) : null;

    const localSessions = localData?.sessions?.length || 0;
    const localDecisions = localData?.totalDecisions || 0;

    if (remoteData) {
      const remoteSessions = (remoteData.sessions as unknown[])?.length || 0;
      const remoteDecisions = (remoteData.totalDecisions as number) || 0;

      if (remoteDecisions > localDecisions || remoteSessions > localSessions) {
        const { lastSynced: _, ...dataToRestore } = remoteData;
        localStorage.setItem(TRAINING_STORAGE_KEY, JSON.stringify(dataToRestore));
        console.log(`✅ Training data restored from cloud (${remoteSessions} sessions, ${remoteDecisions} decisions)`);
        return { success: true, restored: true, message: `Training data restored (${remoteSessions} sessions)` };
      }
    }

    if (localDecisions > 0) {
      const lastSync = Number(localStorage.getItem(TRAINING_LAST_SYNC_KEY) || '0');
      const syncedDecisions = Number(localStorage.getItem(TRAINING_SYNCED_DECISIONS_KEY) || '0');
      const newDecisions = localDecisions - syncedDecisions;
      const enoughTime = Date.now() - lastSync > SYNC_INTERVAL_MS;
      const enoughData = newDecisions >= MIN_NEW_DECISIONS_TO_SYNC;

      if (enoughTime && enoughData) {
        uploadTrainingToGitHub().then(() => {
          localStorage.setItem(TRAINING_LAST_SYNC_KEY, String(Date.now()));
          localStorage.setItem(TRAINING_SYNCED_DECISIONS_KEY, String(localDecisions));
          console.log(`✅ Training sync completed (${newDecisions} new decisions)`);
        }).catch(err => console.warn('Training sync failed:', err));
      }
    }

    return { success: true, restored: false, message: 'Local training data is up to date' };
  } catch (error) {
    console.error('Error restoring training data:', error);
    return { success: false, restored: false, message: 'Failed to restore training data' };
  }
};

// ════════════════════════════════════════════════════════════
// SHARED TRAINING POOL SYNC
// ════════════════════════════════════════════════════════════

const decodeGitHubContent = (fileInfo: { content: string }): string => {
  const base64Clean = fileInfo.content.replace(/\n/g, '');
  const binaryString = atob(base64Clean);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
};

const uploadGitHubFile = async (
  token: string,
  path: string,
  data: unknown,
  message: string,
  keepalive = false
): Promise<{ success: boolean; message: string }> => {
  try {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
    let sha: string | undefined;

    const getResp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' },
      keepalive,
    });
    if (getResp.ok) {
      sha = (await getResp.json()).sha;
    }

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
    const putResp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, content, sha, branch: GITHUB_BRANCH }),
      keepalive,
    });

    if (!putResp.ok) {
      const err = await putResp.json();
      throw new Error(err.message || `Upload failed: ${putResp.status}`);
    }
    return { success: true, message: 'OK' };
  } catch (error) {
    console.error(`Error uploading ${path}:`, error);
    return { success: false, message: error instanceof Error ? error.message : 'Upload failed' };
  }
};

const fetchGitHubJson = async <T>(path: string, token?: string): Promise<T | null> => {
  try {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`;
    const headers: Record<string, string> = { 'Accept': 'application/vnd.github.v3+json' };
    const effectiveToken = token || getEffectiveToken(true);
    if (effectiveToken) headers['Authorization'] = `token ${effectiveToken}`;

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      if (resp.status === 404) return null;
      throw new Error(`GitHub fetch failed: ${resp.status}`);
    }
    const fileInfo = await resp.json();

    // Files >1MB have no inline content — use the Blob API instead
    if (fileInfo.content) {
      return JSON.parse(decodeGitHubContent(fileInfo)) as T;
    }
    if (fileInfo.sha) {
      const blobUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs/${fileInfo.sha}`;
      const blobResp = await fetch(blobUrl, { headers });
      if (!blobResp.ok) throw new Error(`Blob fetch failed: ${blobResp.status}`);
      const blob = await blobResp.json();
      return JSON.parse(decodeGitHubContent(blob)) as T;
    }
    throw new Error('No content or sha in GitHub response');
  } catch (error) {
    console.error(`Error fetching ${path}:`, error);
    return null;
  }
};

export const uploadTrainingPool = async (pool: TrainingPool): Promise<{ success: boolean; message: string }> => {
  if (USE_SUPABASE) {
    const gid = getGroupId();
    if (!gid) return { success: false, message: 'No active group' };
    await supabase.from('training_pool').delete().eq('group_id', gid);
    if (pool.scenarios.length > 0) {
      const rows = pool.scenarios.map(s => ({
        group_id: gid,
        scenario_id: s.poolId,
        category: s.category,
        category_id: s.categoryId,
        scenario: s,
        reviewed_at: s.reviewedAt || null,
      }));
      for (let i = 0; i < rows.length; i += 50) {
        const { error } = await supabase.from('training_pool').insert(rows.slice(i, i + 50));
        if (error) return { success: false, message: error.message };
      }
    }
    return { success: true, message: `${pool.totalScenarios} scenarios uploaded` };
  }
  const token = getEffectiveToken(false);
  if (!token) return { success: false, message: 'No GitHub token' };
  return uploadGitHubFile(token, GITHUB_TRAINING_POOL_PATH, pool, `Training pool update - ${pool.totalScenarios} scenarios`);
};

export const fetchTrainingPool = async (): Promise<TrainingPool | null> => {
  if (USE_SUPABASE) {
    const gid = getGroupId();
    if (!gid) return null;
    // Paginate to avoid the 1000-row default limit
    const allRows: Record<string, unknown>[] = [];
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('training_pool')
        .select('*')
        .eq('group_id', gid)
        .range(offset, offset + PAGE - 1);
      if (error) { console.warn('fetchTrainingPool error:', error.message); break; }
      if (!data || data.length === 0) break;
      allRows.push(...(data as Record<string, unknown>[]));
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    if (allRows.length === 0) return null;
    const scenarios: PoolScenario[] = allRows.map(row => ({
      ...(row.scenario as Record<string, unknown>),
      poolId: row.scenario_id as string,
      categoryId: row.category_id as string,
      category: row.category as string,
    } as PoolScenario));
    const byCategory: Record<string, number> = {};
    scenarios.forEach(s => { byCategory[s.categoryId] = (byCategory[s.categoryId] || 0) + 1; });
    const latestCreatedAt = allRows.reduce((max, row) => {
      const t = (row.created_at as string) || '';
      return t > max ? t : max;
    }, '');
    return {
      generatedAt: latestCreatedAt || new Date().toISOString(),
      totalScenarios: scenarios.length,
      byCategory,
      scenarios,
    };
  }
  const token = getEffectiveToken(true);
  return fetchGitHubJson<TrainingPool>(GITHUB_TRAINING_POOL_PATH, token || undefined);
};

export const fetchTrainingAnswers = async (): Promise<TrainingAnswersFile | null> => {
  if (USE_SUPABASE) {
    const gid = getGroupId();
    if (!gid) return null;
    const { data: rows } = await supabase.from('training_answers').select('*').eq('group_id', gid);
    if (!rows || rows.length === 0) return { lastUpdated: '', players: [] };
    return {
      lastUpdated: rows.reduce((latest, r) => ((r.updated_at as string) || '') > latest ? (r.updated_at as string) : latest, ''),
      players: rows.map(row => {
        const stats = (row.stats || {}) as Record<string, unknown>;
        return {
          playerName: row.player_name as string,
          sessions: (row.sessions || []) as TrainingAnswersFile['players'][0]['sessions'],
          totalQuestions: (stats.totalQuestions as number) || 0,
          totalCorrect: (stats.totalCorrect as number) || 0,
          accuracy: (stats.accuracy as number) || 0,
          reports: (row.reports || []) as TrainingAnswersFile['players'][0]['reports'],
          pendingReportMilestones: (stats.pendingReportMilestones as number[]) || [],
        };
      }),
    };
  }
  const token = getEffectiveToken(true);
  return fetchGitHubJson<TrainingAnswersFile>(GITHUB_TRAINING_ANSWERS_PATH, token || undefined);
};

export const fetchTrainingInsights = async (): Promise<TrainingInsightsFile | null> => {
  if (USE_SUPABASE) {
    const gid = getGroupId();
    if (!gid) return null;
    const { data: rows } = await supabase.from('training_insights').select('*').eq('group_id', gid);
    if (!rows || rows.length === 0) return { lastUpdated: '', insights: {} };
    const insights: TrainingInsightsFile['insights'] = {};
    for (const row of rows) {
      const data = row.insights as Record<string, unknown>;
      insights[row.player_name as string] = {
        generatedAt: (data.generatedAt as string) || '',
        sessionsAtGeneration: (data.sessionsAtGeneration as number) || 0,
        improvement: (data.improvement as string) || '',
      };
    }
    return {
      lastUpdated: rows.reduce((latest, r) => ((r.updated_at as string) || '') > latest ? (r.updated_at as string) : latest, ''),
      insights,
    };
  }
  const token = getEffectiveToken(true);
  return fetchGitHubJson<TrainingInsightsFile>(GITHUB_TRAINING_INSIGHTS_PATH, token || undefined);
};

export const uploadTrainingInsights = async (data: TrainingInsightsFile): Promise<{ success: boolean; message: string }> => {
  if (USE_SUPABASE) {
    const gid = getGroupId();
    if (!gid) return { success: false, message: 'No active group' };
    for (const [playerName, insight] of Object.entries(data.insights)) {
      const { error } = await supabase.from('training_insights').upsert({
        group_id: gid,
        player_name: playerName,
        insights: insight,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'group_id,player_name' });
      if (error) return { success: false, message: error.message };
    }
    return { success: true, message: 'Insights uploaded' };
  }
  const token = getEffectiveToken(false);
  if (!token) return { success: false, message: 'No GitHub token' };
  return uploadGitHubFile(token, GITHUB_TRAINING_INSIGHTS_PATH, data, 'Training insights update');
};

export const writeTrainingAnswersWithRetry = async (
  mutate: (data: TrainingAnswersFile) => TrainingAnswersFile,
  _keepalive = false
): Promise<boolean> => {
  if (USE_SUPABASE) {
    const gid = getGroupId();
    if (!gid) return false;
    try {
      const existing = await fetchTrainingAnswers() || { lastUpdated: '', players: [] };
      const updated = mutate(existing);
      for (const player of updated.players) {
        await supabase.from('training_answers').upsert({
          group_id: gid,
          player_name: player.playerName,
          sessions: player.sessions,
          stats: {
            totalQuestions: player.totalQuestions,
            totalCorrect: player.totalCorrect,
            accuracy: player.accuracy,
            pendingReportMilestones: player.pendingReportMilestones,
          },
          reports: player.reports || [],
          updated_at: new Date().toISOString(),
        }, { onConflict: 'group_id,player_name' });
      }
      return true;
    } catch (err) {
      console.warn('Training answers Supabase write failed:', err);
      return false;
    }
  }
  const keepalive = _keepalive;
  const token = getEffectiveToken(true);
  if (!token) return false;

  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_TRAINING_ANSWERS_PATH}`;

  const fetchFile = async (): Promise<{ data: TrainingAnswersFile; sha: string | undefined }> => {
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' },
      keepalive,
    });
    if (!resp.ok) {
      return { data: { lastUpdated: new Date().toISOString(), players: [] }, sha: undefined };
    }
    const fileInfo = await resp.json();
    try {
      const parsed = JSON.parse(decodeGitHubContent(fileInfo)) as TrainingAnswersFile;
      return { data: parsed, sha: fileInfo.sha };
    } catch {
      return { data: { lastUpdated: new Date().toISOString(), players: [] }, sha: fileInfo.sha };
    }
  };

  const writeFile = async (data: TrainingAnswersFile, sha: string | undefined): Promise<boolean> => {
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'Training answers update', content, sha, branch: GITHUB_BRANCH }),
      keepalive,
    });
    return resp.ok;
  };

  try {
    const { data, sha } = await fetchFile();
    const updated = mutate(data);
    const ok = await writeFile(updated, sha);
    if (!ok) {
      const fresh = await fetchFile();
      const retryData = mutate(fresh.data);
      return await writeFile(retryData, fresh.sha);
    }
    return true;
  } catch (err) {
    console.warn('Training answers write failed:', err);
    return false;
  }
};

export const removeFromTrainingPool = async (poolIdsToRemove: string[]): Promise<{ success: boolean; message: string }> => {
  if (USE_SUPABASE) {
    const gid = getGroupId();
    if (!gid) return { success: false, message: 'No active group' };
    const { error } = await supabase.from('training_pool')
      .delete()
      .eq('group_id', gid)
      .in('scenario_id', poolIdsToRemove);
    if (error) return { success: false, message: error.message };
    const cached = localStorage.getItem('training_pool_cached');
    if (cached) {
      try {
        const pool = JSON.parse(cached) as TrainingPool;
        const removeSet = new Set(poolIdsToRemove);
        pool.scenarios = pool.scenarios.filter(s => !removeSet.has(s.poolId));
        pool.totalScenarios = pool.scenarios.length;
        pool.byCategory = {};
        pool.scenarios.forEach(s => { pool.byCategory[s.categoryId] = (pool.byCategory[s.categoryId] || 0) + 1; });
        pool.generatedAt = new Date().toISOString();
        localStorage.setItem('training_pool_cached', JSON.stringify(pool));
        localStorage.setItem('training_pool_generatedAt', pool.generatedAt);
      } catch { /* ignore */ }
    }
    return { success: true, message: `Removed ${poolIdsToRemove.length} scenarios` };
  }
  const token = getEffectiveToken(false);
  if (!token) return { success: false, message: 'No GitHub token' };

  const pool = await fetchTrainingPool();
  if (!pool) return { success: false, message: 'Could not fetch pool' };

  const removeSet = new Set(poolIdsToRemove);
  pool.scenarios = pool.scenarios.filter(s => !removeSet.has(s.poolId));
  pool.totalScenarios = pool.scenarios.length;
  pool.byCategory = {};
  pool.scenarios.forEach(s => {
    pool.byCategory[s.categoryId] = (pool.byCategory[s.categoryId] || 0) + 1;
  });
  pool.generatedAt = new Date().toISOString();

  const result = await uploadGitHubFile(token, GITHUB_TRAINING_POOL_PATH, pool, `Removed ${poolIdsToRemove.length} flagged scenarios`);

  if (result.success) {
    localStorage.setItem('training_pool_cached', JSON.stringify(pool));
    localStorage.setItem('training_pool_generatedAt', pool.generatedAt);
  }

  return result;
};
