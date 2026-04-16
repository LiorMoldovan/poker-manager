import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://ursjltxklmxmapfvkttj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TzhEQmU6mX2n-utnOUAtwQ_zkGTR13j';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
