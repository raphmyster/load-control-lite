# M5: Claude + Jev hybrid report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Reports page gets a second mode, "Claude + Jev". Jev labels every flight of the week, code uses those labels to pick the flights Claude reads, and Claude writes the same seven-section report from the picked flights plus the SQL facts. Each flight's labels are stored and shown on the report. If Jev fails, the run falls back to the Claude-only path and is marked `fallback`.

**Architecture:** `generate-report` takes a `mode` in its body. In hybrid mode, after the reads and the report row, it sends one Jev request per flight through OpenRouter's Decisions API (`POST /api/alpha/decisions`), eight at a time, each with three typed questions: category (Choice), mention (Noul) and urgency (Score). Pure code in `hybrid.js` checks each answer and decides whether the flight goes to Claude. Answers are stored in a new `flight_ai_labels` table, one row per flight per report, and every Jev request is logged to `ai_calls`. Claude then gets the same facts as in Mode A and a CSV of only the picked flights with their labels. If more than a quarter of the flights got no usable answer, Claude gets the full CSV instead and the report is stored as `fallback`. The Claude call, retry, heading check, deadline and caps are M4's code, unchanged.

**Tech Stack:** Supabase Edge Functions (Deno), supabase-js 2.117.3, OpenRouter Decisions API (alpha) with `typesafe/jev-1.14`, OpenRouter chat completions for Claude, Node 22 `node --test`, plain ES modules.

**Decisions made with the user:**
- Jev's per-flight decisions go in a `flight_ai_labels` table (not JSON on the report), so they join to `flights` and M6 can query them across reports.
- Confidence threshold 0.7 (`JEV_CONFIDENCE` overrides it).

**Decided while planning (reviewer: challenge these if wrong):**
- **One request per flight.** The Decisions API judges one `state` per request and takes several named questions about it. The docs show no way to judge several separate flights in one request. A flight's state plus the three questions is about 2 KB, far under the ~32 KB point where Jev switches to its slower long-context mode. Notes are clipped to 2,000 characters and the DG note to 500, so a pasted wall of text can't cross that line. A test checks this.
- **Every flight goes to Jev**, including the 24 or so a week with no notes. The PRD says every flight's notes and key fields, and a no-note flight can still carry a delay or a DG note. At about 450 input tokens a flight, a week costs roughly $0.001 at Jev's ~$0.04 per million input tokens (third-party price page; output is free).
- **Eight requests at a time** (`JEV_CONCURRENCY`, checked against real latency in Task 5), 10 s per request (`JEV_TIMEOUT_MS`), and the whole Jev phase ends 40 s after the request started. Each request's timeout shrinks to the time left in the phase, and none starts with under 2 s left, so the phase can't overrun. A flight not reached by then is marked "no answer". With the 63 seeded flights a week, that's eight rounds, so Jev must average about 5 s a call. A transient failure (timeout, network, 429, 5xx) gets one retry if at least 5 s of the phase remain. A flight still without an answer goes to Claude anyway, which is the safe direction.
- **Which flights Claude reads.** A flight goes to Claude if any of these holds, checked in this order (the first one that holds is stored as the reason):
  1. `jev_mention`: Jev's mention probability is 0.5 or more.
  2. `flagged`: code already flags it (a group limit at 95% or more this week, or a stop that fails the data-quality check). These flights are already in the facts, and Claude needs their row to name them.
  3. `jev_failed`: Jev gave no usable answer.
  4. `low_confidence`: Jev is unsure. That means the category confidence, or the mention certainty (the larger of p and 1 − p), is under the threshold.
  Otherwise it's `jev_routine` and dropped. Urgency confidence doesn't count: an ordered 1–5 scale spreads its probability over neighbouring levels, so its confidence runs low on clear cases and would send nearly every flight to Claude.
- **Fallback threshold:** more than 25% of flights without a usable answer (`tooManyFailed`). That covers a bad key, a 402, Jev being down or the 40 s phase running out. A handful of malformed answers just send those flights to Claude. Two rounds that never start would be 16 of 63 flights and would cross the line, so Task 5 measures latency before the concurrency is fixed.
- **Labels are stored on fallback too**, so the page can show what Jev did answer. On a fallback run the `included` column says what *would* have been sent. The report's `fallback` status and banner say Claude read every flight.
- **Logging:** one `ai_calls` row per Jev request, retries included (`purpose = 'jev_flight_decisions'`), inserted in one batch after the phase. An answer that came back but failed the check is logged with `status = 'error'` and the reason, and its cost is kept. A hybrid run therefore shows about 64 calls next to Mode A's one, and that difference is part of the M6 comparison.
- **Claude's prompt in hybrid mode** is Mode A's prompt plus one rule. FLIGHTS holds only the picked flights, and the labels are hints: Claude bases each point on notes and figures and doesn't quote the labels. That keeps the two modes' reports comparable. The CSV gains four columns: `category, mention_p, urgency, why_sent`. With no labels, the CSV and prompt are byte-for-byte M4's.
- **Urgency** is stored on the 1–5 scale: Jev's Score answer is a probability-weighted index (0 = first level), so urgency = score + 1, rounded to one decimal. Task 5's probe confirms the index base before the code depends on it.
- **Model pinned** to `typesafe/jev-1.14` (`JEV_MODEL`), not `~typesafe/jev-latest`, so runs stay comparable across M6.
- **Scheduled runs stay Claude-only.** The cron job sends `{}`, and `parseRequest` defaults the mode to `claude_only`. Changing that is one line later if wanted.
- A hybrid run counts as one run toward the 5-a-day cap, and its Jev calls count toward the $2.00 spend cap like any other call.

**Expected result, stated up front so M6 can test it:** on one week of 63 flights, hybrid will likely cost a little *more* than Claude-only and take longer. Jev adds about $0.001 and 5–15 s, and Claude saves maybe 1.5k input tokens (about $0.0002 on Haiku). The case for hybrid is per-flight decisions at volume (thousands of flights a day, each labelled once and cheaply), and M6's projection is where that gets measured.

**Who does what:** Claude writes the code, pushes the migration, deploys the function and sets non-secret settings (`JEV_*`). The user runs the one probe command that reads their key from `supabase/.env.local` (Claude never reads that file), signs in to the preview, and says when to commit. The existing `OPENROUTER_API_KEY` works for Jev; no new secret is needed.

**Constraints:**
- The OpenRouter key exists only as an edge function secret and in the git-ignored `supabase/.env.local`. Never in the repo, the browser, a log line, or this chat.
- Every `supabase` command Claude runs ends in `</dev/null`.
- The AI never changes weights, placement, limits or the print block. Jev only reads.
- No original-operator branding: `scripts/check-debrand.sh ../debrand-terms.txt` must still pass.
- Commit only when the user says so.

---

## How a hybrid run works

```
reports.html ── invoke('generate-report', { period_start, mode: 'hybrid' }) ──►
generate-report (index.ts)
  1–5. As M4: CORS, sign-in or cron secret, parseRequest (now with mode), caps, reads.
  6.  Insert reports row: mode 'hybrid', model_claude, model_jev, status 'error'.
  7.  flaggedFlights(): flights with a group limit ≥ 95% this week or a data-quality issue.
  8.  runJev(): for each of the week's flights, 8 at a time, until t0 + 40 s:
        callJev(flightState(f), QUESTIONS, timeout = min(10 s, time left))
          ── POST /api/alpha/decisions ──► Jev   (one retry on a transient failure if ≥ 5 s left)
        readAnswers() checks types and ranges → label, or an error.
  9.  ai_calls ← jevCallRows(results)        (one batch insert, purpose jev_flight_decisions)
      flight_ai_labels ← labelRows(results)  (one row per flight: answers + included + reason)
  10. tooManyFailed(results)?
        yes → fallback: Claude gets Mode A's full CSV and prompt.
        no  → Claude gets only included flights, with category, mention_p, urgency, why_sent.
  11. writeReport(): unchanged M4 pipeline (retry, heading check, 135 s deadline).
  12. Success → status 'ok' (or 'fallback'), content_md, totals over Jev + Claude calls.
      Failure → totals, status stays 'error' → 502.
```

Time budget: no Jev request outlives the 40 s mark, because each one's timeout is cut to the time left. That leaves Claude at least 95 s inside the 135 s deadline: a 45 s call, its retry, and a heading fix still fit, since `writeReport` shrinks call timeouts and won't start one with under 20 s left.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `supabase/migrations/20261101090000_flight_ai_labels.sql` | Create | The labels table, read-only for signed-in users |
| `supabase/tests/labels_check.sql` | Create | Constraints, cascade, and that the browser can read but not write |
| `supabase/functions/generate-report/report-core.js` | Modify | `mode` in `parseRequest`; export `usedStops`, `stopWeight`, `routeOf`, `stopIssues`; labels columns in `flightsCsv`; hybrid rule in `buildMessages` |
| `supabase/functions/generate-report/report-core.test.mjs` | Modify | Tests for the above |
| `supabase/functions/generate-report/jev.js` | Create | One Decisions API call, normalised like `callOpenRouter`. Never throws |
| `supabase/functions/generate-report/jev.test.mjs` | Create | |
| `supabase/functions/generate-report/hybrid.js` | Create | Questions, per-flight state, answer checks, the include rule, the concurrency pool, rows for `ai_calls` and `flight_ai_labels`, the fallback test |
| `supabase/functions/generate-report/hybrid.test.mjs` | Create | |
| `scripts/jev-probe.mjs` | Create | One real Jev call on a sample flight, run by the user, to confirm field names |
| `supabase/functions/generate-report/index.ts` | Modify | Wiring for mode, the Jev phase, labels, fallback, batch call logging |
| `reports.html`, `js/reports.js`, `css/app.css` | Modify | Mode picker, mode column, `fallback` pill, Jev calls summary, labels table |

---

### Task 1: The `flight_ai_labels` table

**Files:**
- Create: `supabase/migrations/20261101090000_flight_ai_labels.sql`
- Create: `supabase/tests/labels_check.sql`

- [ ] **Step 1: Write the check first**

`supabase/tests/labels_check.sql`:

