# Load Control Lite

A weight-and-balance paperwork app for a fictional regional turboprop operator, extended with an AI weekly operations report written two ways: by Claude alone, and by Claude working from per-flight decisions made by Jev.

**Live:** https://loadcontrol.raphaelattar.com · Demo, not for operational use.

Everything sits behind a login. There is one demo account and sign-ups are off; ask the owner for access.

## What it is

The app started as a single-file load control tool. A loadmaster enters a flight's manifest (stops with cargo, post, fast-track and baggage weights), the app places each stop's load into aircraft zones in loading order, checks every zone and combined-zone limit, and prints the load control form. Printing is blocked while anything is over a limit. The operator, aircraft forms, limits and route network are all fictional, and the forms are drawn in SVG by code.

This project added the production pieces around it: a Postgres database with auth, migrations and row-level security; 504 seeded flights with planted patterns; and an AI weekly ops report, run from a button or every Monday by a scheduler, with every AI call logged and capped. The AI never calculates, changes or approves weights, zone placement or limits, and it never touches the print block. Those stay deterministic code.

## Architecture

```
Browser (static site on GitHub Pages)
  ├── supabase-js ──► Supabase Auth (email + password, sign-ups off)
  ├── supabase-js ──► Postgres: flights, stops, allocations, reports (RLS on every table)
  └── fetch ────────► Edge Function: generate-report  ◄── pg_cron, Mondays 11:00 UTC
                          ├── reads SQL views and the week's flights
                          ├── OpenRouter ──► Jev     (per-flight decisions, hybrid mode only)
                          ├── OpenRouter ──► Claude  (writes the report)
                          └── writes reports, ai_calls and flight_ai_labels

Postgres trigger: a flight goes draft → closed
  └── pg_net ───────► Edge Function: flight-alert
                          ├── OpenRouter ──► Jev     (labels that one flight's notes)
                          ├── writes flight_close_labels and ai_calls
                          └── Resend ──► email to the duty manager, when code decides it should
```

What runs where:
- **Browser:** the UI, manifest entry, auto-place, limit checks and the print block. It holds only the Supabase URL and the publishable key.
- **Postgres:** the source of truth. Every figure in the report is computed in SQL views (`v_route_week`, `v_near_limit`, `v_delays`, `v_zone_loads`) or in code from their rows.
- **Edge functions:** the only place the OpenRouter and Resend keys exist. It checks the caller, enforces the caps, calls the models, validates the answer and logs every call.

## The weekly report

A run goes like this:

1. The caller proves who it is: a signed-in user sends their login token; the scheduler sends a secret generated inside the database and kept in Vault.
2. Caps are checked before any AI call: 5 reports per person per day (Toronto time, failed runs included) and $2.00 of total logged spend.
3. The function reads the week's flights and eight weeks of trend data, and code turns them into fixed tables of figures.
4. The models are called (below). Claude is told to copy figures, never compute them, and to treat loadmaster notes as data, never as instructions.
5. The answer is checked: a complete response, all seven section headings in order. A transient failure gets one retry and missing headings get one corrective call, all inside a 135-second deadline.
6. Every call is logged to `ai_calls` with tokens, cost and latency, and the report is saved. A report row is `error` until a complete report is stored, so a half report never looks finished.

**Claude only.** Claude gets the SQL facts and every flight of the week as a compact CSV, picks what matters, and writes the report in one call.

**Claude + Jev (hybrid).** Jev, a classifier on OpenRouter's Decisions API, labels every flight: a category, whether it should be mentioned, and a follow-up urgency. Code then decides which flights Claude reads. A flight is sent if Jev says to mention it, if SQL already flags it, if Jev gave no usable answer, or if Jev was unsure (confidence under 0.7). Claude writes the report from the facts and the sent flights. Each flight's labels and the reason it was or wasn't sent are stored in `flight_ai_labels` and shown on the report. If more than a quarter of the flights get no usable answer, Claude reads every flight instead and the report is marked `fallback`.

The report has seven fixed sections, so runs can be compared: Summary, Volume and freight by route, Flights close to limits, Delays and causes, Handling and safety notes to follow up, Data-quality issues, Suggested follow-ups.

## Same-day alerts

The weekly report is a summary, and a missing DG acceptance checklist on Tuesday shouldn't wait for Monday. When a flight is closed, a database trigger calls the `flight-alert` function with a secret kept in Vault, the same way the weekly schedule calls the report. The trigger fires on every close path, not only the app's button, and a problem with it never stops a flight from closing.

