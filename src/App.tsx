import { Component, useEffect, useState, useRef, useCallback, useMemo, createContext, useContext, Suspense, lazy } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { PermissionRole } from './types';
import { hasPermission } from './permissions';
import { logActivity, updateSessionActivity, getScreenName, resetSession } from './utils/activityLogger';
import { setObserverMode } from './auth/observerMode';
import { useSupabaseAuth } from './hooks/useSupabaseAuth';
import { LanguageProvider, useTranslation } from './i18n';
import { initSupabaseCache, isCacheForGroup, resetCache, subscribeToRealtime, unsubscribeFromRealtime, fetchNotifications, getCachedNotifications, markNotificationRead, getUnreadNotificationCount, savePushSubscription, deletePushSubscription, flushAllPendingSyncs } from './database/supabaseCache';
import { fixChipCountIds } from './database/migrateToSupabase';
import { getAllPlayers } from './database/storage';
// Side-effect import: attaches `window.previewAllScheduleEmails(email)`
// for one-shot manual previews from the browser console (deployed only —
// the EmailJS Edge Function doesn't run on localhost).
import './utils/previewScheduleEmails';
import Navigation from './components/Navigation';
import GroupSwitcher from './components/GroupSwitcher';
import GroupWizard from './components/GroupWizard';
import { ToastContainer, showToast } from './components/Toast';
import { VoteReminderBanner } from './components/VoteReminderBanner';
import { StyledSelect } from './components/StyledSelect';
import AuthScreen from './screens/AuthScreen';
import GroupSetupScreen from './screens/GroupSetupScreen';

const navImports = {
  NewGameScreen: () => import('./screens/NewGameScreen'),
  HistoryScreen: () => import('./screens/HistoryScreen'),
  StatisticsScreen: () => import('./screens/StatisticsScreen'),
  GraphsScreen: () => import('./screens/GraphsScreen'),
  SettingsScreen: () => import('./screens/SettingsScreen'),
  ScheduleTab: () => import('./components/ScheduleTab'),
};

const NewGameScreen = lazy(navImports.NewGameScreen);
const HistoryScreen = lazy(navImports.HistoryScreen);
const StatisticsScreen = lazy(navImports.StatisticsScreen);
const GraphsScreen = lazy(navImports.GraphsScreen);
const SettingsScreen = lazy(navImports.SettingsScreen);
const ScheduleTab = lazy(navImports.ScheduleTab);

const LiveGameScreen = lazy(() => import('./screens/LiveGameScreen'));
const ChipEntryScreen = lazy(() => import('./screens/ChipEntryScreen'));
const GameSummaryScreen = lazy(() => import('./screens/GameSummaryScreen'));
const TrainingScreen = lazy(() => import('./screens/TrainingScreen'));
const TrainingHandScreen = lazy(() => import('./screens/TrainingHandScreen'));
const QuickTrainingScreen = lazy(() => import('./screens/QuickTrainingScreen'));
const SharedTrainingScreen = lazy(() => import('./screens/SharedTrainingScreen'));
const SharedQuickPlayScreen = lazy(() => import('./screens/SharedQuickPlayScreen'));
const TriviaGameScreen = lazy(() => import('./screens/TriviaGameScreen'));
const TriviaLandingScreen = lazy(() => import('./screens/TriviaLandingScreen'));

// Short-form deep link for schedule polls. The full URL is
// `/schedule?poll=<id>` which is correct but reads as a noisy link
// in WhatsApp captions where the link is always rendered as plain
// text.
//
// As of migration 040 the path param can be EITHER a 36-char poll
// UUID (the legacy form, still emitted by older shares) or a 6-char
// base32 slug (the new short form). We sniff the shape via a UUID
// regex:
//   * UUID-shaped → redirect synchronously, no DB round-trip.
//   * Slug-shaped → call `resolve_poll_share_slug` to get the UUID,
//     then redirect. Failure (unknown slug, network error) falls
//     back to the bare schedule tab so the user lands on something
//     useful instead of a 404.
//
// `replace: true` on the final navigate keeps history clean — a
// back-tap from the deep-linked card returns to wherever the user
// came from rather than bouncing through `/p/<x>`.
const POLL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function PollDeepLinkRedirect() {
  const { pollId } = useParams<{ pollId: string }>();
  const [resolvedId, setResolvedId] = useState<string | null>(null);
  const [resolveFailed, setResolveFailed] = useState(false);

  useEffect(() => {
    if (!pollId) return;
    if (POLL_UUID_RE.test(pollId)) {
      setResolvedId(pollId);
      return;
    }
    let cancelled = false;
    import('./database/storage').then(({ resolvePollShareSlug }) => {
      resolvePollShareSlug(pollId)
        .then(id => {
          if (cancelled) return;
          if (id) setResolvedId(id);
          else setResolveFailed(true);
        })
        .catch(err => {
          console.warn('resolvePollShareSlug failed:', err);
          if (!cancelled) setResolveFailed(true);
        });
    });
    return () => { cancelled = true; };
  }, [pollId]);

  if (!pollId || resolveFailed) {
    return <Navigate to="/schedule" replace />;
  }
  if (!resolvedId) {
    // Slug-resolution in flight — render nothing rather than a flash
    // of skeleton; the lookup is a single round-trip and resolves
    // within a few ms in practice.
    return null;
  }
  return <Navigate
    to={`/schedule?poll=${encodeURIComponent(resolvedId)}`}
    replace
  />;
}

function prefetchNavScreens() {
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(() => {
      Object.values(navImports).forEach(fn => fn());
    });
  } else {
    setTimeout(() => {
      Object.values(navImports).forEach(fn => fn());
    }, 100);
  }
}

// Loading skeleton shown while a lazy-loaded screen module resolves.
// Shape mirrors the home dashboard (NewGameScreen → HomeDashboard) since
// that's the most common landing surface and skeleton-shape mismatches
// cause a visible "jump" when the real content appears. Layout, top-down:
//   * end-aligned sign-out pill placeholder
//   * 5 stacked rounded cards matching the dashboard's card stack
//     (compact / hero / compact / hero / compact)
// Single column, `gap` for spacing — matches `HomeDashboard.tsx`'s
// `flex-direction: column; gap: 0.6rem` so widths/edges line up.
function ScreenSkeleton() {
  const cardHeights = ['4rem', '9rem', '4rem', '9rem', '3rem'];
  return (
    <div className="skeleton-screen" style={{ direction: 'rtl' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '0.5rem' }}>
        <div className="skeleton-pulse" style={{ height: '1.6rem', width: '5.5rem', borderRadius: 999 }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {cardHeights.map((h, i) => (
          <div
            key={i}
            className="skeleton-pulse"
            style={{ height: h, borderRadius: 12 }}
          />
        ))}
      </div>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          minHeight: '100vh', padding: '2rem', textAlign: 'center',
          background: 'var(--background, #0f0f1a)', color: 'var(--text, #e2e8f0)',
          fontFamily: 'Outfit, sans-serif', direction: 'rtl',
        }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
          <h1 style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: '0.5rem' }}>משהו השתבש</h1>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted, #94a3b8)', marginBottom: '1.5rem' }}>
            אירעה שגיאה לא צפויה. לחצו לרענון.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '0.75rem 2rem', borderRadius: '10px', border: 'none', cursor: 'pointer',
              background: 'var(--primary, #6366f1)', color: '#fff', fontSize: '1rem', fontWeight: 600,
              fontFamily: 'Outfit, sans-serif',
            }}
          >
            🔄 רענון
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface GroupManagementFns {
  groupName: string;
  inviteCode: string | null;
  currentUserId: string;
  fetchMembers: () => Promise<import('./hooks/useSupabaseAuth').GroupMember[]>;
  updateMemberRole: (userId: string, role: string) => Promise<{ error: unknown }>;
  removeMember: (userId: string) => Promise<{ error: unknown }>;
  transferOwnership: (userId: string) => Promise<{ error: unknown }>;
  regenerateInviteCode: () => Promise<{ data: string | null; error: unknown }>;
  unlinkMemberPlayer: (userId: string) => Promise<{ error: unknown }>;
  createPlayerInvite: (playerId: string) => Promise<{ data: { invite_code: string; player_name: string; already_existed: boolean } | null; error: unknown }>;
  addMemberByEmail: (email: string, playerId?: string) => Promise<{ data: { user_id: string; display_name: string; player_id: string | null } | null; error: unknown }>;
}

