-- Run: supabase db query --linked -f supabase/tests/ai_usage_check.sql </dev/null
-- Pass: no "FAIL" in the output. Each block rolls back.

-- The demo user is looked up before switching role: service_role can't read auth.users.

-- 1. A report and a $0.50 call made now show up in the figures.
begin;
select set_config('t.uid', (select id::text from auth.users order by created_at limit 1), true);
set local role service_role;
do $$
declare u uuid := current_setting('t.uid')::uuid;
        r0 int; s0 numeric; r1 int; s1 numeric; rid uuid;
begin
  select runs_today, spend_usd into r0, s0 from public.ai_usage(u);
  insert into public.reports (mode, period_start, period_end, status, created_by)
    values ('claude_only', '2026-10-19', '2026-10-25', 'error', u) returning id into rid;
  insert into public.ai_calls (report_id, provider_model, purpose, cost_usd, status)
    values (rid, 'test/model', 'claude_write_report', 0.5, 'ok');
  select runs_today, spend_usd into r1, s1 from public.ai_usage(u);
  assert r1 = r0 + 1, format('FAIL: runs_today %s -> %s', r0, r1);
  assert s1 = s0 + 0.5, format('FAIL: spend_usd %s -> %s', s0, s1);
end $$;
rollback;

-- 2. A report from yesterday (Toronto time) doesn't count today.
begin;
select set_config('t.uid', (select id::text from auth.users order by created_at limit 1), true);
set local role service_role;
do $$
declare u uuid := current_setting('t.uid')::uuid; r0 int; r1 int;
begin
  select runs_today into r0 from public.ai_usage(u);
  insert into public.reports (mode, period_start, period_end, status, created_by, created_at)
    values ('claude_only', '2026-10-19', '2026-10-25', 'ok', u,
            (date_trunc('day', now() at time zone 'America/Toronto') at time zone 'America/Toronto') - interval '1 minute');
  select runs_today into r1 from public.ai_usage(u);
  assert r1 = r0, format('FAIL: a report from yesterday counted (%s -> %s)', r0, r1);
end $$;
rollback;

-- 3. A logged-in user can't call it.
begin;
set local role authenticated;
do $$ begin
  perform public.ai_usage(gen_random_uuid());
  raise exception 'FAIL: authenticated could call ai_usage';
exception when insufficient_privilege then null;
end $$;
rollback;