The function asks Jev the same three questions as the hybrid report, about that one flight, and stores the answer in `flight_close_labels`. A flight with no notes isn't sent to Jev. Code then decides whether the duty manager hears about it today:
- Jev labels it `safety_concern`, at any confidence.
- Jev rates follow-up urgency 4 or more of 5 ("follow up within a day"). The threshold comes from the stored M5 labels: routine flights never passed 2.3, weather and freight delays reached 3 to 3.9, and only safety flights reached 4.
- Jev gives no usable answer (it failed, or the spend cap was reached) and the flight has a note. Doubt goes toward alerting.

An alert is emailed through Resend as plain text, built from a template by code, with the notes quoted and a line saying it comes from an AI label. It is also listed in the Alerts card on the Reports page. Emails are capped at 10 per Toronto day; alerts past the cap are still stored. Each flight is labelled once, and one Jev call costs about $0.00003. These labels are what the hybrid report would need to stop calling Jev for a whole week at once.

## Measured results

One run each on the week of 2026-10-19 (63 flights):

| Model and mode | Cost | Time | Planted patterns found |
|---|---|---|---|
| Haiku, Claude only | $0.0023 | 15.0 s | all 5 |
| Haiku, hybrid | $0.0040 | 20.2 s | all 5 |
| Opus, Claude only | $0.0738 | 24.0 s | all 5 |
| Opus, hybrid | $0.0817 | 27.3 s | all 5 |

At this size the hybrid costs more and runs slower. A week is 63 one-line notes, so the flight list is a small part of Claude's prompt, and most of Claude's cost is the report it writes either way. Jev read about 46,000 tokens to save Claude about 500. The hybrid would pay off at volume: thousands of flights a day with long notes, where each flight is labelled once when it closes and the report reads the stored labels.

The models differed on accuracy, not recall. Haiku gave one wrong delay cause; Opus connected rows across days, noticing an aircraft that flew again with a reported fault and no recorded repair. The full comparison is in [`docs/plans/m5-hybrid.md`](docs/plans/m5-hybrid.md). Total logged AI spend for the whole project so far is under $0.20.

## Secrets and safety

- The OpenRouter key exists only as a Supabase edge function secret and in a git-ignored local file. It has its own credit limit at OpenRouter. The Resend key is kept the same way.
- The browser holds only the publishable Supabase key. Row-level security protects the data, and the `service_role` key is never used in browser code.
- The browser can read `reports` and `ai_calls` but never write them, so no one can fake a report or a cost row.
- CORS on the function allows the live origin and the local preview origin. Every call still needs a valid login token or the schedule secret. `flight-alert` accepts only the alert secret, which never leaves the database.
- GitHub secret scanning and push protection are on. History was scanned with gitleaks before the first push.
- Every schema change is a migration file in `supabase/migrations/`.

## Settings

Edge function settings, set with `supabase secrets set`. Defaults are in [`index.ts`](supabase/functions/generate-report/index.ts).

| Setting | Default | What it does |
|---|---|---|
| `OPENROUTER_API_KEY` | (required) | The one secret |
| `CLAUDE_MODEL` | `anthropic/claude-haiku-5.5` | Model that writes the report |
| `CLAUDE_REASONING` | `low` | Reasoning effort; reasoning tokens count against the 8,000-token output cap |
| `CLAUDE_TIMEOUT_MS` | `45000` | Per Claude call |
| `REPORT_DAILY_CAP` | `5` | Reports per person per Toronto day |
| `AI_SPEND_CAP_USD` | `2` | Total logged spend before reports pause |
| `ALLOWED_ORIGINS` | `http://localhost:8411,http://127.0.0.1:8411` | CORS origins, comma-separated; the first answers unknown origins |
| `JEV_MODEL` | `typesafe/jev-1.14` | Pinned so runs stay comparable |
| `JEV_TIMEOUT_MS` | `10000` | Per Jev call; the whole Jev phase ends at 40 s |
| `JEV_CONCURRENCY` | `8` | Jev calls at a time |
| `JEV_CONFIDENCE` | `0.7` | Below this, a flight goes to Claude rather than being dropped |

