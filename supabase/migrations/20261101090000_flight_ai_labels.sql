-- Jev's decisions for each flight of a hybrid report (M5), kept so the demo and the M6
-- comparison can show why a flight did or didn't reach Claude. One row per flight per
-- report. Only the edge function (service_role) writes; signed-in users read.

create table public.flight_ai_labels (
  id                  uuid primary key default gen_random_uuid(),
  report_id           uuid not null references public.reports on delete cascade,
  flight_id           uuid not null references public.flights on delete cascade,
  -- Jev's answers; null when it gave no usable answer for this flight
  category            text check (category in ('routine', 'delay_weather', 'delay_freight', 'delay_maintenance',
                                               'handling_issue', 'safety_concern', 'data_quality', 'other')),
  category_confidence numeric(4,3) check (category_confidence between 0 and 1),
  mention_p           numeric(4,3) check (mention_p between 0 and 1),   -- Noul: probability it belongs in the report
  urgency             numeric(2,1) check (urgency between 1 and 5),     -- Score, on the 1-5 scale
  urgency_confidence  numeric(4,3) check (urgency_confidence between 0 and 1),
  -- what code decided from them
  included            boolean not null,
  reason              text not null check (reason in ('jev_mention', 'flagged', 'jev_failed', 'low_confidence', 'jev_routine')),
  error_message       text,
  created_at          timestamptz not null default now(),
  unique (report_id, flight_id)              -- also serves as the report_id index
);
create index flight_ai_labels_flight_idx on public.flight_ai_labels (flight_id);

alter table public.flight_ai_labels enable row level security;
create policy "logged-in users read ai labels" on public.flight_ai_labels for select to authenticated using (true);

revoke all on public.flight_ai_labels from anon, authenticated;
grant select on public.flight_ai_labels to authenticated;
grant all    on public.flight_ai_labels to service_role;
