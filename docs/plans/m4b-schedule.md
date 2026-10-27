# M4b: Scheduled weekly report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Monday morning the database calls the `generate-report` edge function for the week that just ended, with no one signed in. The manual Generate button keeps working, and both triggers run through the same function, checks, logging and spend cap.

**Architecture:** `pg_cron` runs `public.run_weekly_report()` on a schedule; that function sends an HTTP POST with `pg_net`, carrying a random secret kept in Supabase Vault. The edge function accepts either a signed-in user (as today) or that secret, which it checks by asking the database (`is_report_cron_secret`), so the secret never exists outside the database: no one types it, copies it or sets it as an edge secret. A scheduled run works out "last week" itself in Toronto time, skips the per-user daily cap, keeps the global spend cap, and does nothing if a scheduled report for that week already exists. `reports.triggered_by` records `manual` or `schedule`, and History shows it.

**Tech Stack:** Supabase `pg_cron`, `pg_net`, Vault; the existing edge function (Deno) and Node tests.

**Decided while planning (reviewer: challenge these if wrong):**
- Schedule: Mondays at 11:00 UTC (`0 11 * * 1`), which is 07:00 in Toronto in summer and 06:00 in winter. pg_cron on Supabase runs in UTC.
- Scheduled reports have `created_by = null`, so they never count toward anyone's 5-a-day cap. They still count toward the $2.00 spend cap, which is the cap that matters when nobody is watching.
- A scheduled run reads data with the service role (there's no user token, so RLS doesn't apply). It only reads, and the same rows are readable by any signed-in user anyway.
- Idempotent per week: a scheduled call for a week that already has an `ok` scheduled report returns `{ skipped: true }` without calling Claude. Manual reports for the same week don't block it.
- The scheduled body may carry `period_start` to override "last week". That's for testing; the job itself sends `{}`.
- The function URL is written into the SQL. It's public (the browser already uses it) and doesn't change at deploy (M7).

**Constraints:** every `supabase` command ends in `</dev/null`; the secret is never printed (no `select decrypted_secret` in any check); commit only when the user says so.

---

### Task 1: Migration

**Files:** Create `supabase/migrations/20261031090000_weekly_schedule.sql`

```sql
-- Weekly scheduled report. pg_cron calls run_weekly_report() every Monday; it POSTs to the
-- generate-report edge function with a random secret from Vault. The edge function sends
-- that secret back to is_report_cron_secret() to check it, so the secret never leaves the
-- database.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

alter table public.reports
  add column triggered_by text not null default 'manual' check (triggered_by in ('manual', 'schedule'));

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'report_cron_secret',
                           'Proves a generate-report call came from the weekly job')
where not exists (select 1 from vault.secrets where name = 'report_cron_secret');

create function public.is_report_cron_secret(p_secret text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(p_secret, '') <> '' and exists (
    select 1 from vault.decrypted_secrets
    where name = 'report_cron_secret' and decrypted_secret = p_secret);
$$;
revoke execute on function public.is_report_cron_secret(text) from public, anon, authenticated;
grant  execute on function public.is_report_cron_secret(text) to service_role;

-- Returns the pg_net request id; the answer lands in net._http_response (kept 6 hours).
create function public.run_weekly_report()
returns bigint
language sql security definer set search_path = ''
as $$
  select net.http_post(
    url := 'https://zjafthfktjfncwhycxej.supabase.co/functions/v1/generate-report',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-report-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'report_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000);
$$;
revoke execute on function public.run_weekly_report() from public, anon, authenticated;

select cron.schedule('weekly-ops-report', '0 11 * * 1', 'select public.run_weekly_report()');
```

- [ ] Push: `supabase db push --yes </dev/null`. Check: `select jobname, schedule, active from cron.job` shows the job; `select count(*) from vault.secrets where name = 'report_cron_secret'` is 1; as `authenticated`, calling either function raises `insufficient_privilege` (add these as `supabase/tests/schedule_check.sql`, same style as `ai_usage_check.sql`).

### Task 2: `lastWeekStart` (TDD)

**Files:** `supabase/functions/generate-report/report-core.js`, `report-core.test.mjs`

Test:

```js
test('lastWeekStart: the Monday of the week before the one containing today', () => {
  assert.equal(lastWeekStart('2026-10-26'), '2026-10-19'); // Monday
  assert.equal(lastWeekStart('2026-10-27'), '2026-10-19'); // Tuesday
  assert.equal(lastWeekStart('2026-10-25'), '2026-10-12'); // Sunday
});
```

Code (after `parseRequest`):

```js
// For the scheduled run: the Monday of last week, given today's date (YYYY-MM-DD).
export function lastWeekStart(today) {
  const sinceMonday = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7;
  return addDays(today, -sinceMonday - 7);
}
```

### Task 3: Edge function

**Files:** `supabase/functions/generate-report/index.ts`

Replace the sign-in block and the period/caps/reads/insert lines so that:

