import { NavLink } from 'react-router-dom';
import { usePermissions } from '../App';
import { useTranslation } from '../i18n';

const Navigation = () => {
  const { t } = useTranslation();
  const { hasPermission, role, trainingEnabled } = usePermissions();
  const canCreateGame = hasPermission('game:create');
  const showNewGameTab = canCreateGame || trainingEnabled;
  const canViewGraphs = !!role;

  return (
    <nav className="bottom-nav">
      {showNewGameTab && (
        <NavLink to="/" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">🃏</span>
          <span>{t('nav.newGame')}</span>
        </NavLink>
      )}
      <NavLink to="/history" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
        <span className="nav-icon">📚</span>
        <span>{t('nav.history')}</span>
      </NavLink>
      <NavLink to="/statistics" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
        <span className="nav-icon">📈</span>
        <span>{t('nav.statistics')}</span>
      </NavLink>
      {canViewGraphs && (
        <NavLink to="/graphs" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">📊</span>
          <span>{t('nav.graphs')}</span>
        </NavLink>
      )}
      <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
        <span className="nav-icon">⚙️</span>
        <span>{t('nav.settings')}</span>
      </NavLink>
    </nav>
  );
};

export default Navigation;