```sql
-- Run: supabase db query --linked -f supabase/tests/labels_check.sql </dev/null
-- Pass: no "FAIL" in the output. Each block rolls back.

-- 1. The service role stores a label, and deleting the report deletes its labels.
begin;
set local role service_role;
do $$
declare rid uuid; fid uuid := (select id from public.flights order by flight_date limit 1); n int;
begin
  insert into public.reports (mode, period_start, period_end, status)
    values ('hybrid', '2026-10-19', '2026-10-25', 'error') returning id into rid;
  insert into public.flight_ai_labels
    (report_id, flight_id, category, category_confidence, mention_p, urgency, urgency_confidence, included, reason)
    values (rid, fid, 'safety_concern', 0.91, 0.97, 4.2, 0.6, true, 'jev_mention');
  select count(*) into n from public.flight_ai_labels where report_id = rid;
  assert n = 1, format('FAIL: expected 1 label, found %s', n);
  delete from public.reports where id = rid;
  select count(*) into n from public.flight_ai_labels where report_id = rid;
  assert n = 0, 'FAIL: labels outlived their report';
end $$;
rollback;

-- 2. Unknown categories and reasons, and urgency outside 1 to 5, are refused.
begin;
set local role service_role;
do $$
declare rid uuid; fid uuid := (select id from public.flights order by flight_date limit 1);
begin
  insert into public.reports (mode, period_start, period_end, status)
    values ('hybrid', '2026-10-19', '2026-10-25', 'error') returning id into rid;
  begin
    insert into public.flight_ai_labels (report_id, flight_id, category, included, reason)
      values (rid, fid, 'weather', true, 'jev_mention');
    raise exception 'FAIL: unknown category accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.flight_ai_labels (report_id, flight_id, included, reason)
      values (rid, fid, true, 'maybe');
    raise exception 'FAIL: unknown reason accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.flight_ai_labels (report_id, flight_id, urgency, included, reason)
      values (rid, fid, 6, true, 'jev_mention');
    raise exception 'FAIL: urgency 6 accepted';
  exception when check_violation then null;
  end;
end $$;
rollback;

-- 3. A signed-in user can read labels (no handler: a missing grant must fail here)...
begin;
set local role authenticated;
select count(*) as labels_visible from public.flight_ai_labels;
rollback;

-- ...but not write them.
begin;
set local role authenticated;
do $$ begin
  insert into public.flight_ai_labels (report_id, flight_id, included, reason)
    values (gen_random_uuid(), gen_random_uuid(), false, 'jev_routine');
  raise exception 'FAIL: authenticated could insert a label';
exception when insufficient_privilege then null;
end $$;
rollback;

-- 4. Anonymous callers can't read them.
begin;
set local role anon;
do $$ begin
  perform 1 from public.flight_ai_labels limit 1;
  raise exception 'FAIL: anon could read labels';
exception when insufficient_privilege then null;
end $$;
rollback;
```

- [ ] **Step 2: Run it and see it fail**

Run: `supabase db query --linked -f supabase/tests/labels_check.sql </dev/null`
Expected: an error that `public.flight_ai_labels` does not exist.

- [ ] **Step 3: Write the migration**

`supabase/migrations/20261101090000_flight_ai_labels.sql`:

```sql
-- Jev's decisions for each flight of a hybrid report (M5), kept so the demo and the M6
-- comparison can show why a flight did or didn't reach Claude. One row per flight per
-- report. Only the edge function (service_role) writes; signed-in users read.

create table public.flight_ai_labels (
  id                  uuid primary key default gen_random_uuid(),
  report_id           uuid not null references public.reports on delete cascade,
  flight_id           uuid not null references public.flights on delete cascade,
  -- Jev's answers; null when it gave no usable answer for this flight
  category            text check (category in ('routine', 'delay_weather', 'delay_freight', 'delay_maintenance',
                                               'handling_issue', 'safety_concern', 'data_quality', 'other')),
  category_confidence numeric(4,3) check (category_confidence between 0 and 1),
  mention_p           numeric(4,3) check (mention_p between 0 and 1),   -- Noul: probability it belongs in the report
  urgency             numeric(2,1) check (urgency between 1 and 5),     -- Score, on the 1-5 scale
  urgency_confidence  numeric(4,3) check (urgency_confidence between 0 and 1),
  -- what code decided from them
  included            boolean not null,
  reason              text not null check (reason in ('jev_mention', 'flagged', 'jev_failed', 'low_confidence', 'jev_routine')),
  error_message       text,
  created_at          timestamptz not null default now(),
  unique (report_id, flight_id)              -- also serves as the report_id index
);
create index flight_ai_labels_flight_idx on public.flight_ai_labels (flight_id);

alter table public.flight_ai_labels enable row level security;
create policy "logged-in users read ai labels" on public.flight_ai_labels for select to authenticated using (true);

revoke all on public.flight_ai_labels from anon, authenticated;
grant select on public.flight_ai_labels to authenticated;
grant all    on public.flight_ai_labels to service_role;
```

- [ ] **Step 4: Push and run the checks**

```bash
supabase db push --linked </dev/null
supabase db query --linked -f supabase/tests/labels_check.sql </dev/null
supabase db query --linked -f supabase/tests/rls_check.sql </dev/null
supabase db query --linked -f supabase/tests/ai_usage_check.sql </dev/null
```

Expected: no `FAIL` or `rror` in any output. Then run the advisors (`supabase db advisors --linked </dev/null`, or the dashboard if the CLI lacks it). Expect only the accepted leaked-password warning, and no unindexed foreign key on the new table.

---

### Task 2: Report-core changes (mode, shared stop helpers, labelled CSV, hybrid rule)

**Files:**
- Modify: `supabase/functions/generate-report/report-core.js`
- Modify: `supabase/functions/generate-report/report-core.test.mjs`

- [ ] **Step 1: Write the failing tests**

