/**
 * GitHub Sync Module
 * Handles uploading and downloading poker data to/from GitHub
 * 
 * Sync behavior:
 * - Admin uploads full data after game end, deletion, or player changes
 * - Users get full replacement on app open (if cloud version is newer)
 * - Players are synced: types, names, additions from cloud are authoritative
 * - Version tracking prevents unnecessary syncs
 */

import { Player, Game, GamePlayer } from '../types';
import { getEmbeddedToken } from './embeddedToken';

// GitHub repository info
const GITHUB_OWNER = 'LiorMoldovan';
const GITHUB_REPO = 'poker-manager';
const GITHUB_FILE_PATH = 'public/sync-data.json';
const GITHUB_BACKUP_PATH = 'public/full-backup.json';  // Full backup file
const GITHUB_TRAINING_PATH = 'public/training-data.json';  // Training progress (admin only)
const GITHUB_BRANCH = 'main';

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

// Fetch current data from GitHub (no auth needed for public repo)
export const fetchFromGitHub = async (): Promise<SyncData | null> => {
  try {
    // Use GitHub API to avoid CDN caching issues
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}?ref=${GITHUB_BRANCH}`;
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
      },
    });
    
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
  
  console.log(`Sync data: ${completedGames.length} completed games (${allGames.length - completedGames.length} incomplete games excluded)`);
  
  return {
    players,
    games: completedGames,
    gamePlayers: completedGamePlayers,
    lastUpdated: new Date().toISOString(),
    updatedBy: 'admin',
  };
};

// Full replacement of games and players from cloud (cloud is authoritative)
const replaceGamesWithRemote = (
  remoteData: SyncData
): { gamesChanged: number; deletedGames: number; newPlayers: number; playersChanged: number } => {
  const localGames: Game[] = JSON.parse(localStorage.getItem('poker_games') || '[]');
  const localPlayers: Player[] = JSON.parse(localStorage.getItem('poker_players') || '[]');
  
  // Calculate changes for reporting
  const remoteGameIds = new Set(remoteData.games.map(g => g.id));
  const localGameIds = new Set(localGames.map(g => g.id));
  
  const newGamesCount = remoteData.games.filter(g => !localGameIds.has(g.id)).length;
  const deletedGames = localGames.filter(g => !remoteGameIds.has(g.id)).length;
  const gamesChanged = newGamesCount + deletedGames;
  
  // Build a map of local players by name for quick lookup
  const localPlayerByName = new Map(localPlayers.map(p => [p.name.toLowerCase(), p]));
  
  // Sync players: remote player list is authoritative for types, IDs, and membership.
  // gamePlayers reference playerId, so local players must have matching IDs.
  let newPlayers = 0;
  let playersChanged = 0;
  const syncedPlayerNames = new Set<string>();
  
  // First pass: sync players referenced in gamePlayers (ensures ID alignment)
  for (const gp of remoteData.gamePlayers) {
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
    } else {
      localPlayers.push({
        id: gp.playerId,
        name: gp.playerName,
        createdAt: remotePlayer?.createdAt || new Date().toISOString(),
        type: remotePlayer?.type || 'permanent'
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
    } else {
      localPlayers.push({
        id: remotePlayer.id,
        name: remotePlayer.name,
        createdAt: remotePlayer.createdAt || new Date().toISOString(),
        type: remotePlayer.type || 'permanent'
      });
      newPlayers++;
    }
  }
  
  // Save all data
  localStorage.setItem('poker_players', JSON.stringify(localPlayers));
  localStorage.setItem('poker_games', JSON.stringify(remoteData.games));
  localStorage.setItem('poker_game_players', JSON.stringify(remoteData.gamePlayers));
  
  return { gamesChanged, deletedGames, newPlayers, playersChanged };
};

// Sync from cloud - full replacement, but only if version is different
export const syncFromCloud = async (): Promise<{
  success: boolean;
  message: string;
  synced: boolean;
  gamesChanged?: number;
  playersChanged?: number;
}> => {
  try {
    const remoteData = await fetchFromGitHub();
    
    if (!remoteData) {
      console.log('No remote data available');
      return { success: true, message: 'No cloud data available yet', synced: false };
    }
    
    // Check if we already have this version
    const lastSyncedVersion = getLastSyncedVersion();
    console.log('Sync check - local version:', lastSyncedVersion, 'remote version:', remoteData.lastUpdated);
    console.log('Remote has', remoteData.games?.length, 'games,', remoteData.players?.length, 'players');
    
    if (lastSyncedVersion === remoteData.lastUpdated) {
      console.log('Already synced to latest version');
      return { success: true, message: 'Already up to date', synced: false };
    }
    
    console.log('New version available - syncing...');
    
    // New version available - do full replacement
    const { gamesChanged, deletedGames, newPlayers, playersChanged } = replaceGamesWithRemote(remoteData);
    console.log('Sync result - gamesChanged:', gamesChanged, 'deleted:', deletedGames, 'newPlayers:', newPlayers, 'playersChanged:', playersChanged);
    
    // Save the synced version
    saveLastSyncedVersion(remoteData.lastUpdated);
    
    // Build message
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

    const response = await fetch(url, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
    });

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

export const restoreTrainingFromGitHub = async (): Promise<{ success: boolean; restored: boolean; message: string }> => {
  try {
    const remoteData = await fetchTrainingFromGitHub();
    if (!remoteData) {
      return { success: true, restored: false, message: 'No cloud training data' };
    }

    const localRaw = localStorage.getItem(TRAINING_STORAGE_KEY);
    const localData = localRaw ? JSON.parse(localRaw) : null;

    const localSessions = localData?.sessions?.length || 0;
    const remoteSessions = (remoteData.sessions as unknown[])?.length || 0;
    const localDecisions = localData?.totalDecisions || 0;
    const remoteDecisions = (remoteData.totalDecisions as number) || 0;

    if (remoteDecisions > localDecisions || remoteSessions > localSessions) {
      const { lastSynced: _, ...dataToRestore } = remoteData;
      localStorage.setItem(TRAINING_STORAGE_KEY, JSON.stringify(dataToRestore));
      console.log(`✅ Training data restored from cloud (${remoteSessions} sessions, ${remoteDecisions} decisions)`);
      return { success: true, restored: true, message: `Training data restored (${remoteSessions} sessions)` };
    }

    return { success: true, restored: false, message: 'Local training data is up to date' };
  } catch (error) {
    console.error('Error restoring training data:', error);
    return { success: false, restored: false, message: 'Failed to restore training data' };
  }
};
