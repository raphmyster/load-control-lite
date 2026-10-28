# Runbook

What to do when Load Control Lite misbehaves. Each section starts from what you'd see, then where to look and what to do.

Every `supabase` command here ends in `</dev/null`, so the CLI never waits on a prompt. Run them from the repo root with the project linked. `supabase secrets list` shows each secret's name and a SHA-256 digest of its value, never the value.

## 1. Where to look first

- **Reports → History** on the site: each run's status, cost, time and trigger (Manual or Scheduled). Opening a report shows its AI calls.
- **`ai_calls`:** one row per model call, retries included, with `status` (`ok`, `error`, `timeout`) and `error_message`. Recent calls across all reports:

  ```bash
  supabase db query --linked "select created_at, purpose, provider_model, status, cost_usd, latency_ms, error_message from ai_calls order by created_at desc limit 20" </dev/null
  ```

- **Function logs:** Supabase dashboard → Edge Functions → generate-report → Logs. One structured line per report with its id, mode, status and totals.
- **Scheduled runs:** `net._http_response` holds the function's answer for about 6 hours. `cron.job_run_details` says `succeeded` once the request is sent, even if the function then failed, so it doesn't prove a report was made.

Never select from `net.http_request_queue`. Until a scheduled request is sent, it holds the request headers, schedule secret included.

Some outcomes leave no report row. A cap rejection (429) and a week with no flights (422) both return before the row is inserted; the function logs show them.

Logged spend can be lower than the OpenRouter bill. A call that times out on our side is logged at $0, but OpenRouter may still charge for it. The OpenRouter dashboard has the billed figure.

## 2. A report shows "error"

A report row is created with status `error` and only becomes `ok` once a complete report is stored. A run still in progress shows `error` too, so wait for the report text or its `ai_calls` rows before deciding it failed. A run never takes longer than 135 seconds.

Then read that report's `ai_calls` rows. The usual causes:

- **401 or 402 from OpenRouter:** the key is wrong, revoked, or out of credit. Check the key's credit limit and the account balance at OpenRouter. To replace the key, see section 10.
- **429 or 5xx from OpenRouter:** the provider was busy. The function already retried once after two seconds. Try again later.
- **`timeout`:** the call ran past `CLAUDE_TIMEOUT_MS` (45 s by default) or the run's deadline.
- **"The answer hit the 8000-token cap and was cut off":** the model used all its output tokens; the message gives the reasoning-token count. Reasoning tokens count against that cap, so check `CLAUDE_REASONING` is `low`.
- **Missing headings:** the report lacked one of the seven sections, and the corrective call didn't fix it.

A failed run is safe to repeat; nothing half-written is shown. It does count toward the day's 5 runs.

## 3. A hybrid report shows "fallback"

More than a quarter of the week's flights got no usable answer from Jev, so Claude read every flight and the report is complete. Nothing needs fixing for that week.

To find out why, read the Jev rows (purpose `jev_flight_decisions`) in that report's `ai_calls`. If every row has the same error, the cause is the key, the credit, or a change in the Decisions API, which is still alpha. Different errors on a few rows usually mean a slow provider: the Jev phase stops after 40 seconds and unanswered flights count as failed.

## 4. Jev returns answers in an unexpected shape

Each answer is checked against the expected types. An answer that fails is logged as `error` with the reason, its cost is kept, and that flight goes to Claude. A few of these are harmless. If all of them fail, the run falls back (section 3).

To see the raw answer shape, the owner runs the probe. It reads the key from the git-ignored env file:

```bash
set -a; . supabase/.env.local; set +a; node scripts/jev-probe.mjs
```

It sends one sample flight eight times in parallel and prints the first answer in full. That costs well under a cent.

## 5. "You've run 5 reports today, the daily limit"

The per-person cap counts the user's reports since midnight Toronto time, failed runs included. Scheduled runs don't count. Today's count for the demo account (the only user):

```bash
supabase db query --linked "select count(*) from reports where created_by = (select id from auth.users limit 1) and created_at >= (date_trunc('day', now() at time zone 'America/Toronto') at time zone 'America/Toronto')" </dev/null
```

Either wait until midnight Toronto time, or raise the cap for a set number of runs and remove it afterwards. The new cap has to be above the current count, not just 5 plus the runs you want.

```bash
supabase secrets set REPORT_DAILY_CAP=8 </dev/null
supabase secrets unset REPORT_DAILY_CAP </dev/null
```

## 6. "AI spend has reached the $2.00 cap"

Total logged spend across every AI call has reached `AI_SPEND_CAP_USD`. Check it:

```bash
supabase db query --linked "select count(*) calls, sum(cost_usd) spend from ai_calls" </dev/null
```

Raising the cap is the owner's decision. Check the OpenRouter balance and the key's credit limit first, then `supabase secrets set AI_SPEND_CAP_USD=3 </dev/null`.

## 7. Sign-in fails, or Reports says "Sign in first"

- **Wrong password:** reset it in the dashboard under Authentication → Users. Sign-ups are off by design, so a new account can't be created from the site.
- **"Sign in first" on Reports after signing in:** the session belongs to the browser and the site's address. Signing in on another browser, or on the local preview, doesn't carry over. Sign in on the flights page of the same site, then open Reports.
- **The function answers "Sign in first." to a signed-in user:** the login token has expired. Sign out and back in.

## 8. The browser shows a CORS error

The page's origin isn't in `ALLOWED_ORIGINS`. Check what the function answers:

```bash
curl -s -i -X OPTIONS -H 'Origin: https://loadcontrol.raphaelattar.com' https://zjafthfktjfncwhycxej.supabase.co/functions/v1/generate-report | grep -i access-control-allow-origin
```

