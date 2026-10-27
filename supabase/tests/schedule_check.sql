-- Run: supabase db query --linked -f supabase/tests/schedule_check.sql </dev/null
-- Pass: no "FAIL" in the output. Never calls run_weekly_report() as postgres (that would
-- send a real request) and never selects the secret.

-- 1. The job, the secret and the column exist.
do $$ begin
  assert (select count(*) from cron.job where jobname = 'weekly-ops-report'
          and schedule = '0 11 * * 1' and command like '%run_weekly_report%' and active) = 1,
    'FAIL: weekly-ops-report job missing or wrong';
  assert (select count(*) from vault.secrets where name = 'report_cron_secret') = 1, 'FAIL: secret missing';
  assert not public.is_report_cron_secret(''), 'FAIL: an empty secret was accepted';
  assert not public.is_report_cron_secret('wrong'), 'FAIL: a wrong secret was accepted';
  assert (select column_default from information_schema.columns
          where table_name = 'reports' and column_name = 'triggered_by') = '''manual''::text',
    'FAIL: triggered_by default';
end $$;

-- 2. A logged-in user can call neither function.
begin;
set local role authenticated;
do $$ begin
  perform public.run_weekly_report();
  raise exception 'FAIL: authenticated could call run_weekly_report';
exception when insufficient_privilege then null;
end $$;
rollback;

begin;
set local role authenticated;
do $$ begin
  perform public.is_report_cron_secret('x');
  raise exception 'FAIL: authenticated could call is_report_cron_secret';
exception when insufficient_privilege then null;
end $$;
rollback;
