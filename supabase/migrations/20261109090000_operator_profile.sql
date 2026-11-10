-- One private operator pack (name, mark, colours, forms, form images), applied by the
-- app after sign-in. Signed-in users read it; only scripts/push-operator-pack.mjs writes it.
create table public.operator_profile (
  id         int primary key default 1 check (id = 1),
  profile    jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.operator_profile enable row level security;
create policy "logged-in users read the operator profile" on public.operator_profile for select to authenticated using (true);

-- anon (not logged in) gets nothing; the app never writes it.
grant select on public.operator_profile to authenticated;
grant all    on public.operator_profile to service_role;
