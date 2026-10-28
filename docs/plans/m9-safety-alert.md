# M9: Same-day safety alert on flight close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** plan only. Nothing here is built before the interview on 2026-10-29. Build starts only on the user's word.

**Goal:** When a loadmaster closes a flight, Jev labels that one flight within seconds. If the label is `safety_concern`, or urgency is 3 or more on the 1–5 scale, the duty manager gets an email the same day instead of reading about it in Monday's weekly report, and the alert is listed on the Reports page.

**Architecture:** A Postgres trigger on `flights` fires when `status` goes from `draft` to `closed` and calls a new edge function, `flight-alert`, through `pg_net`, with a random secret kept in Vault. This is the M4b weekly-schedule pattern, applied to one event instead of a clock. The function checks the secret, reads the flight with the service role, asks Jev the same three questions as the hybrid report, stores the answer in a new `flight_close_labels` table, and decides in code whether to alert. Alerts go out as plain-text email through Resend and stay in the table as the in-app record. Jev only reads the DG note and the loadmaster note. Weights, zone placement, limits and the print block are untouched, and the email text is built by code from a template, not written by a model.

**Tech Stack:** Postgres trigger, `pg_net`, Supabase Vault, a Deno edge function, the existing `jev.js` and `hybrid.js`, Resend's email API, Node tests.

**Why this automation (the interview version):**
- The weekly report is a summary. A missing DG acceptance checklist on Tuesday shouldn't wait for Monday.
- It's event-driven, so it costs one Jev call per closed flight (about $0.00003 and half a second) instead of 63 calls in one batch.
- It's the "label each flight once, when it closes" design that the M5 notes said the hybrid mode needed to pay off. Once labels are stored at close, the weekly hybrid report can read them instead of calling Jev again (a later step, not in this plan).
- The governance story is the same as the report's: a caller that proves who it is, a spend cap, every AI call logged with its cost, and code, not the model, deciding what happens.

**Decisions made with the user (2026-10-28):**
- **Channel:** an in-app list plus email, sent through Resend.
- **Trigger:** a Postgres trigger calling the function through `pg_net`, so every close path alerts, not only the app's button.
- **Labels:** a new table, `flight_close_labels`, one row per closed flight. The M5 `flight_ai_labels` table and its tests stay as they are.
- **Caps:** a per-day cap on alert emails, plus the existing $2.00 spend cap on AI calls.

**Decided while planning (reviewer: challenge these if wrong):**
- **A new edge function, not a third path through `generate-report`.** The report function is already long and has a 135 s deadline built around Claude. `flight-alert` has one job, no user path and no CORS. It reuses `jev.js`, `hybrid.js` and `report-core.js` by relative import (`../generate-report/...`), so the Jev questions and answer checks live in one place.
- **Its own Vault secret, `flight_alert_secret`.** A leaked report secret shouldn't be able to send alerts, and the reverse.
- **One table for labels and alerts.** Every closed flight gets a row; an alert is a row with `alert_reason` set. The in-app list filters on that. A second table would only hold a foreign key and the email columns.
- **The alert rule, in code (`shouldAlert`):** `safety_concern` at any confidence alerts; urgency at or above `ALERT_URGENCY` alerts (3, "Follow up this week", until Task 0 measures it); no usable label alerts if the flight has any DG note or loadmaster note. Doubt goes toward alerting, as in M5's `decide()`: an extra email costs a minute, a missed safety note costs much more.
- **The spend cap doesn't stop the alert, only the Jev call.** Past the cap, the flight is stored with no label and goes through the "no label" rule.
- **The daily cap limits emails, not rows.** `ALERT_DAILY_CAP` (default 10) counts emails sent since midnight Toronto time. Alerts past it are stored with `email_status = 'capped'` and still show in the app.
- **The duty manager is a setting, `ALERT_TO`**, one address in the function's secrets. A roster table is a later step. With `ALERT_TO` unset, alerts are stored with `email_status = 'off'` and nothing is sent.
- **Sender:** Resend's shared `onboarding@resend.dev` address by default. It can only send to the Resend account's own address, which is enough for the demo and needs no DNS change. Sending from a `raphaelattar.com` address means verifying the domain in Resend first (`ALERT_FROM`).
- **Plain-text email only.** The notes are user text. Plain text means no HTML injection, and the subject has newlines stripped.
- **Each email says where it came from:** "This alert comes from an AI label of the notes. Check the flight record before acting."
- **Sent once per flight.** The function skips a flight that already has a row, `flight_id` is unique, and the label row is inserted before the email goes out, so a second concurrent call fails on the unique key and sends nothing. Resend's `Idempotency-Key` header (`flight-alert/<label row id>`) guards the send itself. The key uses the row id, not the flight id, so a deliberate re-send (delete the row, call again) gets a new key instead of Resend's cached first answer.
- **A flight with no notes gets no Jev call.** There's nothing for Jev to read, and an urgency score with no note behind it shouldn't alert.
- **Failures before the label count as "no label".** A missing OpenRouter key, a failed spend check or the spend cap all store the row with the error and go through the "no label" rule, so a problem on our side still alerts on a flight with notes.
- **Seeding doesn't alert.** `npm run seed` inserts flights already closed; the trigger fires on update only.

**Settings (function secrets; defaults in `flight-alert/index.ts`):**

| Setting | Default | Purpose |
|---|---|---|
| `RESEND_API_KEY` | none | Resend key. Unset means no email (`email_status = 'off'`). |
| `ALERT_TO` | none | The duty manager's address. Unset means no email. |
| `ALERT_FROM` | `Load Control Lite <onboarding@resend.dev>` | Sender. |
| `ALERT_URGENCY` | 3 (set by Task 0) | Urgency (1–5) at or above which a flight alerts. |
| `ALERT_DAILY_CAP` | 10 | Emails per Toronto day. |
| `ALERT_APP_URL` | `https://loadcontrol.raphaelattar.com/reports.html` | Link in the email. |
| `JEV_MODEL`, `JEV_TIMEOUT_MS`, `AI_SPEND_CAP_USD` | as in `generate-report` | Shared with the report. |

