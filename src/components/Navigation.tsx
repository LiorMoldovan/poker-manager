import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useCallback } from 'react';
import { usePermissions } from '../App';
import { useTranslation } from '../i18n';
import { hapticTap } from '../utils/haptics';

const Navigation = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { hasPermission, role } = usePermissions();
  const canCreateGame = hasPermission('game:create');
  // Home is visible to every authenticated role: admins use it as the
  // new-game launchpad, members use it as the schedule + last-game
  // dashboard. We still gate on `role` (truthy when the user is a
  // group member) so unauthenticated views don't render the tab.
  const showNewGameTab = !!role;
  const canViewGraphs = !!role;

  const handleNav = useCallback((e: React.MouseEvent<HTMLAnchorElement>, to: string) => {
    if (location.pathname === to) return;
    e.preventDefault();
    hapticTap();
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
    if (doc.startViewTransition) {
      doc.startViewTransition(() => navigate(to));
    } else {
      navigate(to);
    }
  }, [navigate, location.pathname]);

  return (
    <nav className="bottom-nav">
      {showNewGameTab && (
        <NavLink to="/" onClick={e => handleNav(e, '/')} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">🃏</span>
          {/* Admins land on the new-game form here, so the action-
              oriented label still fits. Members land on the home
              dashboard (schedule + last game + training) — for them
              "משחק חדש" promises an action they don't have, so we
              show a neutral "בית" label instead. */}
          <span>{canCreateGame ? t('nav.newGame') : t('nav.home')}</span>
        </NavLink>
      )}
      <NavLink to="/history" onClick={e => handleNav(e, '/history')} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
        <span className="nav-icon">📚</span>
        <span>{t('nav.history')}</span>
      </NavLink>
      <NavLink to="/statistics" onClick={e => handleNav(e, '/statistics')} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
        <span className="nav-icon">📈</span>
        <span>{t('nav.statistics')}</span>
      </NavLink>
      {canViewGraphs && (
        <NavLink to="/graphs" onClick={e => handleNav(e, '/graphs')} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">📊</span>
          <span>{t('nav.graphs')}</span>
        </NavLink>
      )}
      <NavLink to="/settings" onClick={e => handleNav(e, '/settings')} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
        <span className="nav-icon">⚙️</span>
        <span>{t('nav.settings')}</span>
      </NavLink>
    </nav>
  );
};

export default Navigation;
