-- AI weekly reports and one row per model call. Only the edge function (service_role)
-- writes these; logged-in users can read them for the compare view.

create table public.reports (
  id                  uuid primary key default gen_random_uuid(),
  mode                text not null check (mode in ('claude_only', 'hybrid')),
  period_start        date not null,
  period_end          date not null check (period_end >= period_start),
  model_claude        text,
  model_jev           text,
  content_md          text,
  total_cost_usd      numeric(10,6) not null default 0,
  total_latency_ms    int not null default 0,
  total_input_tokens  int not null default 0,
  total_output_tokens int not null default 0,
  call_count          int not null default 0,
  status              text not null check (status in ('ok', 'fallback', 'error')),
  eval_score          numeric(5,2),
  created_by          uuid references auth.users,
  created_at          timestamptz not null default now()
);

create table public.ai_calls (
  id             uuid primary key default gen_random_uuid(),
  report_id      uuid references public.reports on delete set null,
  provider_model text not null,
  purpose        text not null,          -- e.g. 'jev_flight_decisions', 'claude_write_report'
  input_tokens   int not null default 0,
  output_tokens  int not null default 0,
  cost_usd       numeric(10,6) not null default 0,
  latency_ms     int not null default 0,
  status         text not null check (status in ('ok', 'error', 'timeout')),
  error_message  text,
  created_at     timestamptz not null default now()
);
create index ai_calls_report_idx on public.ai_calls (report_id);
create index ai_calls_created_idx on public.ai_calls (created_at);  -- daily spend cap reads by date

alter table public.reports  enable row level security;
alter table public.ai_calls enable row level security;

-- Read only for logged-in users. No insert/update/delete policies: the browser can't
-- write a report or fake a cost row. service_role bypasses RLS.
create policy "logged-in users read reports"  on public.reports  for select to authenticated using (true);
create policy "logged-in users read ai calls" on public.ai_calls for select to authenticated using (true);

grant select on public.reports, public.ai_calls to authenticated;
grant all    on public.reports, public.ai_calls to service_role;