In `report-core.test.mjs`, add `stopIssues, routeOf` to the import list. Replace the existing first `parseRequest` test with the one below (don't add a second copy), then append the other new tests:

```js
test('parseRequest accepts a Monday and works out the week and the 8-week window', () => {
  assert.deepEqual(period, { start: '2026-10-19', end: '2026-10-25', trendStart: '2026-08-31', mode: 'claude_only' });
});

test('parseRequest takes a mode, claude_only by default, and refuses others', () => {
  assert.equal(parseRequest({ period_start: '2026-10-19', mode: 'hybrid' }).mode, 'hybrid');
  assert.equal(parseRequest({ period_start: '2026-10-19', mode: 'claude_only' }).mode, 'claude_only');
  assert.match(parseRequest({ period_start: '2026-10-19', mode: 'jev' }).error, /mode/);
});

test('stopIssues and routeOf: the per-flight pieces behind dataQuality and the CSV', () => {
  const f = fl('2026-09-17', '512', [stop(0, 'YOW', 300), stop(1, '', 140), stop(2, '', 0)]);
  assert.deepEqual(stopIssues(f), ['stop 2 has 140 lb and no destination']);
  assert.equal(routeOf(f), 'YOW-?');
});

test('flightsCsv with labels adds category, mention_p, urgency and why_sent', () => {
  const f = fl('2026-10-22', '512', [stop(0, 'YOW', 900)], { notes: 'Strap damaged' });
  const labels = new Map([[f.id, { category: 'handling_issue', mention_p: 0.96, urgency: 3.8, reason: 'jev_mention' }]]);
  const csv = flightsCsv([f], [], labels).split('\n');
  assert.match(csv[0], /,notes,category,mention_p,urgency,why_sent$/);
  assert.match(csv[1], /,Strap damaged,handling_issue,0\.96,3\.8,jev_mention$/);
});

test('flightsCsv with a failed label leaves the label cells empty', () => {
  const f = fl('2026-10-22', '512', [stop(0, 'YOW', 900)]);
  const labels = new Map([[f.id, { category: null, mention_p: null, urgency: null, reason: 'jev_failed' }]]);
  assert.match(flightsCsv([f], [], labels).split('\n')[1], /,,,,jev_failed$/);
});

test('buildMessages: hybrid adds one rule and renames FLIGHTS; Mode A is unchanged', () => {
  const plain = buildMessages({ facts: 'F', csv: 'C' });
  const again = buildMessages({ facts: 'F', csv: 'C', hybrid: false });
  assert.deepEqual(plain, again);
  const [sys, user] = buildMessages({ facts: 'F', csv: 'C', hybrid: true });
  assert.ok(sys.content.startsWith(plain[0].content));
  assert.match(sys.content, /only the flights picked/);
  assert.match(sys.content, /don't quote the labels/);
  assert.match(user.content, /FLIGHTS \(CSV, only the flights picked for this report/);
});
```

The existing `fl()` fixture already sets `id: \`${flight_date}-${flight_no}\``, which the label tests rely on.

- [ ] **Step 2: Run and see them fail**

Run: `node --test supabase/functions/generate-report/report-core.test.mjs`
Expected: FAIL on the `mode` property, missing `stopIssues`/`routeOf` exports, missing label columns and the missing hybrid rule.

- [ ] **Step 3: Implement**

In `report-core.js`:

1. Export the stop helpers and add `routeOf`:

```js
export const stopWeight = s => num(s.cargo_lb) + num(s.post_lb) + num(s.fast_lb) + num(s.bag_lb);
const stopsOf = f => [...(f.flight_stops ?? [])].sort((a, b) => a.seq - b.seq);
// the same filter as the views: a stop counts if it has a destination or any weight
export const usedStops = f => stopsOf(f).filter(s => (s.dest ?? '').trim() !== '' || stopWeight(s) > 0);
export const routeOf = f => usedStops(f).map(s => (s.dest ?? '').trim() || '?').join('-');
```

2. `parseRequest` takes a mode:

```js
const MODES = ['claude_only', 'hybrid'];

// Body: { period_start: 'YYYY-MM-DD', mode? }. period_start is a Monday; weeks run Monday
// to Sunday, as in v_route_week. mode defaults to claude_only (the scheduled run sends none).
export function parseRequest(body) {
  const start = body?.period_start;
  if (!isDate(start)) return { error: 'period_start must be a date (YYYY-MM-DD)' };
  if (new Date(start + 'T00:00:00Z').getUTCDay() !== 1) return { error: 'period_start must be a Monday' };
  const mode = body?.mode ?? 'claude_only';
  if (!MODES.includes(mode)) return { error: "mode must be 'claude_only' or 'hybrid'" };
  return { start, end: addDays(start, 6), trendStart: addDays(start, -49), mode };
}
```

3. Split `dataQuality` so hybrid can flag flights by id with the same rules:

```js
// One flight's stop problems: weight with no destination, or a destination that isn't three capital letters.
export function stopIssues(f) {
  const issues = [];
  for (const s of stopsOf(f)) {
    const dest = (s.dest ?? '').trim(), w = stopWeight(s);
    if (!dest && w > 0) issues.push(`stop ${s.seq + 1} has ${lb(w)} lb and no destination`);
    else if (dest && !/^[A-Z]{3}$/.test(dest)) issues.push(`stop ${s.seq + 1} has destination "${dest}", not a 3-letter airport code`);
  }
  return issues;
}

export const dataQuality = flights => flights.flatMap(f => stopIssues(f).map(i => `${f.flight_no} on ${f.flight_date}: ${i}`));
```

4. `flightsCsv` takes optional labels (a `Map` of flight id → label row) and uses `routeOf`:

```js
export function flightsCsv(flights, groups, labels = null) {
  const near = new Map();
  for (const r of groups) near.set(r.flight_id, [...new Set([...(near.get(r.flight_id) ?? []), r.label])]);
  const head = 'date,flight,route,registration,form,cargo_lb,post_lb,fast_lb,bag_lb,group_limits_at_95pct,delay_min,status,dg_note,notes';
  const lines = [labels ? `${head},category,mention_p,urgency,why_sent` : head];
  for (const f of [...flights].sort(byDateEtd)) {
    const stops = usedStops(f), sumOf = k => lb(stops.reduce((t, s) => t + num(s[k]), 0));
    const row = [
      f.flight_date, f.flight_no, routeOf(f), f.registration, f.form_id,
      sumOf('cargo_lb'), sumOf('post_lb'), sumOf('fast_lb'), sumOf('bag_lb'),
      (near.get(f.id) ?? []).join('; '), f.delay_minutes ?? '', f.status, f.dg_note, f.notes,
    ];
    if (labels) { const l = labels.get(f.id) ?? {}; row.push(l.category, l.mention_p, l.urgency, l.reason); }
    lines.push(row.map(cell).join(','));
  }
  return lines.join('\n');
}
```

(`cell` already turns `null`/`undefined` into an empty string.)

5. `buildMessages` takes `hybrid`:

```js
const HYBRID_RULE = `
- FLIGHTS holds only the flights picked for this report; a classifier judged the other flights of the week routine. Its columns category, mention_p (chance the flight belongs in the report), urgency (1 to 5) and why_sent are hints: base each point on the notes and figures, and don't quote the labels.`;

export function buildMessages({ facts, csv, hybrid = false }) {
  const flights = hybrid
    ? 'FLIGHTS (CSV, only the flights picked for this report, with the classifier\'s labels)'
    : 'FLIGHTS (CSV, one row per flight this week)';
  return [
    { role: 'system', content: hybrid ? SYSTEM + HYBRID_RULE : SYSTEM },
    { role: 'user', content: `FACTS\n${facts}\n\n${flights}\n${csv}` },
  ];
}
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: all pass. The M4 `dataQuality`, `flightsCsv` and `buildMessages` tests must pass unchanged, apart from the `parseRequest` expectation above.

---

### Task 3: One Jev call (`jev.js`)

**Files:**
- Create: `supabase/functions/generate-report/jev.js`
- Create: `supabase/functions/generate-report/jev.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callJev } from './jev.js';

const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });
const Q = { mention: { type: 'noul', instructions: 'Mention?', criteria: { true: 'yes', false: 'no' } } };
const call = fetchFn => callJev({ apiKey: 'k', model: 'typesafe/jev-1.14', state: { flight: '512' }, questions: Q, fetchFn });
const ANSWERS = { mention: { type: 'noul', noul: 0.93 } };

test('a good answer comes back with answers, tokens, cost and the model that answered', async () => {
  const r = await call(reply(200, { id: 'd1', model: 'typesafe/jev-1.14-20261001', answers: ANSWERS,
    usage: { input_tokens: 410, output_tokens: 3, cost: 0.0000172 } }));
  assert.equal(r.ok, true); assert.equal(r.status, 'ok'); assert.deepEqual(r.answers, ANSWERS);
  assert.equal(r.input_tokens, 410); assert.equal(r.output_tokens, 3); assert.equal(r.cost_usd, 0.0000172);
  assert.equal(r.cost_reported, true); assert.equal(r.model, 'typesafe/jev-1.14-20261001'); assert.ok(r.latency_ms >= 0);
});

test('the request goes to the Decisions endpoint with model, state and questions', async () => {
  let seen;
  await call(async (url, init) => { seen = { url, init }; return new Response('{}', { status: 500 }); });
  assert.equal(seen.url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(seen.init.body), { model: 'typesafe/jev-1.14', state: { flight: '512' }, questions: Q });
  assert.ok(seen.init.signal);
});

test('402 (no credit) is an error that a retry will not fix', async () => {
  const r = await call(reply(402, { error: { code: 402, message: 'Insufficient credits' } }));
  assert.equal(r.ok, false); assert.equal(r.transient, false); assert.match(r.error, /^Jev 402: Insufficient credits/);
});

test('429 and 5xx are transient', async () => {
  for (const s of [429, 503, 529]) assert.equal((await call(reply(s, { error: { code: s, message: 'x' } }))).transient, true, String(s));
});

test('a timeout is reported as a timeout and never throws', async () => {
  const r = await call(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
  assert.equal(r.ok, false); assert.equal(r.status, 'timeout'); assert.match(r.error, /No answer within 10 s/);
});

test('a network failure is an error and never throws', async () => {
  const r = await call(async () => { throw new TypeError('fetch failed'); });
  assert.equal(r.status, 'error'); assert.equal(r.error, 'Could not reach OpenRouter');
});

test('a 200 without answers is an error, with its cost still counted', async () => {
  const r = await call(reply(200, { model: 'm', usage: { input_tokens: 400, output_tokens: 0, cost: 0.00002 } }));
  assert.equal(r.ok, false); assert.equal(r.error, 'No answers in the response'); assert.equal(r.cost_usd, 0.00002);
});

test('missing cost is flagged so the spend cap is not silently fed zeros', async () => {
  const r = await call(reply(200, { model: 'm', answers: ANSWERS, usage: { input_tokens: 400, output_tokens: 0 } }));
  assert.equal(r.ok, true); assert.equal(r.cost_usd, 0); assert.equal(r.cost_reported, false);
});
```

- [ ] **Step 2: Run and see them fail**

Run: `node --test supabase/functions/generate-report/jev.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
/* One Jev decision through OpenRouter's Decisions API, normalised like callOpenRouter so
   the same logging and totals work. Never throws.
   Result: { ok, status: 'ok'|'error'|'timeout', transient, answers, error, model,
             input_tokens, output_tokens, cost_usd, cost_reported, latency_ms }.
   Jev answers typed questions with probabilities instead of text, and bills input tokens
   only. The endpoint is alpha, so the answers are checked in hybrid.js before use. */
const URL = 'https://openrouter.ai/api/alpha/decisions';

export async function callJev({ apiKey, model, state, questions, timeoutMs = 10000, fetchFn = fetch }) {
  const t0 = Date.now();
  const base = { model, answers: null, error: null, input_tokens: 0, output_tokens: 0, cost_usd: 0, cost_reported: false };
  let res;
  try {
    res = await fetchFn(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Load Control Lite' },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ...base, ok: false, status: timeout ? 'timeout' : 'error', transient: true,
      error: timeout ? `No answer within ${timeoutMs / 1000} s` : 'Could not reach OpenRouter', latency_ms: Date.now() - t0 };
  }
  let body = null;
  try { body = await res.json(); } catch { /* empty or cut-off body: handled below */ }
  const u = body?.usage ?? {};
  const out = { ...base, model: body?.model ?? model, input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0,
    cost_usd: Number(u.cost ?? 0), cost_reported: u.cost != null, latency_ms: Date.now() - t0 };
  if (!res.ok || body?.error) {
    const msg = String(body?.error?.message ?? 'request failed').slice(0, 300);
    return { ...out, ok: false, status: 'error', transient: res.status === 429 || res.status >= 500, error: `Jev ${res.status}: ${msg}` };
  }
  if (!body?.answers || typeof body.answers !== 'object') {
    return { ...out, ok: false, status: 'error', transient: true, error: 'No answers in the response' };
  }
  return { ...out, ok: true, status: 'ok', transient: false, answers: body.answers };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test supabase/functions/generate-report/jev.test.mjs`
Expected: 8 pass.

---

### Task 4: Hybrid logic (`hybrid.js`)

**Files:**
- Create: `supabase/functions/generate-report/hybrid.js`
- Create: `supabase/functions/generate-report/hybrid.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, QUESTIONS, flightState, readAnswers, decide, flaggedFlights, runJev, labelRows, jevCallRows, tooManyFailed,
} from './hybrid.js';

const stop = (seq, dest, cargo = 0) => ({ seq, dest, cargo_lb: cargo, post_lb: 0, fast_lb: 0, bag_lb: 0 });
const fl = (id, extra = {}) => ({ id, flight_date: '2026-10-22', flight_no: '512', registration: 'C-GNBA', form_id: 'DH8300',
  delay_minutes: null, dg_note: '', notes: '', status: 'closed', flight_stops: [stop(0, 'YOW', 900)], ...extra });
const ANSWERS = {
  category: { type: 'choice', choice: 'handling_issue', confidence: 0.88, probabilities: {} },
  mention: { type: 'noul', noul: 0.94 },
  urgency: { type: 'score', score: 2.4, confidence: 0.51, probabilities: {}, legend: {} },
};
const LABEL = { category: 'handling_issue', category_confidence: 0.88, mention_p: 0.94, urgency: 3.4, urgency_confidence: 0.51 };

test('QUESTIONS: category is a Choice over the PRD categories, mention a Noul, urgency a 5-level Score', () => {
  assert.equal(QUESTIONS.category.type, 'choice');
  assert.deepEqual(Object.keys(QUESTIONS.category.criteria), CATEGORIES);
  assert.deepEqual(CATEGORIES, ['routine', 'delay_weather', 'delay_freight', 'delay_maintenance', 'handling_issue', 'safety_concern', 'data_quality', 'other']);
  assert.equal(QUESTIONS.mention.type, 'noul');
  assert.deepEqual(Object.keys(QUESTIONS.mention.criteria).sort(), ['false', 'true']);
  assert.equal(QUESTIONS.urgency.type, 'score');
  assert.equal(QUESTIONS.urgency.criteria.length, 5);
});

test('flightState: the fields Jev judges, with the route from the stops', () => {
  const s = flightState(fl('a', { delay_minutes: 45, dg_note: 'UN1845 dry ice', notes: 'Strap damaged' }));
  assert.deepEqual(s, { flight: '512', date: '2026-10-22', route: 'YOW', aircraft_form: 'DH8300', freight_lb: 900,
    delay_min: 45, dg_note: 'UN1845 dry ice', loadmaster_note: 'Strap damaged' });
});

test('flightState keeps a request under 32 KB even with a huge note', () => {
  const s = flightState(fl('a', { notes: 'x'.repeat(50000), dg_note: 'y'.repeat(50000) }));
  assert.ok(s.loadmaster_note.length <= 2000 && s.dg_note.length <= 500);
  const bytes = new TextEncoder().encode(JSON.stringify({ model: 'typesafe/jev-1.14', state: s, questions: QUESTIONS })).length;
  assert.ok(bytes < 32000, `${bytes} bytes`);
});

test('readAnswers turns a good answer into a label, urgency on the 1-5 scale', () => {
  assert.deepEqual(readAnswers(ANSWERS), { label: LABEL });
});

test('readAnswers refuses unknown categories, out-of-range numbers and missing answers', () => {
  const bad = [
    { ...ANSWERS, category: { ...ANSWERS.category, choice: 'weather' } },
    { ...ANSWERS, category: { ...ANSWERS.category, confidence: 1.2 } },
    { ...ANSWERS, mention: { type: 'noul', noul: '0.9' } },
    { ...ANSWERS, urgency: { ...ANSWERS.urgency, score: 4.5 } },
    { ...ANSWERS, urgency: undefined },
    null,
  ];
  for (const a of bad) assert.ok(readAnswers(a).error, JSON.stringify(a));
});

test('decide: Jev says mention, flagged, no answer, unsure, routine', () => {
  const t = 0.7;
  assert.deepEqual(decide(LABEL, false, t), { included: true, reason: 'jev_mention' });
  assert.deepEqual(decide({ ...LABEL, mention_p: 0.05 }, true, t), { included: true, reason: 'flagged' });
  assert.deepEqual(decide(null, false, t), { included: true, reason: 'jev_failed' });
  assert.deepEqual(decide({ ...LABEL, mention_p: 0.35 }, false, t), { included: true, reason: 'low_confidence' });       // certainty 0.65
  assert.deepEqual(decide({ ...LABEL, mention_p: 0.05, category_confidence: 0.6 }, false, t), { included: true, reason: 'low_confidence' });
  assert.deepEqual(decide({ ...LABEL, mention_p: 0.05, urgency_confidence: 0.2 }, false, t), { included: false, reason: 'jev_routine' });
});

test('flaggedFlights: a group limit at 95% this week, or a stop that fails the data-quality check', () => {
  const flights = [fl('a'), fl('b', { flight_stops: [stop(0, '', 140)] }), fl('c')];
  const ids = flaggedFlights(flights, [{ flight_id: 'c', label: 'Zone 2' }]);
  assert.deepEqual([...ids].sort(), ['b', 'c']);
});

test('runJev keeps at most N requests in flight and returns results in flight order', async () => {
  let live = 0, peak = 0;
  const flights = Array.from({ length: 20 }, (_, i) => fl(`f${i}`));
  const results = await runJev({ flights, concurrency: 4, ask: async f => {
    live++; peak = Math.max(peak, live);
    await new Promise(r => setTimeout(r, 5));
    live--;
    return { ok: true, status: 'ok', answers: ANSWERS, model: 'jev', cost_usd: 0.00002 };
  } });
  assert.equal(peak, 4);
  assert.deepEqual(results.map(r => r.flight.id), flights.map(f => f.id));
  assert.ok(results.every(r => r.label && !r.error));
});

test('runJev: a failed call and a malformed answer both leave the flight without a label', async () => {
  const replies = [{ ok: false, status: 'error', transient: false, error: 'Jev 402: no credit' }, { ok: true, status: 'ok', answers: { mention: 1 } }];
  const results = await runJev({ flights: [fl('a'), fl('b')], concurrency: 1, ask: async () => replies.shift() });
  assert.equal(results[0].label, null); assert.equal(results[0].error, 'Jev 402: no credit'); assert.equal(results[0].calls.length, 1);
  assert.equal(results[1].label, null); assert.match(results[1].error, /malformed/);
});

test('runJev retries a transient failure once while time is left', async () => {
  const replies = [{ ok: false, status: 'timeout', transient: true, error: 'No answer within 10 s' }, { ok: true, status: 'ok', answers: ANSWERS }];
  const [r] = await runJev({ flights: [fl('a')], ask: async () => replies.shift() });
  assert.equal(r.calls.length, 2); assert.deepEqual(r.label, LABEL);
});

test('runJev passes the time left, and starts nothing with under 2 s to go', async () => {
  let t = 0;
  const given = [];
  const results = await runJev({ flights: [fl('a'), fl('b'), fl('c')], concurrency: 1, deadline: 5000, now: () => t,
    ask: async (f, ms) => { given.push(ms); t += 2000; return { ok: true, status: 'ok', answers: ANSWERS }; } });
  assert.deepEqual(given, [5000, 3000]);
  assert.deepEqual(results[2].calls, []); assert.match(results[2].error, /ran out of time/);
});

test('runJev skips the retry when under 5 s would be left', async () => {
  let t = 0;
  const [r] = await runJev({ flights: [fl('a')], deadline: 6000, now: () => t,
    ask: async () => { t += 2000; return { ok: false, status: 'timeout', transient: true, error: 'slow' }; } });
  assert.equal(r.calls.length, 1); assert.equal(r.label, null);
});

test('labelRows: one row per flight with rounded answers and the decision', () => {
  const results = [
    { flight: fl('a'), calls: [{}], label: { ...LABEL, mention_p: 0.94444 }, error: null },
    { flight: fl('b'), calls: [], label: null, error: 'Jev ran out of time before this flight' },
  ];
  const rows = labelRows('r1', results, new Set(), 0.7);
  assert.deepEqual(rows[0], { report_id: 'r1', flight_id: 'a', category: 'handling_issue', category_confidence: 0.88,
    mention_p: 0.944, urgency: 3.4, urgency_confidence: 0.51, included: true, reason: 'jev_mention', error_message: null });
  assert.deepEqual(rows[1], { report_id: 'r1', flight_id: 'b', category: null, category_confidence: null,
    mention_p: null, urgency: null, urgency_confidence: null, included: true, reason: 'jev_failed',
    error_message: 'Jev ran out of time before this flight' });
});

test('jevCallRows: one per attempt, a malformed answer logged as an error with its cost', () => {
  const ok = { ok: true, status: 'ok', model: 'jev', cost_usd: 0.00002, error: null };
  const slow = { ...ok, ok: false, status: 'timeout', cost_usd: 0, error: 'No answer within 10 s' };
  const rows = jevCallRows([
    { flight: fl('a'), calls: [ok], label: LABEL, error: null },
    { flight: fl('b'), calls: [ok], label: null, error: 'mention answer is malformed' },
    { flight: fl('c'), calls: [slow, ok], label: LABEL, error: null },
    { flight: fl('d'), calls: [], label: null, error: 'Jev ran out of time before this flight' },
  ]);
  assert.equal(rows.length, 4);
  assert.ok(rows.every(r => r.purpose === 'jev_flight_decisions'));
  assert.deepEqual(rows.map(r => r.status), ['ok', 'error', 'timeout', 'ok']);
  assert.equal(rows[1].error, 'mention answer is malformed'); assert.equal(rows[1].cost_usd, 0.00002);
  assert.equal(rows[2].error, 'No answer within 10 s');
});

test('tooManyFailed: more than a quarter of flights without a label', () => {
  const res = n => Array.from({ length: 63 }, (_, i) => ({ label: i < n ? null : LABEL }));
  assert.equal(tooManyFailed(res(15)), false);
  assert.equal(tooManyFailed(res(16)), true);
  assert.equal(tooManyFailed([]), false);
});
```

- [ ] **Step 2: Run and see them fail**

Run: `node --test supabase/functions/generate-report/hybrid.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
/* Mode B (hybrid): Jev labels every flight of the week, code decides which flights Claude
   reads, and Claude writes the report from those plus the same SQL facts as Mode A.
   Pure apart from the injected `ask`, so `node --test` covers all of it. */
import { stopWeight, usedStops, routeOf, stopIssues } from './report-core.js';

export const CATEGORIES = ['routine', 'delay_weather', 'delay_freight', 'delay_maintenance',
  'handling_issue', 'safety_concern', 'data_quality', 'other'];

// The three typed questions every flight gets. Keys are the answer names Jev sends back.
export const QUESTIONS = {
  category: {
    type: 'choice',
    instructions: "Which category best fits this flight's loadmaster note and DG note?",
    criteria: {
      routine: 'Normal operation; nothing the ops manager needs to know',
      delay_weather: 'A delay caused by weather or de-icing',
      delay_freight: 'A delay or problem caused by freight arriving late or not being ready',
      delay_maintenance: 'A delay caused by a technical or maintenance issue with the aircraft',
      handling_issue: 'Damaged equipment, wrong loading, or another ground-handling problem',
      safety_concern: 'A safety or dangerous-goods concern, such as missing DG paperwork',
      data_quality: 'The flight record itself looks wrong or incomplete',
      other: 'Notable, but none of the above',
    },
  },
  mention: {
    type: 'noul',
    instructions: 'Should this flight be mentioned in the weekly operations report for the load control team?',
    criteria: {
      true: 'Yes: a delay with a stated cause, a handling or safety issue, a problem likely to recur, or a record error',
      false: 'No: a routine flight with nothing the ops manager needs to see',
    },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgently does someone need to follow up on this flight?',
    criteria: [
      'No follow-up needed',
      'Worth knowing, no action',
      'Follow up this week',
      'Follow up within a day',
      'Act now: a safety risk',
    ],
  },
};

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// What Jev sees for one flight. Notes are clipped so a pasted wall of text can't push a
// request past ~32 KB, where Jev switches to its slower, less accurate long-context mode.
export function flightState(f) {
  return {
    flight: f.flight_no,
    date: f.flight_date,
    route: routeOf(f),
    aircraft_form: f.form_id,
    freight_lb: Math.round(usedStops(f).reduce((t, s) => t + stopWeight(s), 0)),
    delay_min: f.delay_minutes ?? 0,
    dg_note: clip(f.dg_note, 500),
    loadmaster_note: clip(f.notes, 2000),
  };
}

const prob = v => typeof v === 'number' && v >= 0 && v <= 1;

// Jev's answers → { label } or { error }. The endpoint is alpha, so nothing is trusted
// unchecked. Score is a probability-weighted index into the 5 levels (0 = first), stored as 1-5.
export function readAnswers(a) {
  const c = a?.category, m = a?.mention, u = a?.urgency;
  if (c?.type !== 'choice' || !CATEGORIES.includes(c.choice) || !prob(c.confidence)) return { error: 'category answer is malformed' };
  if (m?.type !== 'noul' || !prob(m.noul)) return { error: 'mention answer is malformed' };
  if (u?.type !== 'score' || typeof u.score !== 'number' || u.score < 0 || u.score > 4 || !prob(u.confidence)) return { error: 'urgency answer is malformed' };
  return { label: { category: c.choice, category_confidence: c.confidence, mention_p: m.noul,
    urgency: Math.round((u.score + 1) * 10) / 10, urgency_confidence: u.confidence } };
}

// Whether a flight goes to Claude, and why. Doubt always resolves toward sending it:
// a flight Claude didn't need costs a few tokens, a dropped safety note costs much more.
// Urgency confidence is left out: an ordered scale spreads probability over neighbouring
// levels, so it runs low even on clear cases.
export function decide(label, flagged, threshold) {
  if (label && label.mention_p >= 0.5) return { included: true, reason: 'jev_mention' };
  if (flagged) return { included: true, reason: 'flagged' };
  if (!label) return { included: true, reason: 'jev_failed' };
  const sure = Math.min(label.category_confidence, Math.max(label.mention_p, 1 - label.mention_p));
  if (sure < threshold) return { included: true, reason: 'low_confidence' };
  return { included: false, reason: 'jev_routine' };
}

// Flights code already flags: a group limit at 95% or more this week (weekGroups are this
// week's v_near_limit group rows), or a stop that fails the data-quality check.
export function flaggedFlights(flights, weekGroups) {
  const ids = new Set(weekGroups.map(r => r.flight_id));
  for (const f of flights) if (stopIssues(f).length) ids.add(f.id);
  return ids;
}

const MIN_JEV_MS = 2000;   // don't start a request with less time than this left
const RETRY_JEV_MS = 5000; // retry a transient failure only with at least this much left

// Asks Jev about every flight, `concurrency` at a time, and never past the deadline:
// ask(flight, msLeft) must cap its timeout at msLeft. Never throws (ask never does).
// Result per flight, in flight order: { flight, calls, label, error }; calls holds every
// attempt (empty when the deadline passed before the flight's turn).
export async function runJev({ flights, ask, concurrency = 8, deadline = Infinity, now = Date.now }) {
  const results = new Array(flights.length);
  const left = () => deadline - now();
  let next = 0;
  async function worker() {
    while (next < flights.length) {
      const i = next++, flight = flights[i];
      if (left() < MIN_JEV_MS) { results[i] = { flight, calls: [], label: null, error: 'Jev ran out of time before this flight' }; continue; }
      const calls = [await ask(flight, left())];
      if (!calls[0].ok && calls[0].transient && left() >= RETRY_JEV_MS) calls.push(await ask(flight, left()));
      const last = calls.at(-1);
      if (!last.ok) { results[i] = { flight, calls, label: null, error: last.error }; continue; }
      const read = readAnswers(last.answers);
      results[i] = { flight, calls, label: read.label ?? null, error: read.error ?? null };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, flights.length) }, worker));
  return results;
}

const r3 = v => v == null ? null : Math.round(v * 1000) / 1000;

// Rows for flight_ai_labels: Jev's answers (null without one) and the decision.
export function labelRows(reportId, results, flagged, threshold) {
  return results.map(({ flight, label, error }) => ({
    report_id: reportId, flight_id: flight.id,
    category: label?.category ?? null, category_confidence: r3(label?.category_confidence),
    mention_p: r3(label?.mention_p), urgency: label?.urgency ?? null, urgency_confidence: r3(label?.urgency_confidence),
    ...decide(label, flagged.has(flight.id), threshold),
    error_message: error,
  }));
}

// Calls for ai_calls, in callOpenRouter's shape, one per attempt. An answer that came back
// but failed the check is an error; its cost is real and stays.
export const jevCallRows = results => results.flatMap(({ calls, label, error }) => calls.map((call, i) => {
  const last = i === calls.length - 1;
  return { ...call, purpose: 'jev_flight_decisions',
    status: last && call.ok && !label ? 'error' : call.status,
    error: last ? error : call.error };
}));

// Fall back to Mode A when more than a quarter of flights got no usable answer.
export const tooManyFailed = (results, maxShare = 0.25) => results.filter(r => !r.label).length > results.length * maxShare;
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: all pass (58 from before plus the new ones).

---

### Task 5: Probe the real API (user runs it)

The Decisions API is alpha, and its reference doesn't show a full example answer for Choice, Noul or Score. Before the edge function depends on those answers, one real call confirms them.

**Files:**
- Create: `scripts/jev-probe.mjs`

- [ ] **Step 1: Write the probe**

```js
/* Sends a sample flight to Jev 8 times in parallel and prints the first answer in full,
   then each call's status and latency. That confirms the Decisions API's answer fields
   before generate-report depends on them, and shows whether 8 at a time is fast enough
   and free of 429s. Costs well under a cent.
   Run from the repo root (the key stays in the git-ignored env file; nothing prints it):
     set -a; . supabase/.env.local; set +a; node scripts/jev-probe.mjs */
import { callJev } from '../supabase/functions/generate-report/jev.js';
import { QUESTIONS, flightState, readAnswers } from '../supabase/functions/generate-report/hybrid.js';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) { console.error('OPENROUTER_API_KEY is not set in this shell.'); process.exit(1); }