It should echo the origin you sent. If not, set the list again with the live origin first, because the first origin is the answer for any origin not on the list:

```bash
supabase secrets set ALLOWED_ORIGINS=https://loadcontrol.raphaelattar.com,http://localhost:8411,http://127.0.0.1:8411 </dev/null
```

The change applies without a redeploy.

## 9. The scheduled report didn't appear

Nothing alerts anyone when a scheduled run fails, so check on Mondays after 11:00 UTC.

While the seed data is the only data, a missing report is expected. The seed ends on 2026-10-25, so each Monday's run asks for a week with no flights, gets 422 "No flights", and creates nothing and spends nothing. The function log shows the 422.

Once real flights exist for the previous week:

1. Look in History for a `Scheduled` row for last week. If there's an `ok` one, nothing's wrong.
2. If it's missing or `error`, read the function logs, and `net._http_response` if it's within 6 hours of the run.
3. Re-run it. The function only runs as the database owner, so use the CLI or the dashboard's SQL editor:

   ```bash
   supabase db query --linked "select public.run_weekly_report()" </dev/null
   ```

   It returns a request id straight away and doesn't wait for the report. Check History a minute later. It always covers last week. A re-run is skipped only if a scheduled report for that week is already `ok`, or one started in the last 3 minutes; manual reports and failed scheduled runs don't block it.

To change the schedule, run `cron.schedule('weekly-ops-report', ...)` with the new expression. The same name replaces the job.

## 10. Rotate the OpenRouter key

1. At OpenRouter, create a new key for this app and give it its own credit limit.
2. Put it in `supabase/.env.local` in place of the old one.
3. `supabase secrets set --env-file supabase/.env.local </dev/null`
4. Generate one report to confirm it works.
5. Revoke the old key at OpenRouter.

No redeploy is needed. If the key ever leaks, revoke it first and do the rest after.

## 11. The live site is down or wrong

- Check the site answers: `curl -sI https://loadcontrol.raphaelattar.com/` should return `HTTP/2 200` from `server: GitHub.com`.
- Check plain HTTP redirects: `curl -sI http://loadcontrol.raphaelattar.com/` should return a 301 to the https address. If it returns 200, untick and re-tick Enforce HTTPS in the repo's Settings → Pages.
- Check the deploy: the repo's Actions tab shows each `pages build and deployment` run.
- Check the domain: repo Settings → Pages should show `loadcontrol.raphaelattar.com` with a successful DNS check. In Cloudflare, the `loadcontrol` CNAME to `raphmyster.github.io` must stay DNS only (grey cloud); a proxied record breaks the HTTPS certificate.
- Roll back a bad change with `git revert <commit>` and `git push`. Pages redeploys in about a minute.

If the live site can't be fixed quickly, the app runs locally: `python3 -m http.server 8411` from the repo root, then http://localhost:8411. The local origin is in `ALLOWED_ORIGINS`, so reports work from it.

## 12. Never reseed the live project

`npm run seed` deletes every flight in the linked project before loading, and the cascade deletes every stored Jev label with them. Reports keep their text but lose their labels tables. Run the seed only against a fresh project.

## 13. After the interview

Remove the local preview origins, so only the live site can call the function from a browser:

```bash
supabase secrets set ALLOWED_ORIGINS=https://loadcontrol.raphaelattar.com </dev/null
```

The local preview stops working for reports after this.

## 14. A closed flight didn't alert

The `flight-alert` function runs a few seconds after a flight is closed. Each closed flight gets one row in `flight_close_labels`; an alert is a row with `alert_reason` set, and `email_status` says what happened to the email (`sent`, `failed`, `capped`, `off`, or `pending` while it's being sent).

Recent rows:

```bash
supabase db query --linked "select l.created_at, f.flight_no, f.flight_date, l.category, l.urgency, l.alert_reason, l.email_status, l.email_error, l.error_message from flight_close_labels l join flights f on f.id = l.flight_id order by l.created_at desc limit 20" </dev/null
```

Flights the alert missed: closed today with no row, or with a row stuck at `pending` for more than 5 minutes (the function stopped between storing the row and sending):

```bash
supabase db query --linked "select f.id, f.flight_no, f.updated_at, l.email_status from flights f left join flight_close_labels l on l.flight_id = f.id where f.status = 'closed' and f.updated_at >= (date_trunc('day', now() at time zone 'America/Toronto') at time zone 'America/Toronto') and (l.id is null or (l.email_status = 'pending' and l.created_at < now() - interval '5 minutes'))" </dev/null
```

What each outcome means:
- **No row.** The function never got far enough. Check its logs (Edge Functions → flight-alert → Logs) and `net._http_response` (kept about 6 hours). The trigger logs a warning instead of failing the close, so a missing Vault secret shows up only there.
- **`off`.** `ALERT_TO` or `RESEND_API_KEY` isn't set.
- **`capped`.** 10 emails were already sent today (`ALERT_DAILY_CAP`).
- **`failed`.** `email_error` has Resend's answer. With the shared sender, Resend refuses any address other than the account's own.
- **`no_label` alerts on every flight with notes.** Jev is failing or the $2.00 spend cap is reached; `error_message` says which. The spend cap is a lifetime total.

To re-send one flight, delete its row, then queue it again as postgres:

```sql
delete from flight_close_labels where flight_id = '<flight id>';
select public.send_flight_closed('<flight id>');
```

To stop the emails but keep labelling: `supabase secrets unset ALERT_TO </dev/null`. To stop everything, including the Jev calls: `alter table public.flights disable trigger flights_closed_alert` (and `enable` to turn it back on).