interface PermissionContextType {
  role: PermissionRole | null;
  isOwner: boolean;
  isSuperAdmin: boolean;
  trainingEnabled: boolean;
  playerName: string | null;
  hasPermission: (permission: Parameters<typeof hasPermission>[1]) => boolean;
  signOut: () => void;
  // Super-admin-only "View As" controls. Present only when the REAL
  // user is super admin (regardless of any active preview override).
  // Surfaced through the context so the GroupSwitcher header can
  // render the pill inline; gated by `realIsSuperAdmin` in
  // SupabaseApp so non-privileged users never even see the field.
  viewAs?: {
    current: ViewAsRole | null;
    cycle: () => void;
  };
  groupMgmt?: GroupManagementFns;
  multiGroup?: {
    memberships: import('./hooks/useSupabaseAuth').GroupMembership[];
    activeGroupId: string | null;
    switchGroup: (groupId: string) => void;
    createGroup: (name: string) => Promise<{ data: unknown; error: unknown }>;
    joinGroup: (code: string) => Promise<{ data: unknown; error: unknown }>;
    joinByPlayerInvite: (code: string) => Promise<{ data: unknown; error: unknown }>;
    deleteGroup: (groupId: string) => Promise<{ error: unknown }>;
    leaveGroup: (groupId: string) => Promise<{ error: unknown }>;
    refreshMembership: () => void;
    triggerGroupWizard: () => void;
    userEmail: string;
    isSuperAdmin: boolean;
    allGroups: import('./hooks/useSupabaseAuth').AllGroupsEntry[];
    isObservingNonMember: boolean;
  };
}

const PermissionContext = createContext<PermissionContextType>({
  role: null,
  isOwner: false,
  isSuperAdmin: false,
  trainingEnabled: false,
  playerName: null,
  hasPermission: () => false,
  signOut: () => {},
});

export const LEGACY_NAME_CORRECTIONS: Record<string, string> = {
  'פבל': 'פאבל',
  'ארז': 'חרדון',
};

export const usePermissions = () => useContext(PermissionContext);

// ── "View As" preview (super-admin debug tool) ──
// A super admin can preview the UI exactly as another role would see
// it, without touching anything server-side. The override is purely
// client-side and lives in sessionStorage, gated on the REAL super-
// admin flag, so it cannot be used to grant privileges.
//   * `member` → role='member', isOwner=false, isSuperAdmin=false
//   * `admin`  → role='admin',  isOwner=false, isSuperAdmin=false  (regular admin)
//   * `owner`  → role='admin',  isOwner=true,  isSuperAdmin=false  (group owner)
//   * `null`   → real values (default for super admins)
export type ViewAsRole = 'member' | 'admin' | 'owner';
export const VIEW_AS_KEY = 'pm-view-as-role';

export function readViewAsRole(): ViewAsRole | null {
  try {
    const v = sessionStorage.getItem(VIEW_AS_KEY);
    return v === 'member' || v === 'admin' || v === 'owner' ? v : null;
  } catch { return null; }
}

// Inline pill that always reflects the current preview state and
// cycles through views on tap. Rendered only for the REAL super admin
// so non-privileged users never see it. The yellow accent in non-real
// modes is a deliberate "you are not seeing the full app right now"
// reminder so the super admin doesn't get confused mid-debug. Lives
// inside the GroupSwitcher header bar (next to the version label) so
// it never overlaps page content or other top-bar controls.
export function ViewAsSwitcher({
  current,
  onCycle,
}: {
  current: ViewAsRole | null;
  // Parameterless — cycle order lives with the parent that owns the
  // state, so the pill stays a pure visual component. Tap → next view.
  onCycle: () => void;
}) {
  const labels: Record<string, { text: string; bg: string; border: string; color: string }> = {
    'real':   { text: '👑 Super Admin', bg: 'rgba(168, 85, 247, 0.18)', border: 'rgba(168, 85, 247, 0.55)', color: '#c084fc' },
    'member': { text: '👁 כחבר',         bg: 'rgba(234, 179, 8, 0.22)',  border: 'rgba(234, 179, 8, 0.65)',  color: '#fbbf24' },
    'admin':  { text: '👁 כמנהל',         bg: 'rgba(234, 179, 8, 0.22)',  border: 'rgba(234, 179, 8, 0.65)',  color: '#fbbf24' },
    'owner':  { text: '👁 כבעלים',        bg: 'rgba(234, 179, 8, 0.22)',  border: 'rgba(234, 179, 8, 0.65)',  color: '#fbbf24' },
  };
  const cfg = labels[current ?? 'real'];

  return (
    <button
      onClick={onCycle}
      style={{
        // Inline header child — no fixed positioning. Sits adjacent to
        // the version label so the header has a consistent
        // [version + super-admin] · [group] · [sign-out] tri-section
        // layout. Keep it compact so it doesn't compete with the
        // centered group name.
        padding: '3px 8px',
        fontSize: '0.65rem',
        fontWeight: 700,
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        color: cfg.color,
        borderRadius: 999,
        cursor: 'pointer',
        fontFamily: 'Outfit, sans-serif',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        lineHeight: 1.2,
      }}
      title="Cycle preview role (super-admin debug tool)"
    >
      {cfg.text}
    </button>
  );
}

export const useOnlineStatus = () => {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);
  return online;
};