const flight = {
  flight_no: '512', flight_date: '2026-10-22', form_id: 'DH8300', delay_minutes: 0,
  dg_note: '', notes: 'Cargo strap damaged at ramp, replaced before departure. Report filed.',
  flight_stops: [{ seq: 0, dest: 'YOW', cargo_lb: 900, post_lb: 120, fast_lb: 0, bag_lb: 640 }],
};
const model = process.env.JEV_MODEL ?? 'typesafe/jev-1.14';
const all = await Promise.all(Array.from({ length: 8 }, () => callJev({ apiKey, model, state: flightState(flight), questions: QUESTIONS })));
const { answers, ...meta } = all[0];
console.log(JSON.stringify(meta, null, 2));
console.log(JSON.stringify(answers, null, 2));
console.log('readAnswers:', JSON.stringify(all[0].ok ? readAnswers(answers) : null));
const ms = all.map(r => r.latency_ms).sort((a, b) => a - b);
console.log('8 parallel calls:', all.map(r => `${r.status}${r.error ? ` (${r.error})` : ''}`).join(', '));
console.log(`latency ms: min ${ms[0]}, median ${ms[4]}, max ${ms[7]}`);
```

- [ ] **Step 2: The user runs it**

Ask the user to run, from `load-control-lite/`:

```bash
set -a; . supabase/.env.local; set +a; node scripts/jev-probe.mjs
```

and paste the output. Expected: `ok: true` on all eight and a cost under $0.0001 each. For a damaged strap, the category should be `handling_issue` with mention probability above 0.5, and `readAnswers:` should show a `label`.

- [ ] **Step 3: Reconcile**

Compare the output with what `readAnswers` expects:
- If `score` comes back 1-based (between 1 and 5), change `readAnswers` to `urgency: Math.round(u.score * 10) / 10` with bounds 1–5, and update the two tests that assume 0-based.
- If any field name differs (`noul`, `choice`, `confidence`, `score`), fix `readAnswers` and its tests to match the real answer, and note it in "Added during execution".
- If `usage.cost` is missing, keep the code (it already flags `cost_reported: false`) and note it, because the spend cap would then undercount Jev.
- Set the concurrency from the latency line. The 63 flights take ceil(63 / concurrency) rounds, and that times the median latency must stay under 30 s, leaving room inside the 40 s phase. With concurrency 8 that's 8 rounds, so the median must be under 3.7 s. If it isn't, change the `JEV_CONCURRENCY` default in `index.ts` to 16 (4 rounds) before Task 6 deploys. If any of the eight got a 429, keep 8 and raise it with the user, since 16 would make it worse.
- Record the real input tokens, cost and latency per flight in "Added during execution".

Run `npm test` again after any change.

---

### Task 6: Wire hybrid mode into the edge function, then deploy

**Files:**
- Modify: `supabase/functions/generate-report/index.ts`

- [ ] **Step 1: Imports, settings and the header comment**

Update the header comment's first line to `generate-report: writes the weekly ops report, Claude only (Mode A) or Claude + Jev (Mode B, hybrid).` Then:

```ts
import { parseRequest, lastWeekStart, capCheck, buildFacts, flightsCsv, buildMessages, totals } from './report-core.js';
import { callOpenRouter } from './openrouter.js';
import { callJev } from './jev.js';
import { QUESTIONS, flightState, flaggedFlights, runJev, labelRows, jevCallRows, tooManyFailed } from './hybrid.js';
import { writeReport } from './pipeline.js';

