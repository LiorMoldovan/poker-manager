import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = 'https://ursjltxklmxmapfvkttj.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_TzhEQmU6mX2n-utnOUAtwQ_zkGTR13j';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