**Constraints:**
- Prose in docs follows the unslop contract; run both scanners on changed docs.
- `scripts/check-debrand.sh ../debrand-terms.txt` must pass after every task.
- Claude never reads `supabase/.env.local` and never handles the Resend key. The user creates the Resend account and puts the key in `.env.local`.
- Every `supabase` command ends in `</dev/null`.
- Never select from `net.http_request_queue` or `vault.decrypted_secrets` in a check: the queue holds request headers, secret included, until they're sent.
- Commit only on the user's word.

**File map:**

| File | Change |
|---|---|
| `supabase/migrations/20261102090000_flight_close_alert.sql` | New: table, secret, secret check, send function, trigger, email count. |
| `supabase/functions/flight-alert/alert.js` | New: request parsing, `shouldAlert`, email text, label row. Pure. |
| `supabase/functions/flight-alert/alert.test.mjs` | New. |
| `supabase/functions/flight-alert/resend.js` | New: one email send, never throws. |
| `supabase/functions/flight-alert/resend.test.mjs` | New. |
| `supabase/functions/flight-alert/index.ts` | New: wiring. |
| `supabase/config.toml` | Add `[functions.flight-alert] verify_jwt = false`. |
| `package.json` | Add `supabase/functions/flight-alert/*.test.mjs` to `npm test`. |
| `supabase/tests/flight_alert_check.sql` | New SQL check. |
| `reports.html`, `js/reports.js` | Alerts card above History. |
| `.env.example`, `README.md`, `RUNBOOK.md`, `DEMO.md` | Settings, how it works, how to re-send or turn it off. |

---

### Task 0: Pick the urgency threshold from data

Nothing measured backs 3 yet. Jev's urgency is a probability-weighted index, and M5 found it spreads over neighbouring levels, which pulls scores toward the middle. A threshold of 3 might alert on routine flights.

- [ ] **Step 1: Read the M5 labels** (read-only, no AI call; run on the user's word):

```bash
supabase db query --linked "select category, count(*) as n, round(avg(urgency), 2) as avg_u, count(*) filter (where urgency >= 2.5) as ge_2_5, count(*) filter (where urgency >= 3) as ge_3, count(*) filter (where urgency >= 3.5) as ge_3_5 from flight_ai_labels where urgency is not null group by category order by n desc" </dev/null
```

- [ ] **Step 2: Choose the default** with the user: the lowest threshold that leaves `routine` flights below it and keeps `handling_issue` and `delay_*` flights with a real follow-up above it. Put the chosen value and the table in the "Added during execution" notes, and change the default in `alert.js`, `index.ts` and the settings table.

---

### Task 1: Migration

**Files:** Create `supabase/migrations/20261102090000_flight_close_alert.sql`

- [ ] **Step 1: Write it**

```sql
-- Same-day alert when a flight closes (M9). A trigger on flights calls send_flight_closed(),
-- which POSTs the flight id to the flight-alert edge function with a random secret from
-- Vault, as the weekly report job does. The function labels the flight with Jev, stores the
-- label here, and emails the duty manager when code decides it should.
-- Only the edge function (service_role) writes; signed-in users read.

create table public.flight_close_labels (
  id                  uuid primary key default gen_random_uuid(),
  flight_id           uuid not null unique references public.flights on delete cascade,
  model_jev           text,
  -- Jev's answers; null when there's no usable answer (Jev failed, or the spend cap was reached)
  category            text check (category in ('routine', 'delay_weather', 'delay_freight', 'delay_maintenance',
                                               'handling_issue', 'safety_concern', 'data_quality', 'other')),
  category_confidence numeric(4,3) check (category_confidence between 0 and 1),
  mention_p           numeric(4,3) check (mention_p between 0 and 1),
  urgency             numeric(2,1) check (urgency between 1 and 5),
  urgency_confidence  numeric(4,3) check (urgency_confidence between 0 and 1),
  error_message       text,
  -- what code decided; both null when the flight doesn't alert
  alert_reason        text check (alert_reason in ('safety_concern', 'urgency', 'no_label')),
  email_status        text check (email_status in ('pending', 'sent', 'failed', 'capped', 'off')),
  email_error         text,
  emailed_at          timestamptz,
  created_at          timestamptz not null default now(),
  check ((alert_reason is null) = (email_status is null))
);
create index flight_close_labels_alerts_idx on public.flight_close_labels (created_at desc) where alert_reason is not null;

alter table public.flight_close_labels enable row level security;
create policy "logged-in users read close labels" on public.flight_close_labels for select to authenticated using (true);
revoke all on public.flight_close_labels from anon, authenticated;
grant select on public.flight_close_labels to authenticated;
grant all    on public.flight_close_labels to service_role;

-- Emails sent since midnight Toronto time, for ALERT_DAILY_CAP.
create function public.alert_emails_today()
returns int
language sql stable security invoker set search_path = ''
as $$
  select count(*)::int from public.flight_close_labels
  where email_status = 'sent'
    and emailed_at >= (date_trunc('day', now() at time zone 'America/Toronto') at time zone 'America/Toronto');
$$;
revoke execute on function public.alert_emails_today() from public, anon, authenticated;
grant  execute on function public.alert_emails_today() to service_role;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'flight_alert_secret',
                           'Proves a flight-alert call came from the close trigger')
where not exists (select 1 from vault.secrets where name = 'flight_alert_secret');

create function public.is_flight_alert_secret(p_secret text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(p_secret, '') <> '' and exists (
    select 1 from vault.decrypted_secrets
    where name = 'flight_alert_secret' and decrypted_secret = p_secret);
$$;
revoke execute on function public.is_flight_alert_secret(text) from public, anon, authenticated;
grant  execute on function public.is_flight_alert_secret(text) to service_role;

-- Returns the pg_net request id. pg_net sends after the closing transaction commits, so a
-- save that rolls back sends nothing. Also the way to re-send by hand, as postgres.
create function public.send_flight_closed(p_flight uuid)
returns bigint
language sql security definer set search_path = ''
as $$
  select net.http_post(
    url := 'https://zjafthfktjfncwhycxej.supabase.co/functions/v1/flight-alert',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-flight-alert', (select decrypted_secret from vault.decrypted_secrets where name = 'flight_alert_secret')),
    body := jsonb_build_object('flight_id', p_flight),
    timeout_milliseconds := 30000);
$$;
revoke execute on function public.send_flight_closed(uuid) from public, anon, authenticated;

create function public.on_flight_closed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- Closing a load sheet must never depend on the alert: a missing secret or a pg_net
  -- problem logs a warning and the close goes through.
  begin
    perform public.send_flight_closed(new.id);
  exception when others then
    raise warning 'flight alert not queued for %: %', new.id, sqlerrm;
  end;
  return null;
end $$;
revoke execute on function public.on_flight_closed() from public, anon, authenticated;

-- save_flight() sets status in every update, so `of status` alone would fire on each save;
-- the WHEN clause keeps it to the one draft -> closed change.
create trigger flights_closed_alert
  after update of status on public.flights
  for each row when (old.status = 'draft' and new.status = 'closed')
  execute function public.on_flight_closed();
```

- [ ] **Step 2: The privilege question.** Postgres checks `EXECUTE` on a trigger function when the trigger is created, not when it fires, so revoking `on_flight_closed()` from `authenticated` doesn't stop a loadmaster's close from firing it. `rls_check.sql`, `save_flight_check.sql` and Task 6 all close a flight as `authenticated`, so they prove it.

- [ ] **Step 3: Don't push yet.** The migration goes live in Task 7, after the function is deployed, so the trigger never calls a function that doesn't exist.

---

### Task 2: `alert.js` (TDD)

**Files:** Create `supabase/functions/flight-alert/alert.js`, `supabase/functions/flight-alert/alert.test.mjs`. Modify `package.json` (test glob).

- [ ] **Step 1: Add the folder to `npm test`**

```json
"test": "node --test scripts/*.test.mjs js/*.test.mjs seed/*.test.mjs supabase/functions/generate-report/*.test.mjs supabase/functions/flight-alert/*.test.mjs",
```

- [ ] **Step 2: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAlertRequest, hasNotes, shouldAlert, alertEmail, closeLabelRow } from './alert.js';

