import { useEffect } from 'react';
import { USE_SUPABASE } from '../database/config';

export function useRealtimeRefresh(callback: () => void): void {
  useEffect(() => {
    if (!USE_SUPABASE) return;
    const handler = () => callback();
    window.addEventListener('supabase-cache-updated', handler);
    return () => window.removeEventListener('supabase-cache-updated', handler);
  }, [callback]);
}
