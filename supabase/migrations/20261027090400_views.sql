-- Deterministic aggregates for the weekly report. security_invoker = true makes each
-- view run with the caller's permissions, so RLS on the tables underneath still applies.
-- Without it a view runs as its owner and would skip RLS.

-- Total placed weight per flight and zone (all stops and kinds), as in the app's compute():
-- only stops with a destination or a weight, and only zones on the flight's current form
-- (allocations left over from a form change don't count).
create view public.v_zone_loads with (security_invoker = true) as
select a.flight_id, a.zone_id, sum(a.weight_lb) as load_lb
from public.zone_allocations a
join public.flight_stops s on s.id = a.stop_id
join public.flights f on f.id = a.flight_id
join public.form_zones z on z.form_id = f.form_id and z.zone_id = a.zone_id
where s.dest <> '' or s.cargo_lb + s.post_lb + s.fast_lb + s.bag_lb > 0
group by a.flight_id, a.zone_id;

-- Flights at or above 95% of any zone or combined-zone limit.
create view public.v_near_limit with (security_invoker = true) as
with checks as (
  select f.id as flight_id, 'zone' as limit_kind, z.zone_id as limit_id, z.label,
         coalesce(l.load_lb, 0) as load_lb, z.max_lb
  from public.flights f
  join public.form_zones z on z.form_id = f.form_id and z.max_lb is not null
  left join public.v_zone_loads l on l.flight_id = f.id and l.zone_id = z.zone_id
  union all
  select f.id, 'group', g.group_id, g.label,
         coalesce((select sum(l.load_lb) from public.v_zone_loads l
                   where l.flight_id = f.id and l.zone_id = any (g.zone_ids)), 0),
         g.max_lb
  from public.flights f
  join public.form_groups g on g.form_id = f.form_id
)
select f.id as flight_id, f.flight_date, f.flight_no, f.registration, f.form_id,
       c.limit_kind, c.limit_id, c.label, c.load_lb, c.max_lb,
       round(c.load_lb / c.max_lb, 3) as pct_of_max,
       c.load_lb > c.max_lb as is_over
from checks c
join public.flights f on f.id = c.flight_id
where c.load_lb >= 0.95 * c.max_lb;

-- Freight per route per week. Route is the stops in order, e.g. 'YSB-YTS'.
-- load_factor_proxy: placed weight / form capacity, averaged over the week's flights.
create view public.v_route_week with (security_invoker = true) as
with per_flight as (
  select f.id, f.flight_date, f.form_id,
         string_agg(s.dest, '-' order by s.seq) as route,
         sum(s.cargo_lb) as cargo_lb, sum(s.post_lb) as post_lb,
         sum(s.fast_lb) as fast_lb, sum(s.bag_lb) as bag_lb
  from public.flights f
  join public.flight_stops s on s.flight_id = f.id
  where s.dest <> '' or s.cargo_lb + s.post_lb + s.fast_lb + s.bag_lb > 0
  group by f.id
)
select date_trunc('week', p.flight_date)::date as week_start, p.route, p.form_id,
       count(*) as flights,
       sum(p.cargo_lb) as cargo_lb, sum(p.post_lb) as post_lb,
       sum(p.fast_lb) as fast_lb, sum(p.bag_lb) as bag_lb,
       sum(p.cargo_lb + p.post_lb + p.fast_lb + p.bag_lb) as total_lb,
       round(avg(coalesce(l.placed_lb, 0) / fm.capacity_lb), 3) as load_factor_proxy
from per_flight p
join public.forms fm on fm.form_id = p.form_id
left join (select flight_id, sum(load_lb) as placed_lb from public.v_zone_loads group by flight_id) l
  on l.flight_id = p.id
group by 1, 2, 3;

-- Delays per day.
create view public.v_delays with (security_invoker = true) as
select f.flight_date,
       count(*) as flights,
       count(*) filter (where f.delay_minutes > 0) as delayed_flights,
       coalesce(sum(f.delay_minutes), 0) as total_delay_minutes,
       max(f.delay_minutes) as max_delay_minutes
from public.flights f
group by f.flight_date;

grant select on public.v_zone_loads, public.v_near_limit, public.v_route_week, public.v_delays
  to authenticated, service_role;
