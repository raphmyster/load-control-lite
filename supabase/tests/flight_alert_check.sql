-- Run: supabase db query --linked -f supabase/tests/flight_alert_check.sql </dev/null
-- Pass: no "FAIL" in the output. Everything that could send a request rolls back, and
-- nothing selects the secret or net.http_request_queue (it holds the secret until sent).

-- 1. The objects exist and the secret check refuses empty and wrong secrets.
do $$ begin
  assert (select count(*) from vault.secrets where name = 'flight_alert_secret') = 1, 'FAIL: secret missing';
  assert not public.is_flight_alert_secret(''), 'FAIL: an empty secret was accepted';
  assert not public.is_flight_alert_secret('wrong'), 'FAIL: a wrong secret was accepted';
  assert (select count(*) from pg_trigger where tgname = 'flights_closed_alert' and not tgisinternal) = 1, 'FAIL: trigger missing';
  assert (select relrowsecurity from pg_class where oid = 'public.flight_close_labels'::regclass), 'FAIL: RLS off';
end $$;

-- 2. A logged-in user can't call the send or secret functions, or write a label; anon can't read.
begin;
set local role authenticated;
do $$ begin
  perform public.send_flight_closed(gen_random_uuid());
  raise exception 'FAIL: authenticated could call send_flight_closed';
exception when insufficient_privilege then null;
end $$;
rollback;

begin;
set local role authenticated;
do $$ begin
  perform public.is_flight_alert_secret('x');
  raise exception 'FAIL: authenticated could call is_flight_alert_secret';
exception when insufficient_privilege then null;
end $$;
rollback;

begin;
set local role authenticated;
do $$ begin
  insert into public.flight_close_labels (flight_id) values (gen_random_uuid());
  raise exception 'FAIL: authenticated could insert a close label';
exception when insufficient_privilege then null;
end $$;
rollback;

begin;
set local role anon;
do $$ begin
  perform 1 from public.flight_close_labels limit 1;
  raise exception 'FAIL: anon could read close labels';
exception when insufficient_privilege then null;
end $$;
rollback;

-- 3. A loadmaster's close queues exactly one request, and a draft save queues none.
-- Counted through the queue's id sequence (sequences don't roll back), never its rows.
-- Everything else rolls back, so nothing is sent. Another close at the same moment would
-- make the count 2; re-run if that happens.
begin;
create temp table seq_mark on commit drop as
  select last_value, is_called from net.http_request_queue_id_seq;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users order by created_at limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  fid uuid := gen_random_uuid();
  base jsonb := jsonb_build_object('id', fid, 'flight_date', current_date, 'flight_no', 'T1', 'form_id', 'DH8300',
    'status', 'draft', 'stops', '[]'::jsonb, 'allocations', '[]'::jsonb);
begin
  perform public.save_flight(base);
  perform public.save_flight(base);                                   -- draft -> draft: no request
  perform public.save_flight(base || '{"status": "closed"}'::jsonb);  -- draft -> closed: one request
end $$;
reset role;
do $$
declare b bigint; a bigint;
begin
  select case when is_called then last_value else last_value - 1 end into b from seq_mark;
  select case when is_called then last_value else last_value - 1 end into a from net.http_request_queue_id_seq;
  assert a - b = 1, format('FAIL: expected 1 queued request, got %s', a - b);
end $$;
rollback;
