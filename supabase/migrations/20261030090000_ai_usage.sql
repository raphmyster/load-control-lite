-- Figures for the report caps, read by the generate-report edge function (service role).
-- runs_today: the user's reports created since midnight Toronto time, whatever their status,
--             so failed runs count too (they cost money).
-- spend_usd:  every AI call ever logged, for the global spend cap.
create function public.ai_usage(p_user uuid)
returns table (runs_today int, spend_usd numeric)
language sql stable security invoker set search_path = ''
as $$
  select
    (select count(*)::int from public.reports r
      where r.created_by = p_user
        and r.created_at >= (date_trunc('day', now() at time zone 'America/Toronto') at time zone 'America/Toronto')),
    (select coalesce(sum(c.cost_usd), 0) from public.ai_calls c);
$$;

-- New functions are executable by PUBLIC (and Supabase grants anon/authenticated too).
-- Only the edge function needs this one.
revoke execute on function public.ai_usage(uuid) from public, anon, authenticated;
grant  execute on function public.ai_usage(uuid) to service_role;