const stop = (seq, dest, cargo = 0) => ({ seq, dest, cargo_lb: cargo, post_lb: 0, fast_lb: 0, bag_lb: 0 });
const fl = (extra = {}) => ({ id: '0b6f3c1e-8f3a-4c55-9a51-3f0e7d2a9b10', flight_date: '2026-11-03', flight_no: '512',
  registration: 'C-GNBA', form_id: 'DH8300', delay_minutes: null, dg_note: '', notes: '', status: 'closed',
  flight_stops: [stop(0, 'YOW', 900)], ...extra });
const label = (extra = {}) => ({ category: 'routine', category_confidence: 0.91, mention_p: 0.08, urgency: 1.2,
  urgency_confidence: 0.6, ...extra });

test('parseAlertRequest takes a flight id and nothing else', () => {
  assert.deepEqual(parseAlertRequest({ flight_id: '0B6F3C1E-8F3A-4C55-9A51-3F0E7D2A9B10' }),
    { flightId: '0b6f3c1e-8f3a-4c55-9a51-3f0e7d2a9b10' });
  for (const bad of [null, {}, { flight_id: 'abc' }, { flight_id: "x' or 1=1" }, { flight_id: 42 }])
    assert.ok('error' in parseAlertRequest(bad), JSON.stringify(bad));
});

test('hasNotes: any non-blank DG or loadmaster note', () => {
  assert.equal(hasNotes(fl()), false);
  assert.equal(hasNotes(fl({ notes: ' \n ' })), false);
  assert.equal(hasNotes(fl({ dg_note: 'UN1845' })), true);
});

test('shouldAlert: a safety concern alerts at any urgency or confidence', () => {
  assert.deepEqual(shouldAlert(label({ category: 'safety_concern', category_confidence: 0.4, urgency: 1.5 }), fl()),
    { alert: true, reason: 'safety_concern' });
});

test('shouldAlert: urgency at the threshold alerts, just under it does not', () => {
  assert.deepEqual(shouldAlert(label({ category: 'handling_issue', urgency: 3 }), fl()), { alert: true, reason: 'urgency' });
  assert.deepEqual(shouldAlert(label({ category: 'handling_issue', urgency: 2.9 }), fl()), { alert: false, reason: null });
  assert.deepEqual(shouldAlert(label({ urgency: 4 }), fl(), 4.5), { alert: false, reason: null });
});

test('shouldAlert: no label alerts when the flight has any note, and not otherwise', () => {
  assert.deepEqual(shouldAlert(null, fl({ dg_note: 'UN3480' })), { alert: true, reason: 'no_label' });
  assert.deepEqual(shouldAlert(null, fl({ notes: 'Strap damaged' })), { alert: true, reason: 'no_label' });
  assert.deepEqual(shouldAlert(null, fl({ notes: '   ' })), { alert: false, reason: null });
});

test('shouldAlert: a routine label stays quiet', () => {
  assert.deepEqual(shouldAlert(label(), fl({ notes: 'All normal' })), { alert: false, reason: null });
});

test('alertEmail: plain text, one-line subject, notes quoted, the AI caveat included', () => {
  const f = fl({ flight_no: '512\r\nBcc: x@y.z', dg_note: 'UN3480 lithium batteries', notes: 'No DG acceptance\nchecklist on file' });
  const { subject, text } = alertEmail({ flight: f, label: label({ category: 'safety_concern', category_confidence: 0.88, urgency: 4.1 }),
    reason: 'safety_concern', appUrl: 'https://example.test/reports.html' });
  assert.ok(!/[\r\n]/.test(subject), subject);
  assert.match(subject, /^Safety alert: flight 512/);
  assert.match(text, /safety concern \(88% sure\)/);
  assert.match(text, /Urgency: 4\.1 of 5/);
  assert.match(text, /DG note: "UN3480 lithium batteries"/);
  assert.match(text, /Loadmaster note: "No DG acceptance checklist on file"/);
  assert.match(text, /Check the flight record before acting/);
  assert.match(text, /https:\/\/example\.test\/reports\.html/);
  assert.ok(!/<[a-z]/i.test(text));
});