const env = (k: string, d = '') => Deno.env.get(k) ?? d;
// A typo in a numeric setting falls back to the default instead of becoming NaN.
const numEnv = (k: string, d: number) => { const v = Number(Deno.env.get(k)); return Number.isFinite(v) && v > 0 ? v : d; };
const JEV_PHASE_MS = 40000; // the Jev phase ends by then, leaving Claude 95 s of the 135 s deadline
```

- [ ] **Step 2: Replace everything from `const weekGroups = …` to the end of the `writeReport({...})` call**

```ts
    const weekGroups = ng.data.filter(r => r.flight_date >= period.start);
    const facts = buildFacts({ period, routeWeeks: rw.data, nearGroups: ng.data, zoneNearCount: zn.count ?? 0,
      delays: dl.data, trendNotes: tn.data, flights: fl.data });

    const apiKey = env('OPENROUTER_API_KEY');
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
    const hybrid = period.mode === 'hybrid';
    const jevModel = env('JEV_MODEL', 'typesafe/jev-1.14');

    const { data: rep, error: rErr } = await admin.from('reports').insert({
      mode: period.mode, period_start: period.start, period_end: period.end, model_claude: model,
      model_jev: hybrid ? jevModel : null,
      status: 'error', created_by: user?.id ?? null, triggered_by: scheduled ? 'schedule' : 'manual',
      // status stays 'error' until a complete report is stored
    }).select('id').single();
    if (rErr) throw rErr;
    reportId = rep.id;

    // One log line per call and one insert per batch (a hybrid run makes ~63 Jev calls).
    const logCalls = async (cs: any[]) => {
      if (!cs.length) return;
      const rows = cs.map(c => ({ report_id: reportId, provider_model: c.model, purpose: c.purpose, input_tokens: c.input_tokens,
        output_tokens: c.output_tokens, cost_usd: c.cost_usd, latency_ms: c.latency_ms, status: c.status, error_message: c.error }));
      for (const [i, row] of rows.entries()) {
        console.log(JSON.stringify({ event: 'ai_call', ...row }));
        if (cs[i].ok && !cs[i].cost_reported) console.warn(JSON.stringify({ event: 'cost_missing', report_id: reportId, model: cs[i].model }));
      }
      const { error } = await admin.from('ai_calls').insert(rows);
      if (error) console.error(JSON.stringify({ event: 'ai_call_log_failed', report_id: reportId, message: error.message }));
    };

    // Mode B: Jev labels every flight; only the picked ones reach Claude. If Jev fails for
    // too many flights, Claude reads them all (Mode A's input) and the report is 'fallback'.
    let csv = flightsCsv(fl.data, weekGroups), jevCalls: any[] = [], fellBack = false;
    if (hybrid) {
      const jevTimeout = numEnv('JEV_TIMEOUT_MS', 10000);
      const results = await runJev({
        flights: fl.data, concurrency: numEnv('JEV_CONCURRENCY', 8), deadline: t0 + JEV_PHASE_MS,
        // timeout capped at the phase's time left, so no request outlives the 40 s mark
        ask: (f: any, msLeft: number) => callJev({ apiKey, model: jevModel, state: flightState(f), questions: QUESTIONS,
          timeoutMs: Math.min(jevTimeout, msLeft) }),
      });
      jevCalls = jevCallRows(results);
      await logCalls(jevCalls);
      const labels = labelRows(reportId, results, flaggedFlights(fl.data, weekGroups), numEnv('JEV_CONFIDENCE', 0.7));
      const { error: lErr } = await admin.from('flight_ai_labels').insert(labels);
      if (lErr) console.error(JSON.stringify({ event: 'labels_log_failed', report_id: reportId, message: lErr.message }));
      fellBack = tooManyFailed(results);
      if (!fellBack) {
        const byId = new Map(labels.map(l => [l.flight_id, l]));
        csv = flightsCsv(fl.data.filter(f => byId.get(f.id)?.included), weekGroups, byId);
      }
      console.log(JSON.stringify({ event: 'jev', report_id: reportId, flights: results.length,
        sent: labels.filter(l => l.included).length, failed: results.filter(r => !r.label).length, fell_back: fellBack }));
    }
    const messages = buildMessages({ facts, csv, hybrid: hybrid && !fellBack });

    const result = await writeReport({
      messages,
      callModel: (m: unknown, ms: number) => callOpenRouter({ apiKey, model, messages: m, timeoutMs: ms, reasoningEffort: env('CLAUDE_REASONING', 'low') }),
      timeoutMs: Number(env('CLAUDE_TIMEOUT_MS', '45000')),
      deadline: t0 + 135000,
      onCall: (c: any) => logCalls([c]),
    });
