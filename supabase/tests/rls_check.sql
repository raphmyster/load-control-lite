-- Run in the Supabase SQL Editor, one block at a time. Each block pretends to be a
-- different caller and rolls back, so nothing is saved.
-- Pass: "Success. No rows returned". Fail: an error whose message starts with FAIL.
-- Blocks 2 and 3 log in as the demo user automatically (the only user in auth.users).

-- 1. Not logged in: anon has no GRANT, so reading flights must be refused.
begin;
set local role anon;
do $$ begin
  perform count(*) from public.flights;
  raise exception 'FAIL: anon could read flights';
exception when insufficient_privilege then null;  -- refused, as expected
end $$;
rollback;

-- 2. Logged in: create a draft flight, read it, close it, then try to edit it.
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users order by created_at limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare n int;
begin
  insert into public.flights (flight_date, flight_no, form_id) values (current_date, 'RLS1', 'PC12');
  select count(*) into n from public.flights where flight_no = 'RLS1';
  assert n = 1, 'FAIL: logged-in user could not read the flight they created';

  update public.flights set status = 'closed' where flight_no = 'RLS1';
  get diagnostics n = row_count;
  assert n = 1, 'FAIL: could not close a draft flight';

  update public.flights set notes = 'edited' where flight_no = 'RLS1';
  get diagnostics n = row_count;
  assert n = 0, 'FAIL: a closed flight was edited';

  begin
    update public.flights set created_by = gen_random_uuid() where flight_no = 'RLS1';
    raise exception 'FAIL: created_by could be changed';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

-- 3. Logged in: can read limits, can't change them.
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users order by created_at limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare n int;
begin
  select count(*) into n from public.forms;
  assert n = 4, 'FAIL: expected 4 forms, got ' || n;
  begin
    update public.forms set capacity_lb = 1;
    raise exception 'FAIL: a logged-in user changed a limit';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;
