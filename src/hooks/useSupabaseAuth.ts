import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../database/supabaseClient';
import type { User, Session } from '@supabase/supabase-js';
import type { PermissionRole } from '../types';

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
    const { data, error } = await supabase.rpc('create_group', { group_name: groupName });
    if (!error && state.user) {
      await fetchMembership(state.user.id);
    }
    return { data, error };
  }, [state.user, fetchMembership]);

  const joinGroup = useCallback(async (inviteCode: string) => {
    const { data, error } = await supabase.rpc('join_group_by_invite', { code: inviteCode });
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

  return {
    ...state,
    signIn,
    signUp,
    signInWithGoogle,
    signOut,
    createGroup,
    joinGroup,
    linkToPlayer,
    refreshMembership: () => {
      if (state.user) fetchMembership(state.user.id);
    },
  };
}
