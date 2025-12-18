/**
 * GitHub Sync Module
 * Handles uploading and downloading poker data to/from GitHub
 */

import { Player, Game, GamePlayer } from '../types';

// GitHub repository info
const GITHUB_OWNER = 'LiorMoldovan';
const GITHUB_REPO = 'poker-manager';
const GITHUB_FILE_PATH = 'public/sync-data.json';
const GITHUB_BRANCH = 'main';

// Storage key for GitHub token
const GITHUB_TOKEN_KEY = 'poker_github_token';

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

// Replace local data with remote data (full sync - admin is master)
export const replaceWithRemoteData = (
  remoteData: SyncData
): { gamesChanged: number; playersChanged: number; deletedGames: number } => {
  // Get current local data for comparison
  const localGames: Game[] = JSON.parse(localStorage.getItem('poker_games') || '[]');
  const localPlayers: Player[] = JSON.parse(localStorage.getItem('poker_players') || '[]');
  
  // Calculate what changed
  const remoteGameIds = new Set(remoteData.games.map(g => g.id));
  const localGameIds = new Set(localGames.map(g => g.id));
  
  // Count new games (in remote but not in local)
  const newGames = remoteData.games.filter(g => !localGameIds.has(g.id)).length;
  // Count deleted games (in local but not in remote)
  const deletedGames = localGames.filter(g => !remoteGameIds.has(g.id)).length;
  const gamesChanged = newGames + deletedGames;
  
  // Count player changes
  const remotePlayerIds = new Set(remoteData.players.map(p => p.id));
  const localPlayerIds = new Set(localPlayers.map(p => p.id));
  const newPlayersAdded = remoteData.players.filter(p => !localPlayerIds.has(p.id)).length;
  const deletedPlayers = localPlayers.filter(p => !remotePlayerIds.has(p.id)).length;
  const playersChanged = newPlayersAdded + deletedPlayers;
  
  // Full replacement - admin is the source of truth
  localStorage.setItem('poker_players', JSON.stringify(remoteData.players));
  localStorage.setItem('poker_games', JSON.stringify(remoteData.games));
  localStorage.setItem('poker_game_players', JSON.stringify(remoteData.gamePlayers));
  
  return { gamesChanged, playersChanged, deletedGames };
};

// Full sync process for all users (download and replace - admin is master)
export const syncFromCloud = async (): Promise<{
  success: boolean;
  message: string;
  gamesChanged?: number;
  playersChanged?: number;
}> => {
  try {
    const remoteData = await fetchFromGitHub();
    
    if (!remoteData) {
      return { success: true, message: 'No cloud data available yet' };
    }
    
    const { gamesChanged, playersChanged, deletedGames } = replaceWithRemoteData(remoteData);
    
    if (gamesChanged === 0 && playersChanged === 0) {
      return { success: true, message: 'Already up to date' };
    }
    
    // Build descriptive message
    let message = 'Synced: ';
    const parts: string[] = [];
    if (gamesChanged > 0) {
      if (deletedGames > 0) {
        parts.push(`${gamesChanged} game${gamesChanged !== 1 ? 's' : ''} updated`);
      } else {
        parts.push(`${gamesChanged} new game${gamesChanged !== 1 ? 's' : ''}`);
      }
    }
    if (playersChanged > 0) {
      parts.push(`${playersChanged} player${playersChanged !== 1 ? 's' : ''} updated`);
    }
    message += parts.join(', ');
    
    return {
      success: true,
      message,
      gamesChanged,
      playersChanged,
    };
  } catch (error) {
    console.error('Sync error:', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Sync failed',
    };
  }
};

// Full sync process for admin (upload current data)
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

