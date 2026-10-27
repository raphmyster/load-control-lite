-- Run in the Supabase SQL Editor (or: supabase db query --linked -f <this file>).
-- Note: (base->'stops') - 1 needs the brackets; `-` binds tighter than `->`.
-- Pass: "Success. No rows returned". Fail: an error starting with FAIL. Rolls back.
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users order by created_at limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  fid uuid := gen_random_uuid(); s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
  n int; total numeric;
  base jsonb;
begin
  base := jsonb_build_object('id', fid, 'flight_date', current_date, 'flight_no', 'SF1', 'form_id', 'DH8300',
    'etd', '10:30', 'status', 'draft',
    'stops', jsonb_build_array(
      jsonb_build_object('id', s1, 'dest', 'YSB', 'cargo_lb', 545, 'post_lb', 0, 'fast_lb', 0, 'bag_lb', 40, 'raw_entry', '{"cargo":"500+45"}'::jsonb),
      jsonb_build_object('id', s2, 'dest', 'YTS', 'cargo_lb', 310, 'post_lb', 45, 'fast_lb', 20, 'bag_lb', 60)),
    'allocations', jsonb_build_array(
      jsonb_build_object('stop_id', s1, 'kind', 'cargo', 'zone_id', 'Z2A', 'weight_lb', 440),
      jsonb_build_object('stop_id', s2, 'kind', 'cargo', 'zone_id', 'Z2B', 'weight_lb', 500)));

  -- 1. New flight: one flight, two stops, two allocations; created_by is the caller.
  perform public.save_flight(base);
  select count(*) into n from public.flight_stops where flight_id = fid;
  assert n = 2, 'FAIL: expected 2 stops, got ' || n;
  select count(*) into n from public.flights where id = fid and created_by = auth.uid();
  assert n = 1, 'FAIL: created_by is not the caller';

  -- 2. Save again with one stop removed: replaced, not added to.
  perform public.save_flight(jsonb_set(jsonb_set(base, '{stops}', (base->'stops') - 1), '{allocations}', (base->'allocations') - 1));
  select count(*) into n from public.flight_stops where flight_id = fid;
  assert n = 1, 'FAIL: stops were not replaced, got ' || n;
  select coalesce(sum(weight_lb), 0) into total from public.zone_allocations where flight_id = fid;
  assert total = 440, 'FAIL: allocations were not replaced, total ' || total;

  -- 3. The views see it: Z2A 440 of 450 is 97.8%, so it is near the limit.
  select count(*) into n from public.v_near_limit where flight_id = fid and limit_id = 'Z2A';
  assert n = 1, 'FAIL: v_near_limit missed Z2A at 440/450';

  -- 4. Close it, then any further save is refused.
  perform public.save_flight(jsonb_set(base, '{status}', '"closed"'));
  select count(*) into n from public.flights where id = fid and status = 'closed';
  assert n = 1, 'FAIL: flight did not close';
  begin
    perform public.save_flight(base);
    raise exception 'FAIL: a closed flight was saved';
  exception when check_violation then null;
  end;
end $$;
rollback;

-- 5. Not logged in: anon can't call it.
begin;
set local role anon;
do $$ begin
  perform public.save_flight('{}'::jsonb);
  raise exception 'FAIL: anon could call save_flight';
exception when insufficient_privilege then null;
end $$;
rollback;
