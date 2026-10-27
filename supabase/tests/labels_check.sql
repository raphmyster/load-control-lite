-- Run: supabase db query --linked -f supabase/tests/labels_check.sql </dev/null
-- Pass: no "FAIL" in the output. Each block rolls back.

-- 1. The service role stores a label, and deleting the report deletes its labels.
begin;
set local role service_role;
do $$
declare rid uuid; fid uuid := (select id from public.flights order by flight_date limit 1); n int;
begin
  insert into public.reports (mode, period_start, period_end, status)
    values ('hybrid', '2026-10-19', '2026-10-25', 'error') returning id into rid;
  insert into public.flight_ai_labels
    (report_id, flight_id, category, category_confidence, mention_p, urgency, urgency_confidence, included, reason)
    values (rid, fid, 'safety_concern', 0.91, 0.97, 4.2, 0.6, true, 'jev_mention');
  select count(*) into n from public.flight_ai_labels where report_id = rid;
  assert n = 1, format('FAIL: expected 1 label, found %s', n);
  delete from public.reports where id = rid;
  select count(*) into n from public.flight_ai_labels where report_id = rid;
  assert n = 0, 'FAIL: labels outlived their report';
end $$;
rollback;

-- 2. Unknown categories and reasons, and urgency outside 1 to 5, are refused.
begin;
set local role service_role;
do $$
declare rid uuid; fid uuid := (select id from public.flights order by flight_date limit 1);
begin
  insert into public.reports (mode, period_start, period_end, status)
    values ('hybrid', '2026-10-19', '2026-10-25', 'error') returning id into rid;
  begin
    insert into public.flight_ai_labels (report_id, flight_id, category, included, reason)
      values (rid, fid, 'weather', true, 'jev_mention');
    raise exception 'FAIL: unknown category accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.flight_ai_labels (report_id, flight_id, included, reason)
      values (rid, fid, true, 'maybe');
    raise exception 'FAIL: unknown reason accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.flight_ai_labels (report_id, flight_id, urgency, included, reason)
      values (rid, fid, 6, true, 'jev_mention');
    raise exception 'FAIL: urgency 6 accepted';
  exception when check_violation then null;
  end;
end $$;
rollback;

-- 3. A signed-in user can read labels (no handler: a missing grant must fail here)...
begin;
set local role authenticated;
select count(*) as labels_visible from public.flight_ai_labels;
rollback;

-- ...but not write them.
begin;
set local role authenticated;
do $$ begin
  insert into public.flight_ai_labels (report_id, flight_id, included, reason)
    values (gen_random_uuid(), gen_random_uuid(), false, 'jev_routine');
  raise exception 'FAIL: authenticated could insert a label';
exception when insufficient_privilege then null;
end $$;
rollback;

-- 4. Anonymous callers can't read them.
begin;
set local role anon;
do $$ begin
  perform 1 from public.flight_ai_labels limit 1;
  raise exception 'FAIL: anon could read labels';
exception when insufficient_privilege then null;
end $$;
rollback;
