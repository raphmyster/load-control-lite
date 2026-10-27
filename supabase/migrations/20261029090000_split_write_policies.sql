-- The "write ... of draft flights" policies were `for all`, which includes select. Reads
-- then ran their draft check next to the plain read policy (the performance advisor's
-- multiple_permissive_policies warning). Split them into insert, update and delete so
-- reads use only "read stops" / "read allocations". The draft-only rule for writes is
-- unchanged.

drop policy "write stops of draft flights" on public.flight_stops;
drop policy "write allocations of draft flights" on public.zone_allocations;

create policy "insert stops of draft flights" on public.flight_stops
  for insert to authenticated
  with check (exists (select 1 from public.flights f where f.id = flight_id and f.status = 'draft'));
create policy "update stops of draft flights" on public.flight_stops
  for update to authenticated
  using      (exists (select 1 from public.flights f where f.id = flight_id and f.status = 'draft'))
  with check (exists (select 1 from public.flights f where f.id = flight_id and f.status = 'draft'));
create policy "delete stops of draft flights" on public.flight_stops
  for delete to authenticated
  using (exists (select 1 from public.flights f where f.id = flight_id and f.status = 'draft'));

create policy "insert allocations of draft flights" on public.zone_allocations
  for insert to authenticated
  with check (exists (select 1 from public.flights f where f.id = flight_id and f.status = 'draft'));
create policy "update allocations of draft flights" on public.zone_allocations
  for update to authenticated
  using      (exists (select 1 from public.flights f where f.id = flight_id and f.status = 'draft'))
  with check (exists (select 1 from public.flights f where f.id = flight_id and f.status = 'draft'));
create policy "delete allocations of draft flights" on public.zone_allocations
  for delete to authenticated
  using (exists (select 1 from public.flights f where f.id = flight_id and f.status = 'draft'));
