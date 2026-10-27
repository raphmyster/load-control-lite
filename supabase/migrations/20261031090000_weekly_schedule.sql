-- Weekly scheduled report. pg_cron calls run_weekly_report() every Monday; it POSTs to the
-- generate-report edge function with a random secret from Vault. The edge function sends
-- that secret back to is_report_cron_secret() to check it, so the secret never leaves the
-- database.
create extension if not exists supabase_vault with schema vault;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

alter table public.reports
  add column triggered_by text not null default 'manual' check (triggered_by in ('manual', 'schedule'));

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'report_cron_secret',
                           'Proves a generate-report call came from the weekly job')
where not exists (select 1 from vault.secrets where name = 'report_cron_secret');

create function public.is_report_cron_secret(p_secret text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(p_secret, '') <> '' and exists (
    select 1 from vault.decrypted_secrets
    where name = 'report_cron_secret' and decrypted_secret = p_secret);
$$;
revoke execute on function public.is_report_cron_secret(text) from public, anon, authenticated;
grant  execute on function public.is_report_cron_secret(text) to service_role;

-- Returns the pg_net request id; the answer lands in net._http_response (kept 6 hours).
-- The 150 s timeout outlasts the edge function's own 135 s deadline, so its real answer is kept.
create function public.run_weekly_report()
returns bigint
language sql security definer set search_path = ''
as $$
  select net.http_post(
    url := 'https://zjafthfktjfncwhycxej.supabase.co/functions/v1/generate-report',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-report-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'report_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000);
$$;
revoke execute on function public.run_weekly_report() from public, anon, authenticated;

-- Mondays 11:00 UTC: 07:00 in Toronto in summer, 06:00 in winter.
select cron.schedule('weekly-ops-report', '0 11 * * 1', 'select public.run_weekly_report()');
