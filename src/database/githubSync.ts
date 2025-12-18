/**
 * GitHub Sync Module
 * Handles uploading and downloading poker data to/from GitHub
 * 
 * Sync behavior:
 * - Admin uploads full data after game end or deletion
 * - Users get full replacement on app open (if cloud version is newer)
 * - Players are NOT synced (kept local, auto-created from game data if missing)
 * - Version tracking prevents unnecessary syncs
 */

import { Player, Game, GamePlayer } from '../types';

// GitHub repository info
const GITHUB_OWNER = 'LiorMoldovan';
const GITHUB_REPO = 'poker-manager';
const GITHUB_FILE_PATH = 'public/sync-data.json';
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
        'Cache-Control': 'no-cache',
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

// Get current local data for sync
export const getLocalSyncData = (): SyncData => {
  const players = JSON.parse(localStorage.getItem('poker_players') || '[]');
  const games = JSON.parse(localStorage.getItem('poker_games') || '[]');
  const gamePlayers = JSON.parse(localStorage.getItem('poker_game_players') || '[]');
  
  return {
    players,
    games,
    gamePlayers,
    lastUpdated: new Date().toISOString(),
    updatedBy: 'admin',
  };
};

// Full replacement of games (players synced with ID matching for proper stats)
const replaceGamesWithRemote = (
  remoteData: SyncData
): { gamesChanged: number; deletedGames: number; newPlayers: number } => {
  const localGames: Game[] = JSON.parse(localStorage.getItem('poker_games') || '[]');
  const localPlayers: Player[] = JSON.parse(localStorage.getItem('poker_players') || '[]');
  
  // Calculate changes for reporting
  const remoteGameIds = new Set(remoteData.games.map(g => g.id));
  const localGameIds = new Set(localGames.map(g => g.id));
  
  const newGamesCount = remoteData.games.filter(g => !localGameIds.has(g.id)).length;
  const deletedGames = localGames.filter(g => !remoteGameIds.has(g.id)).length;
  const gamesChanged = newGamesCount + deletedGames;
  
  // Build a map of remote players for quick lookup by name
  const remotePlayerMap = new Map(remoteData.players.map(p => [p.name.toLowerCase(), p]));
  
  // Build a map of local players by name for quick lookup
  const localPlayerByName = new Map(localPlayers.map(p => [p.name.toLowerCase(), p]));
  
  // Sync players: update existing player IDs to match remote, or create new players
  // This is CRITICAL for stats to work - gamePlayers reference playerId, so local players
  // must have the same IDs as what's in gamePlayers
  let newPlayers = 0;
  const syncedPlayerNames = new Set<string>();
  
  for (const gp of remoteData.gamePlayers) {
    const playerNameLower = gp.playerName.toLowerCase();
    
    if (syncedPlayerNames.has(playerNameLower)) {
      continue; // Already processed this player
    }
    syncedPlayerNames.add(playerNameLower);
    
    const localPlayer = localPlayerByName.get(playerNameLower);
    const remotePlayer = remotePlayerMap.get(playerNameLower);
    
    if (localPlayer) {
      // Player exists locally - update their ID to match remote data
      // This ensures gamePlayers references match
      if (localPlayer.id !== gp.playerId) {
        localPlayer.id = gp.playerId;
      }
      // Also update type from remote if available
      if (remotePlayer?.type) {
        localPlayer.type = remotePlayer.type;
      }
    } else {
      // Player doesn't exist locally - create new
      localPlayers.push({
        id: gp.playerId,
        name: gp.playerName,
        createdAt: remotePlayer?.createdAt || new Date().toISOString(),
        type: remotePlayer?.type || 'permanent' // Default to permanent for synced players
      });
      localPlayerByName.set(playerNameLower, localPlayers[localPlayers.length - 1]);
      newPlayers++;
    }
  }
  
  // Save all data
  localStorage.setItem('poker_players', JSON.stringify(localPlayers));
  localStorage.setItem('poker_games', JSON.stringify(remoteData.games));
  localStorage.setItem('poker_game_players', JSON.stringify(remoteData.gamePlayers));
  
  return { gamesChanged, deletedGames, newPlayers };
};

// Sync from cloud - full replacement, but only if version is different
export const syncFromCloud = async (): Promise<{
  success: boolean;
  message: string;
  synced: boolean;
  gamesChanged?: number;
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
    console.log('Remote has', remoteData.games?.length, 'games');
    
    if (lastSyncedVersion === remoteData.lastUpdated) {
      console.log('Already synced to latest version');
      return { success: true, message: 'Already up to date', synced: false };
    }
    
    console.log('New version available - syncing...');
    
    // New version available - do full replacement
    const { gamesChanged, deletedGames, newPlayers } = replaceGamesWithRemote(remoteData);
    console.log('Sync result - gamesChanged:', gamesChanged, 'deleted:', deletedGames, 'newPlayers:', newPlayers);
    
    // Save the synced version
    saveLastSyncedVersion(remoteData.lastUpdated);
    
    // Build message
    let message = '';
    if (gamesChanged === 0 && newPlayers === 0) {
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
      message = parts.join(', ');
    }
    
    return {
      success: true,
      message,
      synced: true,
      gamesChanged,
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

// Upload current data to cloud (for admin)
export const syncToCloud = async (): Promise<{
  success: boolean;
  message: string;
}> => {
  const token = getGitHubToken();
  
  if (!token) {
    return { success: false, message: 'No GitHub token configured' };
  }
  
  const data = getLocalSyncData();
  return await uploadToGitHub(token, data);
};
