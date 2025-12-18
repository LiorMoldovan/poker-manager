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
    // Use raw.githubusercontent.com for direct file access (with cache busting)
    const url = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${GITHUB_FILE_PATH}?t=${Date.now()}`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      if (response.status === 404) {
        console.log('Sync file not found on GitHub - first sync needed');
        return null;
      }
      throw new Error(`GitHub fetch failed: ${response.status}`);
    }
    
    const data = await response.json();
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

// Full replacement of games (players kept local, auto-created if missing)
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
  
  // Auto-create any missing players from remote data (with correct player type)
  let newPlayers = 0;
  const localPlayerNames = new Set(localPlayers.map(p => p.name.toLowerCase()));
  
  // Build a map of remote players for quick lookup
  const remotePlayerMap = new Map(remoteData.players.map(p => [p.name.toLowerCase(), p]));
  
  for (const gp of remoteData.gamePlayers) {
    if (!localPlayerNames.has(gp.playerName.toLowerCase())) {
      // Get the player info from remote data (includes correct type)
      const remotePlayer = remotePlayerMap.get(gp.playerName.toLowerCase());
      
      localPlayers.push({
        id: gp.playerId,
        name: gp.playerName,
        createdAt: remotePlayer?.createdAt || new Date().toISOString(),
        type: remotePlayer?.type || 'guest' // Use remote type if available
      });
      localPlayerNames.add(gp.playerName.toLowerCase());
      newPlayers++;
    }
  }
  
  // Replace games and gamePlayers (but keep local players)
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
      return { success: true, message: 'No cloud data available yet', synced: false };
    }
    
    // Check if we already have this version
    const lastSyncedVersion = getLastSyncedVersion();
    if (lastSyncedVersion === remoteData.lastUpdated) {
      console.log('Already synced to latest version:', lastSyncedVersion);
      return { success: true, message: 'Already up to date', synced: false };
    }
    
    // New version available - do full replacement
    const { gamesChanged, deletedGames, newPlayers } = replaceGamesWithRemote(remoteData);
    
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
