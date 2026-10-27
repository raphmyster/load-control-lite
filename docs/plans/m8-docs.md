# M8: Docs and demo prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The public repo explains itself, and the interview demo can't be sunk by one failure. `README.md`, `RUNBOOK.md` and `DEMO.md` sit at the repo root, screenshots of the live app are in `docs/screenshots/`, and the interview prep notes gain the two answers worked out on 2026-10-27.

**Architecture:** Documentation only; no app code, migration or function setting changes. Every figure in the docs comes from the database, the plan notes in `docs/plans/`, or a command run while writing, never from memory. Screenshots come from existing reports on the live site, so no new AI runs and no spend.

**Tech Stack:** Markdown (GitHub renders it), the browser pane for screenshots, the unslop scanners for prose.

**Decisions made with the user:**
- M6 (compare view and evals) is not built before Thursday. The docs say so plainly and list it as the next step.
- Thursday morning is rehearsal only, no code changes.

**Decided while planning (reviewer: challenge these if wrong):**
- **Three docs at the repo root, as PRD section 11 names them.** GitHub shows `README.md` on the repo's front page. `RUNBOOK.md` and `DEMO.md` sit beside it so the README can link them by name.
- **The architecture diagram is a fenced text diagram, not an image.** It renders anywhere, diffs cleanly, and matches the diagram already in the PRD and the interview notes. A Mermaid or Excalidraw version is a nice-to-have that can wait.
- **DEMO.md is public.** It's a demo script and the talking points, written so an interviewer reading it learns how the system works. Prepared answers and anything about the interviewers stay in `../interview-prep-ai-report.md`, outside the repo.
- **The talking points name the role, not the company.** "The Specialist, AI & Automation role" passes the debrand check, and the public repo shouldn't name the airline. Spoken in the interview, it can be named freely.
- **Screenshots are JPEGs at the pane's 1x scale**, under 200 KB each, so `check-debrand.sh`'s large-file check still passes. They show demo data only: no email address, no keys, no account settings.
- **No new report runs.** The history already holds an ok Claude-only run, an ok hybrid run with its labels table, and a fallback run. That's every state the demo needs to show.
- **Measured results are the M5 table, not new runs.** Week of 2026-10-19, one run per model and mode. The docs call it one run each, not an average, as the M5 notes do.

