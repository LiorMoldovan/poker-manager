import { useEffect } from 'react';

export function useRealtimeRefresh(callback: () => void): void {
  useEffect(() => {
    const handler = () => callback();
    window.addEventListener('supabase-cache-updated', handler);
    return () => window.removeEventListener('supabase-cache-updated', handler);
  }, [callback]);
}
