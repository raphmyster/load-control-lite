-- Flights and their manifest. Maps the app's flight object:
--   flight fields -> flights, rows -> flight_stops, alloc -> zone_allocations, pos -> flights.tag_positions

create table public.flights (
  id                uuid primary key default gen_random_uuid(),
  flight_date       date not null,
  flight_no         text not null default '',
  registration      text not null default '',
  form_id           text not null references public.forms,
  etd               time,
  actual_departure  time,
  delay_minutes     int check (delay_minutes >= 0),
  special_hr        boolean not null default false,
  special_aog       boolean not null default false,
  dg_note           text not null default '',
  loadmaster        text not null default '',
  notes             text not null default '',
  manual_alloc      boolean not null default false,  -- true once the user edits allocations by hand
  tag_positions     jsonb not null default '{}',     -- print layout only; the app's `pos`
  status            text not null default 'draft' check (status in ('draft', 'closed')),
  created_by        uuid not null default auth.uid() references auth.users,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index flights_date_idx on public.flights (flight_date);

create table public.flight_stops (
  id        uuid primary key default gen_random_uuid(),
  flight_id uuid not null references public.flights on delete cascade,
  seq       int not null,                  -- manifest order, 0 first
  dest      text not null default '',      -- no airport foreign key: the seed plants a bad code on purpose
  cargo_lb  numeric(8,1) not null default 0 check (cargo_lb >= 0),
  post_lb   numeric(8,1) not null default 0 check (post_lb >= 0),
  fast_lb   numeric(8,1) not null default 0 check (fast_lb >= 0),
  bag_lb    numeric(8,1) not null default 0 check (bag_lb >= 0),
  raw_entry jsonb not null default '{}',   -- cells as typed, e.g. {"cargo": "100+45"}
  unique (flight_id, seq) deferrable initially deferred,  -- lets the app reorder stops in one transaction
  unique (id, flight_id)                   -- target for the allocation foreign key below
);

create table public.zone_allocations (
  id        uuid primary key default gen_random_uuid(),
  flight_id uuid not null references public.flights on delete cascade,
  stop_id   uuid not null,
  kind      text not null check (kind in ('bag', 'cargo', 'all')),
  zone_id   text not null,
  weight_lb numeric(8,1) not null check (weight_lb >= 0),
  unique (stop_id, kind, zone_id),
  -- the stop must belong to the same flight, so an allocation can't be filed
  -- under a draft flight while pointing at a closed flight's stop
  foreign key (stop_id, flight_id) references public.flight_stops (id, flight_id) on delete cascade
);
create index zone_allocations_flight_idx on public.zone_allocations (flight_id);
create index flight_stops_flight_idx on public.flight_stops (flight_id);

-- Keep updated_at current on every edit.
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger flights_touch before update on public.flights
  for each row execute function public.touch_updated_at();

-- ---------- RLS ----------
alter table public.flights          enable row level security;
alter table public.flight_stops     enable row level security;
alter table public.zone_allocations enable row level security;

-- flights: read
create policy "logged-in users read flights" on public.flights
  for select to authenticated using (true);

-- flights: any logged-in user can create a flight; created_by must be themselves.
create policy "logged-in users create flights" on public.flights
  for insert to authenticated
  with check (created_by = (select auth.uid()));

-- flights: edit while draft. `using` checks the row before the change (must be draft);
-- `with check` checks the row after it. Without `with check`, Postgres reuses `using`
-- for the new row too, and closing a flight (draft -> closed) would be rejected.
-- Closed flights can't be edited or reopened because they fail `using`.
create policy "logged-in users edit draft flights" on public.flights
  for update to authenticated
  using (status = 'draft')
  with check (status in ('draft', 'closed'));

create policy "logged-in users delete draft flights" on public.flights
  for delete to authenticated
  using (status = 'draft');

-- stops and allocations follow their flight: readable always, writable only while it's draft.
create policy "read stops" on public.flight_stops
  for select to authenticated using (true);
create policy "write stops of draft flights" on public.flight_stops
  for all to authenticated
  using      (exists (select 1 from public.flights f where f.id = flight_id and f.status = 'draft'))
  with check (exists (select 1 from public.flights f where f.id = flight_id and f.status = 'draft'));

create policy "read allocations" on public.zone_allocations
  for select to authenticated using (true);
create policy "write allocations of draft flights" on public.zone_allocations
  for all to authenticated
  using      (exists (select 1 from public.flights f where f.id = flight_id and f.status = 'draft'))
  with check (exists (select 1 from public.flights f where f.id = flight_id and f.status = 'draft'));

-- ---------- GRANTs ----------
-- flights: update is granted column by column, leaving out id, created_by and created_at,
-- so nobody can reassign who made a flight. (M2: save with update, not an upsert that
-- sends every column.)
grant select, insert, delete on public.flights to authenticated;
grant update (flight_date, flight_no, registration, form_id, etd, actual_departure, delay_minutes,
              special_hr, special_aog, dg_note, loadmaster, notes, manual_alloc, tag_positions,
              status, updated_at)
  on public.flights to authenticated;
grant select, insert, update, delete on public.flight_stops, public.zone_allocations to authenticated;
grant all on public.flights, public.flight_stops, public.zone_allocations to service_role;