function PlayerPicker({ onSelfCreate, onLink, listLinkable, userDisplayName }: {
  onSelfCreate: (name: string) => Promise<{ data: unknown; error: unknown }>;
  onLink: (playerId: string) => Promise<{ error: unknown }>;
  listLinkable: () => Promise<{ id: string; name: string }[]>;
  userDisplayName: string;
}) {
  const { t } = useTranslation();
  const [newName, setNewName] = useState(userDisplayName);
  const [error, setError] = useState('');
  const [linkable, setLinkable] = useState<{ id: string; name: string }[] | null>(null);
  // 'list' = pick existing player, 'create' = type a new name
  // We start in 'list' mode if there are existing unlinked players to claim
  // (this is the path that prevents duplicates — see migration 047). We fall
  // back to 'create' automatically if the list is empty.
  const [mode, setMode] = useState<'list' | 'create'>('list');
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listLinkable().then(rows => {
      if (cancelled) return;
      setLinkable(rows);
      if (rows.length === 0) setMode('create');
    });
    return () => { cancelled = true; };
  }, [listLinkable]);

  const handleSelfCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) { setError(t('picker.emptyName')); return; }
    setError('');
    setSubmitting(true);
    const { error: err } = await onSelfCreate(trimmed);
    setSubmitting(false);
    if (err) {
      const msg = (err as { message?: string })?.message || '';
      setError(msg.includes('duplicate') ? t('picker.duplicate') : msg || t('picker.createError'));
    }
  };

  const handlePick = async (playerId: string) => {
    setError('');
    setLinkingId(playerId);
    const { error: err } = await onLink(playerId);
    setLinkingId(null);
    if (err) {
      const msg = (err as { message?: string })?.message || '';
      setError(msg || t('picker.linkError'));
    }
  };

  const showList = mode === 'list' && linkable && linkable.length > 0;

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--background)', direction: 'rtl',
    }}>
      <div style={{
        background: 'var(--surface)', borderRadius: '16px', padding: '1.5rem',
        maxWidth: '400px', width: '90%', boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🃏</div>
          <h2 style={{ color: 'var(--text)', marginBottom: '0.25rem' }}>
            {showList ? t('picker.existingHeader') : t('picker.welcome')}
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {showList ? t('picker.existingHelp') : t('picker.subtitle')}
          </p>
        </div>

        {showList ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.75rem', maxHeight: '50vh', overflowY: 'auto' }}>
              {linkable!.map(p => (
                <button
                  key={p.id}
                  onClick={() => handlePick(p.id)}
                  disabled={linkingId !== null}
                  style={{
                    padding: '0.75rem 1rem', fontSize: '0.95rem', fontWeight: 600, borderRadius: '10px',
                    border: '2px solid var(--border)', background: 'var(--background)', color: 'var(--text)',
                    cursor: linkingId === null ? 'pointer' : 'wait', textAlign: 'right',
                    opacity: linkingId !== null && linkingId !== p.id ? 0.5 : 1,
                    fontFamily: 'Outfit, sans-serif',
                  }}
                >
                  {linkingId === p.id ? '…' : p.name}
                </button>
              ))}
            </div>
            {error && <p style={{ color: '#ef4444', fontSize: '0.85rem', textAlign: 'center', marginBottom: '0.5rem' }}>{error}</p>}
            <button
              onClick={() => { setError(''); setMode('create'); }}
              disabled={linkingId !== null}
              style={{
                width: '100%', padding: '0.6rem', fontSize: '0.85rem', fontWeight: 500, borderRadius: '10px',
                border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)',
                cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
              }}
            >
              {t('picker.notInList')}
            </button>
          </>
        ) : (
          <>
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder={t('picker.placeholder')}
              autoFocus
              dir="rtl"
              style={{
                width: '100%', padding: '0.75rem 1rem', fontSize: '1rem', borderRadius: '10px',
                border: '2px solid var(--border)', background: 'var(--background)', color: 'var(--text)',
                marginBottom: '0.75rem', boxSizing: 'border-box', outline: 'none', fontFamily: 'Outfit, sans-serif',
              }}
              onKeyDown={e => { if (e.key === 'Enter') handleSelfCreate(); }}
            />
            {error && <p style={{ color: '#ef4444', fontSize: '0.85rem', textAlign: 'center', marginBottom: '0.5rem' }}>{error}</p>}
            <button
              onClick={handleSelfCreate}
              disabled={submitting}
              style={{
                width: '100%', padding: '0.75rem', fontSize: '1rem', fontWeight: 600, borderRadius: '10px',
                border: 'none', background: 'var(--primary)', color: 'white',
                cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.6 : 1,
                fontFamily: 'Outfit, sans-serif', marginBottom: linkable && linkable.length > 0 ? '0.5rem' : 0,
              }}
            >
              {t('picker.continue')}
            </button>
            {linkable && linkable.length > 0 && (
              <button
                onClick={() => { setError(''); setMode('list'); }}
                disabled={submitting}
                style={{
                  width: '100%', padding: '0.5rem', fontSize: '0.8rem', fontWeight: 500, borderRadius: '10px',
                  border: 'none', background: 'transparent', color: 'var(--text-muted)',
                  cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
                }}
              >
                {t('picker.backToList')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SupabaseApp() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const auth = useSupabaseAuth();
  const [dataReady, setDataReady] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [addMemberPrompt, setAddMemberPrompt] = useState<string | null>(null);
  const [addMemberStatus, setAddMemberStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [addMemberMsg, setAddMemberMsg] = useState('');
  const [addMemberPlayerId, setAddMemberPlayerId] = useState<string>('');
  const [addMemberUnlinked, setAddMemberUnlinked] = useState<{ id: string; name: string; type: string }[]>([]);
  const [notifCount, setNotifCount] = useState(0);
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const [showGroupWizard, setShowGroupWizard] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [showPushNudge, setShowPushNudge] = useState(false);

  // For super admins, `activeGroupId` may point to a group the user
  // isn't a member of (observer mode). The cache, RLS, and every
  // group-scoped read/write key off this id; `auth.membership` falls
  // back to null in that case, so we use auth.activeGroupId directly.
  const groupId = auth.activeGroupId ?? null;
  const isObservingNonMember = auth.isObservingNonMember;
  // In observer mode the super admin acts as owner-equivalent. The
  // existing membership-derived role/owner flags are null because
  // there's no group_members row, so we synthesize them.
  const realRole: PermissionRole | null = isObservingNonMember
    ? 'admin'
    : (auth.membership?.role ?? null);
  const realIsOwner = isObservingNonMember
    ? true
    : (auth.membership?.isOwner ?? false);
  const realIsSuperAdmin = auth.isSuperAdmin;
  // training_enabled is fetched on the all-groups list for super admins,
  // so even when observing we can show the right state.
  const observedGroupMeta = isObservingNonMember
    ? auth.allGroups.find(g => g.groupId === auth.activeGroupId) ?? null
    : null;
  const trainingEnabled = isObservingNonMember
    ? (observedGroupMeta?.trainingEnabled ?? false)
    : (auth.membership?.trainingEnabled ?? false);
  // No linked player in an observed group. Surface a synthetic name so
  // existing UI code that reads `playerName` doesn't crash on null.
  const playerName = isObservingNonMember
    ? '👁 Super Admin'
    : (auth.membership?.playerName ?? null);

  // Keep the non-React observerMode flag in sync so activityLogger and
  // savePushSubscription (called from outside React's tree) can read
  // it. Effect runs on every render where the value flipped.
  useEffect(() => {
    setObserverMode(isObservingNonMember);
  }, [isObservingNonMember]);

  // ── "View As" preview (super admin only) ──
  // Lets the real super admin see the app exactly as a member / regular
  // admin / owner would, without changing anything server-side. Purely
  // a client-side override of the role flags exposed via PermissionContext;
  // RLS / RPCs continue to trust the JWT, so there is no security impact.
  // Persisted in sessionStorage so a page refresh keeps the same preview,
  // but a tab close / new browser doesn't carry the override over.
  const [viewAsRole, setViewAsRoleRaw] = useState<ViewAsRole | null>(() => readViewAsRole());
  const setViewAsRole = useCallback((next: ViewAsRole | null) => {
    setViewAsRoleRaw(next);
    try {
      if (next) sessionStorage.setItem(VIEW_AS_KEY, next);
      else sessionStorage.removeItem(VIEW_AS_KEY);
    } catch { /* sessionStorage may be blocked — preview just won't persist */ }
  }, []);
  // Override is gated on the REAL super-admin flag so a non-super-admin
  // can't force their session into a different role by writing the
  // sessionStorage key from devtools.
  const effectiveViewAs: ViewAsRole | null = realIsSuperAdmin ? viewAsRole : null;
  const role: PermissionRole | null = effectiveViewAs === 'member'
    ? 'member'
    : (effectiveViewAs === 'admin' || effectiveViewAs === 'owner')
      ? 'admin'
      : realRole;
  const isOwner = effectiveViewAs === 'owner'
    ? true
    : effectiveViewAs
      ? false
      : realIsOwner;
  const isSuperAdmin = effectiveViewAs ? false : realIsSuperAdmin;
  // Admin = anyone with create-game powers. Used by the /new-game route
  // gate: members get redirected home to avoid an empty-state screen.
  const isAdmin = role === 'admin' || isOwner || isSuperAdmin;

  useEffect(() => {
    if (!groupId) return;
    const win = window as unknown as Record<string, unknown>;
    win.fixChipCounts = () => fixChipCountIds(groupId);
    return () => { delete win.fixChipCounts; };
  }, [groupId]);

  // Initialize Supabase cache once we have a group
  useEffect(() => {
    if (!groupId) return;
    if (isCacheForGroup(groupId)) { setDataReady(true); return; }
    setDataReady(false);
    setDataError(null);
    resetCache();
    const targetGroupId = groupId;
    initSupabaseCache(targetGroupId)
      .then(() => {
        if (!isCacheForGroup(targetGroupId)) return;
        setDataReady(true);
        subscribeToRealtime();
        prefetchNavScreens();
        // Drain the notification queue once at boot. Migration 061's DB
        // triggers enqueue jobs atomically with lifecycle transitions, but
        // the realtime subscription only fires on NEW events — any job
        // enqueued before this tab connected (or carried over from a
        // closed peer client whose dispatch was interrupted) needs an
        // initial kick. The worker is rate-limited and stampede-guarded,
        // so this is safe to fire eagerly.
        void import('./utils/notificationWorker').then(m =>
          m.processNotificationJobs().catch(err =>
            console.warn('[boot] notification worker kick failed:', err))
        );
      })
      .catch(err => {
        if (!isCacheForGroup(targetGroupId)) return;
        console.error('Failed to load data from Supabase:', err);
        setDataError(t('app.cloudError'));
      });
    return () => unsubscribeFromRealtime();
  }, [groupId]);

  // Notification polling
  useEffect(() => {
    if (!dataReady) return;
    const load = () => fetchNotifications().then(() => setNotifCount(getUnreadNotificationCount()));
    load();
    const handler = () => { setNotifCount(getUnreadNotificationCount()); };
    window.addEventListener('supabase-cache-updated', handler);
    return () => window.removeEventListener('supabase-cache-updated', handler);
  }, [dataReady]);

  // Surface Supabase sync failures as toasts so silent saves never go
  // unnoticed (previously a missing-column or RLS error would only log to
  // console while the local cache appeared to "save" — and then the next
  // realtime refresh would clobber the not-yet-synced row).
  useEffect(() => {
    let lastShownAt = 0;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { table?: string; op?: string; message?: string } | undefined;
      // Throttle to one toast per 4 seconds — sync errors come in bursts.
      const now = Date.now();
      if (now - lastShownAt < 4000) return;
      lastShownAt = now;
      const what = detail?.table ? `${detail.table}/${detail.op || 'sync'}` : 'sync';
      showToast(`⚠️ Save failed: ${what} — ${detail?.message || 'unknown error'}`, 'error');
    };
    window.addEventListener('supabase-sync-error', handler);
    return () => window.removeEventListener('supabase-sync-error', handler);
  }, []);

  // One-shot toast when an email send is blocked because this group isn't
  // the deployment owner's. Fired by `apiProxy.ts` either pre-flight (we
  // know up front from VITE_OWNER_GROUP_ID) or as defense-in-depth on a
  // server 403. Dedup via sessionStorage so we don't pester the user every
  // time a new poll event would have triggered email — once per session is
  // enough to set expectations.
  useEffect(() => {
    const SEEN_KEY = 'email-disabled-toast-shown';
    const handler = () => {
      try {
        if (sessionStorage.getItem(SEEN_KEY) === '1') return;
        sessionStorage.setItem(SEEN_KEY, '1');
      } catch { /* sessionStorage unavailable, fall through and show once */ }
      const lang = (typeof document !== 'undefined' && document.documentElement.lang === 'en') ? 'en' : 'he';
      const msg = lang === 'en'
        ? 'ℹ️ Email is disabled for this group · push notifications continue to work'
        : 'ℹ️ מיילים מושבתים בקבוצה זו · התראות דחיפה ממשיכות לעבוד';
      showToast(msg, 'info');
    };
    window.addEventListener('email-disabled-for-group', handler);
    return () => window.removeEventListener('email-disabled-for-group', handler);
  }, []);

  // Mobile-safety net: flush any pending debounced syncs when the tab is
  // hidden or being unloaded. Mobile browsers (especially iOS Safari) will
  // suspend or evict setTimeout when the tab backgrounds, so a 300ms
  // debounced sync that hasn't fired yet would be lost forever otherwise —
  // exactly the bug that made AI summaries appear to save and then vanish
  // on the next session.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushAllPendingSyncs();
    };
    const onPageHide = () => flushAllPendingSyncs();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  // Push notification subscription — only when permission is already granted
  const subscribeToPush = useCallback(async () => {
    if (!groupId || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (Notification.permission !== 'granted') return;

    const VAPID_PUBLIC = 'BIyHc2Q3XXbAYl1DgPRpqHZGJVM4i38ElcKYpeBib5RXVAUKSiG7IxZ-ZJPyt1UWokY_saRldY-CY54UXnvZbH8';
    const isDead = (ep: string) => ep.includes('permanently-removed') || ep.includes('.invalid');
    try {
      let reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        if (isDead(existing.endpoint)) {
          deletePushSubscription(existing.endpoint);
        }
        await existing.unsubscribe();
      }

      let sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: VAPID_PUBLIC,
      });

      if (isDead(sub.endpoint)) {
        await sub.unsubscribe();
        const allRegs = await navigator.serviceWorker.getRegistrations();
        for (const r of allRegs) {
          const s = await r.pushManager.getSubscription();
          if (s) await s.unsubscribe();
          await r.unregister();
        }
        await new Promise(r => setTimeout(r, 1500));
        await navigator.serviceWorker.register('/sw.js');
        reg = await navigator.serviceWorker.ready;
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: VAPID_PUBLIC,
        });
        if (isDead(sub.endpoint)) return;
      }

      await savePushSubscription(groupId, playerName, sub);
    } catch (_err) { /* push subscription not available */ }
  }, [groupId, playerName]);

  useEffect(() => {
    if (!dataReady) return;
    subscribeToPush();
  }, [dataReady, subscribeToPush]);

  const handleEnablePush = useCallback(async () => {
    setShowPushNudge(false);
    if (!('Notification' in window)) return;
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      subscribeToPush();
    }
  }, [subscribeToPush]);

  // Activity tracking — one session per app load, screens accumulated via navigation effect
  const sessionStartRef = useRef<number | null>(null);
  const screensVisitedRef = useRef<Set<string>>(new Set());
  const isTrackingRef = useRef(false);
  const activityIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const locationRef = useRef(location.pathname);
  locationRef.current = location.pathname;

  const pushSessionUpdate = useCallback((keepalive = false) => {
    if (!isTrackingRef.current || !sessionStartRef.current) return;
    const screens = Array.from(screensVisitedRef.current);
    const duration = (Date.now() - sessionStartRef.current) / 60000;
    updateSessionActivity(screens, duration, keepalive).catch(() => {});
  }, []);

  // Wait until auth is fully settled before starting a session — `auth.loading`
  // stays true until `fetchMemberships` resolves, so by the time we enter this
  // effect `playerName` reflects the real linked-player value (or null because
  // the member genuinely isn't linked yet) rather than the transient "auth.user
  // arrived but memberships haven't" gap that previously inserted activity_log
  // rows with player_name = NULL.
  //
  // Dep on `auth.user?.id` (not `auth.user`) so a Supabase token refresh —
  // which emits a NEW user object reference but the same identity — doesn't
  // tear down and rebuild the session. Without this the effect re-fires every
  // ~hour and inserts a duplicate row.
  const userId = auth.user?.id ?? null;
  useEffect(() => {
    if (!dataReady || !role || !userId || auth.loading) return;
    sessionStartRef.current = Date.now();
    screensVisitedRef.current = new Set([getScreenName(locationRef.current)]);
    isTrackingRef.current = true;

    const initialScreen = getScreenName(locationRef.current);
    logActivity(role, playerName || undefined, userId, [initialScreen]).catch(() => {});

    activityIntervalRef.current = setInterval(() => pushSessionUpdate(), 5 * 60 * 1000);

    const handleVisChange = () => {
      if (document.visibilityState === 'hidden') pushSessionUpdate(true);
    };
    document.addEventListener('visibilitychange', handleVisChange);

    return () => {
      if (isTrackingRef.current) {
        pushSessionUpdate(true);
        isTrackingRef.current = false;
        resetSession();
      }
      if (activityIntervalRef.current) clearInterval(activityIntervalRef.current);
      document.removeEventListener('visibilitychange', handleVisChange);
    };
  }, [dataReady, role, userId, auth.loading, playerName, pushSessionUpdate]);

  useEffect(() => {
    if (isTrackingRef.current) {
      screensVisitedRef.current.add(getScreenName(location.pathname));
      pushSessionUpdate();
    }
  }, [location.pathname, pushSessionUpdate]);

  // Install prompt — capture beforeinstallprompt for Android/Chrome
  useEffect(() => {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || (navigator as unknown as Record<string, boolean>).standalone === true;
    if (isStandalone) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e);
      const dismissed = localStorage.getItem('install-banner-dismissed');
      if (dismissed && Date.now() - Number(dismissed) < 7 * 86400000) return;
      setTimeout(() => setShowInstallBanner(true), 3000);
    };
    window.addEventListener('beforeinstallprompt', handler);

    // iOS Safari — no beforeinstallprompt, show manual instructions
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as unknown as Record<string, unknown>).MSStream;
    const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome|CriOS|FxiOS/.test(navigator.userAgent);
    if (isIOS && isSafari) {
      const dismissed = localStorage.getItem('install-banner-dismissed');
      if (!dismissed || Date.now() - Number(dismissed) >= 7 * 86400000) {
        setTimeout(() => setShowInstallBanner(true), 4000);
      }
    }

    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // Push permission nudge — show friendly modal instead of cold browser prompt
  useEffect(() => {
    if (!dataReady || !('Notification' in window)) return;
    if (Notification.permission !== 'default') return;
    const dismissed = localStorage.getItem('push-nudge-dismissed');
    if (dismissed && Date.now() - Number(dismissed) < 3 * 86400000) return;
    const timer = setTimeout(() => setShowPushNudge(true), 5000);
    return () => clearTimeout(timer);
  }, [dataReady]);

  // Detect ?addMember=email deep link
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const email = params.get('addMember');
    if (email && auth.membership && (role === 'admin' || isSuperAdmin || isOwner)) {
      setAddMemberPrompt(email);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [auth.membership, role, isSuperAdmin, isOwner]);

  // When the deep-link banner opens, compute which existing players in this
  // group aren't linked to any user yet, so the admin can attach the joiner
  // to a historical player record (preventing Sefi/Tomer-style duplicates).
  // Auto-suggest a likely match by comparing the email's local-part to each
  // unlinked player's name.
  useEffect(() => {
    if (!addMemberPrompt || !auth.membership) {
      if (!addMemberPrompt) {
        setAddMemberPlayerId('');
        setAddMemberUnlinked([]);
      }
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const members = await auth.fetchMembers();
        if (cancelled) return;
        const linked = new Set(members.map(m => m.playerId).filter((x): x is string => !!x));
        const typeOrder: Record<string, number> = { permanent: 0, permanent_guest: 1, guest: 2 };
        const players = getAllPlayers()
          .filter(p => !linked.has(p.id))
          .map(p => ({ id: p.id, name: p.name, type: p.type as string }))
          .sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) || a.name.localeCompare(b.name));
        setAddMemberUnlinked(players);

        const localPart = (addMemberPrompt.split('@')[0] || '').toLowerCase();
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z\u0590-\u05ff]/g, '');
        const localNorm = norm(localPart);
        const match = players.find(p => {
          const playerNorm = norm(p.name);
          if (!playerNorm || !localNorm) return false;
          return localNorm.includes(playerNorm) || playerNorm.includes(localNorm);
        });
        if (match) setAddMemberPlayerId(match.id);
      } catch (e) {
        if (!cancelled) console.warn('addMember: failed to load unlinked players', e);
      }
    })();
    return () => { cancelled = true; };
  }, [addMemberPrompt, auth.membership, auth.fetchMembers]);

  const handleAddMemberFromLink = async () => {
    if (!addMemberPrompt) return;
    setAddMemberStatus('loading');
    const { error } = await auth.addMemberByEmail(addMemberPrompt, addMemberPlayerId || undefined);
    if (error) {
      const msg = (error as { message?: string })?.message || '';
      if (msg.includes('No registered user')) setAddMemberMsg(t('addMember.noUser'));
      else if (msg.includes('already a member')) setAddMemberMsg(t('addMember.alreadyMember'));
      else setAddMemberMsg(msg || t('addMember.error'));
      setAddMemberStatus('error');
    } else {
      setAddMemberMsg(t('addMember.added', { email: addMemberPrompt }));
      setAddMemberStatus('success');
      setTimeout(() => {
        setAddMemberPrompt(null);
        setAddMemberStatus('idle');
        setAddMemberPlayerId('');
        setAddMemberUnlinked([]);
      }, 3000);
    }
  };

  const signOut = useCallback(() => {
    unsubscribeFromRealtime(); resetCache(); setDataReady(false); auth.signOut();
  }, [auth]);

  const switchGroup = useCallback((gid: string) => {
    unsubscribeFromRealtime(); resetCache(); setDataReady(false); auth.switchGroup(gid);
  }, [auth]);

  const deleteGroupCb = useCallback(async (gid: string) => {
    const result = await auth.deleteGroup(gid);
    if (!result.error) { unsubscribeFromRealtime(); resetCache(); setDataReady(false); }
    return result;
  }, [auth]);

  const leaveGroupCb = useCallback(async (gid: string) => {
    const result = await auth.leaveGroup(gid);
    if (!result.error) { unsubscribeFromRealtime(); resetCache(); setDataReady(false); }
    return result;
  }, [auth]);

  const triggerGroupWizard = useCallback(() => setShowGroupWizard(true), []);

  // Cycle helper for the View-As pill. Defined outside the memo so the
  // identity is stable per-render. The four-state cycle (real →
  // member → admin → owner → real → ...) mirrors the previous
  // ViewAsSwitcher implementation 1:1; only the rendering location
  // changed.
  const cycleViewAs = useCallback(() => {
    const order: (ViewAsRole | null)[] = [null, 'member', 'admin', 'owner'];
    const idx = order.indexOf(viewAsRole);
    setViewAsRole(order[(idx + 1) % order.length]);
  }, [viewAsRole, setViewAsRole]);

  const permissionValue: PermissionContextType = useMemo(() => ({
    role,
    isOwner,
    isSuperAdmin,
    trainingEnabled,
    playerName,
    hasPermission: (permission) => isSuperAdmin || isOwner || hasPermission(role, permission),
    signOut,
    // View-As controls present only when the REAL user is super admin
    // (gated on `realIsSuperAdmin`, not the possibly-overridden flag,
    // so the pill is always reachable to switch back).
    viewAs: realIsSuperAdmin ? { current: viewAsRole, cycle: cycleViewAs } : undefined,
    // groupMgmt is provided in two cases:
    //   1) Real member: pulled from auth.membership (group name + invite
    //      code derived from the user's group_members row).
    //   2) Super-admin observer (no membership row in the active group):
    //      synthesized from auth.allGroups so the Settings > Group tab
    //      can render. Mutation callbacks are still wired through, but
    //      GroupManagementTab is rendered with `readOnly` when
    //      `isObservingNonMember` is true so write affordances are
    //      hidden — the server-side RPCs for those mutations would
    //      reject super admins anyway (migration 061 only widened the
    //      read path, by product decision).
    groupMgmt: auth.membership ? {
      groupName: auth.membership.groupName,
      inviteCode: auth.membership.inviteCode,
      currentUserId: auth.user?.id ?? '',
      fetchMembers: auth.fetchMembers,
      updateMemberRole: auth.updateMemberRole,
      removeMember: auth.removeMember,
      transferOwnership: auth.transferOwnership,
      regenerateInviteCode: auth.regenerateInviteCode,
      unlinkMemberPlayer: auth.unlinkMemberPlayer,
      createPlayerInvite: auth.createPlayerInvite,
      addMemberByEmail: auth.addMemberByEmail,
    } : (isObservingNonMember && observedGroupMeta ? {
      groupName: observedGroupMeta.groupName,
      inviteCode: observedGroupMeta.inviteCode,
      currentUserId: auth.user?.id ?? '',
      fetchMembers: auth.fetchMembers,
      updateMemberRole: auth.updateMemberRole,
      removeMember: auth.removeMember,
      transferOwnership: auth.transferOwnership,
      regenerateInviteCode: auth.regenerateInviteCode,
      unlinkMemberPlayer: auth.unlinkMemberPlayer,
      createPlayerInvite: auth.createPlayerInvite,
      addMemberByEmail: auth.addMemberByEmail,
    } : undefined),
    multiGroup: {
      memberships: auth.memberships,
      activeGroupId: groupId,
      switchGroup,
      createGroup: auth.createGroup,
      joinGroup: auth.joinGroup,
      joinByPlayerInvite: auth.joinByPlayerInvite,
      deleteGroup: deleteGroupCb,
      leaveGroup: leaveGroupCb,
      refreshMembership: auth.refreshMembership,
      triggerGroupWizard,
      userEmail: auth.user?.email ?? '',
      // Surfaced for super admins so the GroupSwitcher can render
      // platform-wide groups (the ones the user isn't a member of) as
      // observer entries. `realIsSuperAdmin` is the source of truth —
      // not the View-As-overlaid role — because observer privileges
      // are tied to the actual super_admins row, not a UI preview.
      isSuperAdmin: realIsSuperAdmin,
      allGroups: auth.allGroups,
      isObservingNonMember,
    },
  }), [role, isOwner, isSuperAdmin, realIsSuperAdmin, viewAsRole, cycleViewAs, trainingEnabled, playerName, signOut, auth, groupId, switchGroup, deleteGroupCb, leaveGroupCb, triggerGroupWizard, isObservingNonMember, observedGroupMeta]);

  if (auth.loading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--background)',
      }}>
        <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🃏</div>
          {t('app.loading')}
        </div>
      </div>
    );
  }

  if (!auth.user) {
    return <AuthScreen onSignIn={auth.signIn} onSignUp={auth.signUp} onGoogleSignIn={auth.signInWithGoogle} />;
  }

  // Show the group setup gate only when the user truly has no
  // memberships. A super admin who's observing a non-member group has
  // `auth.membership === null` (no row in group_members for the active
  // group) but `auth.memberships.length > 0` for their own groups —
  // they should NOT be bounced to the setup screen.
  if (auth.memberships.length === 0) {
    return (
      <GroupSetupScreen
        userEmail={auth.user.email ?? ''}
        onCreateGroup={async (name) => {
          const result = await auth.createGroup(name);
          if (!result.error) setShowGroupWizard(true);
          return result;
        }}
        onJoinGroup={auth.joinGroup}
        onJoinByPlayerInvite={auth.joinByPlayerInvite}
        onSignOut={auth.signOut}
        onContinue={() => auth.refreshMembership()}
      />
    );
  }

  if (!dataReady) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--background)', direction: 'rtl',
      }}>
        <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🃏</div>
          {dataError ? (
            <>
              <p style={{ color: '#ef4444', marginBottom: '1rem' }}>{dataError}</p>
              <button
                onClick={() => window.location.reload()}
                style={{
                  padding: '0.6rem 1.5rem', borderRadius: '8px', border: 'none',
                  background: 'var(--primary)', color: 'white', cursor: 'pointer',
                  fontFamily: 'Outfit, sans-serif',
                }}
              >
                {t('common.retry')}
              </button>
            </>
          ) : (
            t('app.loadingData')
          )}
        </div>
      </div>
    );
  }

  if (showGroupWizard) {
    return (
      <GroupWizard
        ownerPlayerName={playerName}
        groupName={auth.membership?.groupName ?? null}
        onComplete={() => setShowGroupWizard(false)}
        onSelfCreate={!playerName ? auth.selfCreateAndLink : undefined}
        createPlayerInvite={auth.createPlayerInvite}
        groupInviteCode={auth.membership?.inviteCode ?? null}
      />
    );
  }

  if (dataReady && !playerName) {
    const displayName = auth.user?.user_metadata?.full_name
      || auth.user?.user_metadata?.name
      || auth.user?.email?.split('@')[0]
      || '';
    return (
      <PlayerPicker
        onSelfCreate={auth.selfCreateAndLink}
        onLink={auth.linkToPlayer}
        listLinkable={auth.listLinkablePlayers}
        userDisplayName={displayName}
      />
    );
  }

  // Focus-mode routes — the bottom navigation is hidden so the
  // active flow gets the full viewport. `/trivia/play` belongs here
  // (same family as training quizzes): the trivia screen needs every
  // pixel to fit question + 2×2 answers + reveal banner + report
  // pill on short mobile screens, and the bottom nav was overlapping
  // the report row.
  const hideNav = ['/live-game', '/chip-entry', '/game-summary', '/training/play', '/shared-training/play', '/trivia/play'].some(path =>
    location.pathname.startsWith(path)
  );

  const addMemberBanner = addMemberPrompt && (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
      background: 'var(--surface)', borderBottom: '2px solid var(--primary)',
      padding: '1rem', direction: 'rtl', boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
    }}>
      {addMemberStatus === 'idle' && (
        <div style={{ textAlign: 'center', maxWidth: '420px', margin: '0 auto' }}>
          <p style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text)' }}>
            {t('addMember.title')}
          </p>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            {t('addMember.question', { email: addMemberPrompt })}
          </p>
          {addMemberUnlinked.length > 0 && (
            <div style={{ marginBottom: '0.75rem', textAlign: 'right' }}>
              <label style={{
                display: 'block', fontSize: '0.78rem', color: 'var(--text-muted)',
                marginBottom: '0.3rem', fontWeight: 500,
              }}>
                {t('addMember.linkLabel')}
              </label>
              <StyledSelect<string>
                value={addMemberPlayerId}
                onChange={setAddMemberPlayerId}
                options={[
                  { value: '', label: t('addMember.linkAsNew') },
                  ...addMemberUnlinked.map(p => ({
                    value: p.id,
                    label: `${p.name}${p.type === 'permanent' ? ' ⭐' : p.type === 'permanent_guest' ? ' 🏠' : ''}`,
                  })),
                ]}
                size="md"
                fullWidth
                title={t('addMember.linkLabel')}
              />
              <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.3rem', lineHeight: 1.4 }}>
                {addMemberPlayerId
                  ? t('addMember.linkHelpSelected')
                  : t('addMember.linkHelpUnselected')}
              </p>
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
            <button
              onClick={handleAddMemberFromLink}
              style={{
                padding: '0.55rem 1.5rem', borderRadius: '8px', border: 'none',
                background: 'var(--primary)', color: 'white', cursor: 'pointer',
                fontSize: '0.9rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
              }}
            >
              {t('addMember.confirm')}
            </button>
            <button
              onClick={() => {
                setAddMemberPrompt(null);
                setAddMemberStatus('idle');
                setAddMemberPlayerId('');
                setAddMemberUnlinked([]);
              }}
              style={{
                padding: '0.55rem 1.5rem', borderRadius: '8px',
                border: '1px solid var(--border)', background: 'none',
                color: 'var(--text-muted)', cursor: 'pointer',
                fontSize: '0.9rem', fontFamily: 'Outfit, sans-serif',
              }}
            >
              {t('addMember.dismiss')}
            </button>
          </div>
        </div>
      )}
      {addMemberStatus === 'loading' && (
        <p style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{t('addMember.adding')}</p>
      )}
      {addMemberStatus === 'success' && (
        <p style={{ textAlign: 'center', color: '#10B981', fontWeight: 600 }}>✓ {addMemberMsg}</p>
      )}
      {addMemberStatus === 'error' && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: '#EF4444', marginBottom: '0.5rem' }}>{addMemberMsg}</p>
          <button
            onClick={() => {
              setAddMemberPrompt(null);
              setAddMemberStatus('idle');
              setAddMemberPlayerId('');
              setAddMemberUnlinked([]);
            }}
            style={{
              padding: '0.4rem 1rem', borderRadius: '6px', border: '1px solid var(--border)',
              background: 'none', color: 'var(--text-muted)', cursor: 'pointer',
              fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif',
            }}
          >
            {t('common.close')}
          </button>
        </div>
      )}
    </div>
  );

  const unreadNotifications = getCachedNotifications().filter(n => !n.read);
  const bannerLabel = notifCount === 1 && unreadNotifications[0]?.title
    ? unreadNotifications[0].title
    : t('notification.bannerMany', { count: notifCount });

  const notificationBanner = notifCount > 0 && !showNotifPanel && (
    <div
      onClick={() => setShowNotifPanel(true)}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9998,
        background: 'linear-gradient(135deg, #1e293b, #0f172a)', borderBottom: '2px solid #EAB308',
        padding: '0.5rem 1rem', direction: 'rtl', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
        animation: 'contentFadeIn 0.3s ease-out',
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      }}
    >
      <span style={{ fontSize: '1.1rem' }}>🔔</span>
      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#EAB308' }}>
        {bannerLabel}
      </span>
    </div>
  );

  const notificationPanel = showNotifPanel && (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.6)', animation: 'backdropFadeIn 0.2s ease-out',
      }}
      onClick={() => setShowNotifPanel(false)}
    >
      <div
        style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          maxHeight: '60vh', overflowY: 'auto',
          background: 'var(--surface)', borderRadius: '0 0 16px 16px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)', padding: '1rem',
          direction: 'rtl', animation: 'modalSlideUp 0.3s ease-out',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--text)' }}>🔔 התראות</h3>
          <button
            onClick={() => setShowNotifPanel(false)}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem' }}
          >✕</button>
        </div>
        {getCachedNotifications().filter(n => !n.read).map(n => (
          <div
            key={n.id}
            style={{
              background: '#1e2d45', borderRadius: '10px', padding: '0.75rem',
              marginBottom: '0.5rem', borderRight: '3px solid #EAB308',
            }}
          >
            <p style={{ margin: '0 0 0.3rem', fontSize: '0.85rem', fontWeight: 600, color: '#EAB308' }}>{n.title}</p>
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>{n.body}</p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {!!n.data?.gameId && (
                <button
                  onClick={() => {
                    markNotificationRead(n.id).then(() => setNotifCount(getUnreadNotificationCount()));
                    setShowNotifPanel(false);
                    navigate(`/game/${String(n.data!.gameId)}`);
                  }}
                  style={{
                    padding: '0.35rem 0.75rem', borderRadius: '6px', border: 'none',
                    background: '#3b82f6', color: 'white', fontSize: '0.75rem',
                    fontWeight: 600, cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
                  }}
                >
                  {t('notification.open')}
                </button>
              )}
              <button
                onClick={() => markNotificationRead(n.id).then(() => setNotifCount(getUnreadNotificationCount()))}
                style={{
                  padding: '0.35rem 0.75rem', borderRadius: '6px',
                  border: '1px solid var(--border)', background: 'none',
                  color: 'var(--text-muted)', fontSize: '0.75rem', cursor: 'pointer',
                  fontFamily: 'Outfit, sans-serif',
                }}
              >
                {t('notification.dismiss')}
              </button>
            </div>
          </div>
        ))}
        {getCachedNotifications().filter(n => !n.read).length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem', padding: '1rem 0' }}>
            אין התראות חדשות
          </p>
        )}
      </div>
    </div>
  );

  // Everyone (admins, members, super-admin previews) lands on the
  // home tab now. Members previously fell through to /statistics
  // because the home screen was empty for them, but it now shows
  // the schedule + last-game + training dashboard, so it's the
  // right landing surface for every role.
  const defaultRoute = '/';

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as unknown as Record<string, unknown>).MSStream;

  const installBanner = showInstallBanner && (
    <div style={{
      position: 'fixed', bottom: 70, left: 12, right: 12, zIndex: 9997,
      background: 'linear-gradient(135deg, #1a2332, #0f1923)',
      border: '1px solid rgba(16,185,129,0.25)', borderRadius: '14px',
      padding: '1rem 1.1rem', direction: 'rtl',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      animation: 'contentFadeIn 0.3s ease-out',
    }}>
      <button
        onClick={() => { setShowInstallBanner(false); localStorage.setItem('install-banner-dismissed', String(Date.now())); }}
        style={{ position: 'absolute', top: 8, left: 10, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem' }}
      >✕</button>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <span style={{ fontSize: '2rem', flexShrink: 0 }}>🃏</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text)', marginBottom: '0.2rem' }}>
            {t('install.title')}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
            {isIOS ? t('install.iosHint') : t('install.hint')}
          </div>
        </div>
        {!isIOS && installPrompt && (
          <button
            onClick={async () => {
              const prompt = installPrompt as unknown as { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
              await prompt.prompt();
              const choice = await prompt.userChoice;
              if (choice.outcome === 'accepted') {
                setShowInstallBanner(false);
              }
              setInstallPrompt(null);
            }}
            style={{
              padding: '0.5rem 1rem', borderRadius: '10px', border: 'none',
              background: '#10B981', color: 'white', fontWeight: 700,
              fontSize: '0.85rem', cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            {t('install.button')}
          </button>
        )}
      </div>
    </div>
  );

  const pushNudge = showPushNudge && (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10001,
        background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem', animation: 'backdropFadeIn 0.2s ease-out',
      }}
      onClick={() => { setShowPushNudge(false); localStorage.setItem('push-nudge-dismissed', String(Date.now())); }}
    >
      <div
        style={{
          background: 'var(--surface)', borderRadius: '16px', padding: '1.5rem',
          maxWidth: '340px', width: '100%', direction: 'rtl',
          border: '1px solid var(--border)', boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
          animation: 'contentFadeIn 0.3s ease-out',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🔔</div>
          <h3 style={{ margin: '0 0 0.4rem', color: 'var(--text)', fontSize: '1.1rem' }}>
            {t('pushNudge.title')}
          </h3>
          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {t('pushNudge.body')}
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <button
            onClick={handleEnablePush}
            style={{
              width: '100%', padding: '0.7rem', borderRadius: '10px', border: 'none',
              background: '#10B981', color: 'white', fontWeight: 700, fontSize: '0.9rem',
              cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
            }}
          >
            {t('pushNudge.enable')}
          </button>
          <button
            onClick={() => { setShowPushNudge(false); localStorage.setItem('push-nudge-dismissed', String(Date.now())); }}
            style={{
              width: '100%', padding: '0.5rem', borderRadius: '10px',
              border: '1px solid var(--border)', background: 'none',
              color: 'var(--text-muted)', fontSize: '0.8rem',
              cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
            }}
          >
            {t('pushNudge.later')}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <ErrorBoundary>
      <PermissionContext.Provider value={permissionValue}>
        {/* Super-admin-only "View As" pill is rendered inline inside
            the GroupSwitcher header (next to the version label) so it
            never overlaps page content. The pill consumes
            `permissionValue.viewAs` from this context. */}
        {addMemberBanner}
        {notificationBanner}
        {notificationPanel}
        {installBanner}
        {pushNudge}
        <div className="app-container">
          {/* Global observer-mode banner. Visible on EVERY route
              (including focus-mode game screens) so a super admin
              observing a foreign group via GroupSwitcher always
              knows their context is read-only. The cache kill
              switch in `pushToSupabase` and the AI proxy gate in
              `apiProxy.ts` silently block the actual writes — this
              banner is the *visible* cue so the operator doesn't
              get confused when buttons appear to do nothing.

              Rendered as a regular block at the very top of
              `.app-container` (no `position`, no `sticky`/`fixed`).
              Per-user feedback: a pinned bar covered content as
              the user scrolled past it. A non-pinned bar gives
              the visible cue at the top of every page transition
              (it re-paints on every route change since `<main>`
              fades in via `contentFadeIn`) without ever
              occluding game data while scrolling. */}
          {isObservingNonMember && (
            <div
              role="status"
              aria-live="polite"
              style={{
                width: '100%',
                padding: '0.35rem 1rem',
                background: 'rgba(234, 179, 8, 0.18)',
                borderBottom: '1px solid rgba(234, 179, 8, 0.4)',
                color: '#ca8a04',
                fontSize: '0.75rem',
                fontWeight: 600,
                textAlign: 'center',
                direction: 'rtl',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {hideNav
                ? t('observer.bannerShort')
                : t('observer.banner').replace(
                    '{group}',
                    observedGroupMeta?.groupName ?? '',
                  )}
            </div>
          )}
          {!hideNav && <GroupSwitcher />}
          {/* On focus-mode routes (hideNav) we drop the global
              `.main-content { padding-bottom: 6rem }` reservation
              for the now-hidden bottom nav. Otherwise the trivia /
              live-game flows lose ~96 px of usable viewport that
              they need for their content to fit on small screens. */}
          <main
            className="main-content"
            style={hideNav ? { paddingBottom: '1rem' } : undefined}
          >
            {/* Global vote-reminder banner. Hidden on no-nav screens
                (live-game / chip-entry / game-summary) since the user is
                mid-game and shouldn't be prompted to do scheduling actions. */}
            {!hideNav && <VoteReminderBanner />}
            <Suspense fallback={<ScreenSkeleton />}>
              <Routes>
                {/* Home — visible to every role. NewGameScreen renders
                    the admin game-creation panel when allowed, and a
                    schedule/last-game/training dashboard for members. */}
                <Route path="/" element={<NewGameScreen />} />
                {/* Admin-only "new game" action screen. Members hitting
                    this URL fall through to the home dashboard via the
                    redirect below — keeps the URL clean while preventing
                    confused empty-state UX. The screen itself also gates
                    its admin form on isMember=false so even if a member
                    somehow lands here, no form leaks through. */}
                <Route
                  path="/new-game"
                  element={
                    isAdmin && !isObservingNonMember
                      ? <NewGameScreen />
                      : <Navigate to="/" replace />
                  }
                />
                <Route path="/live-game/:gameId" element={<LiveGameScreen />} />
                <Route path="/chip-entry/:gameId" element={<ChipEntryScreen />} />
                <Route path="/game-summary/:gameId" element={<GameSummaryScreen />} />
                <Route path="/history" element={<HistoryScreen />} />
                <Route path="/game/:gameId" element={<GameSummaryScreen />} />
                <Route path="/statistics" element={<StatisticsScreen />} />
                <Route path="/settings" element={<SettingsScreen />} />
                {/* Schedule / polls — top-level page (was previously
                    mounted as a tab inside Settings). Promoted to its
                    own route in v5.60 because voting on the next game
                    is a recurring task, not a setting, and Home is now
                    the primary launcher. Old `/settings?tab=schedule`
                    URLs (push notifications, emails, OAuth redirects)
                    are transparently rerouted by SettingsScreen so no
                    deep-link breaks. */}
                <Route path="/schedule" element={<ScheduleTab />} />
                {/* Short-form schedule-poll deep link — see PollDeepLinkRedirect.
                    Used in WhatsApp share captions to keep the URL clean. */}
                <Route path="/p/:pollId" element={<PollDeepLinkRedirect />} />
                <Route path="/graphs" element={<GraphsScreen />} />
                {isSuperAdmin && <Route path="/training" element={<TrainingScreen />} />}
                {isSuperAdmin && <Route path="/training/play" element={<TrainingHandScreen />} />}
                {isSuperAdmin && <Route path="/training/quick" element={<QuickTrainingScreen />} />}
                {trainingEnabled && <Route path="/shared-training" element={<SharedTrainingScreen />} />}
                {trainingEnabled && <Route path="/shared-training/play" element={<SharedQuickPlayScreen />} />}
                <Route path="/trivia" element={<TriviaLandingScreen />} />
                <Route path="/trivia/play" element={<TriviaGameScreen />} />
                <Route path="*" element={<Navigate to={defaultRoute} replace />} />
              </Routes>
            </Suspense>
          </main>
          {!hideNav && <Navigation />}
        </div>
        <ToastContainer />
      </PermissionContext.Provider>
    </ErrorBoundary>
  );
}

function AppWithLanguage() {
  const { isRTL } = useTranslation();
  useEffect(() => {
    document.documentElement.dir = isRTL ? 'rtl' : 'ltr';
    document.documentElement.lang = isRTL ? 'he' : 'en';
  }, [isRTL]);
  return <SupabaseApp />;
}

function App() {
  return (
    <LanguageProvider>
      <AppWithLanguage />
    </LanguageProvider>
  );
}

export default App;