test('alertEmail: urgency and no-label alerts say why', () => {
  const u = alertEmail({ flight: fl(), label: label({ category: 'handling_issue', urgency: 3.4 }), reason: 'urgency', appUrl: 'u' });
  assert.match(u.subject, /^Follow-up alert/);
  assert.match(u.text, /rated follow-up urgency 3\.4 of 5/);
  const n = alertEmail({ flight: fl({ notes: 'x' }), label: null, reason: 'no_label', error: 'AI spend cap reached', appUrl: 'u' });
  assert.match(n.text, /no usable label \(AI spend cap reached\)/);
});

test('alertEmail clips a huge note', () => {
  const { text } = alertEmail({ flight: fl({ notes: 'x'.repeat(50000) }), label: null, reason: 'no_label', error: 'e', appUrl: 'u' });
  assert.ok(text.length < 4000, String(text.length));
});

test('closeLabelRow: answers, rounding and the decision; nulls without a label', () => {
  assert.deepEqual(closeLabelRow('f1', 'typesafe/jev-1.14', label({ category_confidence: 0.91234 }), null, { alert: false, reason: null }), {
    flight_id: 'f1', model_jev: 'typesafe/jev-1.14', category: 'routine', category_confidence: 0.912, mention_p: 0.08,
    urgency: 1.2, urgency_confidence: 0.6, error_message: null, alert_reason: null, email_status: null });
  const r = closeLabelRow('f1', 'm', null, 'Jev 503: down', { alert: true, reason: 'no_label' });
  assert.equal(r.category, null);
  assert.equal(r.error_message, 'Jev 503: down');
  assert.equal(r.alert_reason, 'no_label');
  assert.equal(r.email_status, 'pending');
});
```

- [ ] **Step 3: Run them and see them fail**

Run: `npm test`
Expected: FAIL, `Cannot find module './alert.js'`.

- [ ] **Step 4: Write `alert.js`**

```js
/* flight-alert: what Jev's label for one closed flight means for the duty manager, and the
   email text. Pure, so node --test covers all of it. Jev reads the notes; code decides. */
import { routeOf } from '../generate-report/report-core.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const r3 = v => v == null ? null : Math.round(v * 1000) / 1000;
export const hasNotes = f => Boolean(oneLine(f.notes, 1) || oneLine(f.dg_note, 1));

// Body: { flight_id }. The trigger sends nothing else.
export function parseAlertRequest(body) {
  const id = body?.flight_id;
  return typeof id === 'string' && UUID.test(id) ? { flightId: id.toLowerCase() } : { error: 'flight_id must be a UUID' };
}

// Whether the duty manager hears about this flight today. Doubt goes toward alerting, as in
// decide(): without a usable label, any note at all is enough.
export function shouldAlert(label, flight, minUrgency = 3) {
  if (!label) return hasNotes(flight) ? { alert: true, reason: 'no_label' } : { alert: false, reason: null };
  if (label.category === 'safety_concern') return { alert: true, reason: 'safety_concern' };
  if (label.urgency >= minUrgency) return { alert: true, reason: 'urgency' };
  return { alert: false, reason: null };
}

const WHY = {
  safety_concern: l => `Jev labelled the notes a safety concern (${Math.round(l.category_confidence * 100)}% sure).`,
  urgency: l => `Jev rated follow-up urgency ${l.urgency} of 5.`,
  no_label: (l, error) => `Jev gave no usable label (${oneLine(error, 200)}), and the flight has notes.`,
};

// Plain text only: the notes are user text, and the subject has no newlines.
export function alertEmail({ flight: f, label, reason, error, appUrl }) {
  const kind = reason === 'safety_concern' ? 'Safety' : 'Follow-up';
  const subject = oneLine(`${kind} alert: flight ${oneLine(f.flight_no, 12) || '(no number)'} on ${f.flight_date}`, 120);
  const text = [
    `Flight ${oneLine(f.flight_no, 12) || '(no number)'} on ${f.flight_date}, ${oneLine(f.registration, 12) || 'no registration'}, route ${routeOf(f) || '?'}, was closed.`,
    '',
    WHY[reason](label, error),
    label ? `Category: ${label.category}. Urgency: ${label.urgency} of 5.` : null,
    '',
    `DG note: "${oneLine(f.dg_note, 500) || '(none)'}"`,
    `Loadmaster note: "${oneLine(f.notes, 2000) || '(none)'}"`,
    '',
    `Open the app: ${appUrl}`,
    '',
    'This alert comes from an AI label of the notes. Check the flight record before acting.',
  ].filter(l => l !== null).join('\n');
  return { subject, text };
}

// Row for flight_close_labels. email_status starts 'pending' and is set once the send is done.
export const closeLabelRow = (flightId, model, label, error, decision) => ({
  flight_id: flightId, model_jev: model,
  category: label?.category ?? null, category_confidence: r3(label?.category_confidence),
  mention_p: r3(label?.mention_p), urgency: label?.urgency ?? null, urgency_confidence: r3(label?.urgency_confidence),
  error_message: error ?? null,
  alert_reason: decision.alert ? decision.reason : null,
  email_status: decision.alert ? 'pending' : null,
});
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: all pass (90 earlier, plus these 10).

- [ ] **Step 6: Commit on the user's word**

```bash
git add package.json supabase/functions/flight-alert/alert.js supabase/functions/flight-alert/alert.test.mjs
git commit -m "M9: alert rule and email text for closed flights"
```

---

### Task 3: `resend.js` (TDD)

**Files:** Create `supabase/functions/flight-alert/resend.js`, `supabase/functions/flight-alert/resend.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendEmail } from './resend.js';

const args = { apiKey: 'k', from: 'A <a@x.test>', to: 'dm@x.test', subject: 'S', text: 'T', idempotencyKey: 'flight-alert/1' };
const res = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('sendEmail posts plain text with the idempotency key and returns the id', async () => {
  let seen;
  const out = await sendEmail({ ...args, fetchFn: async (url, init) => { seen = { url, init }; return res(200, { id: 'em_1' }); } });
  assert.deepEqual(out, { ok: true, id: 'em_1', error: null });
  assert.equal(seen.url, 'https://api.resend.com/emails');
  assert.equal(seen.init.headers['Idempotency-Key'], 'flight-alert/1');
  assert.deepEqual(JSON.parse(seen.init.body), { from: 'A <a@x.test>', to: ['dm@x.test'], subject: 'S', text: 'T' });
});

test('sendEmail reports an API error without throwing', async () => {
  const out = await sendEmail({ ...args, fetchFn: async () => res(403, { message: 'You can only send testing emails to your own address' }) });
  assert.equal(out.ok, false);
  assert.match(out.error, /^Resend 403: You can only send/);
});

test('sendEmail reports a network failure or timeout without throwing', async () => {
  const out = await sendEmail({ ...args, fetchFn: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } });
  assert.deepEqual(out, { ok: false, id: null, error: 'No answer from Resend within 8 s' });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm test`
