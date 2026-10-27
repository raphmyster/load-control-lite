-- Saves one flight with its stops and allocations in a single transaction.
-- The browser sends the whole flight as JSON; this replaces the stops and allocations.
-- security invoker: runs as the logged-in user, so every M1 RLS policy and column
-- grant still applies. A closed flight is refused.
--
-- Order matters: stops and allocations are written while the flight is still draft
-- (their RLS policies require it), and the flight row, including any draft -> closed
-- change, is updated last.

create function public.save_flight(p jsonb) returns timestamptz
language plpgsql security invoker set search_path = '' as $$
declare
  fid uuid := (p->>'id')::uuid;
  cur_status text;
  saved_at timestamptz;
begin
  select status into cur_status from public.flights where id = fid;
  if cur_status = 'closed' then
    raise exception 'Flight % is closed and can''t be changed', fid using errcode = 'check_violation';
  end if;

  if cur_status is null then
    insert into public.flights (id, flight_date, form_id) values (fid, (p->>'flight_date')::date, p->>'form_id');
  end if;

  delete from public.zone_allocations where flight_id = fid;
  delete from public.flight_stops where flight_id = fid;

  insert into public.flight_stops (id, flight_id, seq, dest, cargo_lb, post_lb, fast_lb, bag_lb, raw_entry)
  select (s->>'id')::uuid, fid, (t.ord - 1)::int, coalesce(s->>'dest', ''),
         (s->>'cargo_lb')::numeric, (s->>'post_lb')::numeric, (s->>'fast_lb')::numeric, (s->>'bag_lb')::numeric,
         coalesce(s->'raw_entry', '{}')
  from jsonb_array_elements(coalesce(p->'stops', '[]')) with ordinality as t(s, ord);

  insert into public.zone_allocations (flight_id, stop_id, kind, zone_id, weight_lb)
  select fid, (a->>'stop_id')::uuid, a->>'kind', a->>'zone_id', (a->>'weight_lb')::numeric
  from jsonb_array_elements(coalesce(p->'allocations', '[]')) as a;

  update public.flights set
    flight_date      = (p->>'flight_date')::date,
    flight_no        = coalesce(p->>'flight_no', ''),
    registration     = coalesce(p->>'registration', ''),
    form_id          = p->>'form_id',
    etd              = nullif(p->>'etd', '')::time,
    actual_departure = nullif(p->>'actual_departure', '')::time,
    delay_minutes    = (p->>'delay_minutes')::int,
    special_hr       = coalesce((p->>'special_hr')::boolean, false),
    special_aog      = coalesce((p->>'special_aog')::boolean, false),
    dg_note          = coalesce(p->>'dg_note', ''),
    loadmaster       = coalesce(p->>'loadmaster', ''),
    notes            = coalesce(p->>'notes', ''),
    manual_alloc     = coalesce((p->>'manual_alloc')::boolean, false),
    tag_positions    = coalesce(p->'tag_positions', '{}'),
    status           = coalesce(p->>'status', 'draft')
  where id = fid
  returning updated_at into saved_at;

  return saved_at;
end $$;

-- Functions are executable by everyone by default. Only logged-in users may call this one.
revoke execute on function public.save_flight(jsonb) from public, anon;
grant execute on function public.save_flight(jsonb) to authenticated, service_role;
