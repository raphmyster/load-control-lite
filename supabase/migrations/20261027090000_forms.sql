-- Form definitions and their weight limits. The rows come from js/config.js
-- (see the next migration), so the database and the browser agree on every limit.

create table public.forms (
  form_id       text primary key,              -- matches the key in FORMS, e.g. 'DH8300'
  aircraft_type text not null,
  name          text not null,
  is_split      boolean not null default false, -- true: bags and cargo recorded separately per zone
  capacity_lb   numeric(8,1) not null check (capacity_lb > 0)
);

create table public.form_zones (
  form_id text not null references public.forms on delete cascade,
  zone_id text not null,
  label   text not null,
  max_lb  numeric(8,1) check (max_lb > 0),     -- null: no limit printed for this zone
  seq     int not null,                         -- left-to-right order on the form
  primary key (form_id, zone_id)
);

-- A combined-zone limit, e.g. "Zone 1A + 1B together max 1,700 lb".
create table public.form_groups (
  form_id  text not null references public.forms on delete cascade,
  group_id text not null,
  label    text not null,
  zone_ids text[] not null check (cardinality(zone_ids) > 1),
  max_lb   numeric(8,1) not null check (max_lb > 0),
  primary key (form_id, group_id)
);

-- RLS: logged-in users can read the limits. Nobody writes them from the app;
-- they change only through a migration.
alter table public.forms       enable row level security;
alter table public.form_zones  enable row level security;
alter table public.form_groups enable row level security;

create policy "logged-in users read forms"       on public.forms       for select to authenticated using (true);
create policy "logged-in users read form zones"  on public.form_zones  for select to authenticated using (true);
create policy "logged-in users read form groups" on public.form_groups for select to authenticated using (true);

-- GRANTs: "automatically expose new tables" is off, so nothing is reachable until granted.
-- anon (not logged in) gets nothing.
grant select on public.forms, public.form_zones, public.form_groups to authenticated;
grant all    on public.forms, public.form_zones, public.form_groups to service_role;