Expected: FAIL, `Cannot find module './resend.js'`.

- [ ] **Step 3: Write `resend.js`**

```js
/* One email through Resend's API. Never throws: { ok, id, error }.
   The idempotency key makes a repeated send of the same alert a no-op on Resend's side. */
export async function sendEmail({ apiKey, from, to, subject, text, idempotencyKey, timeoutMs = 8000, fetchFn = fetch }) {
  let res;
  try {
    res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, id: null, error: timeout ? `No answer from Resend within ${timeoutMs / 1000} s` : 'Could not reach Resend' };
  }
  let body = null;
  try { body = await res.json(); } catch { /* empty body: handled below */ }
  if (!res.ok || !body?.id) return { ok: false, id: null, error: `Resend ${res.status}: ${String(body?.message ?? 'request failed').slice(0, 300)}` };
  return { ok: true, id: body.id, error: null };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Check Resend's docs** for the request shape and the `Idempotency-Key` header before deploying (https://resend.com/docs/api-reference/emails/send-email). Adjust the code and tests if either changed.

- [ ] **Step 6: Commit on the user's word**

```bash
git add supabase/functions/flight-alert/resend.js supabase/functions/flight-alert/resend.test.mjs
git commit -m "M9: send one alert email through Resend"
```

---

### Task 4: Edge function wiring

**Files:** Create `supabase/functions/flight-alert/index.ts`. Modify `supabase/config.toml`.

- [ ] **Step 1: Turn off the gateway's JWT check** (the trigger sends a secret, not a user token), next to the existing block:

```toml
[functions.flight-alert]
verify_jwt = false
```

- [ ] **Step 2: Write `index.ts`**

```ts
/* flight-alert: labels one just-closed flight with Jev and emails the duty manager when code
   decides it should. Wiring only; the logic is in alert.js, resend.js and generate-report's
   jev.js and hybrid.js. The only caller is the flights_closed_alert trigger, which proves
   itself with the x-flight-alert secret from Vault. Reads and writes use the service role. */
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import { callJev } from '../generate-report/jev.js';
import { QUESTIONS, flightState, runJev, jevCallRows } from '../generate-report/hybrid.js';
import { parseAlertRequest, hasNotes, shouldAlert, alertEmail, closeLabelRow } from './alert.js';
import { sendEmail } from './resend.js';

const env = (k: string, d = '') => Deno.env.get(k) ?? d;
const numEnv = (k: string, d: number) => { const v = Number(Deno.env.get(k)); return Number.isFinite(v) && v > 0 ? v : d; };
// Jev 12 s + DB calls + email 8 s stays inside pg_net's 30 s timeout, with room for a cold
// start that t0 doesn't see. A pg_net timeout only loses net._http_response, not the work.
const JEV_PHASE_MS = 12000;
const FLIGHT_COLS = 'id, flight_date, flight_no, registration, form_id, etd, delay_minutes, dg_note, notes, status, '
  + 'flight_stops!flight_stops_flight_id_fkey(seq, dest, cargo_lb, post_lb, fast_lb, bag_lb)';

