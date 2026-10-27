# Demo script

A five-minute walkthrough of Load Control Lite and its AI weekly report, written for the interview for the Specialist, AI & Automation role. It works as a tour for anyone else too.

## Before the call (10 minutes)

- **No live Generate on interview day before the call.** Every run counts toward the 5 a day per person, failed ones included, and the demo needs two. Check today's count is 0 with the query in [RUNBOOK section 5](RUNBOOK.md#5-youve-run-5-reports-today-the-daily-limit).
- Check the OpenRouter balance and the key's credit limit.
- Open, each in its own tab:
  - the live site, signed in: https://loadcontrol.raphaelattar.com
  - the repo: https://github.com/raphmyster/load-control-lite
  - the Supabase dashboard on Edge Functions → generate-report → Logs
  - the screenshots in [`docs/screenshots/`](docs/screenshots/), as the fallback
- Have the local preview ready as the backup: `python3 -m http.server 8411` from the repo root. Its origin is allowed by the function.
- Check `curl -sI http://loadcontrol.raphaelattar.com/` redirects to https.

## The five minutes

**0:00–0:45 · The load control app.** Open a closed Dash 8-300 flight (301 on 2026-10-25). Point at the manifest, the zone placement table with its limits, and the form. Say what the app guarantees: printing is blocked while anything is over a limit. *"AI never touches any of this. Weights, placement, limits and the print block stay deterministic code."* ([screenshot](docs/screenshots/01-flights.jpg))

**0:45–2:00 · Claude only.** Reports → week 2026-10-19 → Claude only → Generate. It takes 15–25 seconds. While it runs, walk the pipeline: the login token is checked, then the caps, then SQL computes every figure, then one Claude call, then validation, then every call is logged. When it lands, show a Summary bullet and trace one number back to the database, then the footer: cost, time, tokens, model. ([report](docs/screenshots/02-report-claude-only.jpg), [footer](docs/screenshots/03-report-footer.jpg))

If nothing is back after about 35 seconds, open the existing Claude-only report from History and carry on. The run finishes in the background and still counts.

**2:00–3:15 · Claude + Jev.** Mode → Claude + Jev → Generate. It takes 20–30 seconds, with the same 35-second cut-off. Open "Jev decisions": every flight labelled, which were sent to Claude and why ("Jev: mention", "Flagged by a database check", "Jev unsure"), and which were dropped as routine. Then the honest result: at 63 one-line notes a week, the hybrid costs more and is slower. Jev reads about 46,000 tokens to save Claude about 500, and Claude's cost is mostly the report it writes either way. It pays off at volume, with labels stored when each flight closes. ([labels](docs/screenshots/04-report-hybrid-labels.jpg), [dropped](docs/screenshots/04b-report-hybrid-dropped.jpg))

**3:15–4:15 · Running it safely.** History: both modes, the Scheduled row from the Monday job, the cost of each run. Open the fallback report and its banner: Jev failed, Claude read every flight, and the page says so. Then the caps: 5 runs a person a day and $2.00 in total, checked before any AI call, plus the key's own limit at OpenRouter. ([history](docs/screenshots/06-history.jpg), [fallback](docs/screenshots/05-fallback.jpg))

**4:15–5:00 · The repo.** `supabase/migrations/` (every schema change is a file, with RLS on every table), the tests beside each module, and `docs/plans/`: one plan per milestone, each reviewed before building, each ending with what actually happened.

## If something fails live

| What happens | What to show instead |
|---|---|
| A report comes back as `error` | Open its calls: the attempt and its error are logged, and no half report is shown. This is the validation working. |
| A hybrid run comes back as `fallback` | The banner, then the Jev rows in its calls. The report is still complete. |
| "You've run 5 reports today" | That's the cap doing its job. Open existing reports from History. |
| The run is slow | Open the same week's existing report from History after 35 seconds. |
| The live site won't load | The local preview on port 8411, then the screenshots. |
| Sign-in fails | The screenshots, then [RUNBOOK section 7](RUNBOOK.md#7-sign-in-fails-or-reports-says-sign-in-first) after the call. |

## What it shows, mapped to the role

| The role asks for | Point at |
|---|---|
| Rapid proofs of concept and prototypes | A single-file prototype taken to a deployed, logged-in app with a database, in a short time-box |
| Evaluating AI tools on feasibility, scalability and value | The Claude-only vs hybrid comparison with measured cost and latency, and the call on when the hybrid pays off |
| Integrations between systems and data sources | Browser ↔ Supabase ↔ edge function ↔ OpenRouter (Claude and Jev), plus pg_cron |
| Reliable, governed data foundations | Migrations, RLS on every table, read-only audit tables, seeded data with a known answer key |
| Data-driven insight and decision support | SQL computes the figures; Claude adds judgment over free-text notes |
| Low-code and code-based | A managed platform (Supabase) with TypeScript functions |
| Monitoring, troubleshooting, optimizing | `ai_calls` as the audit trail, caps, fallbacks, the RUNBOOK |
| Documentation and knowledge transfer | README, RUNBOOK, this script, and a plan per milestone |
| Safety management | AI never touches weight and balance or the print block |

## Questions to expect

- **How do you control cost?** Model choice (Haiku at about $0.0025 a report, measured), a cost row per call, caps checked before any call, and the key's own limit. Show the footer and History.
- **Where does the key live?** Only in the edge function's secrets. The browser holds the publishable key, and RLS protects the data. Show `js/supabase-config.js`.
- **What happens when the AI fails?** A report is `error` until it's complete; one retry for transient errors, one corrective call for missing headings, a 135-second deadline. Show an `error` row in History.
- **Why doesn't the model do the math?** Models are unreliable at arithmetic, so SQL and code compute every figure and Claude only copies them. Show a figure in the report and its view.
- **How do you know the report is good?** Planted patterns with an answer key in `seed/ground_truth.json`; every run checked by hand so far found all of them that apply to its week. Automatic scoring is the next step.
- **What's next?** The compare view with automatic scoring (M6), a check that quoted figures match the facts, an alert on failed scheduled runs, and labelling each flight when it closes so the hybrid pays off.
