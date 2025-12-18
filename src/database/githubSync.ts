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

// Merge remote data with local data (only adds new items)
export const mergeWithLocalData = (
  remoteData: SyncData
): { newGames: number; newPlayers: number } => {
  // Get current local data
  const localPlayers: Player[] = JSON.parse(localStorage.getItem('poker_players') || '[]');
  const localGames: Game[] = JSON.parse(localStorage.getItem('poker_games') || '[]');
  const localGamePlayers: GamePlayer[] = JSON.parse(localStorage.getItem('poker_game_players') || '[]');
  
  // Create sets for quick lookup
  const localPlayerIds = new Set(localPlayers.map(p => p.id));
  const localPlayerNames = new Set(localPlayers.map(p => p.name.toLowerCase()));
  const localGameIds = new Set(localGames.map(g => g.id));
  const localGamePlayerIds = new Set(localGamePlayers.map(gp => gp.id));
  
  let newPlayersCount = 0;
  let newGamesCount = 0;
  
  // Player ID mapping (remote ID -> local ID) for players that exist by name
  const playerIdMap = new Map<string, string>();
  
  // First pass: map existing players by name and add new ones
  for (const remotePlayer of remoteData.players) {
    if (localPlayerIds.has(remotePlayer.id)) {
      // Player exists with same ID
      playerIdMap.set(remotePlayer.id, remotePlayer.id);
    } else if (localPlayerNames.has(remotePlayer.name.toLowerCase())) {
      // Player exists with different ID - find local ID by name
      const localPlayer = localPlayers.find(
        p => p.name.toLowerCase() === remotePlayer.name.toLowerCase()
      );
      if (localPlayer) {
        playerIdMap.set(remotePlayer.id, localPlayer.id);
      }
    } else {
      // New player - add them
      localPlayers.push(remotePlayer);
      localPlayerIds.add(remotePlayer.id);
      localPlayerNames.add(remotePlayer.name.toLowerCase());
      playerIdMap.set(remotePlayer.id, remotePlayer.id);
      newPlayersCount++;
    }
  }
  
  // Add new games
  for (const remoteGame of remoteData.games) {
    if (!localGameIds.has(remoteGame.id)) {
      localGames.push(remoteGame);
      localGameIds.add(remoteGame.id);
      newGamesCount++;
    }
  }
  
  // Add new game players (with mapped player IDs)
  for (const remoteGamePlayer of remoteData.gamePlayers) {
    if (!localGamePlayerIds.has(remoteGamePlayer.id)) {
      // Map the player ID if needed
      const mappedPlayerId = playerIdMap.get(remoteGamePlayer.playerId) || remoteGamePlayer.playerId;
      
      localGamePlayers.push({
        ...remoteGamePlayer,
        playerId: mappedPlayerId,
      });
      localGamePlayerIds.add(remoteGamePlayer.id);
    }
  }
  
  // Save merged data
  localStorage.setItem('poker_players', JSON.stringify(localPlayers));
  localStorage.setItem('poker_games', JSON.stringify(localGames));
  localStorage.setItem('poker_game_players', JSON.stringify(localGamePlayers));
  
  return { newGames: newGamesCount, newPlayers: newPlayersCount };
};

// Full sync process for non-admin users (download and merge)
export const syncFromCloud = async (): Promise<{
  success: boolean;
  message: string;
  newGames?: number;
  newPlayers?: number;
}> => {
  try {
    const remoteData = await fetchFromGitHub();
    
    if (!remoteData) {
      return { success: true, message: 'No cloud data available yet' };
    }
    
    const { newGames, newPlayers } = mergeWithLocalData(remoteData);
    
    if (newGames === 0 && newPlayers === 0) {
      return { success: true, message: 'Already up to date' };
    }
    
    return {
      success: true,
      message: `Synced ${newGames} new game${newGames !== 1 ? 's' : ''}${newPlayers > 0 ? ` and ${newPlayers} new player${newPlayers !== 1 ? 's' : ''}` : ''}`,
      newGames,
      newPlayers,
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

