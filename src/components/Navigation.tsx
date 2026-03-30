import { NavLink } from 'react-router-dom';
import { usePermissions } from '../App';

const Navigation = () => {
  const { hasPermission, role } = usePermissions();
  const canCreateGame = hasPermission('game:create');
  const canViewGraphs = role === 'admin' || role === 'member' || role === 'viewer';

  return (
    <nav className="bottom-nav">
      {canCreateGame && (
        <NavLink to="/" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">🃏</span>
          <span>New Game</span>
        </NavLink>
      )}
      <NavLink to="/history" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
        <span className="nav-icon">📚</span>
        <span>History</span>
      </NavLink>
      <NavLink to="/statistics" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
        <span className="nav-icon">📈</span>
        <span>Statistics</span>
      </NavLink>
      {canViewGraphs && (
        <NavLink to="/graphs" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="nav-icon">📊</span>
          <span>Graphs</span>
        </NavLink>
      )}
      <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
        <span className="nav-icon">⚙️</span>
        <span>Settings</span>
      </NavLink>
    </nav>
  );
};

export default Navigation;