```

The old `const messages = buildMessages({ facts, csv: flightsCsv(fl.data, weekGroups) });` line and the old in-place `apiKey` check after the insert both go away. The key check now comes before the report row is inserted, so a missing key no longer leaves an `error` row.

- [ ] **Step 3: Totals over both phases, and the final status**

Replace the `update` block and the success reply:

```ts
    const calls = [...jevCalls, ...result.calls];
    const status = fellBack ? 'fallback' : 'ok';
    const update = { ...totals(calls), total_latency_ms: Date.now() - t0,
      ...(result.ok ? { status, content_md: result.content } : {}) };
    const { error: uErr2 } = await admin.from('reports').update(update).eq('id', reportId);
    if (uErr2) throw uErr2;
    console.log(JSON.stringify({ event: 'report', report_id: reportId, mode: period.mode, status: result.ok ? status : 'error', ...totals(calls) }));
    return result.ok ? reply(200, { report_id: reportId, status }) : reply(502, { error: result.error, report_id: reportId });
```

- [ ] **Step 4: Type-check, test, deploy**

```bash
deno check supabase/functions/generate-report/index.ts   # skip if deno isn't installed; the deploy bundler type-checks too
npm test
supabase functions deploy generate-report --use-api </dev/null
```

Expected: tests pass and the deploy reports success. `config.toml` already has `verify_jwt = false` for this function.

- [ ] **Step 5: Mode A still works the same way**

Before the UI changes, check the request rules without spending: an unsigned call still gets 401 and a bad mode gets 400.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://zjafthfktjfncwhycxej.supabase.co/functions/v1/generate-report -H 'Content-Type: application/json' -d '{"period_start":"2026-10-19","mode":"hybrid"}'
```

Expected: `401`. The 400 for a bad mode is covered by the `parseRequest` test, since it can't be reached signed out.

---

### Task 7: The Reports page

**Files:**
- Modify: `reports.html`
- Modify: `js/reports.js`
- Modify: `css/app.css`

- [ ] **Step 1: Markup**

In `reports.html`, replace the hint line under the week picker with a mode picker and a hint that follows it:

```html
      <label class="f">Mode<select id="modePick">
        <option value="claude_only">Claude only</option>
        <option value="hybrid">Claude + Jev</option>
      </select></label>
      <p class="hint" id="modeHint"></p>
```

In the History header, add `<th>Mode</th>` after `<th>Week</th>`.

- [ ] **Step 2: CSS**

After the second `.pill.err` rule in `css/app.css` (around line 224):

```css
.pill.warn { color: var(--warn); background: var(--warn-bg); }
.report-labels { margin-top: 12px; }
.report-labels table { font-size: 13px; }
```

- [ ] **Step 3: Script**

In `js/reports.js`:

1. Update the header comment ("generate the Claude-only report" → "generate the report in either mode"). Then add these after `LIST_COLS`, and add `model_jev` to `LIST_COLS`:

```js
const MODE_NAME = { claude_only: 'Claude only', hybrid: 'Claude + Jev' };
const MODE_HINT = {
  claude_only: 'Claude reads every flight of the week and writes the report.',
  hybrid: 'Jev labels each flight, code picks the ones worth reading, and Claude writes the report from those.',
};
const pillClass = s => ({ ok: 'ok', fallback: 'warn' })[s] ?? 'err';
const modelsOf = r => [r.model_claude, r.model_jev].filter(Boolean).join(' + ');
const pct = v => v == null ? '–' : `${Math.round(Number(v) * 100)}%`;
const WHY = { jev_mention: 'Jev: mention', flagged: 'Flagged by a database check', jev_failed: 'No Jev answer',
  low_confidence: 'Jev unsure', jev_routine: 'Jev: routine' };
const showHint = () => { $('modeHint').textContent = `${MODE_HINT[$('modePick').value]} Every figure comes from the database.`; };
```

2. History rows: use `pillClass(r.status)`, add the mode cell after the week, and show both models:

```js
  $('historyBody').innerHTML = data.map(r => `<tr>
    <td>${esc(when(r.created_at))}</td><td>${esc(r.period_start)}</td><td>${esc(MODE_NAME[r.mode] ?? r.mode)}</td>
    <td><span class="pill ${pillClass(r.status)}">${esc(r.status)}</span></td>
    <td>${r.triggered_by === 'schedule' ? 'Scheduled' : 'Manual'}</td>
    <td>${usd(r.total_cost_usd)}</td><td>${secs(r.total_latency_ms)}</td><td>${esc(modelsOf(r))}</td>
    <td><button class="btn small" data-open="${esc(r.id)}">Open</button></td></tr>`).join('');
```

3. A labels table for hybrid reports:

