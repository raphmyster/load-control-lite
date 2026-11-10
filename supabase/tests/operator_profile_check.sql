-- Run: supabase db query --linked -f supabase/tests/operator_profile_check.sql </dev/null
-- Each block pretends to be a different caller and rolls back, so nothing is saved.
-- Pass: no error. Fail: an error whose message starts with FAIL.

-- 1. Not logged in: anon has no GRANT, so reading the pack must be refused.
begin;
set local role anon;
do $$ begin
  perform count(*) from public.operator_profile;
  raise exception 'FAIL: anon could read the operator profile';
exception when insufficient_privilege then null;  -- refused, as expected
end $$;
rollback;

-- 2. Logged in: can read the pack, can't write it.
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users order by created_at limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ begin
  perform count(*) from public.operator_profile;
  begin
    insert into public.operator_profile (id, profile) values (1, '{}');
    raise exception 'FAIL: a signed-in user could write the operator profile';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;
