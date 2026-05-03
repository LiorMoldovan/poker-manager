import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../database/supabaseClient';
import type { User, Session } from '@supabase/supabase-js';
import type { PermissionRole } from '../types';

export interface GroupMember {
  userId: string;
  displayName: string | null;
  role: string;
  playerId: string | null;
  playerName: string | null;
  email: string | null;
}

export interface GroupMembership {
  groupId: string;
  groupName: string;
  role: PermissionRole;
  isOwner: boolean;
  playerName: string | null;
  playerId: string | null;
  inviteCode: string | null;
  trainingEnabled: boolean;
  memberCount: number;
}

interface AuthState {
  user: User | null;
  session: Session | null;
  memberships: GroupMembership[];
  activeGroupId: string | null;
  isSuperAdmin: boolean;
  loading: boolean;
}

const SUPABASE_ROLE_MAP: Record<string, PermissionRole> = {
  admin: 'admin',
  member: 'member',
};

export function useSupabaseAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    memberships: [],
    activeGroupId: null,
    isSuperAdmin: false,
    loading: true,
  });

  const membership = state.memberships.find(m => m.groupId === state.activeGroupId) ?? null;
  const activeGroupId = state.activeGroupId;

  const checkSuperAdmin = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from('super_admins')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();
    setState(prev => ({ ...prev, isSuperAdmin: !!data }));
  }, []);

  const fetchMemberships = useCallback(async (userId: string, switchToGroupId?: string) => {
    const { data, error } = await supabase
      .from('group_members')
      .select(`
        group_id,
        role,
        player_id,
        players ( name ),
        groups ( name, invite_code, created_by, training_enabled )
      `)
      .eq('user_id', userId)
      .order('joined_at', { ascending: true });

    if (error) {
      console.warn('fetchMemberships network error, keeping current state:', error.message);
      setState(prev => ({ ...prev, loading: false }));
      return;
    }
    if (data && data.length > 0) {
      const memberships: GroupMembership[] = data.map(row => {
        const playerRow = row.players as unknown as { name: string } | null;
        const groupRow = row.groups as unknown as { name: string; invite_code: string | null; created_by: string; training_enabled: boolean } | null;
        return {
          groupId: row.group_id,
          groupName: groupRow?.name ?? '',
          role: SUPABASE_ROLE_MAP[row.role] ?? 'member',
          isOwner: groupRow?.created_by === userId,
          playerName: playerRow?.name ?? null,
          playerId: row.player_id ?? null,
          inviteCode: groupRow?.invite_code ?? null,
          trainingEnabled: groupRow?.training_enabled ?? false,
          memberCount: 0,
        };
      });

      const { data: countData } = await supabase.rpc('get_group_member_counts', {
        p_group_ids: memberships.map(m => m.groupId),
      });
      if (Array.isArray(countData)) {
        const countMap = new Map<string, number>();
        (countData as Array<{ group_id: string; member_count: number }>).forEach(r => {
          countMap.set(r.group_id, r.member_count);
        });
        memberships.forEach(m => {
          m.memberCount = countMap.get(m.groupId) || 0;
        });
      }

      setState(prev => ({
        ...prev,
        memberships,
        activeGroupId: switchToGroupId && memberships.some(m => m.groupId === switchToGroupId)
          ? switchToGroupId
          : prev.activeGroupId && memberships.some(m => m.groupId === prev.activeGroupId)
            ? prev.activeGroupId
            : memberships[0].groupId,
        loading: false,
      }));
    } else {
      setState(prev => ({ ...prev, memberships: [], activeGroupId: null, loading: false }));
    }
  }, []);

  const switchGroup = useCallback((groupId: string) => {
    setState(prev => {
      if (!prev.memberships.some(m => m.groupId === groupId)) return prev;
      return { ...prev, activeGroupId: groupId };
    });
  }, []);

  useEffect(() => {
    let membershipFetchedFor: string | null = null;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setState(prev => ({ ...prev, user: session.user, session }));
        membershipFetchedFor = session.user.id;
        fetchMemberships(session.user.id);
        checkSuperAdmin(session.user.id);
      } else {
        setState(prev => ({ ...prev, loading: false }));
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setState(prev => ({ ...prev, user: session.user, session }));
        if (session.user.id !== membershipFetchedFor) {
          membershipFetchedFor = session.user.id;
          fetchMemberships(session.user.id);
          checkSuperAdmin(session.user.id);
        }
      } else {
        membershipFetchedFor = null;
        setState({ user: null, session: null, memberships: [], activeGroupId: null, isSuperAdmin: false, loading: false });
      }
    });

    return () => subscription.unsubscribe();
  }, [fetchMemberships, checkSuperAdmin]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signUp({ email, password });
    return { data, error };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    // Use the FULL current URL as the redirect target (not just origin)
    // so query params survive the OAuth round-trip. This is what makes
    // share-card deep links land on the right poll: a recipient who
    // taps `…/settings?tab=schedule&poll=abc` and signs in with Google
    // returns to that same URL after the OAuth dance, and the in-app
    // routers + ScheduleTab pick up the tab + poll params naturally.
    // For users signing in from the home page this is identical to the
    // old behavior (origin === href when there are no params).
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.href,
      },
    });
    return { error };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setState({ user: null, session: null, memberships: [], activeGroupId: null, isSuperAdmin: false, loading: false });
  }, []);

  const createGroup = useCallback(async (groupName: string) => {
    const displayName = state.user?.user_metadata?.full_name
      || state.user?.user_metadata?.name
      || state.user?.email?.split('@')[0]
      || null;
    const { data, error } = await supabase.rpc('create_group', {
      group_name: groupName,
      display_name: displayName,
    });
    if (!error && state.user) {
      const newGroupId = (data as { group_id?: string } | null)?.group_id;
      await fetchMemberships(state.user.id, newGroupId ?? undefined);
    }
    return { data, error };
  }, [state.user, fetchMemberships]);

  const joinGroup = useCallback(async (inviteCode: string) => {
    const displayName = state.user?.user_metadata?.full_name
      || state.user?.user_metadata?.name
      || state.user?.email?.split('@')[0]
      || null;
    const { data, error } = await supabase.rpc('join_group_by_invite', {
      code: inviteCode,
      display_name: displayName,
    });
    if (!error && state.user) {
      const joinedGroupId = (data as { group_id?: string } | null)?.group_id;
      await fetchMemberships(state.user.id, joinedGroupId ?? undefined);
    }
    return { data, error };
  }, [state.user, fetchMemberships]);

  const linkToPlayer = useCallback(async (playerId: string) => {
    const { error } = await supabase.rpc('link_member_to_player', {
      target_player_id: playerId,
    });
    if (!error && state.user) {
      await fetchMemberships(state.user.id);
    }
    return { error };
  }, [state.user, fetchMemberships]);

  const selfCreateAndLink = useCallback(async (playerName: string) => {
    const { data, error } = await supabase.rpc('self_create_and_link', {
      player_name: playerName,
      p_group_id: activeGroupId,
    });
    if (!error && state.user) {
      await fetchMemberships(state.user.id);
    }
    return { data, error };
  }, [state.user, activeGroupId, fetchMemberships]);

  // Lists existing players in the group that no member is currently linked to.
  // Used by PlayerPicker so a new joiner can claim an existing record (with all
  // its game history) rather than typing a slightly different name and creating
  // a duplicate — see migration 047 + the duplicate-player issue Sefi hit.
  const listLinkablePlayers = useCallback(async (): Promise<{ id: string; name: string }[]> => {
    const { data, error } = await supabase.rpc('list_linkable_players', {
      p_group_id: activeGroupId,
    });
    if (error) {
      console.error('[auth] list_linkable_players failed:', error.message);
      return [];
    }
    return (data as { id: string; name: string }[] | null) ?? [];
  }, [activeGroupId]);

  const updateMemberRole = useCallback(async (targetUserId: string, newRole: string) => {
    const { error } = await supabase.rpc('update_member_role', {
      target_user_id: targetUserId,
      new_role: newRole,
      p_group_id: activeGroupId,
    });
    return { error };
  }, [activeGroupId]);

  const removeMember = useCallback(async (targetUserId: string) => {
    const { error } = await supabase.rpc('remove_group_member', {
      target_user_id: targetUserId,
      p_group_id: activeGroupId,
    });
    return { error };
  }, [activeGroupId]);

  const transferOwnership = useCallback(async (newOwnerId: string) => {
    const { error } = await supabase.rpc('transfer_ownership', {
      new_owner_id: newOwnerId,
      p_group_id: activeGroupId,
    });
    if (!error && state.user) {
      await fetchMemberships(state.user.id);
    }
    return { error };
  }, [state.user, activeGroupId, fetchMemberships]);

  const regenerateInviteCode = useCallback(async () => {
    const { data, error } = await supabase.rpc('regenerate_invite_code', {
      p_group_id: activeGroupId,
    });
    return { data: data as string | null, error };
  }, [activeGroupId]);

  const unlinkMemberPlayer = useCallback(async (targetUserId: string) => {
    const { error } = await supabase.rpc('unlink_member_player', {
      target_user_id: targetUserId,
      p_group_id: activeGroupId,
    });
    return { error };
  }, [activeGroupId]);

  const addMemberByEmail = useCallback(async (email: string, playerId?: string) => {
    const { data, error } = await supabase.rpc('add_member_by_email', {
      target_email: email,
      target_player_id: playerId ?? null,
      p_group_id: activeGroupId,
    });
    return { data: data as { user_id: string; display_name: string; player_id: string | null } | null, error };
  }, [activeGroupId]);

  const createPlayerInvite = useCallback(async (targetPlayerId: string) => {
    const { data, error } = await supabase.rpc('create_player_invite', {
      target_player_id: targetPlayerId,
      p_group_id: activeGroupId,
    });
    return { data: data as { invite_code: string; player_name: string; already_existed: boolean } | null, error };
  }, [activeGroupId]);

  const joinByPlayerInvite = useCallback(async (code: string) => {
    const displayName = state.user?.user_metadata?.full_name
      || state.user?.user_metadata?.name
      || state.user?.email?.split('@')[0]
      || null;
    const { data, error } = await supabase.rpc('join_group_by_player_invite', {
      code,
      display_name: displayName,
    });
    if (data && !error && state.user) {
      const joinedGroupId = (data as { group_id?: string } | null)?.group_id;
      await fetchMemberships(state.user.id, joinedGroupId ?? undefined);
    }
    return { data: data as { group_id: string; group_name: string; player_id: string; player_name: string } | null, error };
  }, [state.user, fetchMemberships]);

  const deleteGroup = useCallback(async (groupId: string) => {
    const { error } = await supabase.rpc('delete_group', { p_group_id: groupId });
    if (!error && state.user) {
      await fetchMemberships(state.user.id);
    }
    return { error };
  }, [state.user, fetchMemberships]);

  const leaveGroup = useCallback(async (groupId: string) => {
    const { error } = await supabase.rpc('leave_group', { p_group_id: groupId });
    if (!error && state.user) {
      await fetchMemberships(state.user.id);
    }
    return { error };
  }, [state.user, fetchMemberships]);

  const fetchMembers = useCallback(async (): Promise<GroupMember[]> => {
    const groupId = membership?.groupId;
    if (!groupId) return [];
    const { data, error } = await supabase.rpc('fetch_group_members_with_email', {
      p_group_id: groupId,
    });
    if (!error && Array.isArray(data)) {
      return (data as Array<{ user_id: string; display_name: string | null; role: string; player_id: string | null; player_name: string | null; email: string | null }>).map(row => ({
        userId: row.user_id,
        displayName: row.display_name,
        role: row.role,
        playerId: row.player_id,
        playerName: row.player_name,
        email: row.email,
      }));
    }
    return [];
  }, [membership?.groupId]);

  return {
    user: state.user,
    session: state.session,
    membership,
    memberships: state.memberships,
    isSuperAdmin: state.isSuperAdmin,
    loading: state.loading,
    signIn,
    signUp,
    signInWithGoogle,
    signOut,
    createGroup,
    joinGroup,
    linkToPlayer,
    selfCreateAndLink,
    listLinkablePlayers,
    updateMemberRole,
    removeMember,
    transferOwnership,
    regenerateInviteCode,
    unlinkMemberPlayer,
    addMemberByEmail,
    createPlayerInvite,
    joinByPlayerInvite,
    deleteGroup,
    leaveGroup,
    fetchMembers,
    switchGroup,
    refreshMembership: () => {
      if (state.user) fetchMemberships(state.user.id);
    },
  };
}
