import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { useNavigate, useLocation } from 'react-router-dom';
import { GameWithDetails } from '../types';
import { getAllGames, getGamePlayers, getSettings, deleteGame, getAllPlayers } from '../database/storage';
import { cleanNumber } from '../utils/calculations';
import { usePermissions } from '../App';
import { useTranslation } from '../i18n';

const gameSortTimeMs = (g: { date: string; createdAt: string }): number => {
  const primary = new Date(g.date || g.createdAt).getTime();
  if (Number.isFinite(primary)) return primary;
  const fallback = new Date(g.createdAt).getTime();
  return Number.isFinite(fallback) ? fallback : 0;
};

const HistoryScreen = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t, isRTL } = useTranslation();
  const { hasPermission, playerName: identityName } = usePermissions();
  const [games, setGames] = useState<GameWithDetails[]>([]);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterPlayers, setFilterPlayers] = useState<string[]>([]);
  const [filterLocation, setFilterLocation] = useState<string | null>(null);
  const [filterYear, setFilterYear] = useState<number | null>(null);
  const [filterMonth, setFilterMonth] = useState<number | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({ permanent_guest: true, guest: true });
  
  const canDeleteGames = hasPermission('game:delete');

  const loadGames = useCallback(() => {
    const allGames = getAllGames();
    const settings = getSettings();

    const gamesWithDetails: GameWithDetails[] = allGames
      .filter(g => g.status === 'completed')
      .map(game => {
        const players = getGamePlayers(game.id);
        const sortedPlayers = [...players].sort((a, b) => b.profit - a.profit);
        const totalBuyins = players.reduce((sum, p) => sum + p.rebuys, 0);
        const totalPot = totalBuyins * settings.rebuyValue;
        return { ...game, players: sortedPlayers, totalPot, totalBuyins };
      })
      .sort((a, b) => gameSortTimeMs(b) - gameSortTimeMs(a));

    setGames(gamesWithDetails);
  }, []);

  useEffect(() => {
    if (location.pathname === '/history') {
      loadGames();
    }
  }, [location.pathname, loadGames]);

  useRealtimeRefresh(loadGames);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && location.pathname === '/history') {
        loadGames();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [location.pathname, loadGames]);

  const handleDelete = (gameId: string) => {
    deleteGame(gameId);
    loadGames();
    setDeleteConfirm(null);
  };

  const getWinner = (game: GameWithDetails) => {
    const sorted = [...game.players].sort((a, b) => b.profit - a.profit);
    return sorted[0];
  };

  const hebrewMonthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const enMonthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthNames = isRTL ? hebrewMonthNames : enMonthNames;

  type PlayerGroup = { label: string; key: string; names: string[] };

  const { playerGroups, locations, years, monthsByYear } = useMemo(() => {
    const playerCount: Record<string, number> = {};
    const locSet = new Set<string>();
    const ymSet = new Set<string>();
    for (const g of games) {
      for (const p of g.players) playerCount[p.playerName] = (playerCount[p.playerName] || 0) + 1;
      if (g.location) locSet.add(g.location);
      const d = new Date(g.date || g.createdAt);
      ymSet.add(`${d.getFullYear()}-${d.getMonth()}`);
    }
    const allP = getAllPlayers();
    const typeMap: Record<string, string> = {};
    for (const p of allP) typeMap[p.name] = p.type;

    const groups: PlayerGroup[] = [
      { label: t('history.permanent'), key: 'permanent', names: [] },
      { label: t('history.guests'), key: 'permanent_guest', names: [] },
      { label: t('history.occasional'), key: 'guest', names: [] },
    ];
    const sortedNames = Object.entries(playerCount).sort((a, b) => b[1] - a[1]).map(([name]) => name);
    for (const name of sortedNames) {
      const type = typeMap[name] || 'guest';
      const group = groups.find(g => g.key === type);
      if (group) group.names.push(name);
    }

    const yearSet = new Set<number>();
    const mByY: Record<number, number[]> = {};
    for (const ym of ymSet) {
      const [y, m] = ym.split('-').map(Number);
      yearSet.add(y);
      if (!mByY[y]) mByY[y] = [];
      mByY[y].push(m);
    }
    for (const y of Object.keys(mByY)) mByY[Number(y)].sort((a, b) => a - b);
    return {
      playerGroups: groups.filter(g => g.names.length > 0),
      locations: Array.from(locSet),
      years: Array.from(yearSet).sort((a, b) => b - a),
      monthsByYear: mByY,
    };
  }, [games, t]);

  const activeYear = filterYear ?? years[0] ?? new Date().getFullYear();
  const availableMonths = monthsByYear[activeYear] ?? [];

  const hasActiveFilter = !!searchQuery || filterPlayers.length > 0 || !!filterLocation || filterYear !== null || filterMonth !== null;

  const filteredGames = useMemo(() => {
    let result = games;
    if (filterPlayers.length > 0) {
      result = result.filter(g => filterPlayers.every(fp => g.players.some(p => p.playerName === fp)));
    }
    if (filterLocation) {
      result = result.filter(g => g.location === filterLocation);
    }
    if (filterYear !== null) {
      result = result.filter(g => {
        const d = new Date(g.date || g.createdAt);
        if (d.getFullYear() !== filterYear) return false;
        if (filterMonth !== null && d.getMonth() !== filterMonth) return false;
        return true;
      });
    } else if (filterMonth !== null) {
      result = result.filter(g => {
        const d = new Date(g.date || g.createdAt);
        return d.getFullYear() === activeYear && d.getMonth() === filterMonth;
      });
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(game => {
        if (game.players.some(p => p.playerName.toLowerCase().includes(q))) return true;
        if (game.location && game.location.toLowerCase().includes(q)) return true;
        const dateStr = new Date(game.date).toLocaleDateString(isRTL ? 'he-IL' : 'en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        if (dateStr.toLowerCase().includes(q)) return true;
        return false;
      });
    }
    return result;
  }, [games, searchQuery, filterPlayers, filterLocation, filterYear, filterMonth, activeYear, isRTL]);

  const clearAllFilters = () => {
    setSearchQuery('');
    setFilterPlayers([]);
    setFilterLocation(null);
    setFilterYear(null);
    setFilterMonth(null);
  };

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">{t('history.title')}</h1>
        <p className="page-subtitle">
          {games.length === 1 ? t('history.subtitleSingle') : t('history.subtitle', { count: games.length })}
        </p>
      </div>

      {games.length > 0 && (
        <div style={{ marginBottom: '0.75rem' }}>
          {/* Filter toggle + active filter summary */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              onClick={() => setShowFilters(!showFilters)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.3rem',
                padding: '0.4rem 0.7rem',
                borderRadius: '8px',
                border: hasActiveFilter ? '1px solid var(--primary)' : '1px solid var(--border)',
                background: hasActiveFilter ? 'rgba(99, 102, 241, 0.15)' : 'var(--surface)',
                color: hasActiveFilter ? 'var(--primary)' : 'var(--text)',
                fontSize: '0.8rem', fontWeight: '600', cursor: 'pointer',
                fontFamily: 'Outfit, sans-serif',
                flexShrink: 0,
              }}
            >
              {t('history.filter')}
              {hasActiveFilter && <span style={{ background: 'var(--primary)', color: 'white', borderRadius: '50%', width: '16px', height: '16px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem' }}>
                {filterPlayers.length + (filterLocation ? 1 : 0) + ((filterYear !== null || filterMonth !== null) ? 1 : 0) + (searchQuery ? 1 : 0)}
              </span>}
            </button>

            {/* Active filter pills */}
            {hasActiveFilter && (
              <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', alignItems: 'center', flex: 1, minWidth: 0 }}>
                {filterPlayers.map(fp => (
                  <span key={fp} onClick={() => setFilterPlayers(prev => prev.filter(n => n !== fp))} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', padding: '0.2rem 0.5rem', borderRadius: '12px', background: 'rgba(99, 102, 241, 0.2)', color: 'var(--primary)', fontSize: '0.7rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    👤 {fp} ✕
                  </span>
                ))}
                {filterLocation && (
                  <span onClick={() => setFilterLocation(null)} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', padding: '0.2rem 0.5rem', borderRadius: '12px', background: 'rgba(99, 102, 241, 0.2)', color: 'var(--primary)', fontSize: '0.7rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    📍 {filterLocation} ✕
                  </span>
                )}
                {(filterYear !== null || filterMonth !== null) && (
                  <span onClick={() => { setFilterYear(null); setFilterMonth(null); }} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', padding: '0.2rem 0.5rem', borderRadius: '12px', background: 'rgba(99, 102, 241, 0.2)', color: 'var(--primary)', fontSize: '0.7rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    📅 {filterMonth !== null ? `${monthNames[filterMonth]} ` : ''}{filterYear ?? activeYear} ✕
                  </span>
                )}
                {searchQuery && (
                  <span onClick={() => setSearchQuery('')} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', padding: '0.2rem 0.5rem', borderRadius: '12px', background: 'rgba(99, 102, 241, 0.2)', color: 'var(--primary)', fontSize: '0.7rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    "{searchQuery}" ✕
                  </span>
                )}
                <span onClick={clearAllFilters} style={{ fontSize: '0.65rem', color: 'var(--text-muted)', cursor: 'pointer', textDecoration: 'underline', whiteSpace: 'nowrap' }}>{t('history.clearAll')}</span>
              </div>
            )}

            {hasActiveFilter && !showFilters && (
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                {filteredGames.length}/{games.length}
              </span>
            )}
          </div>

          {/* Expanded filter panel */}
          {showFilters && (
            <div style={{ marginTop: '0.5rem', padding: '0.6rem', background: 'var(--surface)', borderRadius: '10px', border: '1px solid var(--border)' }}>
              {/* Text search */}
              <div style={{ position: 'relative', marginBottom: '0.5rem' }}>
                <input
                  type="text"
                  placeholder={t('history.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    width: '100%', padding: '0.45rem 0.6rem',
                    borderRadius: '8px', border: '1px solid var(--border)',
                    background: 'var(--bg)', color: 'var(--text)',
                    fontSize: '0.8rem',
                    fontFamily: 'Outfit, sans-serif', outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </div>

              {/* Player chips by group */}
              <div style={{ marginBottom: '0.4rem' }}>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t('history.playerFilter')}</div>
                {playerGroups.map(group => {
                  const isCollapsed = !!collapsedGroups[group.key];
                  const selectedCount = group.names.filter(n => filterPlayers.includes(n)).length;
                  return (
                    <div key={group.key} style={{ marginBottom: '0.3rem' }}>
                      <button
                        onClick={() => setCollapsedGroups(prev => ({ ...prev, [group.key]: !prev[group.key] }))}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer', padding: '0.15rem 0',
                          display: 'flex', alignItems: 'center', gap: '0.3rem', justifyContent: 'flex-start',
                          color: 'var(--text-muted)', fontSize: '0.65rem', fontFamily: 'Outfit, sans-serif',
                        }}
                      >
                        {group.label} ({group.names.length})
                        {selectedCount > 0 && <span style={{ background: 'var(--primary)', color: 'white', borderRadius: '50%', width: '14px', height: '14px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.55rem' }}>{selectedCount}</span>}
                        <span style={{ transform: isCollapsed ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', display: 'inline-block', fontSize: '0.55rem' }}>▼</span>
                      </button>
                      {!isCollapsed && (
                        <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginTop: '0.15rem' }}>
                          {group.names.map(name => (
                            <button
                              key={name}
                              onClick={() => setFilterPlayers(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])}
                              style={{
                                padding: '0.2rem 0.5rem', borderRadius: '12px', fontSize: '0.7rem',
                                border: filterPlayers.includes(name) ? '1px solid var(--primary)' : '1px solid var(--border)',
                                background: filterPlayers.includes(name) ? 'rgba(99, 102, 241, 0.2)' : 'transparent',
                                color: filterPlayers.includes(name) ? 'var(--primary)' : 'var(--text)',
                                cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: filterPlayers.includes(name) ? '600' : '400',
                              }}
                            >
                              {name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Location chips */}
              {locations.length > 0 && (
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t('history.locationFilter')}</div>
                  <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                    {locations.map(loc => (
                      <button
                        key={loc}
                        onClick={() => setFilterLocation(filterLocation === loc ? null : loc)}
                        style={{
                          padding: '0.2rem 0.5rem', borderRadius: '12px', fontSize: '0.7rem',
                          border: filterLocation === loc ? '1px solid var(--primary)' : '1px solid var(--border)',
                          background: filterLocation === loc ? 'rgba(99, 102, 241, 0.2)' : 'transparent',
                          color: filterLocation === loc ? 'var(--primary)' : 'var(--text)',
                          cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: filterLocation === loc ? '600' : '400',
                        }}
                      >
                        {loc}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Date filter: year selector + month chips */}
              {years.length > 0 && (
                <div style={{ marginTop: '0.4rem' }}>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t('history.dateFilter')}</div>
                  {/* Year row */}
                  <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.3rem' }}>
                    {years.map(y => (
                      <button
                        key={y}
                        onClick={() => {
                          if (filterYear === y) { setFilterYear(null); setFilterMonth(null); }
                          else { setFilterYear(y); setFilterMonth(null); }
                        }}
                        style={{
                          padding: '0.25rem 0.6rem', borderRadius: '12px', fontSize: '0.75rem', fontWeight: '600',
                          border: filterYear === y ? '1px solid var(--primary)' : '1px solid var(--border)',
                          background: filterYear === y ? 'rgba(99, 102, 241, 0.2)' : 'transparent',
                          color: filterYear === y ? 'var(--primary)' : 'var(--text)',
                          cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
                        }}
                      >
                        {y}
                      </button>
                    ))}
                  </div>
                  {/* Month row for selected year */}
                  <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                    {availableMonths.map(m => (
                      <button
                        key={m}
                        onClick={() => {
                          if (filterMonth === m) {
                            setFilterMonth(null);
                          } else {
                            setFilterMonth(m);
                            if (filterYear === null && years[0] != null) setFilterYear(years[0]);
                          }
                        }}
                        style={{
                          padding: '0.2rem 0.5rem', borderRadius: '12px', fontSize: '0.7rem',
                          border: filterMonth === m ? '1px solid var(--primary)' : '1px solid var(--border)',
                          background: filterMonth === m ? 'rgba(99, 102, 241, 0.2)' : 'transparent',
                          color: filterMonth === m ? 'var(--primary)' : 'var(--text)',
                          cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: filterMonth === m ? '600' : '400',
                        }}
                      >
                        {monthNames[m]}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Result count */}
              {hasActiveFilter && (
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.4rem', textAlign: 'center' }}>
                  {t('history.filterResult', { filtered: filteredGames.length, total: games.length })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {games.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">📚</div>
            <p>{t('history.noGames')}</p>
            <p className="text-muted">{t('history.noGamesDesc')}</p>
          </div>
        </div>
      ) : filteredGames.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>🔍</div>
          <div style={{ fontSize: '0.85rem' }}>
            {searchQuery.trim()
              ? t('history.noResults', { query: searchQuery })
              : t('history.noFilterResults')}
          </div>
        </div>
      ) : (
        filteredGames.map(game => {
          const winner = getWinner(game);
          return (
            <div 
              key={game.id} 
              className="card" 
              style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/game-summary/${game.id}`, { state: { from: 'history' } })}
            >
                <div className="card-header">
                <div>
                  <div style={{ fontWeight: '600' }}>
                    {new Date(game.date).toLocaleDateString(isRTL ? 'he-IL' : 'en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                    {game.location && <span style={{ fontWeight: '400', color: 'var(--text-muted)', marginLeft: '0.5rem' }}>📍 {game.location}</span>}
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                    {t('history.playersCount', { n: game.players.length, buyins: (game as any).totalBuyins || 0 })}
                    {game.sharedExpenses && game.sharedExpenses.length > 0 && (
                      <span style={{ color: '#f59e0b', marginLeft: '0.5rem' }}>
                        🍕 {cleanNumber(game.sharedExpenses.reduce((sum, e) => sum + e.amount, 0))}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: isRTL ? 'right' : 'left' }}>
                  {winner && winner.profit > 0 && (
                    <>
                      <div className="text-muted" style={{ fontSize: '0.75rem' }}>{t('history.winner')}</div>
                      <div style={{ fontWeight: '600', color: 'var(--success)' }}>
                        🏆 {winner.playerName}
                      </div>
                    </>
                  )}
                </div>
              </div>
              
              {/* All players sorted by profit */}
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                {game.players.map(p => {
                  const isMe = identityName && p.playerName === identityName;
                  return (
                  <span 
                    key={p.id}
                    className={`badge ${p.profit > 0 ? 'badge-success' : p.profit < 0 ? 'badge-danger' : ''}`}
                    style={{ fontSize: '0.7rem', padding: '0.2rem 0.4rem', ...(isMe ? { outline: '1.5px solid #3b82f6', fontWeight: '700' } : {}) }}
                  >
                    {p.playerName}: {p.profit >= 0 ? '\u200E+' : ''}{cleanNumber(p.profit)}
                  </span>
                  );
                })}
              </div>

              {/* Actions row */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.75rem', alignItems: 'center' }}>
                <button 
                  className="btn btn-sm"
                  style={{ 
                    background: 'var(--primary)', 
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    fontSize: '0.75rem',
                    padding: '0.3rem 0.5rem',
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/game-summary/${game.id}`, { state: { from: 'history' } });
                  }}
                >
                  {t('history.details')}
                </button>
                {canDeleteGames && (
                  <button 
                    className="btn btn-sm btn-danger"
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.3rem 0.5rem',
                      marginInlineStart: 'auto',
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteConfirm(game.id);
                    }}
                  >
                    🗑️
                  </button>
                )}
              </div>
            </div>
          );
        })
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{t('history.deleteTitle')}</h3>
              <button className="modal-close" onClick={() => setDeleteConfirm(null)}>×</button>
            </div>
            <p className="text-muted mb-2">{t('history.deleteWarning')}</p>
            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setDeleteConfirm(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-danger" onClick={() => handleDelete(deleteConfirm)}>
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HistoryScreen;

