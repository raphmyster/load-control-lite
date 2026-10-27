-- public.rls_auto_enable() is created by Supabase's "automatic RLS" setting and runs
-- from the ensure_rls event trigger. It's SECURITY DEFINER in the public schema, so the
-- security advisor flags it as callable through /rest/v1/rpc by anon and authenticated.
-- Nobody needs to call it directly: Postgres doesn't check EXECUTE when an event
-- trigger fires, so revoking it keeps automatic RLS working.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
