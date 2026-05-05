import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useCallback } from 'react';
import { usePermissions } from '../App';
import { useTranslation } from '../i18n';
import { hapticTap } from '../utils/haptics';

const Navigation = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { role } = usePermissions();
  // Home is the dashboard for every role. Admins start a new game from
  // the prominent CTA on the dashboard rather than from the bottom nav,
  // which keeps the nav semantically clean: every tab maps to a
  // top-level surface (home / history / stats / graphs / settings) and
  // not to a sub-action.
  const showHomeTab = !!role;
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
      {showHomeTab && (
        <NavLink to="/" onClick={e => handleNav(e, '/')} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">🏠</span>
          <span>{t('nav.home')}</span>
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
