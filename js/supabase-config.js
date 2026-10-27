/* The browser's connection to Supabase. Both values are public by design: anyone can
   read them from the page. The data is protected by RLS in the database, not by hiding
   this key. Never put the service_role (secret) key here. */
export const SUPABASE_URL = 'https://zjafthfktjfncwhycxej.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_gtmiihhPYVh-mhmhkWFr-Q_FpSG64Mb'; // Project Settings -> API Keys -> Publishable key (sb_publishable_...)