Deno.serve(async req => {
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  const t0 = Date.now();
  let flightId: string | null = null;
  try {
    const admin = createClient(env('SUPABASE_URL'), env('SB_SECRET_KEY') || env('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: ok, error: sErr } = await admin.rpc('is_flight_alert_secret', { p_secret: req.headers.get('x-flight-alert') ?? '' });
    if (sErr) throw sErr;
    if (!ok) return reply(401, { error: 'Bad alert secret.' });

    const parsed = parseAlertRequest(await req.json().catch(() => null));
    if ('error' in parsed) return reply(400, { error: parsed.error });
    flightId = parsed.flightId;

    const { data: seen, error: dErr } = await admin.from('flight_close_labels').select('id').eq('flight_id', flightId).maybeSingle();
    if (dErr) throw dErr;
    if (seen) return reply(200, { flight_id: flightId, skipped: true });

    const { data: f, error: fErr } = await admin.from('flights').select(FLIGHT_COLS).eq('id', flightId).maybeSingle();
    if (fErr) throw fErr;
    if (!f) return reply(404, { error: 'No such flight.' });
    if (f.status !== 'closed') return reply(409, { error: 'Flight is not closed.' });

    // Anything that stops the Jev call (no notes, a failed spend check, no key, the spend cap)
    // stores the reason and leaves the flight to the "no label" rule; it never stops the alert.
    const jevModel = env('JEV_MODEL', 'typesafe/jev-1.14');
    const apiKey = env('OPENROUTER_API_KEY');
    let result: any = { flight: f, calls: [], label: null, error: null };
    const { data: usage, error: uErr } = hasNotes(f) ? await admin.rpc('ai_usage', { p_user: null }).single() : { data: null, error: null };
    if (!hasNotes(f)) result.error = 'No notes to label';
    else if (uErr) result.error = `Spend check failed: ${String(uErr.message).slice(0, 200)}`;
    else if (!apiKey) result.error = 'OPENROUTER_API_KEY is not set';
    else if (Number(usage.spend_usd) >= numEnv('AI_SPEND_CAP_USD', 2)) result.error = 'AI spend cap reached';
    else {
      [result] = await runJev({ flights: [f], concurrency: 1, deadline: t0 + JEV_PHASE_MS,
        ask: (fl: any, msLeft: number) => callJev({ apiKey, model: jevModel, state: flightState(fl), questions: QUESTIONS,
          timeoutMs: Math.min(numEnv('JEV_TIMEOUT_MS', 10000), msLeft) }) });
      const rows = jevCallRows([result]).map((c: any) => ({ report_id: null, provider_model: c.model, purpose: 'jev_flight_close',
        input_tokens: c.input_tokens, output_tokens: c.output_tokens, cost_usd: c.cost_usd, latency_ms: c.latency_ms,
        status: c.status, error_message: c.error }));
      if (rows.length) {
        const { error } = await admin.from('ai_calls').insert(rows);
        if (error) console.error(JSON.stringify({ event: 'ai_call_log_failed', flight_id: flightId, message: error.message }));
      }
    }

    const decision = shouldAlert(result.label, f, numEnv('ALERT_URGENCY', 3));
    // Inserted before the email: a second, concurrent call fails here on the unique key and sends nothing.
    const { data: row, error: iErr } = await admin.from('flight_close_labels')
      .insert(closeLabelRow(flightId, jevModel, result.label, result.error, decision)).select('id').single();
    if (iErr?.code === '23505') return reply(200, { flight_id: flightId, skipped: true });
    if (iErr) throw iErr;

    let emailStatus: string | null = null, emailError: string | null = null;
    if (decision.alert) {
      const to = env('ALERT_TO'), key = env('RESEND_API_KEY');
      // From here on a failure marks the row 'failed' instead of leaving it 'pending'.
      try {
        const { data: sentToday, error: cErr } = to && key ? await admin.rpc('alert_emails_today') : { data: 0, error: null };
        if (cErr) throw cErr;
        if (!to || !key) emailStatus = 'off';
        else if (Number(sentToday) >= numEnv('ALERT_DAILY_CAP', 10)) emailStatus = 'capped';
        else {
          const { subject, text } = alertEmail({ flight: f, label: result.label, reason: decision.reason, error: result.error,
            appUrl: env('ALERT_APP_URL', 'https://loadcontrol.raphaelattar.com/reports.html') });
          // Keyed on the row, so a deliberate re-send (row deleted) isn't swallowed by Resend.
          const sent = await sendEmail({ apiKey: key, from: env('ALERT_FROM', 'Load Control Lite <onboarding@resend.dev>'),
            to, subject, text, idempotencyKey: `flight-alert/${row.id}` });
          emailStatus = sent.ok ? 'sent' : 'failed';
          emailError = sent.error;
        }
      } catch (e) {
        emailStatus = 'failed';
        emailError = String((e as Error)?.message ?? e).slice(0, 300);
      }
      const { error } = await admin.from('flight_close_labels').update({ email_status: emailStatus, email_error: emailError,
        emailed_at: emailStatus === 'sent' ? new Date().toISOString() : null }).eq('id', row.id);
      if (error) throw error;
    }
    console.log(JSON.stringify({ event: 'flight_alert', flight_id: flightId, category: result.label?.category ?? null,
      urgency: result.label?.urgency ?? null, alert: decision.reason, email: emailStatus, ms: Date.now() - t0 }));
    return reply(200, { flight_id: flightId, alert: decision.alert, reason: decision.reason, email_status: emailStatus });
  } catch (e) {
    console.error(JSON.stringify({ event: 'flight_alert_failed', flight_id: flightId, message: String((e as Error)?.message ?? e) }));
    return reply(500, { error: 'The alert could not be processed.', flight_id: flightId });
  }
});
```

- [ ] **Step 3: Type-check it locally** if Deno is installed: `deno check supabase/functions/flight-alert/index.ts`. If not, the deploy in Task 7 bundles and reports type errors.

- [ ] **Step 4: Commit on the user's word**

```bash
git add supabase/config.toml supabase/functions/flight-alert/index.ts
git commit -m "M9: flight-alert edge function"
```

---

### Task 5: Alerts card on the Reports page

**Files:** Modify `reports.html`, `js/reports.js`

- [ ] **Step 1: Add the card above History** in `reports.html`:

```html
  <section class="card" id="alertsCard" hidden>
    <h2>Alerts</h2>
    <p class="hint">Sent when a closed flight's notes look like a safety concern or need follow-up. Jev labels the notes; code decides.</p>
    <div class="table-wrap"><table class="history"><thead><tr>
      <th>Closed</th><th>Flight</th><th>Why</th><th>Category</th><th>Urgency</th><th>Email</th>
    </tr></thead><tbody id="alertsBody"></tbody></table></div>
  </section>
```

- [ ] **Step 2: Load it in `js/reports.js`**, next to `loadHistory`, and add it to the `Promise.all` in `boot()`:

```js
const ALERT_WHY = { safety_concern: 'Safety concern', urgency: 'Follow-up', no_label: 'No Jev label, has notes' };
const EMAIL_PILL = { sent: 'ok', capped: 'warn', off: 'warn', pending: 'warn' };

// Never throws: a failed query leaves the card hidden and History still loads.
async function loadAlerts() {
  const { data, error } = await sb.from('flight_close_labels')
    .select('created_at, alert_reason, category, urgency, email_status, flights(flight_no, flight_date, registration)')
    .not('alert_reason', 'is', null).order('created_at', { ascending: false }).limit(20);
  if (error) { console.warn('alerts', error.message); return; }
  $('alertsCard').hidden = false;
  $('alertsBody').innerHTML = data.length ? data.map(a => `<tr>
    <td>${esc(when(a.created_at))}</td>
    <td>${esc(a.flights?.flight_no || '–')} · ${esc(a.flights?.flight_date ?? '')} · ${esc(a.flights?.registration || '')}</td>
    <td>${esc(ALERT_WHY[a.alert_reason] ?? a.alert_reason)}</td>
    <td>${esc(a.category ?? '–')}</td>
    <td>${a.urgency == null ? '–' : esc(String(a.urgency))}</td>
    <td><span class="pill ${EMAIL_PILL[a.email_status] ?? 'err'}">${esc(a.email_status)}</span></td>
  </tr>`).join('') : '<tr><td colspan="6">No alerts yet.</td></tr>';
}
```

Check the existing `pill` class names in `css/` and the History row markup first, and match them.

- [ ] **Step 3: Check it renders** with the browser pane against the live database once Task 7 has run (the table doesn't exist before then). An empty list shows "No alerts yet."

- [ ] **Step 4: Commit on the user's word**

```bash
git add reports.html js/reports.js
git commit -m "M9: alerts list on the Reports page"
```

---

### Task 6: SQL check

**Files:** Create `supabase/tests/flight_alert_check.sql`

- [ ] **Step 1: Write it.** It never calls `send_flight_closed()` outside a rolled-back transaction and never reads the queue or the secret.

```sql
-- Run: supabase db query --linked -f supabase/tests/flight_alert_check.sql </dev/null
-- Pass: no "FAIL" in the output. Everything that could send a request rolls back, and
-- nothing selects the secret or net.http_request_queue (it holds the secret until sent).

-- 1. The objects exist and the secret check refuses empty and wrong secrets.
do $$ begin
  assert (select count(*) from vault.secrets where name = 'flight_alert_secret') = 1, 'FAIL: secret missing';
  assert not public.is_flight_alert_secret(''), 'FAIL: an empty secret was accepted';
  assert not public.is_flight_alert_secret('wrong'), 'FAIL: a wrong secret was accepted';
  assert (select count(*) from pg_trigger where tgname = 'flights_closed_alert' and not tgisinternal) = 1, 'FAIL: trigger missing';
  assert (select relrowsecurity from pg_class where oid = 'public.flight_close_labels'::regclass), 'FAIL: RLS off';
end $$;

-- 2. A logged-in user can't call the send or secret functions, or write a label.
begin;
set local role authenticated;
do $$ begin
  perform public.send_flight_closed(gen_random_uuid());
  raise exception 'FAIL: authenticated could call send_flight_closed';
exception when insufficient_privilege then null;
end $$;
rollback;

begin;
set local role authenticated;
do $$ begin
  perform public.is_flight_alert_secret('x');
  raise exception 'FAIL: authenticated could call is_flight_alert_secret';
exception when insufficient_privilege then null;
end $$;
rollback;

begin;
set local role authenticated;
do $$ begin
  insert into public.flight_close_labels (flight_id) values (gen_random_uuid());
  raise exception 'FAIL: authenticated could insert a close label';
exception when insufficient_privilege then null;
end $$;
rollback;

begin;
set local role anon;
do $$ begin
  perform 1 from public.flight_close_labels limit 1;
  raise exception 'FAIL: anon could read close labels';
exception when insufficient_privilege then null;
end $$;
rollback;

-- 3. A loadmaster's close queues exactly one request, and a draft save queues none.
-- Counted through the queue's id sequence (sequences don't roll back), never its rows.
-- Everything else rolls back, so nothing is sent.
begin;
create temp table seq_mark on commit drop as
  select 'before'::text as at, last_value, is_called from net.http_request_queue_id_seq;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users order by created_at limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  fid uuid := gen_random_uuid();
  base jsonb := jsonb_build_object('id', fid, 'flight_date', current_date, 'flight_no', 'T1', 'form_id', 'DH8300',
    'status', 'draft', 'stops', '[]'::jsonb, 'allocations', '[]'::jsonb);
begin
  perform public.save_flight(base);
  perform public.save_flight(base);                                   -- draft -> draft: no request
  perform public.save_flight(base || '{"status": "closed"}'::jsonb);  -- draft -> closed: one request
end $$;
reset role;
do $$
declare b bigint; a bigint;
begin
  select case when is_called then last_value else last_value - 1 end into b from seq_mark;
  select case when is_called then last_value else last_value - 1 end into a from net.http_request_queue_id_seq;
  assert a - b = 1, format('FAIL: expected 1 queued request, got %s', a - b);
end $$;
rollback;
```

- [ ] **Step 2: Confirm the sequence name** on the hosted project before the first run (`select pg_get_serial_sequence('net.http_request_queue', 'id')`). If it differs, use that name. If the queue has no sequence, drop the count and keep section 3 as "the close doesn't raise"; Task 7's live check then proves the request count. Another session's close during the check would make the count 2; re-run if that happens.

- [ ] **Step 3: Commit on the user's word** with Task 7's notes.

---

### Task 7: Deploy and live check

Nothing here runs without the user's go-ahead. Each step that sends a request or an email costs real money or lands in a real inbox.

- [ ] **Step 1 (user): Resend.** The user creates a Resend account, makes an API key with send access only, and adds three lines to `supabase/.env.local`: `RESEND_API_KEY`, `ALERT_TO` (the address the Resend account was created with, since the shared sender can only reach that one), and optionally `ALERT_URGENCY` or `ALERT_DAILY_CAP`. Then:

```bash
supabase secrets set --env-file supabase/.env.local </dev/null
supabase secrets list </dev/null
```

Expected: `RESEND_API_KEY` and `ALERT_TO` listed (digests only).

- [ ] **Step 2: Tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 3: Deploy the function before the migration**, as in M4b, so the trigger never calls a missing function:

```bash
supabase functions deploy flight-alert --use-api </dev/null
```

If the bundler refuses the `../generate-report/` imports, move `jev.js`, `hybrid.js` and `report-core.js` with their tests to `supabase/functions/_shared/`, update both functions' imports and the `npm test` glob, run the tests, redeploy `generate-report` too, and note it under "Added during execution".

- [ ] **Step 4: Without a secret it refuses**

```bash
curl -s -X POST https://zjafthfktjfncwhycxej.supabase.co/functions/v1/flight-alert -H 'Content-Type: application/json' -d '{"flight_id":"00000000-0000-0000-0000-000000000000"}'
```

Expected: `{"error":"Bad alert secret."}`. (Before the migration the RPC doesn't exist yet, so this may return the 500 message instead; repeat after Step 5.)

- [ ] **Step 5: Migration and checks**

```bash
supabase db push --yes </dev/null
supabase db query --linked -f supabase/tests/flight_alert_check.sql </dev/null
supabase db query --linked -f supabase/tests/rls_check.sql </dev/null
supabase db query --linked -f supabase/tests/save_flight_check.sql </dev/null
```

Expected: no FAIL in any of them.

- [ ] **Step 6: Close a flight with a safety note** on the live site. New flight dated today, flight number `T901`, one stop with some cargo, DG note `UN3480 lithium ion batteries`, loadmaster note `Loaded without the DG acceptance checklist; shipper paperwork missing`. Close it.

Expected within a minute: an email titled "Safety alert: flight T901 on …" in the `ALERT_TO` inbox; the Alerts card shows the row with `sent`; and:

```bash
supabase db query --linked "select category, urgency, alert_reason, email_status, email_error from flight_close_labels order by created_at desc limit 3" </dev/null
supabase db query --linked "select purpose, status, cost_usd, latency_ms from ai_calls where purpose = 'jev_flight_close' order by created_at desc limit 3" </dev/null
```

- [ ] **Step 7: Close a routine flight**, `T902`, with the note `Loaded as planned`. Expected: a label row with `alert_reason` null, no email, one more `jev_flight_close` call.

- [ ] **Step 8: Re-send is a no-op.** As postgres: `select public.send_flight_closed('<T901 id>')`, then read `net._http_response` for that request id. Expected: `{"skipped":true}` and no second email.

- [ ] **Step 9: Clean up the test flights** (ask the user first). They're dated today, so if they stay, the Monday run on 2026-11-02 reports on them. As postgres: `delete from flights where flight_no in ('T901', 'T902') and flight_date = current_date`. The cascade removes their labels; their `ai_calls` rows stay, unlinked, so the spend cap still counts them.

- [ ] **Step 10: Notes.** Add what happened under "Added during execution" below: figures, latency from close to email, anything that differed from the plan.

---

### Task 8: Docs

**Files:** Modify `.env.example`, `README.md`, `RUNBOOK.md`, `DEMO.md`

- [ ] **Step 1: `.env.example`.** Add the alert settings to the "Optional settings" comment and `RESEND_API_KEY=` and `ALERT_TO=` as lines.
- [ ] **Step 2: `README.md`.** Add the flight-alert path to the architecture diagram (flights trigger → pg_net → `flight-alert` → Jev, Resend), a short "Same-day alerts" section after "The weekly report", the new settings in the settings table, and the new table in the table list. Move "an alert on…" items in "Not built yet" as they apply.
- [ ] **Step 3: `RUNBOOK.md`.** Where to look (`flight_close_labels`, `ai_calls` with `purpose = 'jev_flight_close'`, `net._http_response`, the function logs); a query for flights the alert missed: closed today (`status = 'closed'`, `updated_at` since Toronto midnight) with no `flight_close_labels` row, or with a row stuck at `email_status = 'pending'` for more than 5 minutes (the function died between the insert and the send); how to re-send for a flight (delete its `flight_close_labels` row, then `select public.send_flight_closed('<id>')` as postgres); how to stop emails (`supabase secrets unset ALERT_TO </dev/null`) and how to stop the whole thing (`alter table public.flights disable trigger flights_closed_alert`).
- [ ] **Step 4: `DEMO.md`.** A short live step: close a flight with a DG problem in the note, show the email on a phone and the Alerts card. A fallback if the email is slow: show the row and the log line.
- [ ] **Step 5: Scanners and debrand** on each changed doc:

```bash
for f in README.md RUNBOOK.md DEMO.md; do P="$PWD/$f"; (cd ~/.claude/skills/unslop && python3 scripts/banned_phrase_scan.py "$P" && python3 scripts/structure_scan.py --genre docs "$P"); done
scripts/check-debrand.sh ../debrand-terms.txt
```

- [ ] **Step 6: Commit on the user's word**

---

## Known limits

- `pg_net` is fire-and-forget. If the function fails before it stores a row, the flight gets no label and no alert, and nothing retries. `net._http_response` keeps the answer for about 6 hours. The RUNBOOK query for "closed today with no label row" finds them; re-sending is one SQL call.
- An email isn't a page. A real duty manager would want Teams or SMS for urgent cases and a way to mark an alert as seen. Both are later steps.
- The shared Resend sender only reaches the Resend account's own address. A second recipient needs a verified domain.
- If the function dies after storing the row and before the send, the row stays `pending` and later calls skip it. The RUNBOOK query finds these.
- If Jev is down, every closed flight with a note alerts as "no label" until the daily cap. That's deliberate (doubt goes toward alerting) and the cap bounds it.
- The spend cap is a lifetime total, not a monthly one. Once $2.00 is reached, every closed flight with a note becomes a "no label" alert from then on, with emails still held to the daily cap. Raising the cap is the user's call.
- The daily cap counts, then sends. Flights closed at the same moment can each pass the check, so the cap can be exceeded by the number of sends running at once.
- Jev's endpoint is alpha. Its answers are checked by `readAnswers()` before use, as in M5.
- The function URL is written into the migration, as in M4b. A fork must edit it before `db push`.

## Later, not in this plan

- The weekly hybrid report reads `flight_close_labels` for flights that already have one and calls Jev only for the rest. That's where the M5 cost comparison turns around.
- A duty roster instead of one `ALERT_TO` address.
- A "mark seen" action on the Alerts card, recording who saw it and when.

## Review

An independent subagent read the plan against the repo on 2026-10-28 and ran the Task 2 and 3 tests in a scratch copy (all passed; the repo's `npm test` passes 90). It confirmed the imported functions and shapes, the trigger's `of status ... when` against `save_flight`, that seeding doesn't fire it, and the Toronto-midnight count. Changes made from its review, already in the task text above:
- The trigger function catches its own errors, so a missing secret or a `pg_net` problem can't stop a flight closing.
- Resend's idempotency key uses the label row id, so the RUNBOOK re-send isn't swallowed by Resend's cached answer.
- A missing OpenRouter key or a failed spend check is stored as "no label" instead of throwing before the row exists. An error after the insert marks the row `failed`, not `pending`.
- Flights with no notes skip the Jev call.
- The RUNBOOK query also finds rows stuck at `pending`.
- Task 0 picks `ALERT_URGENCY` from the M5 labels instead of assuming 3.
- The Alerts card can't break History if its query fails.
- The SQL check counts queued requests through the queue's id sequence, uses flight number `T1`, and checks that anon can't read the table.
- The Jev phase is 12 s, leaving room for a cold start inside `pg_net`'s 30 s.
- Known limits now cover the lifetime spend cap and a daily cap that concurrent closes can pass.

## Added during execution

(Empty until the build.)
