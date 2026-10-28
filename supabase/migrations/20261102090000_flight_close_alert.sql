-- Same-day alert when a flight closes (M9). A trigger on flights calls send_flight_closed(),
-- which POSTs the flight id to the flight-alert edge function with a random secret from
-- Vault, as the weekly report job does. The function labels the flight with Jev, stores the
-- label here, and emails the duty manager when code decides it should.
-- Only the edge function (service_role) writes; signed-in users read.

create table public.flight_close_labels (
  id                  uuid primary key default gen_random_uuid(),
  flight_id           uuid not null unique references public.flights on delete cascade,
  model_jev           text,
  -- Jev's answers; null when there's no usable answer (no notes, Jev failed, or the spend cap)
  category            text check (category in ('routine', 'delay_weather', 'delay_freight', 'delay_maintenance',
                                               'handling_issue', 'safety_concern', 'data_quality', 'other')),
  category_confidence numeric(4,3) check (category_confidence between 0 and 1),
  mention_p           numeric(4,3) check (mention_p between 0 and 1),
  urgency             numeric(2,1) check (urgency between 1 and 5),
  urgency_confidence  numeric(4,3) check (urgency_confidence between 0 and 1),
  error_message       text,
  -- what code decided; both null when the flight doesn't alert
  alert_reason        text check (alert_reason in ('safety_concern', 'urgency', 'no_label')),
  email_status        text check (email_status in ('pending', 'sent', 'failed', 'capped', 'off')),
  email_error         text,
  emailed_at          timestamptz,
  created_at          timestamptz not null default now(),
  check ((alert_reason is null) = (email_status is null))
);
create index flight_close_labels_alerts_idx on public.flight_close_labels (created_at desc) where alert_reason is not null;

alter table public.flight_close_labels enable row level security;
create policy "logged-in users read close labels" on public.flight_close_labels for select to authenticated using (true);
revoke all on public.flight_close_labels from anon, authenticated;
grant select on public.flight_close_labels to authenticated;
grant all    on public.flight_close_labels to service_role;

-- Emails sent since midnight Toronto time, for ALERT_DAILY_CAP.
create function public.alert_emails_today()
returns int
language sql stable security invoker set search_path = ''
as $$
  select count(*)::int from public.flight_close_labels
  where email_status = 'sent'
    and emailed_at >= (date_trunc('day', now() at time zone 'America/Toronto') at time zone 'America/Toronto');
$$;
revoke execute on function public.alert_emails_today() from public, anon, authenticated;
grant  execute on function public.alert_emails_today() to service_role;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'flight_alert_secret',
                           'Proves a flight-alert call came from the close trigger')
where not exists (select 1 from vault.secrets where name = 'flight_alert_secret');

create function public.is_flight_alert_secret(p_secret text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(p_secret, '') <> '' and exists (
    select 1 from vault.decrypted_secrets
    where name = 'flight_alert_secret' and decrypted_secret = p_secret);
$$;
revoke execute on function public.is_flight_alert_secret(text) from public, anon, authenticated;
grant  execute on function public.is_flight_alert_secret(text) to service_role;

-- Returns the pg_net request id. pg_net sends after the closing transaction commits, so a
-- save that rolls back sends nothing. Also the way to re-send by hand, as postgres.
create function public.send_flight_closed(p_flight uuid)
returns bigint
language sql security definer set search_path = ''
as $$
  select net.http_post(
    url := 'https://zjafthfktjfncwhycxej.supabase.co/functions/v1/flight-alert',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-flight-alert', (select decrypted_secret from vault.decrypted_secrets where name = 'flight_alert_secret')),
    body := jsonb_build_object('flight_id', p_flight),
    timeout_milliseconds := 30000);
$$;
revoke execute on function public.send_flight_closed(uuid) from public, anon, authenticated;

create function public.on_flight_closed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- Closing a load sheet must never depend on the alert: a missing secret or a pg_net
  -- problem logs a warning and the close goes through.
  begin
    perform public.send_flight_closed(new.id);
  exception when others then
    raise warning 'flight alert not queued for %: %', new.id, sqlerrm;
  end;
  return null;
end $$;
revoke execute on function public.on_flight_closed() from public, anon, authenticated;

-- save_flight() sets status in every update, so `of status` alone would fire on each save;
-- the WHEN clause keeps it to the one draft -> closed change.
create trigger flights_closed_alert
  after update of status on public.flights
  for each row when (old.status = 'draft' and new.status = 'closed')
  execute function public.on_flight_closed();
