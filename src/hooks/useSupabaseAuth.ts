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
}

interface GroupMembership {
  groupId: string;
  groupName: string;
  role: PermissionRole;
  isOwner: boolean;
  playerName: string | null;
  playerId: string | null;
  inviteCode: string | null;
}

interface AuthState {
  user: User | null;
  session: Session | null;
  membership: GroupMembership | null;
  loading: boolean;
}

const SUPABASE_ROLE_MAP: Record<string, PermissionRole> = {
  admin: 'admin',
  member: 'member',
  viewer: 'viewer',
};

export function useSupabaseAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    membership: null,
    loading: true,
  });

  const fetchMembership = useCallback(async (userId: string) => {
    const { data, error } = await supabase
      .from('group_members')
      .select(`
        group_id,
        role,
        player_id,
        players ( name ),
        groups ( name, invite_code, created_by )
      `)
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();

    if (data && !error) {
      const playerRow = data.players as unknown as { name: string } | null;
      const groupRow = data.groups as unknown as { name: string; invite_code: string | null; created_by: string } | null;
      setState(prev => ({
        ...prev,
        membership: {
          groupId: data.group_id,
          groupName: groupRow?.name ?? '',
          role: SUPABASE_ROLE_MAP[data.role] ?? 'viewer',
          isOwner: groupRow?.created_by === userId,
          playerName: playerRow?.name ?? null,
          playerId: data.player_id ?? null,
          inviteCode: groupRow?.invite_code ?? null,
        },
        loading: false,
      }));
    } else {
      setState(prev => ({ ...prev, membership: null, loading: false }));
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setState(prev => ({ ...prev, user: session.user, session }));
        fetchMembership(session.user.id);
      } else {
        setState(prev => ({ ...prev, loading: false }));
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setState(prev => ({ ...prev, user: session.user, session }));
        fetchMembership(session.user.id);
      } else {
        setState({ user: null, session: null, membership: null, loading: false });
      }
    });

    return () => subscription.unsubscribe();
  }, [fetchMembership]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signUp({ email, password });
    return { data, error };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    });
    return { error };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setState({ user: null, session: null, membership: null, loading: false });
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
      await fetchMembership(state.user.id);
    }
    return { data, error };
  }, [state.user, fetchMembership]);

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
      await fetchMembership(state.user.id);
    }
    return { data, error };
  }, [state.user, fetchMembership]);

  const linkToPlayer = useCallback(async (playerId: string) => {
    const { error } = await supabase.rpc('link_member_to_player', {
      target_player_id: playerId,
    });
    if (!error && state.user) {
      await fetchMembership(state.user.id);
    }
    return { error };
  }, [state.user, fetchMembership]);

  const selfCreateAndLink = useCallback(async (playerName: string) => {
    const { data, error } = await supabase.rpc('self_create_and_link', {
      player_name: playerName,
    });
    if (!error && state.user) {
      await fetchMembership(state.user.id);
    }
    return { data, error };
  }, [state.user, fetchMembership]);

  const updateMemberRole = useCallback(async (targetUserId: string, newRole: string) => {
    const { error } = await supabase.rpc('update_member_role', {
      target_user_id: targetUserId,
      new_role: newRole,
    });
    return { error };
  }, []);

  const removeMember = useCallback(async (targetUserId: string) => {
    const { error } = await supabase.rpc('remove_group_member', {
      target_user_id: targetUserId,
    });
    return { error };
  }, []);

  const transferOwnership = useCallback(async (newOwnerId: string) => {
    const { error } = await supabase.rpc('transfer_ownership', {
      new_owner_id: newOwnerId,
    });
    if (!error && state.user) {
      await fetchMembership(state.user.id);
    }
    return { error };
  }, [state.user, fetchMembership]);

  const regenerateInviteCode = useCallback(async () => {
    const { data, error } = await supabase.rpc('regenerate_invite_code');
    return { data: data as string | null, error };
  }, []);

  const unlinkMemberPlayer = useCallback(async (targetUserId: string) => {
    const { error } = await supabase.rpc('unlink_member_player', {
      target_user_id: targetUserId,
    });
    return { error };
  }, []);

  const addMemberByEmail = useCallback(async (email: string, playerId?: string) => {
    const { data, error } = await supabase.rpc('add_member_by_email', {
      target_email: email,
      target_player_id: playerId ?? null,
    });
    return { data: data as { user_id: string; display_name: string; player_id: string | null } | null, error };
  }, []);

  const createPlayerInvite = useCallback(async (targetPlayerId: string) => {
    const { data, error } = await supabase.rpc('create_player_invite', {
      target_player_id: targetPlayerId,
    });
    return { data: data as { invite_code: string; player_name: string; already_existed: boolean } | null, error };
  }, []);

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
      await fetchMembership(state.user.id);
    }
    return { data: data as { group_id: string; group_name: string; player_id: string; player_name: string } | null, error };
  }, [state.user, fetchMembership]);

  const fetchMembers = useCallback(async (): Promise<GroupMember[]> => {
    const groupId = state.membership?.groupId;
    if (!groupId) return [];
    const { data, error } = await supabase
      .from('group_members')
      .select('user_id, display_name, role, player_id, players ( name )')
      .eq('group_id', groupId);
    if (error || !data) return [];
    return data.map(row => ({
      userId: row.user_id,
      displayName: row.display_name,
      role: row.role,
      playerId: row.player_id,
      playerName: (row.players as unknown as { name: string } | null)?.name ?? null,
    }));
  }, [state.membership?.groupId]);

  return {
    ...state,
    signIn,
    signUp,
    signInWithGoogle,
    signOut,
    createGroup,
    joinGroup,
    linkToPlayer,
    selfCreateAndLink,
    updateMemberRole,
    removeMember,
    transferOwnership,
    regenerateInviteCode,
    unlinkMemberPlayer,
    addMemberByEmail,
    createPlayerInvite,
    joinByPlayerInvite,
    fetchMembers,
    refreshMembership: () => {
      if (state.user) fetchMembership(state.user.id);
    },
  };
}