```js
// Jev's decision for each flight of a hybrid report: the flights Claude read first, then the rest.
function labelsHtml(labels) {
  if (!labels.length) return '';
  const sent = labels.filter(l => l.included).length;
  const rows = [...labels].sort((a, b) => b.included - a.included || Number(b.mention_p ?? 1) - Number(a.mention_p ?? 1)
    || String(a.flights?.flight_date).localeCompare(String(b.flights?.flight_date)));
  return `<details class="report-labels"><summary>Jev decisions: ${sent} of ${labels.length} flights sent to Claude</summary>
    <div class="table-wrap"><table class="history"><thead><tr>
      <th>Flight</th><th>Date</th><th>Category</th><th>Sure</th><th>Mention</th><th>Urgency</th><th>Sent</th><th>Why</th>
    </tr></thead><tbody>${rows.map(l => `<tr>
      <td>${esc(l.flights?.flight_no ?? '')}</td><td>${esc(l.flights?.flight_date ?? '')}</td>
      <td>${esc(l.category ?? '–')}</td><td>${esc(pct(l.category_confidence))}</td><td>${esc(pct(l.mention_p))}</td>
      <td>${esc(l.urgency ?? '–')}</td><td>${l.included ? 'Yes' : 'No'}</td>
      <td>${esc(WHY[l.reason] ?? l.reason)}${l.error_message ? ` (${esc(l.error_message)})` : ''}</td></tr>`).join('')}
    </tbody></table></div></details>`;
}
```

4. In `showReport`, fetch the labels alongside the report and calls, and use them:

```js
  const [rep, calls, labs] = await Promise.all([
    sb.from('reports').select('*').eq('id', id).single().then(r => r, error => ({ error })),
    sb.from('ai_calls').select('purpose, provider_model, status, cost_usd, latency_ms, input_tokens, output_tokens, error_message')
      .eq('report_id', id).order('created_at').then(r => r, error => ({ error })),
    sb.from('flight_ai_labels').select('category, category_confidence, mention_p, urgency, included, reason, error_message, flights(flight_no, flight_date)')
      .eq('report_id', id).then(r => r, error => ({ error })),
  ]);
  if (rep.error) throw rep.error;
  const r = rep.data, list = calls.data ?? [], labels = labs.data ?? [];
  const failed = r.status === 'error';
  const jev = list.filter(c => c.purpose === 'jev_flight_decisions'), claude = list.filter(c => c.purpose !== 'jev_flight_decisions');
  const lastError = [...claude].reverse().find(c => c.error_message)?.error_message;
  const models = [...new Set(list.map(c => c.provider_model))].join(', ') || modelsOf(r);
```

Then, in the card template:
- The heading pill becomes `<span class="pill ${pillClass(r.status)}">`.
- After the `<h2>`, add the fallback banner: `${r.status === 'fallback' ? '<p class="alert warn">Jev didn\'t answer for enough flights, so Claude read every flight instead (the Claude-only input).</p>' : ''}`
- Replace the calls `<details>` with a version that folds the Jev calls into one line:

```js
    ${list.length > 1 ? `<details class="report-calls"><summary>Calls</summary><ul>
      ${jev.length ? `<li>jev_flight_decisions × ${jev.length} · ${jev.filter(c => c.status !== 'ok').length} failed
        · ${usd(jev.reduce((t, c) => t + Number(c.cost_usd), 0))} · longest ${secs(Math.max(...jev.map(c => c.latency_ms)))}</li>` : ''}
      ${claude.map(c => `<li>${esc(c.purpose)} · ${esc(c.status)} · ${usd(c.cost_usd)} · ${secs(c.latency_ms)}${c.error_message ? ` · ${esc(c.error_message)}` : ''}</li>`).join('')}
    </ul></details>` : ''}
    ${labelsHtml(labels)}`;
