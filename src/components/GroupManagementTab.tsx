import { useState, useEffect, useCallback } from 'react';
import { getAllPlayers } from '../database/storage';
import type { GroupMember } from '../hooks/useSupabaseAuth';

interface GroupManagementTabProps {
  groupName: string;
  inviteCode: string | null;
  isOwner: boolean;
  currentUserId: string;
  fetchMembers: () => Promise<GroupMember[]>;
  updateMemberRole: (userId: string, role: string) => Promise<{ error: unknown }>;
  removeMember: (userId: string) => Promise<{ error: unknown }>;
  transferOwnership: (userId: string) => Promise<{ error: unknown }>;
  regenerateInviteCode: () => Promise<{ data: string | null; error: unknown }>;
  unlinkMemberPlayer: (userId: string) => Promise<{ error: unknown }>;
  createPlayerInvite: (playerId: string) => Promise<{ data: { invite_code: string; player_name: string; already_existed: boolean } | null; error: unknown }>;
  addMemberByEmail: (email: string, playerId?: string) => Promise<{ data: { user_id: string; display_name: string; player_id: string | null } | null; error: unknown }>;
  appUrl: string;
}

export default function GroupManagementTab({
  groupName,
  inviteCode: initialInviteCode,
  isOwner,
  currentUserId,
  fetchMembers,
  updateMemberRole,
  removeMember,
  transferOwnership,
  regenerateInviteCode,
  unlinkMemberPlayer,
  createPlayerInvite,
  addMemberByEmail,
  appUrl,
}: GroupManagementTabProps) {
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const [copied, setCopied] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: 'remove' | 'transfer' | 'regenerate';
    userId?: string;
    name?: string;
  } | null>(null);
  const [personalInvite, setPersonalInvite] = useState<{
    playerName: string;
    code: string;
    message: string;
  } | null>(null);
  const [addEmail, setAddEmail] = useState('');
  const [addEmailPlayer, setAddEmailPlayer] = useState('');
  const [addEmailLoading, setAddEmailLoading] = useState(false);

  const loadMembers = useCallback(async () => {
    setLoading(true);
    const data = await fetchMembers();
    setMembers(data);
    setLoading(false);
  }, [fetchMembers]);

  useEffect(() => { loadMembers(); }, [loadMembers]);

  const showMsg = (type: 'success' | 'error', text: string) => {
    setActionMsg({ type, text });
    setTimeout(() => setActionMsg(null), 3000);
  };

  const handleRoleChange = async (userId: string, newRole: string) => {
    const { error } = await updateMemberRole(userId, newRole);
    if (error) {
      showMsg('error', (error as { message?: string })?.message || 'שגיאה בשינוי תפקיד');
    } else {
      showMsg('success', 'התפקיד עודכן');
      loadMembers();
    }
  };

  const handleRemove = async (userId: string) => {
    const { error } = await removeMember(userId);
    setConfirmAction(null);
    if (error) {
      showMsg('error', (error as { message?: string })?.message || 'שגיאה בהסרת חבר');
    } else {
      showMsg('success', 'החבר הוסר מהקבוצה');
      loadMembers();
    }
  };

  const handleTransfer = async (userId: string) => {
    const { error } = await transferOwnership(userId);
    setConfirmAction(null);
    if (error) {
      showMsg('error', (error as { message?: string })?.message || 'שגיאה בהעברת בעלות');
    } else {
      showMsg('success', 'הבעלות הועברה בהצלחה');
      loadMembers();
    }
  };

  const handleRegenerate = async () => {
    const { data, error } = await regenerateInviteCode();
    setConfirmAction(null);
    if (error) {
      showMsg('error', (error as { message?: string })?.message || 'שגיאה ביצירת קוד חדש');
    } else if (data) {
      setInviteCode(data);
      showMsg('success', 'קוד הזמנה חדש נוצר');
    }
  };

  const handleUnlink = async (userId: string) => {
    const { error } = await unlinkMemberPlayer(userId);
    if (error) {
      showMsg('error', (error as { message?: string })?.message || 'שגיאה בניתוק שחקן');
    } else {
      showMsg('success', 'השחקן נותק מהחבר');
      loadMembers();
    }
  };

  const handleCreateInvite = async (playerId: string) => {
    const { data, error } = await createPlayerInvite(playerId);
    if (error) {
      showMsg('error', (error as { message?: string })?.message || 'שגיאה ביצירת הזמנה');
      return;
    }
    if (data) {
      const msg = [
        `🃏 ${data.player_name}, הוזמנת לקבוצת הפוקר שלנו!`,
        ``,
        `📱 היכנס לאפליקציה:`,
        appUrl,
        ``,
        `🔑 קוד ההצטרפות האישי שלך:`,
        data.invite_code,
        ``,
        `המקום שלך שמור — פשוט היכנס עם הקוד הזה ותהיה מוכן למשחק הבא! 🎯`,
      ].join('\n');
      setPersonalInvite({ playerName: data.player_name, code: data.invite_code, message: msg });
    }
  };

  const handleAddByEmail = async () => {
    const email = addEmail.trim();
    if (!email) { showMsg('error', 'נא להזין כתובת אימייל'); return; }
    setAddEmailLoading(true);
    const { error } = await addMemberByEmail(email, addEmailPlayer || undefined);
    setAddEmailLoading(false);
    if (error) {
      const msg = (error as { message?: string })?.message || '';
      if (msg.includes('No registered user')) showMsg('error', 'לא נמצא משתמש רשום עם האימייל הזה');
      else if (msg.includes('already a member')) showMsg('error', 'המשתמש כבר חבר בקבוצה');
      else showMsg('error', msg || 'שגיאה בהוספת חבר');
    } else {
      showMsg('success', 'החבר נוסף לקבוצה!');
      setAddEmail('');
      setAddEmailPlayer('');
      loadMembers();
    }
  };

  const linkedPlayerIds = new Set(members.map(m => m.playerId).filter(Boolean));
  const unlinkedPlayers = getAllPlayers().filter(p => !linkedPlayerIds.has(p.id));

  const roleLabel = (role: string) => {
    switch (role) {
      case 'admin': return '👑 מנהל';
      case 'member': return '⭐ חבר';
      case 'viewer': return '👁️ צופה';
      default: return role;
    }
  };

  return (
    <div style={{ direction: 'rtl' }}>
      {/* Action feedback */}
      {actionMsg && (
        <div style={{
          padding: '0.6rem 1rem', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.85rem', fontWeight: 500,
          background: actionMsg.type === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
          color: actionMsg.type === 'success' ? '#10B981' : '#EF4444',
          border: `1px solid ${actionMsg.type === 'success' ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
        }}>
          {actionMsg.text}
        </div>
      )}

      {/* Group Info */}
      <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
        <h2 className="card-title" style={{ margin: '0 0 0.75rem 0' }}>🏠 פרטי קבוצה</h2>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>שם הקבוצה</span>
          <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>{groupName}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>חברים</span>
          <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>{members.length}</span>
        </div>
      </div>

      {/* Invite Code — visible to owner/admin */}
      {inviteCode && (
        <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
          <h2 className="card-title" style={{ margin: '0 0 0.5rem 0' }}>🔗 קוד הזמנה</h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            שתף את הקוד עם שחקנים חדשים כדי שיצטרפו לקבוצה
          </p>
          <div style={{
            background: 'var(--background)', border: '2px dashed var(--border)', borderRadius: '10px',
            padding: '0.6rem', textAlign: 'center', letterSpacing: '5px', fontSize: '1.4rem',
            fontWeight: 700, fontFamily: 'monospace', color: 'var(--text)', direction: 'ltr', marginBottom: '0.75rem',
          }}>
            {inviteCode}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={() => {
                navigator.clipboard.writeText(inviteCode);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              style={{
                flex: 1, padding: '0.5rem', borderRadius: '8px', border: '1px solid var(--border)',
                background: copied ? '#10B981' : 'var(--surface)', color: copied ? 'white' : 'var(--text)',
                cursor: 'pointer', fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
              }}
            >
              {copied ? '✓ הועתק!' : '📋 העתק'}
            </button>
            {typeof navigator.share === 'function' && (
              <button
                onClick={() => {
                  navigator.share({
                    title: `הצטרף ל${groupName}`,
                    text: `הצטרף לקבוצת הפוקר שלנו! קוד הזמנה: ${inviteCode}`,
                  }).catch(() => {});
                }}
                style={{
                  flex: 1, padding: '0.5rem', borderRadius: '8px', border: '1px solid var(--border)',
                  background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer',
                  fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                }}
              >
                📤 שתף
              </button>
            )}
            {isOwner && (
              <button
                onClick={() => setConfirmAction({ type: 'regenerate' })}
                style={{
                  padding: '0.5rem 0.75rem', borderRadius: '8px', border: '1px solid rgba(239,68,68,0.3)',
                  background: 'rgba(239,68,68,0.08)', color: '#EF4444', cursor: 'pointer',
                  fontSize: '0.75rem', fontFamily: 'Outfit, sans-serif',
                }}
                title="הקוד הישן יפסיק לעבוד"
              >
                🔄
              </button>
            )}
          </div>
        </div>
      )}

      {/* Personal Player Invites */}
      {isOwner && unlinkedPlayers.length > 0 && (
        <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
          <h2 className="card-title" style={{ margin: '0 0 0.5rem 0' }}>📨 הזמנות אישיות</h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            שלח הזמנה אישית לשחקן — כשיירשם עם הקוד, הוא יקושר אוטומטית
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {unlinkedPlayers.map(p => (
              <div key={p.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '0.55rem 0.75rem', borderRadius: '8px', background: 'var(--background)',
                border: '1px solid var(--border)',
              }}>
                <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{p.name}</span>
                <button
                  onClick={() => handleCreateInvite(p.id)}
                  style={{
                    padding: '0.35rem 0.75rem', borderRadius: '8px', border: 'none',
                    background: 'var(--primary)', color: 'white', cursor: 'pointer',
                    fontSize: '0.75rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                  }}
                >
                  📩 הזמן
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Member by Email */}
      {isOwner && (
        <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
          <h2 className="card-title" style={{ margin: '0 0 0.5rem 0' }}>➕ הוסף חבר לפי אימייל</h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            הוסף משתמש שכבר נרשם לאפליקציה אבל לא הצטרף לקבוצה
          </p>
          <input
            type="email"
            value={addEmail}
            onChange={e => setAddEmail(e.target.value)}
            placeholder="example@gmail.com"
            dir="ltr"
            style={{
              width: '100%', padding: '0.6rem 0.75rem', borderRadius: '8px',
              border: '1px solid var(--border)', background: 'var(--background)',
              color: 'var(--text)', fontSize: '0.9rem', fontFamily: 'Outfit, sans-serif',
              boxSizing: 'border-box', marginBottom: '0.5rem',
            }}
          />
          {unlinkedPlayers.length > 0 && (
            <select
              value={addEmailPlayer}
              onChange={e => setAddEmailPlayer(e.target.value)}
              style={{
                width: '100%', padding: '0.5rem 0.75rem', borderRadius: '8px',
                border: '1px solid var(--border)', background: '#1a1a2e',
                color: '#ffffff', fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif',
                marginBottom: '0.5rem', cursor: 'pointer',
              }}
            >
              <option value="" style={{ background: '#1a1a2e', color: '#ffffff' }}>קשר לשחקן (אופציונלי)</option>
              {unlinkedPlayers.map(p => (
                <option key={p.id} value={p.id} style={{ background: '#1a1a2e', color: '#ffffff' }}>{p.name}</option>
              ))}
            </select>
          )}
          <button
            onClick={handleAddByEmail}
            disabled={addEmailLoading}
            style={{
              width: '100%', padding: '0.6rem', borderRadius: '8px', border: 'none',
              background: 'var(--primary)', color: 'white', cursor: addEmailLoading ? 'not-allowed' : 'pointer',
              fontSize: '0.85rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
              opacity: addEmailLoading ? 0.6 : 1,
            }}
          >
            {addEmailLoading ? '...' : '➕ הוסף לקבוצה'}
          </button>
        </div>
      )}

      {/* Personal Invite Share Modal */}
      {personalInvite && (
        <div className="modal-overlay" onClick={() => setPersonalInvite(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ direction: 'rtl', maxWidth: '380px' }}>
            <div className="modal-header">
              <h3 className="modal-title">📨 הזמנה ל{personalInvite.playerName}</h3>
              <button className="modal-close" onClick={() => setPersonalInvite(null)}>×</button>
            </div>

            <div style={{
              background: 'var(--background)', borderRadius: '10px', padding: '1rem',
              fontSize: '0.85rem', lineHeight: '1.6', whiteSpace: 'pre-line',
              marginBottom: '1rem', border: '1px solid var(--border)',
              direction: 'rtl',
            }}>
              {personalInvite.message}
            </div>

            <div style={{
              background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)',
              borderRadius: '8px', padding: '0.6rem', textAlign: 'center', marginBottom: '1rem',
            }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>קוד אישי</div>
              <div style={{
                letterSpacing: '4px', fontSize: '1.4rem', fontWeight: 700,
                fontFamily: 'monospace', color: 'var(--text)', direction: 'ltr',
              }}>
                {personalInvite.code}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(personalInvite.message);
                  showMsg('success', 'ההודעה הועתקה!');
                }}
                style={{
                  flex: 1, padding: '0.65rem', borderRadius: '8px', border: '1px solid var(--border)',
                  background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer',
                  fontSize: '0.85rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                }}
              >
                📋 העתק הודעה
              </button>
              {typeof navigator.share === 'function' && (
                <button
                  onClick={() => {
                    navigator.share({
                      title: `הזמנה ל${personalInvite.playerName}`,
                      text: personalInvite.message,
                    }).catch(() => {});
                  }}
                  style={{
                    flex: 1, padding: '0.65rem', borderRadius: '8px', border: 'none',
                    background: '#25D366', color: 'white', cursor: 'pointer',
                    fontSize: '0.85rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                  }}
                >
                  📤 שלח בוואטסאפ
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Member List */}
      <div className="card" style={{ padding: '1rem' }}>
        <h2 className="card-title" style={{ margin: '0 0 0.75rem 0' }}>👥 חברי קבוצה</h2>

        {loading ? (
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>טוען...</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {members.map(m => {
              const isMe = m.userId === currentUserId;
              const isMemberOwner = members.length > 0 && isOwner && isMe;
              return (
                <div key={m.userId} style={{
                  padding: '0.75rem', borderRadius: '10px', border: '1px solid var(--border)',
                  background: isMe ? 'rgba(16,185,129,0.05)' : 'var(--background)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                        {m.displayName || m.playerName || '(ללא שם)'}
                      </span>
                      {isMe && (
                        <span style={{ fontSize: '0.65rem', background: 'rgba(16,185,129,0.15)', color: '#10B981', padding: '0.1rem 0.4rem', borderRadius: '6px' }}>
                          אתה
                        </span>
                      )}
                      {isMemberOwner && (
                        <span style={{ fontSize: '0.65rem', background: 'rgba(234,179,8,0.15)', color: '#EAB308', padding: '0.1rem 0.4rem', borderRadius: '6px' }}>
                          בעלים
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {roleLabel(m.role)}
                    </span>
                  </div>

                  {m.playerName && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                      שחקן: {m.playerName}
                    </div>
                  )}
                  {!m.playerName && m.playerId === null && (
                    <div style={{ fontSize: '0.75rem', color: '#F59E0B' }}>
                      לא מקושר לשחקן
                    </div>
                  )}

                  {/* Admin Controls */}
                  {!isMe && isOwner && (
                    <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                      <select
                        value={m.role}
                        onChange={e => handleRoleChange(m.userId, e.target.value)}
                        style={{
                          padding: '0.3rem 0.5rem', borderRadius: '6px', border: '1px solid var(--border)',
                          background: '#1a1a2e', color: 'var(--text)', fontSize: '0.75rem', fontFamily: 'Outfit, sans-serif',
                          cursor: 'pointer',
                        }}
                      >
                        <option value="admin" style={{ background: '#1a1a2e', color: '#ffffff' }}>מנהל</option>
                        <option value="member" style={{ background: '#1a1a2e', color: '#ffffff' }}>חבר</option>
                        <option value="viewer" style={{ background: '#1a1a2e', color: '#ffffff' }}>צופה</option>
                      </select>
                      {m.playerName && (
                        <button
                          onClick={() => handleUnlink(m.userId)}
                          style={{
                            padding: '0.3rem 0.5rem', borderRadius: '6px', border: '1px solid rgba(245,158,11,0.3)',
                            background: 'rgba(245,158,11,0.08)', color: '#F59E0B', fontSize: '0.7rem',
                            cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
                          }}
                        >
                          נתק שחקן
                        </button>
                      )}
                      <button
                        onClick={() => setConfirmAction({ type: 'transfer', userId: m.userId, name: m.displayName || m.playerName || '' })}
                        style={{
                          padding: '0.3rem 0.5rem', borderRadius: '6px', border: '1px solid rgba(168,85,247,0.3)',
                          background: 'rgba(168,85,247,0.08)', color: '#A855F7', fontSize: '0.7rem',
                          cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
                        }}
                      >
                        העבר בעלות
                      </button>
                      <button
                        onClick={() => setConfirmAction({ type: 'remove', userId: m.userId, name: m.displayName || m.playerName || '' })}
                        style={{
                          padding: '0.3rem 0.5rem', borderRadius: '6px', border: '1px solid rgba(239,68,68,0.3)',
                          background: 'rgba(239,68,68,0.08)', color: '#EF4444', fontSize: '0.7rem',
                          cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
                        }}
                      >
                        הסר
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Confirmation Modal */}
      {confirmAction && (
        <div className="modal-overlay" onClick={() => setConfirmAction(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ direction: 'rtl' }}>
            <div className="modal-header">
              <h3 className="modal-title">
                {confirmAction.type === 'remove' && '🗑️ הסרת חבר'}
                {confirmAction.type === 'transfer' && '👑 העברת בעלות'}
                {confirmAction.type === 'regenerate' && '🔄 יצירת קוד חדש'}
              </h3>
              <button className="modal-close" onClick={() => setConfirmAction(null)}>×</button>
            </div>

            {confirmAction.type === 'remove' && (
              <>
                <p style={{ marginBottom: '0.5rem' }}>
                  להסיר את <strong>{confirmAction.name}</strong> מהקבוצה?
                </p>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                  היסטוריית המשחקים שלו תישמר
                </p>
              </>
            )}
            {confirmAction.type === 'transfer' && (
              <>
                <p style={{ marginBottom: '0.5rem' }}>
                  להעביר את בעלות הקבוצה ל<strong>{confirmAction.name}</strong>?
                </p>
                <p style={{ fontSize: '0.8rem', color: '#F59E0B', marginBottom: '1rem' }}>
                  ⚠️ לא תוכל לבטל פעולה זו. תישאר כמנהל אבל לא כבעלים.
                </p>
              </>
            )}
            {confirmAction.type === 'regenerate' && (
              <>
                <p style={{ marginBottom: '0.5rem' }}>
                  ליצור קוד הזמנה חדש?
                </p>
                <p style={{ fontSize: '0.8rem', color: '#F59E0B', marginBottom: '1rem' }}>
                  ⚠️ הקוד הנוכחי יפסיק לעבוד. מי שלא הצטרף עדיין יצטרך את הקוד החדש.
                </p>
              </>
            )}

            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setConfirmAction(null)}>
                ביטול
              </button>
              <button
                className={confirmAction.type === 'transfer' ? 'btn' : 'btn btn-danger'}
                style={confirmAction.type === 'transfer' ? { background: '#A855F7', color: 'white', border: 'none', padding: '0.5rem 1rem', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Outfit, sans-serif' } : undefined}
                onClick={() => {
                  if (confirmAction.type === 'remove' && confirmAction.userId) handleRemove(confirmAction.userId);
                  if (confirmAction.type === 'transfer' && confirmAction.userId) handleTransfer(confirmAction.userId);
                  if (confirmAction.type === 'regenerate') handleRegenerate();
                }}
              >
                {confirmAction.type === 'remove' && 'הסר'}
                {confirmAction.type === 'transfer' && 'העבר בעלות'}
                {confirmAction.type === 'regenerate' && 'צור קוד חדש'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