```ts
    const cronSecret = req.headers.get('x-report-cron');
    let user = null, scheduled = false, jwt = '';
    if (cronSecret !== null) {
      const { data: ok, error } = await admin.rpc('is_report_cron_secret', { p_secret: cronSecret });
      if (error) throw error;
      if (!ok) return reply(401, { error: 'Bad schedule secret.' });
      scheduled = true;
    } else {
      jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      const { data: auth } = jwt ? await admin.auth.getUser(jwt) : { data: null };
      user = auth?.user;
      if (!user) return reply(401, { error: 'Sign in first.' });
    }

    const body = await req.json().catch(() => null);
    const torontoToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
    const period = parseRequest(scheduled && !body?.period_start ? { period_start: lastWeekStart(torontoToday) } : body);
    if ('error' in period) return reply(400, { error: period.error });

    if (scheduled) {
      const { data: done, error } = await admin.from('reports').select('id')
        .eq('triggered_by', 'schedule').eq('status', 'ok').eq('period_start', period.start).limit(1);
      if (error) throw error;
      if (done.length) return reply(200, { report_id: done[0].id, skipped: true });
    }

    const { data: usage, error: uErr } = await admin.rpc('ai_usage', { p_user: user?.id ?? null }).single();
    if (uErr) throw uErr;
    // the daily cap is per person; a scheduled run has no person, only the spend cap applies
    const capped = capCheck({ runsToday: scheduled ? 0 : Number(usage.runs_today), spendUsd: Number(usage.spend_usd) }, caps);
    if (capped) return reply(429, { error: capped.message, code: capped.code });

    // No user token on a scheduled run, so it reads with the service role.
    const db = scheduled ? admin : createClient(url, env('SB_PUBLISHABLE_KEY') || env('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: noSession,
    });
```

and the insert gets `created_by: user?.id ?? null, triggered_by: scheduled ? 'schedule' : 'manual'`. Import `lastWeekStart`. Update the header comment. Deploy with `supabase functions deploy generate-report --use-api </dev/null`.

### Task 4: History shows the trigger

**Files:** `js/reports.js`, `reports.html`

- Add `triggered_by` to `LIST_COLS`; add a "Run by" column (`Manual` / `Scheduled`) after Status in `reports.html` and in the row template.
- In the footer, add `· scheduled` when `r.triggered_by === 'schedule'`.

### Task 5: Live verification

- [ ] `npm test` passes; `schedule_check.sql`, `ai_usage_check.sql`, `rls_check.sql` pass.
- [ ] Wrong secret: `curl -s -X POST -H 'x-report-cron: wrong' -H 'Content-Type: application/json' -d '{}' $F` → `{"error":"Bad schedule secret."}`. Empty header value → the same.
- [ ] Manual still works: the signed-in page loads History with the new column. Don't generate (the user has 1 run left today).
- [ ] Real scheduled run: `select public.run_weekly_report()`; wait about 30 s; `select status_code, content::text from net._http_response order by created desc limit 1` → 200 with a `report_id`; the report row has `triggered_by = 'schedule'`, `created_by` null, `status = 'ok'`, period 2026-10-19. Cost about $0.0025.
- [ ] Idempotent: run it again → 200 with `"skipped":true`, no new report or `ai_calls` row.
- [ ] pg_cron really fires: `select cron.schedule('weekly-ops-report-test', '* * * * *', 'select public.run_weekly_report()')`, wait about 70 s, check `cron.job_run_details` for a `succeeded` run and `net._http_response` for a skipped answer, then `select cron.unschedule('weekly-ops-report-test')`.
- [ ] The report opens on the page, marked Scheduled.

## Known limits

- pg_net is fire-and-forget: if the edge function fails, the job doesn't retry. The failed run is still in `reports` as `error` and in `net._http_response`; next Monday's run won't fill the gap. Re-running is one `select public.run_weekly_report()` (it covers last week only).
- Nothing alerts anyone when a scheduled run fails. M8's RUNBOOK says where to look.
- Changing the schedule means `cron.schedule('weekly-ops-report', ...)` again with the new expression (same name replaces it).

## Review

An independent subagent checked the SQL against hosted Supabase and ran Task 2 in a scratch copy (58 tests pass). Changes made from its review, all in the built code rather than the task text above:
- The empty-header test sends a really empty header (`-H 'x-report-cron;'`).
- The every-minute cron test unschedules itself after one run, so a failed real run can't keep calling Claude.
- Toronto's date is built from `formatToParts`, not from the `en-CA` format string.
- The skip check also skips a scheduled run started in the last 3 minutes. Rows stay `error` until complete, so two overlapping calls can't both generate.
- `schedule_check.sql` never calls `run_weekly_report()` as postgres and never selects the secret. Never select from `net.http_request_queue`: it holds the request headers, secret included, until they're sent.
- The migration creates `supabase_vault` if it's missing.
- The footer label was dropped; the History column is enough.

## Added during execution

- The edge function was deployed before the migration, so the job never had an old function to call. Migration applied; `schedule_check.sql`, `ai_usage_check.sql`, `rls_check.sql` and `save_flight_check.sql` all pass. 58 tests pass.
- Wrong secret and empty secret both return "Bad schedule secret."; no header returns "Sign in first."
- `select public.run_weekly_report()` → `net._http_response` 200 with a report id. The report: week 2026-10-19, `triggered_by = 'schedule'`, `created_by` null, `ok`, $0.0030, 21.5 s.
- The one-time cron test fired at 15:19 UTC (`succeeded` in `cron.job_run_details`) and got `{"skipped":true}` with the same report id: no new report, no AI call. It then removed itself; `cron.job` holds only `weekly-ops-report` (`0 11 * * 1`, active).
- History shows the new Run by column (Scheduled / Manual).
- Spend so far: 5 reports, 5 calls, $0.0138.