Same-day alert settings, defaults in [`flight-alert/index.ts`](supabase/functions/flight-alert/index.ts). It shares `OPENROUTER_API_KEY`, `JEV_MODEL`, `JEV_TIMEOUT_MS` and `AI_SPEND_CAP_USD` with the report.

| Setting | Default | What it does |
|---|---|---|
| `RESEND_API_KEY` | (none) | Resend key. Without it, alerts are stored with email `off` |
| `ALERT_TO` | (none) | The duty manager's address. Without it, alerts are stored with email `off` |
| `ALERT_FROM` | `Load Control Lite <onboarding@resend.dev>` | Sender. Resend's shared sender only reaches the Resend account's own address |
| `ALERT_URGENCY` | `4` | Urgency (1–5) at or above which a flight alerts |
| `ALERT_DAILY_CAP` | `10` | Alert emails per Toronto day |
| `ALERT_APP_URL` | `https://loadcontrol.raphaelattar.com/reports.html` | Link in the email |

## Repo layout

- `index.html`, `reports.html`, `css/`, `js/`: the static site. `js/supabase-config.js` holds the public Supabase URL and key.
- `supabase/migrations/`: schema, RLS, views, the AI usage function, the weekly schedule, the labels table, the close trigger and its table.
- `supabase/functions/generate-report/`: the report function. `index.ts` is wiring; the logic is in plain modules with tests beside them.
- `supabase/functions/flight-alert/`: the same-day alert function. It reuses the report function's Jev modules.
- `supabase/tests/`: SQL checks for RLS, caps, the schedule, the labels table and the close trigger.
- `seed/`: the reproducible seed (seed 214, 504 flights, 2026-08-31 to 2026-10-25) and `ground_truth.json`, the planted patterns.
- `scripts/`: the debrand check, a Jev probe, form-config helpers.
- `docs/plans/`: one plan per milestone, each with its review and what actually happened while building it.

## Run it yourself

You need Node 22, the Supabase CLI, a Supabase project and an OpenRouter key.

1. `supabase link` to your project.
2. Edit the function URLs in `supabase/migrations/20261031090000_weekly_schedule.sql` and `20261102090000_flight_close_alert.sql` to your project's. They're hardcoded for this project.
3. `supabase db push`.
4. In the dashboard, create one user (Authentication → Users) and turn sign-ups off. `supabase/config.toml` only configures the local stack.
5. `npm run seed`, then `npm run seed:verify`. The seed needs the user to exist, and it deletes every flight before loading, so run it only against a fresh project.
6. Copy `.env.example` to `supabase/.env.local`, add your OpenRouter key (and a Resend key and `ALERT_TO` for alert emails), and run `supabase secrets set --env-file supabase/.env.local`.
7. `supabase functions deploy generate-report --use-api` and `supabase functions deploy flight-alert --use-api`.
8. Put your project's URL and publishable key in `js/supabase-config.js`.
9. Serve the repo root: `python3 -m http.server 8411`, then open http://localhost:8411.

Tests: `npm test` runs the JavaScript tests (103). The SQL checks run with `supabase db query --linked -f supabase/tests/<file>.sql`.

## Deploy

GitHub Pages serves `main` from the repo root, with `CNAME` naming the custom domain and `.nojekyll` turning off Jekyll. DNS is a DNS-only CNAME from `loadcontrol` to `raphmyster.github.io`. The function's `ALLOWED_ORIGINS` lists the live origin first. The full record is in [`docs/plans/m7-deploy.md`](docs/plans/m7-deploy.md).

## Not built yet

- **The compare view and evals (M6):** side-by-side reports, cost projections, and automatic scoring of each report against `ground_truth.json`. The comparison above was checked by hand.
- **A figures check:** comparing the numbers Claude quotes against the facts it was sent. Today that's an instruction, not an enforced check.
- **Alerts beyond email:** a duty roster instead of one address, Teams or SMS for urgent cases, and a way to mark an alert as seen. The weekly hybrid report doesn't read the stored close labels yet.
- **An alert when a scheduled run fails,** and an admin page for recent calls and errors. The RUNBOOK has the SQL for both.
- **New flights for the schedule.** The seed ends on 2026-10-25, so each Monday's scheduled run finds no flights for the previous week and creates nothing until new flights are entered.

When something goes wrong, see [`RUNBOOK.md`](RUNBOOK.md). For the five-minute demo, see [`DEMO.md`](DEMO.md).
