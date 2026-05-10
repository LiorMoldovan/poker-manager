// Per-group "deleted" trivia templates — kill switch for bad questions.
//
// Why this module exists:
//   `trivia_deleted_templates` (migration 070) holds <group_id, template_id>
//   rows that should be EXCLUDED from `generateTriviaBatch` for that group.
//   Every client needs to read it (RLS allows any group member to SELECT)
//   so the next generated batch reflects the current state without a page
//   reload.
//
//   Rather than bolt this onto `supabaseCache.ts` (which already manages
//   ~20 tables and is heavy), we keep a tiny standalone in-memory set
//   here. The trade-off: callers must `loadDeletedTriviaTemplates(gid)`
//   once per group before relying on `getDeletedTemplateIds()` to be
//   accurate. The trivia entry points (TriviaGameScreen on mount, the
//   super-admin reports tab on mount) both do this.
//
// Realtime:
//   `subscribeRealtimeDeletedTemplates` listens for INSERT/DELETE on the
//   table and refreshes the local set, then dispatches the cache-updated
//   event so screens re-render. This way, when the super-admin deletes a
//   template on their phone, every other client's next trivia round
//   already excludes it without anyone reloading.
//
// Mutations:
//   `deleteTriviaTemplate` and `restoreTriviaTemplate` call the SECURITY
//   DEFINER RPCs from migration 070 (super-admin enforced server-side).
//   We optimistically update the local set on success so the UI feels
//   instant, even before realtime echoes back.

import { supabase } from '../database/supabaseClient';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface DeletedTriviaTemplateRow {
  group_id: string;
  template_id: string;
  deleted_by: string | null;
  deleted_at: string;
  reason: string | null;
}

// Module-level state. We only ever care about ONE group at a time —
// the active group of the signed-in user. Switching groups (rare; only
// super admins or multi-group members) re-runs `loadDeletedTriviaTemplates`
// with the new id and replaces the whole set.
let currentGroupId: string | null = null;
let deletedSet: Set<string> = new Set();
let realtimeChannel: RealtimeChannel | null = null;

// Sync getter — used by `generateTriviaBatch` so it can filter the
// template pool synchronously per call. Returns the empty set if the
// caller never loaded for this group, which means "no exclusions" —
// the safe default that just shows all questions.
export function getDeletedTemplateIds(): ReadonlySet<string> {
  return deletedSet;
}

// Async loader. Replaces the in-memory set with the rows for `groupId`.
// Idempotent: safe to call repeatedly (e.g. on every screen mount that
// reads from the set). Returns the loaded set so callers can await
// it when they need a guaranteed-accurate view.
export async function loadDeletedTriviaTemplates(groupId: string): Promise<ReadonlySet<string>> {
  currentGroupId = groupId;
  const { data, error } = await supabase
    .from('trivia_deleted_templates')
    .select('template_id')
    .eq('group_id', groupId);
  if (error) {
    console.error('[triviaDeletedTemplates] load failed', error);
    return deletedSet;
  }
  deletedSet = new Set((data ?? []).map(r => (r as { template_id: string }).template_id));
  return deletedSet;
}

// Full row fetch for the super-admin "restore" UI — needs reason +
// timestamp + deleted_by. Not cached because it's only opened on
// demand from the reports tab.
export async function fetchAllDeletedTriviaTemplates(groupId: string): Promise<DeletedTriviaTemplateRow[]> {
  const { data, error } = await supabase
    .from('trivia_deleted_templates')
    .select('*')
    .eq('group_id', groupId)
    .order('deleted_at', { ascending: false });
  if (error) {
    console.error('[triviaDeletedTemplates] fetchAll failed', error);
    return [];
  }
  return (data as DeletedTriviaTemplateRow[]) ?? [];
}

// Calls the SECURITY DEFINER `delete_trivia_template` RPC. Server
// enforces super-admin. On success, optimistically adds to the local
// set so the next `generateTriviaBatch` already excludes it without
// waiting for realtime to echo back.
export async function deleteTriviaTemplate(
  groupId: string,
  templateId: string,
  reason: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.rpc('delete_trivia_template', {
    p_group_id: groupId,
    p_template_id: templateId,
    p_reason: reason,
  });
  if (error) {
    console.error('[triviaDeletedTemplates] delete RPC failed', error);
    return { ok: false, error: error.message || 'delete failed' };
  }
  if (groupId === currentGroupId) {
    deletedSet.add(templateId);
    window.dispatchEvent(new CustomEvent('supabase-cache-updated'));
  }
  return { ok: true };
}

export async function restoreTriviaTemplate(
  groupId: string,
  templateId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.rpc('restore_trivia_template', {
    p_group_id: groupId,
    p_template_id: templateId,
  });
  if (error) {
    console.error('[triviaDeletedTemplates] restore RPC failed', error);
    return { ok: false, error: error.message || 'restore failed' };
  }
  if (groupId === currentGroupId) {
    deletedSet.delete(templateId);
    window.dispatchEvent(new CustomEvent('supabase-cache-updated'));
  }
  return { ok: true };
}

// Realtime subscription. Returns an unsubscribe function. Refreshes
// the local set on any INSERT/DELETE for the watched group, then
// dispatches the cache-updated event so screens listening via
// `useRealtimeRefresh` rerender — which means the super-admin's
// "Deleted templates" list updates live as other admins delete or
// restore, AND the next trivia batch on every client respects the
// change without a reload.
export function subscribeRealtimeDeletedTemplates(groupId: string): () => void {
  if (realtimeChannel) {
    void supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  const channel = supabase
    .channel(`trivia-deleted-${groupId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'trivia_deleted_templates', filter: `group_id=eq.${groupId}` },
      () => {
        void loadDeletedTriviaTemplates(groupId).then(() => {
          window.dispatchEvent(new CustomEvent('supabase-cache-updated'));
        });
      },
    )
    .subscribe();
  realtimeChannel = channel;
  return () => {
    void supabase.removeChannel(channel);
    if (realtimeChannel === channel) realtimeChannel = null;
  };
}
