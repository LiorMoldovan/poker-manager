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

// Delta sync - only add new games (safe, no deletions)
// Players are NOT synced - but missing players are auto-created from game data
export const addNewGamesFromRemote = (
  remoteData: SyncData
): { newGames: number; newPlayers: number } => {
  // Get current local data
  const localPlayers: Player[] = JSON.parse(localStorage.getItem('poker_players') || '[]');
  const localGames: Game[] = JSON.parse(localStorage.getItem('poker_games') || '[]');
  const localGamePlayers: GamePlayer[] = JSON.parse(localStorage.getItem('poker_game_players') || '[]');
  
  const localGameIds = new Set(localGames.map(g => g.id));
  const localGamePlayerIds = new Set(localGamePlayers.map(gp => gp.id));
  const localPlayerNames = new Set(localPlayers.map(p => p.name.toLowerCase()));
  
  let newGamesCount = 0;
  let newPlayersCount = 0;
  
  // Add new games only
  for (const remoteGame of remoteData.games) {
    if (!localGameIds.has(remoteGame.id)) {
      localGames.push(remoteGame);
      localGameIds.add(remoteGame.id);
      newGamesCount++;
    }
  }
  
  // Add game players for new games, auto-create missing players
  for (const remoteGamePlayer of remoteData.gamePlayers) {
    if (!localGamePlayerIds.has(remoteGamePlayer.id)) {
      // Check if we have the player locally (by name)
      if (!localPlayerNames.has(remoteGamePlayer.playerName.toLowerCase())) {
        // Auto-create the player from game data
        const newPlayer: Player = {
          id: remoteGamePlayer.playerId,
          name: remoteGamePlayer.playerName,
          createdAt: new Date().toISOString(),
          type: 'guest' // Default to guest for auto-created players
        };
        localPlayers.push(newPlayer);
        localPlayerNames.add(newPlayer.name.toLowerCase());
        newPlayersCount++;
      }
      
      localGamePlayers.push(remoteGamePlayer);
      localGamePlayerIds.add(remoteGamePlayer.id);
    }
  }
  
  // Save updated data
  localStorage.setItem('poker_players', JSON.stringify(localPlayers));
  localStorage.setItem('poker_games', JSON.stringify(localGames));
  localStorage.setItem('poker_game_players', JSON.stringify(localGamePlayers));
  
  return { newGames: newGamesCount, newPlayers: newPlayersCount };
};

// Force full sync - replaces games/gamePlayers with remote (for admin force sync)
// Players are still NOT synced
export const forceReplaceGames = (
  remoteData: SyncData
): { gamesChanged: number; deletedGames: number } => {
  const localGames: Game[] = JSON.parse(localStorage.getItem('poker_games') || '[]');
  const localPlayers: Player[] = JSON.parse(localStorage.getItem('poker_players') || '[]');
  
  // Calculate what changed
  const remoteGameIds = new Set(remoteData.games.map(g => g.id));
  const localGameIds = new Set(localGames.map(g => g.id));
  
  const newGames = remoteData.games.filter(g => !localGameIds.has(g.id)).length;
  const deletedGames = localGames.filter(g => !remoteGameIds.has(g.id)).length;
  const gamesChanged = newGames + deletedGames;
  
  // Auto-create any missing players from game data
  const localPlayerNames = new Set(localPlayers.map(p => p.name.toLowerCase()));
  for (const gp of remoteData.gamePlayers) {
    if (!localPlayerNames.has(gp.playerName.toLowerCase())) {
      localPlayers.push({
        id: gp.playerId,
        name: gp.playerName,
        createdAt: new Date().toISOString(),
        type: 'guest'
      });
      localPlayerNames.add(gp.playerName.toLowerCase());
    }
  }
  
  // Replace games and gamePlayers (but keep local players)
  localStorage.setItem('poker_players', JSON.stringify(localPlayers));
  localStorage.setItem('poker_games', JSON.stringify(remoteData.games));
  localStorage.setItem('poker_game_players', JSON.stringify(remoteData.gamePlayers));
  
  return { gamesChanged, deletedGames };
};

// Normal sync - delta only (adds new games, safe)
export const syncFromCloud = async (): Promise<{
  success: boolean;
  message: string;
  newGames?: number;
}> => {
  try {
    const remoteData = await fetchFromGitHub();
    
    if (!remoteData) {
      return { success: true, message: 'No cloud data available yet' };
    }
    
    const { newGames, newPlayers } = addNewGamesFromRemote(remoteData);
    
    if (newGames === 0) {
      return { success: true, message: 'Already up to date' };
    }
    
    let message = `${newGames} new game${newGames !== 1 ? 's' : ''}`;
    if (newPlayers > 0) {
      message += ` (+${newPlayers} player${newPlayers !== 1 ? 's' : ''})`;
    }
    
    return {
      success: true,
      message,
      newGames,
    };
  } catch (error) {
    console.error('Sync error:', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Sync failed',
    };
  }
};

// Force full sync - for admin to propagate deletions (replaces games)
export const forceSyncFromCloud = async (): Promise<{
  success: boolean;
  message: string;
  gamesChanged?: number;
  deletedGames?: number;
}> => {
  try {
    const remoteData = await fetchFromGitHub();
    
    if (!remoteData) {
      return { success: false, message: 'No cloud data available' };
    }
    
    const { gamesChanged, deletedGames } = forceReplaceGames(remoteData);
    
    if (gamesChanged === 0) {
      return { success: true, message: 'Already up to date' };
    }
    
    let message = `${gamesChanged} game${gamesChanged !== 1 ? 's' : ''} synced`;
    if (deletedGames > 0) {
      message += ` (${deletedGames} removed)`;
    }
    
    return {
      success: true,
      message,
      gamesChanged,
      deletedGames,
    };
  } catch (error) {
    console.error('Force sync error:', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Force sync failed',
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