```

`models` now lists Jev's served model id too. For a hybrid report the footer reads, for example, `… · anthropic/claude-haiku-5.5, typesafe/jev-1.14-20261001`.

5. `generate()`: send the mode, and make the ticker's estimate fit it:

```js
  const mode = $('modePick').value;
  const tick = setInterval(() => {
    status.textContent = `Writing the report… ${Math.round((Date.now() - started) / 1000)} s (usually ${mode === 'hybrid' ? '20 to 50' : '10 to 30'})`;
  }, 500);
  try {
    const { data, error } = await sb.functions.invoke('generate-report', { body: { period_start: $('weekPick').value, mode } });
```

6. In `boot()`, after `$('generator').hidden = false;`, add `showHint();`. Next to the other listeners, add `$('modePick').addEventListener('change', showHint);`.

- [ ] **Step 4: Checks**

```bash
npm test
scripts/check-debrand.sh ../debrand-terms.txt
```

Expected: tests pass, de-brand check passes.

---

### Task 8: Live verification

- [ ] **Step 1: Preview.** The preview config at `../.claude/launch.json` points at the old session's scratchpad. Repoint it to this session's scratchpad `site/` folder, then `rsync -a --delete --exclude .git --exclude node_modules --exclude 'supabase/.env*' --exclude .env ./ <scratchpad>/site/`, and start it with `preview_start` (port 8411). The user signs in.

- [ ] **Step 2: Budget check.** Read today's run count and the total spend first:

```bash
supabase db query --linked "select count(*) filter (where created_at >= (date_trunc('day', now() at time zone 'America/Toronto') at time zone 'America/Toronto')) runs_today, (select sum(cost_usd) from ai_calls) spend from reports" </dev/null
```

This step needs three runs. If fewer than three are left today under the 5-a-day cap, stop and ask the user whether to wait or raise `REPORT_DAILY_CAP` for the session.

- [ ] **Step 3: Hybrid on the week of 2026-10-19.** Generate with "Claude + Jev". Check:
- The report has seven sections and status `ok`. It finds the same ground-truth patterns as the M4 run on this week: 405/YAM growth, 301 and 305 at the Zone 2 limit, the de-icing day, late freight on 118, and the safety note on 512 on 10-22.
- The labels table lists 63 flights. The 512 safety note, the de-icing flights and 118's late-freight notes are sent. Most "nothing to report" flights are `Jev: routine`.
- Count the reasons: `supabase db query --linked "select reason, count(*) from flight_ai_labels where report_id = (select id from reports order by created_at desc limit 1) group by 1" </dev/null`. If `low_confidence` covers more than half the flights, the category confidence is probably splitting between `routine` and `other` on empty notes. Then hybrid saves Claude nothing and M6 would compare little. Record it, and before M6 ask the user whether to gate on mention certainty alone.
- `ai_calls` has about 63 `jev_flight_decisions` rows plus the Claude call. The report's `call_count` and `total_cost_usd` equal the sum of its calls:

```bash
supabase db query --linked "select r.call_count, r.total_cost_usd, count(c.*), sum(c.cost_usd) from reports r join ai_calls c on c.report_id = r.id where r.id = (select id from reports order by created_at desc limit 1) group by r.id" </dev/null
```

- [ ] **Step 4: Hybrid on the week of 2026-09-14.** It should find the DG paperwork note on 620 on 09-15 and the 140 lb stop with no destination on 512 on 09-17. The stop should be sent as `flagged` if Jev called that flight routine.

- [ ] **Step 5: Forced fallback.** Set a model that doesn't exist (a non-secret setting), run hybrid once, then remove the setting:

```bash
supabase secrets set JEV_MODEL=typesafe/no-such-model </dev/null
# generate one hybrid report on the page
supabase secrets unset JEV_MODEL </dev/null
```

Expected:
- The report is complete with status `fallback`. It shows the yellow pill and banner, and History shows it as `fallback`.
- Every label row is `jev_failed` (or `flagged`, which the rule checks first), and every Jev call row is `error` with a 4xx message from Jev (400 or 404, whichever OpenRouter sends for an unknown model). A 4xx isn't transient, so there are no retries: 63 call rows.
- Claude's call cost is logged.

- [ ] **Step 6: Mode A unchanged.** Open the M4 reports from History. They still render, with "Claude only" in the Mode column. Don't spend a run on a new Claude-only report unless one is left over today.

- [ ] **Step 7: Record results.** Under "Added during execution", record cost, time, tokens and call count for each hybrid run, next to M4's Claude-only figures for the same weeks. Also record how many flights each run sent to Claude, broken down by reason. Run the repo checks once more:

```bash
npm test
supabase db query --linked -f supabase/tests/labels_check.sql </dev/null
supabase db query --linked -f supabase/tests/ai_usage_check.sql </dev/null
supabase db query --linked -f supabase/tests/rls_check.sql </dev/null
supabase db query --linked -f supabase/tests/schedule_check.sql </dev/null
```

- [ ] **Step 8: Commit, on the user's word.** Suggested message: `M5: Claude + Jev hybrid report with stored per-flight labels and Mode A fallback`.

---

## Added during execution

- Tasks 1–4 were built by one implementer. The new files match the plan's code exactly, and the migration is applied with `labels_check`, `rls_check` and `ai_usage_check` passing. The advisors show only the accepted leaked-password warning.
- Code review of Tasks 1–4 found that bad numeric settings fail in unsafe ways. A NaN or 0 `JEV_CONCURRENCY` started no workers, so a run came back `ok` with Claude seeing no flights. A NaN `JEV_CONFIDENCE` silently dropped unsure flights. Fixes:
  - `runJev` always starts at least one worker.
  - `decide` treats a threshold it can't compare as "unsure", which sends the flight.
  - `readAnswers` rounds probabilities to the table's 3 places, so a stored 0.500 can't carry a non-mention reason.
  - Task 6 reads the `JEV_*` settings through `numEnv`, which falls back to the default.
  Three regression tests were added, for 89 of 89.
- Probe (Task 5), run by the user on 2026-10-27, served by `typesafe/jev-1.14-20261014`:
  - The answer fields match `readAnswers` exactly. Score is 0-based (the legend runs 0–4), so urgency = score + 1 stands.
  - The damaged-strap sample came back `handling_issue` at 0.99 confidence, mention 0.91, urgency 2.8 at 0.27 confidence. That low urgency confidence on a clear case supports leaving urgency out of the confidence rule.
  - 731 input tokens and 119 output tokens per call, $0.0000307 with `usage.cost` reported. That's about $0.0019 for a 63-flight week.
  - Latency: 8 parallel calls, all ok, no 429. Min 465 ms, median 492 ms, max 528 ms. 8 rounds × 0.5 s is about 4 s, far under the 30 s rule, so `JEV_CONCURRENCY` stays 8.
  - Probabilities come back with two decimals, so the reviewer's float-at-the-bound concern doesn't arise. No change.
- Tasks 6–7 were built by a second implementer, deployed, and an unsigned call still gets 401. Code review found no blocking bugs. Changes from it:
  - On a fallback report, the labels summary and column now say what Jev *would have* sent ("Would send"), so they don't contradict the banner.
  - A failed labels read is logged to the console.
  - The `byId` Map line is typed for `deno check`.
- The first live run's total ($0.003975) didn't equal the sum of its calls ($0.003967). Each `ai_calls` row stores its cost rounded to 6 places, and `totals` summed the unrounded values. Over 63 Jev calls that drifted by $0.000008. `totals` now rounds each call before adding, with a test (90 of 90). The one affected report row was corrected to the sum of its calls.
- The old session's static preview server was still on port 8411. It was stopped, and `../.claude/launch.json` now points at this session's scratchpad `site/`.
- The daily cap was at 4 of 5, so the user approved `REPORT_DAILY_CAP=8` for the three live runs. It was unset afterwards, and `OPENROUTER_API_KEY` is again the only custom secret.
- Live results (Haiku 5.5 with low reasoning, Jev 1.14), next to M4's Claude-only runs of the same weeks:

  | Run | Status | Cost | Time | Calls | Claude tokens in | Claude cost | Flights to Claude |
  |---|---|---|---|---|---|---|---|
  | Week of 2026-10-19, Claude only (M4) | ok | $0.0023 | 15.0 s | 1 | 6.0k | $0.0023 | 63 |
  | Week of 2026-10-19, hybrid | ok | $0.003967 | 20.2 s | 64 | 5,448 | $0.00206 | 36 |
  | Week of 2026-09-14, Claude only (M4) | ok | $0.0028 | 19.3 s | 1 | about 6k | $0.0028 | 63 |
  | Week of 2026-09-14, hybrid | ok | $0.004045 | 17.6 s | 64 | 4,612 | $0.00214 | 30 |
  | Week of 2026-10-19, forced fallback | fallback | $0.002600 | 23.9 s | 64 | 5,995 | $0.00260 | 63 (all) |

  - Week of 2026-10-19, hybrid: found every ground-truth pattern. That covers 405/YAM growth (+80.7%), 301 and 305 at the Zone 2 limit (36 and 37 legs in the 7 weeks before), the de-icing day (7 flights, 467 min), 118's late freight, and the safety note on 512 on 10-22. Reasons: 16 `jev_mention`, 9 `flagged`, 11 `low_confidence`, 27 `jev_routine`. All seven de-icing flights were labelled `delay_weather` with mention at 0.88 or above. The slowest Jev call took 2.4 s. The 512 safety note came back `safety_concern` at only 44% category confidence (split with `handling_issue`) and was still sent on mention 0.93.
  - Week of 2026-09-14, hybrid: found the DG paperwork note on 620 on 09-15 (`safety_concern`, mention 0.93) and the 140 lb stop with no destination on 512 on 09-17. Jev called that stop routine (mention 0.44), and the `flagged` rule sent it anyway, which is the safety net working as designed. Reasons: 14 `jev_mention`, 10 `flagged`, 6 `low_confidence`, 33 `jev_routine`.
  - `low_confidence` was 11 and 6 of 63, well under half, so the confidence rule stays as it is.
  - Forced fallback (`JEV_MODEL=typesafe/no-such-model`): all 63 Jev calls were logged as `error` with "Jev 400: Model typesafe/no-such-model does not exist", with no retries since 400 isn't transient. Claude got the full CSV (5,995 tokens in), and the report is complete, marked `fallback`, and shows the yellow pill and banner. The plan expected every label to read `jev_failed`. In fact 53 do, and 10 read `flagged`, because the include rule checks `flagged` first. That's correct; the plan's expectation was off.
  - Call counts and costs equal the sum of their `ai_calls` rows on both runs made after the fix.
  - Finding for M6: on a 63-flight week, hybrid costs about 1.4–1.7× Claude-only. Jev adds about $0.0019, and Claude saves 0.5–1.4k input tokens, about $0.0002–0.0007. Time is similar either way, because Jev's phase is a few seconds. That matches the expectation stated at the top. The case for hybrid is labelling per flight at volume.
  - Claude broke the "don't quote the labels" rule once on 10-19, with a data-quality bullet citing "data_quality or low-confidence labels". It's minor, and an item for M6's evals.
- Final checks: `npm test` passes 90 of 90. `labels_check`, `ai_usage_check`, `rls_check`, `schedule_check` and `save_flight_check` pass, and so does the de-brand check. The advisors show only the accepted leaked-password warning. Total logged spend is now $0.0244.

## Opus comparison (run after M5, input for M6)

On 2026-10-27, after the M5 commit, the user asked for one Opus 5.5 run per mode on the week of 2026-10-19, to compare with the Haiku runs of the same week. `CLAUDE_MODEL=anthropic/claude-opus-5.5`, `CLAUDE_TIMEOUT_MS=100000` and `REPORT_DAILY_CAP=9` were set for the two runs and then unset. The logged costs match $4 in / $20 out per million tokens.

| Run | Cost | Time | Claude tokens in / out | Words | All 5 patterns in report | All 5 in Summary |
|---|---|---|---|---|---|---|
| Haiku, Claude only | $0.0023 | 15.0 s | 5,995 / 3,362 | 751 | yes | no (YAM growth, 118 freight missing) |
| Haiku, hybrid | $0.0040 | 20.2 s | 5,448 / 3,031 | 644 | yes | no (YAM growth missing) |
| Opus, Claude only | $0.0738 | 24.0 s | 5,995 / 2,489 | 704 | yes | yes |
| Opus, hybrid | $0.0817 | 27.3 s | 5,520 / 2,885 | 860 | yes | yes |

Claims checked against `flights`:
- Haiku, Claude only, misattributed a cause: "ATC flow control (214 and 118 on 2026-10-23)". 118 that day was late forwarder cargo, which both Opus reports give correctly.
- Haiku, hybrid, quoted the classifier's labels against the rule. Opus, hybrid, didn't.
- Only Opus connected rows. It noticed that C-GNBC, the aircraft with the loose net anchor on 512 on 10-22, flew 512 again on 10-24 and 10-25 with no repair recorded (true; the 10-25 note says only "nets checked"). It also suggested checking the same fitting on the other B1900D aircraft. Opus, hybrid, also found a real pattern nobody planted: "crew late from the hotel" on 3 legs of 214 over the 8 weeks.
- All four flagged "crew" in `dg_note` as unclear, so that isn't a model difference.
- The 700-word limit was broken by three of the four (Opus, hybrid, by the most, at 860).

What this says:
- Recall on the planted patterns doesn't separate the models; all four found everything. The differences are in accuracy (one wrong cause from Haiku), rule-following, what makes the Summary, and reasoning across rows, where Opus is better.
- Opus costs 20–32× Haiku per report: about $0.08 against $0.002–0.004, or roughly $4 a year against $0.20 for one weekly report. At this volume both are negligible. Rank the models on the quality differences, not price.
- Hybrid doesn't save input tokens on either model at 63 flights: 475 fewer with Opus, 547 with Haiku. The SQL facts make up most of the prompt, so trimming the flight CSV barely matters. Hybrid's case rests on volume, not on this report.
- For M6: score accuracy of causes and figures, rule breaks, Summary coverage and word count, not just recall. One run per model is an anecdote; M6 needs at least 3.

## Done when

- `npm test` passes, including the new Jev, hybrid and report-core tests.
- `labels_check.sql`, `ai_usage_check.sql`, `rls_check.sql` and `schedule_check.sql` pass.
- A signed-in user can pick "Claude + Jev", get a seven-section report, and open a table of Jev's decision for every flight of the week, with why each was or wasn't sent.
- Each hybrid run's totals equal the sum of its Jev and Claude calls.
- A broken Jev model produces a complete report marked `fallback`, shown as such on the page. A Claude failure still produces no half report.
- Claude-only runs and the weekly schedule behave as before.

## Known limits

- A Jev call that times out on our side logs $0, though OpenRouter may still bill it, as with Claude in M4.
- The spend cap is checked once before a run. A hybrid run is about 64 calls, still well under a cent.
- Labels are only as good as Jev's reading of a short note; the `flagged` rule and the low-confidence rule are the safety net, and M6's evals measure what gets missed.
- The labels table on a fallback run shows what Jev would have sent, while the report itself used every flight. The status and banner say so.
- The Decisions API is alpha; a field rename would make every answer fail the check and every run fall back to Mode A. That's the intended failure mode, and the fallback banner makes it visible.

## Review

An independent subagent applied Tasks 2, 3 and 4 in a scratch copy, and all 84 tests passed (58 existing, 26 new). It found the Mode A prompt and CSV byte-for-byte unchanged, and the migration, the `index.ts` splice and the page edits consistent with the existing code. Every interpolation on the page is escaped. Changes made from its review:
- The Jev phase could overrun 40 s by one request timeout, which would have squeezed out Claude's heading-fix call. Each request's timeout is now capped at the phase's time left, none starts with under 2 s left, and a test checks the timeout passed in.
- Throughput decided the fallback by chance: eight rounds at concurrency 8, no retry, and two rounds not started would cross 25%. The probe now sends 8 calls in parallel and reports latency and 429s. Task 5 sets the concurrency by a stated rule, and transient failures get one retry when 5 s remain. Retries are logged as their own calls.
- `labels_check.sql` block 3 caught the read inside the same exception handler as the insert, so a missing select grant would have passed. The read now runs on its own.
- Task 8 counts the reasons and flags it if `low_confidence` covers more than half the flights. If it does, the user decides before M6 whether to gate on mention certainty alone.
- The forced-fallback check expects any 4xx from Jev, not 400 only.
- Wording: the `parseRequest` test is replaced rather than added, and the note that `fl()` lacked an id is gone.

After the fixes, Task 4's code from this plan passes in the scratch copy: 86 of 86.