**Facts the docs use (gathered 2026-10-27; re-check any that could have moved):**
- Live: `https://loadcontrol.raphaelattar.com`. Repo: `https://github.com/raphmyster/load-control-lite`. Function: `https://zjafthfktjfncwhycxej.supabase.co/functions/v1/generate-report`.
- Tables: `flights`, `flight_stops`, `zone_allocations`, `reports`, `ai_calls`, `flight_ai_labels`, plus the forms tables. Views: `v_route_week`, `v_near_limit`, `v_delays`, `v_zone_loads`. RLS on every table.
- Claude settings (defaults in `index.ts`): `CLAUDE_MODEL` = `anthropic/claude-haiku-5.5`, `CLAUDE_REASONING` = low, `CLAUDE_TIMEOUT_MS` = 45000, output capped at 8000 tokens. Each run has a 135 s deadline, and no call starts with under 20 s left. A transient failure gets one retry; missing headings get one corrective call.
- Jev settings: `JEV_MODEL` = `typesafe/jev-1.14`, `JEV_TIMEOUT_MS` = 10000, `JEV_CONCURRENCY` = 8, `JEV_CONFIDENCE` = 0.7, and the Jev phase ends at 40 s. `.env.example` doesn't list the `JEV_*` settings, so the README does.
- `ALLOWED_ORIGINS` = the live origin, then `http://localhost:8411` and `http://127.0.0.1:8411`.
- Timed-out calls log $0, so logged spend can be below what OpenRouter billed.
- A cap rejection (429) or a week with no flights (422) returns before the report row is inserted, so neither leaves a row in `reports`.
- **The schedule has nothing to report yet.** The seed ends on 2026-10-25, so the run on 2026-11-02 asks for the week of 2026-10-26, gets 422 "No flights", and creates no report and no AI call. That repeats every Monday until new flights are entered for the previous week. It costs nothing, and the docs say so plainly.
- `run_weekly_report()` is revoked from anon and authenticated; it runs as postgres: `supabase db query --linked "select public.run_weekly_report()" </dev/null` or the SQL editor. It returns a pg_net request id and doesn't wait. The answer stays in `net._http_response` for about 6 hours. `cron.job_run_details` says "succeeded" once the request is sent, even if the function then failed. The function skips only when a *scheduled* report for that week is `ok` or one started in the last 3 minutes; manual reports and failed scheduled runs don't block a re-run. pg_net's timeout is 150 s.
- `npm run seed` deletes every flight in the linked project before loading, and the cascade deletes all `flight_ai_labels` rows. Never run it against the live project.
- Migration `20261031090000_weekly_schedule.sql` hardcodes this project's function URL. A fork must edit it before `db push`.
- Seed: 504 flights over 8 weeks (2026-08-31 to 2026-10-25), 9 routes from YTZ, seed 214, planted patterns in `seed/ground_truth.json`.
- Caps: 5 reports per person per Toronto day (`REPORT_DAILY_CAP`), $2.00 total spend (`AI_SPEND_CAP_USD`), and the OpenRouter key's own credit limit.
- Spend to date: 263 AI calls, $0.1823 total. Reports: 5 Claude-only ok, 2 Claude-only error, 3 hybrid ok, 1 hybrid fallback (before today's live run; re-query).
- Haiku, Claude only: $0.0023, 15.0 s. Haiku, hybrid: $0.0040, 20.2 s. Opus, Claude only: $0.0738, 24.0 s. Opus, hybrid: $0.0817, 27.3 s. All four found the 5 planted patterns that apply to that week. Live deploy run: $0.00245, 16.7 s.
- Schedule: pg_cron, Mondays 11:00 UTC, Claude-only, first automatic run 2026-11-02.
- Tests: `npm test`, 90 pass. SQL checks in `supabase/tests/`.
- Commands as used in the plans: `supabase db push --yes </dev/null`, `supabase functions deploy generate-report --use-api </dev/null`, `supabase secrets set --env-file supabase/.env.local </dev/null`, `supabase db query --linked -f supabase/tests/<file>.sql </dev/null`, `supabase secrets set KEY=value </dev/null`, `supabase secrets unset KEY </dev/null`, `supabase secrets list </dev/null` (names and SHA-256 digests, never values), `npm run seed`, `npm run seed:verify`.
- Today's run count for the demo user: `supabase db query --linked "select count(*) from reports where created_by = (select id from auth.users limit 1) and created_at >= (date_trunc('day', now() at time zone 'America/Toronto') at time zone 'America/Toronto')" </dev/null` (one user exists; sign-ups are off).
- Recent calls and errors across all reports (PRD section 11's "admin view"; there's no page for it): `select created_at, purpose, provider_model, status, cost_usd, latency_ms, error_message from ai_calls order by created_at desc limit 20`.

**Constraints:**
- Prose follows the unslop contract. Run both scanners on every doc and fix what they confirm.
- `scripts/check-debrand.sh ../debrand-terms.txt` must pass after every task.
- No secret values in any doc. Name where a secret lives, never what it is.
- Claude never reads `supabase/.env.local`.
- Commit and push only on the user's word.

---

### Task 1: README.md

**Files:** Create `README.md`

- [ ] **Step 1: Write it**, in this order:
  1. Title, one-line description, the live URL, and the "demo, not for operational use" line. One sentence on the login (one demo account, sign-ups off, ask for access).
  2. **What it is.** Two short paragraphs: the load control app (manifest entry, auto-place, limit checks, print block) and what this project added (database, auth, RLS, AI weekly report in two modes, logging, caps). State that AI never touches weights, placement, limits or the print block.
  3. **Architecture.** The text diagram from PRD section 4, updated with the schedule (pg_cron → function) and the `flight_ai_labels` table. Then the "what runs where" rule in three lines.
  4. **The weekly report.** How a run works in numbered steps (caller check, caps, SQL facts, Claude or Jev + Claude, validation, logging). One paragraph each on Claude-only and hybrid, and the hybrid's fallback rule.
  5. **Measured results.** The four-row table above, plus the honest reading: at 63 one-line notes a week the hybrid costs more and is slower, because Jev reads about 46k tokens to save Claude about 500, and Claude's cost is mostly output. Where it would pay off (labels stored when a flight closes, at volume). Say it's one run each.
  6. **Secrets and safety.** The PRD 9a table condensed to bullets: key only in function secrets, publishable key only in the browser, RLS, caps, CORS, secret scanning and push protection, notes treated as data in the prompt.
  7. **Repo layout.** One line per top-level folder and key file.
  8. **Run it yourself.** Prerequisites (Node 22, Supabase CLI, an OpenRouter key). Steps: create a Supabase project, `supabase link`, edit the function URL in `supabase/migrations/20261031090000_weekly_schedule.sql` to your project's, `supabase db push`, create the demo user in the dashboard and turn sign-ups off (the dashboard, not `config.toml`, which is for the local stack), `npm run seed` (needs the user to exist; it wipes all flights first, so only against a fresh project), copy `.env.example` to `supabase/.env.local` and set secrets, deploy the function, set `js/supabase-config.js` to your project's URL and publishable key, serve the root with `python3 -m http.server 8411`. Then `npm test` and the SQL checks.
  9. **Deploy.** GitHub Pages from `main` root, `CNAME`, DNS-only CNAME, `ALLOWED_ORIGINS`. Point to `docs/plans/m7-deploy.md` for the full record.
  4b. **Settings.** A table of every setting with its default: the Claude and Jev settings, the two caps, `ALLOWED_ORIGINS`.
  10. **Not built yet.** M6 compare view and evals, automatic scoring against `ground_truth.json`, a figures check, an alert on failed scheduled runs, an admin page for recent calls (the SQL is in the RUNBOOK). Also that the schedule has no new flights to report: the seed ends on 2026-10-25, so each Monday's run finds no flights and creates nothing until new flights are entered. Link `RUNBOOK.md` and `DEMO.md`.

- [ ] **Step 2: Check every command and path** in the README against the repo: each file path exists (`ls`), each npm script exists in `package.json`, and each `supabase` command matches one used in `docs/plans/`.

- [ ] **Step 3: Scanners and debrand.**

Run:
```bash
P="$PWD/README.md"; (cd ~/.claude/skills/unslop && python3 scripts/banned_phrase_scan.py "$P" && python3 scripts/structure_scan.py --genre docs "$P")
scripts/check-debrand.sh ../debrand-terms.txt
```
Expected: `total_violations: 0`, no flags (or flags reviewed and judged genre-natural), `PASS`.

### Task 2: RUNBOOK.md

**Files:** Create `RUNBOOK.md`

- [ ] **Step 1: Write it.** Each section: the symptom as someone would see it, where to look, what to do. Commands exact, with `</dev/null` on every `supabase` command.
  1. **Where to look first.** Reports History on the page (status, cost, time); `ai_calls` (one row per attempt, with `error_message`), with the recent-calls SQL above; Edge Functions → generate-report → Logs in the dashboard (one structured line per call); for scheduled runs, `net._http_response` (kept about 6 hours) and `cron.job_run_details` ("succeeded" means only that the request was sent). A warning not to select from `net.http_request_queue` (it holds the schedule secret until sent). Logged spend can be below the OpenRouter bill, because timed-out calls log $0; the OpenRouter dashboard has the billed figure. A cap rejection or a no-flights week leaves no report row; the function logs show it.
  2. **A report shows "error".** Read its `ai_calls` rows. Common causes: OpenRouter 401/402 (key or credit), 429/5xx (busy; already retried once), timeout, "hit the token cap", missing headings after the corrective retry. Note that a row is `error` until the report is stored, so a run in progress also shows `error`: wait for `content_md` or the `ai_calls` row before deciding it failed.
  3. **A hybrid report shows "fallback".** More than 25% of flights got no usable Jev answer. Check the Jev rows in `ai_calls` (purpose `jev_flight_decisions`). If every row has the same error, it's the key, credit, or an API change (the Decisions API is alpha). The report itself is complete; nothing to fix for that week.
  4. **Jev returns bad output.** Answers that fail the shape check are logged as `error` with the reason, and those flights go to Claude. Re-run `scripts/jev-probe.mjs` (the owner runs it; it reads the key file) to see the raw answer shape.
  5. **"You've run 5 reports today".** The per-person cap, counted from midnight Toronto time, failed runs included. Wait, or raise `REPORT_DAILY_CAP` for a set number of runs and unset it after. Scheduled runs don't count.
  6. **"AI spend has reached the cap".** Total logged spend ≥ `AI_SPEND_CAP_USD`. Check spend with the `ai_calls` sum. Raising the cap is the owner's decision; check the OpenRouter balance and key limit first.
  7. **Sign-in fails, or the Reports page says "Sign in first".** Wrong password; the session expired; or the browser has no session for this origin. Sign-ups are off by design. A password reset goes through the dashboard (Authentication → Users).
  8. **The browser shows a CORS error.** `ALLOWED_ORIGINS` doesn't list the page's origin. Check with the OPTIONS curl from `m7-deploy.md` Task 6, and set the list again (live origin first).
  9. **A scheduled run failed.** Nothing alerts anyone. First: while the seed data is the only data, every Monday's run finds no flights for last week and creates nothing. That's expected, not a failure; the function log shows the 422. Once real flights exist: Monday after 11:00 UTC, check History for a `Scheduled` row for last week. If it's missing or `error`, check the function logs (and `net._http_response` within 6 hours), then re-run with `supabase db query --linked "select public.run_weekly_report()" </dev/null`. It returns a request id and doesn't wait, so check History a minute later. It covers last week only, and it's skipped only if a scheduled report for that week is already `ok`.
  10. **Rotate the OpenRouter key.** Create a new key with its own credit limit → put it in `supabase/.env.local` → `supabase secrets set --env-file supabase/.env.local </dev/null` → generate one report to confirm → revoke the old key. No redeploy needed.
  11. **The live site is down or wrong.** Check `curl -sI https://loadcontrol.raphaelattar.com/`, the repo's Actions tab (`pages build and deployment`), and the Pages settings (custom domain, DNS check). Roll back with `git revert <commit>` and push; Pages redeploys in about a minute. DNS: the `loadcontrol` CNAME must stay DNS only in Cloudflare.
  12. **Never reseed the live project.** `npm run seed` deletes every flight, and with them every stored Jev label.
  13. **After the interview.** Remove the preview origins from `ALLOWED_ORIGINS` with `supabase secrets set ALLOWED_ORIGINS=https://loadcontrol.raphaelattar.com </dev/null`.

  Sections 5 and 6 use `secrets set`, `secrets unset` and `secrets list` with `</dev/null`. Section 11 includes the HTTP→HTTPS redirect check (`curl -sI http://loadcontrol.raphaelattar.com/` should show a 301), open since M7.

- [ ] **Step 2: Check each table, column, function and setting name** against the migrations and `index.ts` (`grep`), and each dashboard path against what the M4–M7 notes recorded.

- [ ] **Step 3: Scanners and debrand**, as in Task 1.

### Task 3: Demo screenshots

**Files:** Create `docs/screenshots/*.jpg`

- [ ] **Step 1: Check the pane is signed in** on `https://loadcontrol.raphaelattar.com`. If not, the user signs in there.

- [ ] **Step 2: Capture, at the pane's default width:**
  - `01-flights.jpg`: a closed Dash 8-300 flight with its manifest and load control section.
  - `02-report-claude-only.jpg`: the Claude-only report for 2026-10-19, top of the report with the status pill.
  - `03-report-footer.jpg`: the same report's cost and speed footer.
  - `04-report-hybrid-labels.jpg`: a hybrid report's Jev labels table, showing why each flight was or wasn't sent.
  - `05-fallback.jpg`: the fallback report with its banner.
  - `06-history.jpg`: the History table with both modes, the Run by column and costs.

  Open each report from History; generate nothing. Never capture the sign-in form. First check that the pane's screenshot is saved as a file Claude can copy (the image path the tool reports). If it is, copy each into `docs/screenshots/` with the name above. If not, the user takes them with Cmd-Shift-4 and Claude converts them with `sips -s format jpeg -s formatOptions 70 <in> --out docs/screenshots/<name>.jpg`.

- [ ] **Step 3: Check them.** `ls -la docs/screenshots` (each under 200 KB), open each with Read to confirm it shows what its name says and no email address or account detail, then run `check-debrand.sh`.

### Task 4: DEMO.md

**Files:** Create `DEMO.md`

- [ ] **Step 1: Write it:**
  1. **Before the call (10 minutes).** No live Generate on interview day before the call: every run counts toward the 5, failed ones too. Check today's count with the SQL above (expect 0). Check the OpenRouter balance. Open the live site and sign in, GitHub on the repo, the Supabase dashboard on Edge Functions → Logs, and the screenshots folder as the fallback. Know the backup: the local preview on port 8411 (still in `ALLOWED_ORIGINS`). Recheck the HTTP→HTTPS redirect.
  2. **The 5-minute script**, timed:
     - 0:00–0:45: the load control app. One flight, auto-place, a limit check, the print block. "AI never touches any of this."
     - 0:45–2:00: Reports → Claude only → Generate. While it runs (15–25 s), the pipeline in one breath: login, caps, SQL facts, one Claude call, validation, logging. Then the report and its footer. If nothing is back by about 35 s, open the existing report from History and carry on; the run finishes in the background and still counts.
     - 2:00–3:15: Claude + Jev → Generate (20–30 s, same 35 s cut-off). The labels table: what Jev sent and why. The honest result: it costs more here, and why.
     - 3:15–4:15: History (both modes, the scheduled row) and the `ai_calls` audit trail. Caps, and the fallback banner.
     - 4:15–5:00: the repo: migrations, tests, the plans with their review and "Added during execution" notes.
  3. **If something fails live.** Each failure and what to show instead: a report error (show its `ai_calls` row; this is the validation working), the site down (local preview, then screenshots), the cap hit (show the message; it's a feature), slow network (open an existing report from History).
  4. **Talking points mapped to the role.** The PRD section 1 table, each row with what to point at on screen.
  5. **Questions to expect**, one line each, pointing to where the answer is shown: cost control, key handling, failure handling, why SQL does the math, how it scales, what's next (M6).

- [ ] **Step 2: Time the script** by reading it aloud with the clicks (the user does this during Wednesday's rehearsal). Note anything that ran long in "Added during execution".

- [ ] **Step 3: Scanners and debrand**, as in Task 1.

### Task 5: Interview prep notes (outside the repo)

**Files:** Modify `../interview-prep-ai-report.md`

- [ ] **Step 1: Add two questions after question 10:**
  - "Why do you store Jev's decisions in their own table?" `ai_calls` is needed for the spend cap and the audit trail; `flight_ai_labels` explains what Jev dropped and why, joins to `flights`, and feeds the M6 evals.
  - "Why did the hybrid cost more and run slower?" The interview paragraph from the M7 handoff, as is.
- [ ] **Step 2: Update the figures** that moved: the deploy is live (add the URL to "What I built"), and "What I'd add next" matches README's "Not built yet".
- [ ] **Step 3: Scanners** on the file. It's outside the repo, so the debrand check doesn't cover it and the airline can be named.

### Task 6: Notes, checks and commit

- [ ] **Step 1: Re-run the checks:** `npm test` (90 pass), `scripts/check-debrand.sh ../debrand-terms.txt` (PASS), `gitleaks git --redact .` after committing (only the publishable key).
- [ ] **Step 2: Re-query the two figures that move** (spend total and report counts) and update README if they changed.
- [ ] **Step 3: Add "Added during execution"** to this file.
- [ ] **Step 4: Commit and push on the user's word.**

```bash
git add README.md RUNBOOK.md DEMO.md docs/screenshots docs/plans/m8-docs.md
git commit -m "M8: README, RUNBOOK, DEMO and demo screenshots"
git push
```
Expected: the repo front page shows the README. Pages redeploys with no change to the app.

---

**Done when (PRD section 12):** README, RUNBOOK and DEMO complete and pushed; screenshots of every demo state in the repo as the backup; interview notes updated; debrand check and tests pass.

**Not in M8:** a screen recording. If the user wants one, it's a macOS screen recording they make during Wednesday's rehearsal (Cmd-Shift-5), kept outside the repo.

---

## Review

A subagent reviewed the first draft on 2026-10-27 and found four problems that would have misled an operator or the demo, all fixed above. The 2026-11-02 scheduled run will find no flights (the seed ends on 2026-10-25), return 422 before any report row is inserted, and repeat that every Monday, so the RUNBOOK's "look for a Scheduled row" check would have reported a failure each week; checked against `index.ts`, where the no-flights reply comes before the insert. The recovery command was wrong on who can run it, on what it waits for, and on when a re-run is skipped. `npm run seed` wipes the live flights and every stored label. A fork must edit the hardcoded function URL in the schedule migration. Also added from the review: the Claude and Jev settings and run timing, `v_zone_loads`, the `secrets` commands, the $0 logging of timed-out calls, SQL for today's run count and for recent calls, a "no live Generate before the call" rule with a 35 s cut-off, and a fallback if the pane's screenshots can't be saved as files.

## Added during execution (2026-10-27)

- **README, RUNBOOK, DEMO** written at the repo root. Each passed both prose scanners and the debrand check. DEMO.md has one soft flag, repeated sentence openings, left as is because a click-by-click script repeats its imperatives. Every path the README names exists, and the RUNBOOK's error text, table names and the `run_weekly_report` schedule were checked against the code. One fix from that check: the token-cap error reads "The answer hit the 8000-token cap and was cut off", not "hit the token cap".
- **Screenshots.** The pane saves each screenshot as an 800 px JPEG, so copying them worked without the Cmd-Shift-4 fallback. Seven files, all under 100 KB: the plan's six plus `04b-report-hybrid-dropped.jpg`, which shows the flights Jev dropped as routine. History rows open from an "Open" button at the right of the scrolling table, not from the row itself. Two captures had a blank lower half (the page hadn't painted below the fold); `03-report-footer.jpg` is cropped to the painted part, and a second flights shot was dropped. Reports used: the live deploy run (Claude only), the 12:46 Haiku hybrid, and the 12:48 fallback. No new runs.
- **Interview notes** (`../interview-prep-ai-report.md`): questions 11 (why a labels table) and 12 (why the hybrid cost more) added; "What I built" mentions the hybrid and the live URL; "What I'd add next" matches the README; a note on the schedule having no new flights.
- **Figures re-checked:** `npm test` 90 pass; 263 AI calls and $0.1823 logged spend, which already included the M7 live run.
- **Still open:** plain HTTP still answers 200 instead of a 301 to https, after Enforce HTTPS was ticked in M7. RUNBOOK section 11 and the DEMO pre-call list both check it. The timed read-aloud of the demo script is for Wednesday's rehearsal.
