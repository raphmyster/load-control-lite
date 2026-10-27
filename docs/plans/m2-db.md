# M2: Swap localStorage for Supabase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flights are created, edited, closed and deleted in Postgres through supabase-js, behind an email login, with every M0 feature working as before.

**Architecture:** The app keeps its in-memory flight objects and render loop. A pure mapping module turns a flight into a save payload and a database row back into a flight. Saving goes through one Postgres function, `save_flight(jsonb)`, which writes the flight, its stops and its allocations in a single transaction. It runs as the caller (`security invoker`), so the M1 RLS policies still apply. Edits autosave about 600 ms after the last change, with a status indicator in the top bar.

**Tech Stack:** supabase-js 2.117.3 as an ES module from jsDelivr (no build step), Postgres 17 on Supabase, Node 22 `node --test`.

**Decisions made with the user:**
- Autosave, with a "Saving… / Saved / Not saved" status.
- An "Actual departure" field; delay minutes are worked out from ETD.
- "Close flight" locks the flight for good: fields read-only, no reopening, printing still works.

**Who does what:**
- **User:** pastes the project's publishable key into `js/supabase-config.js` (Task 4), and signs in to the preview with the demo user (Task 9). Claude never types the demo password.
- **Claude:** everything else. It pushes the migration (the CLI crashes in the user's terminal), and it commits only when the user says so.

**Constraints:**
- No Porter branding. AI never touches weights, placement, limits or printing.
- The publishable (anon) key is public by design and goes in the repo; the `service_role` key never appears in browser code or the repo.
- Theme, print choices and the last-open flight id stay in localStorage as per-viewer conveniences. Flights no longer do.
- The preview serves a copy synced from the repo, because macOS blocks the Python server from reading Documents.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261028090000_save_flight.sql` | `save_flight(jsonb)` function, grants. |
| `supabase/tests/save_flight_check.sql` | SQL Editor test for `save_flight` as the demo user. |
| `js/calc.js` | `calc()` and `n()`, moved out of `app.js` unchanged so Node can test the mapping. |
| `js/db-map.js` | Pure: `toPayload(flight)`, `fromRow(row)`, `delayMinutes(etd, atd)`. No DOM, no network. |
| `js/db-map.test.mjs` | Unit tests for `db-map.js`. |
| `js/supabase-config.js` | Project URL and publishable key. |
| `js/db.js` | supabase-js client: sign in/out, session, load flights, autosave queue, delete. |
| `js/app.js` | Modified: boot after login, autosave, close flight, read-only view, actual departure. |
| `index.html`, `css/app.css` | Modified: sign-in card, Close/Sign out buttons, save status. |
| `package.json` | Modified: test script also runs `js/*.test.mjs`. |

---

### Task 1: `save_flight` migration

**Files:**
- Create: `supabase/migrations/20261028090000_save_flight.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Saves one flight with its stops and allocations in a single transaction.
-- The browser sends the whole flight as JSON; this replaces the stops and allocations.
-- security invoker: runs as the logged-in user, so every M1 RLS policy and column
-- grant still applies. A closed flight is refused.
--
-- Order matters: stops and allocations are written while the flight is still draft
-- (their RLS policies require it), and the flight row, including any draft -> closed
-- change, is updated last.

create function public.save_flight(p jsonb) returns timestamptz
language plpgsql security invoker set search_path = '' as $$
declare
  fid uuid := (p->>'id')::uuid;
  cur_status text;
  saved_at timestamptz;
begin
  select status into cur_status from public.flights where id = fid;
  if cur_status = 'closed' then
    raise exception 'Flight % is closed and can''t be changed', fid using errcode = 'check_violation';
  end if;

  if cur_status is null then
    insert into public.flights (id, flight_date, form_id) values (fid, (p->>'flight_date')::date, p->>'form_id');
  end if;

  delete from public.zone_allocations where flight_id = fid;
  delete from public.flight_stops where flight_id = fid;

  insert into public.flight_stops (id, flight_id, seq, dest, cargo_lb, post_lb, fast_lb, bag_lb, raw_entry)
  select (s->>'id')::uuid, fid, (t.ord - 1)::int, coalesce(s->>'dest', ''),
         (s->>'cargo_lb')::numeric, (s->>'post_lb')::numeric, (s->>'fast_lb')::numeric, (s->>'bag_lb')::numeric,
         coalesce(s->'raw_entry', '{}')
  from jsonb_array_elements(coalesce(p->'stops', '[]')) with ordinality as t(s, ord);

  insert into public.zone_allocations (flight_id, stop_id, kind, zone_id, weight_lb)
  select fid, (a->>'stop_id')::uuid, a->>'kind', a->>'zone_id', (a->>'weight_lb')::numeric
  from jsonb_array_elements(coalesce(p->'allocations', '[]')) as a;

  update public.flights set
    flight_date      = (p->>'flight_date')::date,
    flight_no        = coalesce(p->>'flight_no', ''),
    registration     = coalesce(p->>'registration', ''),
    form_id          = p->>'form_id',
    etd              = nullif(p->>'etd', '')::time,
    actual_departure = nullif(p->>'actual_departure', '')::time,
    delay_minutes    = (p->>'delay_minutes')::int,
    special_hr       = coalesce((p->>'special_hr')::boolean, false),
    special_aog      = coalesce((p->>'special_aog')::boolean, false),
    dg_note          = coalesce(p->>'dg_note', ''),
    loadmaster       = coalesce(p->>'loadmaster', ''),
    notes            = coalesce(p->>'notes', ''),
    manual_alloc     = coalesce((p->>'manual_alloc')::boolean, false),
    tag_positions    = coalesce(p->'tag_positions', '{}'),
    status           = coalesce(p->>'status', 'draft')
  where id = fid
  returning updated_at into saved_at;

  return saved_at;
end $$;

-- Functions are executable by everyone by default. Only logged-in users may call this one.
revoke execute on function public.save_flight(jsonb) from public, anon;
grant execute on function public.save_flight(jsonb) to authenticated, service_role;
```

- [ ] **Step 2: Dry run** — Run: `supabase db push --linked --dry-run </dev/null`
Expected: lists only `20261028090000_save_flight.sql`.

- [ ] **Step 3: Push (Claude, after the user OKs pushing this migration)** — Run: `supabase db push --linked --yes </dev/null`
Expected: `Applying migration 20261028090000_save_flight.sql...` then `Finished supabase db push.`

- [ ] **Step 4: Advisor** — Run: `supabase db advisors --linked --type security </dev/null`
Expected: no new warning about `save_flight` (only the existing leaked-password one).

---

### Task 2: SQL test for `save_flight`

**Files:**
- Create: `supabase/tests/save_flight_check.sql`

- [ ] **Step 1: Write the test**

```sql
-- Run in the Supabase SQL Editor (or: supabase db query --linked -f <this file>).
-- Note: (base->'stops') - 1 needs the brackets; `-` binds tighter than `->`.
-- Pass: "Success. No rows returned". Fail: an error starting with FAIL. Rolls back.
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from auth.users order by created_at limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  fid uuid := gen_random_uuid(); s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
  n int; total numeric;
  base jsonb;
begin
  base := jsonb_build_object('id', fid, 'flight_date', current_date, 'flight_no', 'SF1', 'form_id', 'DH8300',
    'etd', '10:30', 'status', 'draft',
    'stops', jsonb_build_array(
      jsonb_build_object('id', s1, 'dest', 'YSB', 'cargo_lb', 545, 'post_lb', 0, 'fast_lb', 0, 'bag_lb', 40, 'raw_entry', '{"cargo":"500+45"}'::jsonb),
      jsonb_build_object('id', s2, 'dest', 'YTS', 'cargo_lb', 310, 'post_lb', 45, 'fast_lb', 20, 'bag_lb', 60)),
    'allocations', jsonb_build_array(
      jsonb_build_object('stop_id', s1, 'kind', 'cargo', 'zone_id', 'Z2A', 'weight_lb', 440),
      jsonb_build_object('stop_id', s2, 'kind', 'cargo', 'zone_id', 'Z2B', 'weight_lb', 500)));

  -- 1. New flight: one flight, two stops, two allocations; created_by is the caller.
  perform public.save_flight(base);
  select count(*) into n from public.flight_stops where flight_id = fid;
  assert n = 2, 'FAIL: expected 2 stops, got ' || n;
  select count(*) into n from public.flights where id = fid and created_by = auth.uid();
  assert n = 1, 'FAIL: created_by is not the caller';

  -- 2. Save again with one stop removed: replaced, not added to.
  perform public.save_flight(jsonb_set(jsonb_set(base, '{stops}', (base->'stops') - 1), '{allocations}', (base->'allocations') - 1));
  select count(*) into n from public.flight_stops where flight_id = fid;
  assert n = 1, 'FAIL: stops were not replaced, got ' || n;
  select coalesce(sum(weight_lb), 0) into total from public.zone_allocations where flight_id = fid;
  assert total = 440, 'FAIL: allocations were not replaced, total ' || total;

  -- 3. The views see it: Z2A 440 of 450 is 97.8%, so it is near the limit.
  select count(*) into n from public.v_near_limit where flight_id = fid and limit_id = 'Z2A';
  assert n = 1, 'FAIL: v_near_limit missed Z2A at 440/450';

  -- 4. Close it, then any further save is refused.
  perform public.save_flight(jsonb_set(base, '{status}', '"closed"'));
  select count(*) into n from public.flights where id = fid and status = 'closed';
  assert n = 1, 'FAIL: flight did not close';
  begin
    perform public.save_flight(base);
    raise exception 'FAIL: a closed flight was saved';
  exception when check_violation then null;
  end;
end $$;
rollback;

-- 5. Not logged in: anon can't call it.
begin;
set local role anon;
do $$ begin
  perform public.save_flight('{}'::jsonb);
  raise exception 'FAIL: anon could call save_flight';
exception when insufficient_privilege then null;
end $$;
rollback;
```

- [ ] **Step 2: Run it** — Run: `supabase db query --linked -f supabase/tests/save_flight_check.sql </dev/null 2>&1 | grep -E "rror|FAIL" || echo "save_flight test: no errors"`
Expected: `save_flight test: no errors`.

- [ ] **Step 3: Prove it can fail** — change `assert n = 1, 'FAIL: stops were not replaced'` to `assert n = 2` in a temp copy, run it, expect `FAIL: stops were not replaced`. Then confirm `select count(*) from public.flights` is 0 (rolled back).

---

### Task 3: Move `calc` out and write the mapping (TDD)

**Files:**
- Create: `js/calc.js`
- Modify: `js/app.js:10-54` (remove `calc` and `n`, import them)
- Create: `js/db-map.test.mjs`
- Create: `js/db-map.js`
- Modify: `package.json` (test script)

- [ ] **Step 1: Move `calc`.** Cut `function calc(v) { ... }` and `const n = v => calc(v).value;` (the comment above `calc` too) from `js/app.js` into `js/calc.js`, unchanged except `export`:

```js
// Weights may be typed as sums, e.g. 120+45+30 or 3*20. Returns the value and the
// top-level terms (for the breakdown pop-up). No eval: a small recursive-descent parser.
export function calc(v) { /* body moved verbatim from app.js */ }
export const n = v => calc(v).value;
```

In `js/app.js` add `import { calc, n } from './calc.js';` after the existing imports.

- [ ] **Step 2: Update `package.json` test script** to `"test": "node --test scripts/*.test.mjs js/*.test.mjs"`.

- [ ] **Step 3: Write the failing tests** in `js/db-map.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPayload, fromRow, delayMinutes } from './db-map.js';

const S1 = '11111111-1111-4111-8111-111111111111', S2 = '22222222-2222-4222-8222-222222222222';
const flight = () => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', date: '2026-10-28', flightNo: '214', reg: 'C-FNBQ', form: 'DH8300',
  etd: '10:30', atd: '10:55', special: { hr: false, aog: true }, dgNote: 'na',
  rows: [
    { id: S1, dest: 'YSB', cargo: '500+45', post: '', fast: '', bag: '40' },
    { id: S2, dest: 'YTS', cargo: '310', post: '45', fast: '20', bag: '60' },
  ],
  alloc: { [S1]: { cargo: { Z2A: '440', Z1A: '' }, bag: { BINA: '40' } }, gone: { cargo: { Z3: '5' } } },
  pos: { [S1]: { Z2A: [10, 20, 1] } }, manual: true, notes: 'n', loadmaster: 'lm', status: 'draft', updated: 0,
});

test('delayMinutes', () => {
  assert.equal(delayMinutes('10:30', '10:55'), 25);
  assert.equal(delayMinutes('10:30', '10:20'), 0);      // early is not a delay
  assert.equal(delayMinutes('23:50', '00:20'), 30);     // past midnight
  assert.equal(delayMinutes('10:30', ''), null);
  assert.equal(delayMinutes('', '10:30'), null);
});

test('toPayload maps fields, sums typed expressions and keeps the raw text', () => {
  const p = toPayload(flight());
  assert.equal(p.flight_no, '214');
  assert.equal(p.registration, 'C-FNBQ');
  assert.equal(p.form_id, 'DH8300');
  assert.equal(p.actual_departure, '10:55');
  assert.equal(p.delay_minutes, 25);
  assert.equal(p.special_aog, true);
  assert.equal(p.manual_alloc, true);
  assert.deepEqual(p.stops[0], { id: S1, dest: 'YSB', cargo_lb: 545, post_lb: 0, fast_lb: 0, bag_lb: 40,
    raw_entry: { cargo: '500+45', post: '', fast: '', bag: '40' } });
});

test('toPayload drops blank allocations and allocations for removed rows', () => {
  const a = toPayload(flight()).allocations;
  assert.deepEqual(a, [
    { stop_id: S1, kind: 'cargo', zone_id: 'Z2A', weight_lb: 440 },
    { stop_id: S1, kind: 'bag', zone_id: 'BINA', weight_lb: 40 },
  ]);
});

test('toPayload never sends a negative weight', () => {
  const f = flight(); f.rows[0].cargo = '-5';
  assert.equal(toPayload(f).stops[0].cargo_lb, 0);
});

test('empty times are sent as null', () => {
  const f = flight(); f.etd = ''; f.atd = '';
  const p = toPayload(f);
  assert.equal(p.etd, null);
  assert.equal(p.actual_departure, null);
  assert.equal(p.delay_minutes, null);
});

test('fromRow restores the flight the app saved', () => {
  const f = flight(), p = toPayload(f);
  const row = {
    id: f.id, flight_date: p.flight_date, flight_no: p.flight_no, registration: p.registration, form_id: p.form_id,
    etd: '10:30:00', actual_departure: '10:55:00', delay_minutes: 25, special_hr: false, special_aog: true,
    dg_note: 'na', loadmaster: 'lm', notes: 'n', manual_alloc: true, tag_positions: f.pos, status: 'draft',
    updated_at: '2026-10-28T12:00:00Z',
    flight_stops: [...p.stops].reverse().map((s, i) => ({ ...s, seq: 1 - i, cargo_lb: String(s.cargo_lb) })),
    zone_allocations: p.allocations.map(a => ({ ...a, weight_lb: a.weight_lb.toFixed(1) })),
  };
  const back = fromRow(row);
  assert.deepEqual(back.rows.map(r => r.id), [S1, S2]);              // sorted by seq
  assert.equal(back.rows[0].cargo, '500+45');                         // raw text wins
  assert.equal(back.rows[1].post, '45');
  assert.deepEqual(back.alloc, { [S1]: { cargo: { Z2A: '440' }, bag: { BINA: '40' } } });
  assert.equal(back.etd, '10:30');
  assert.equal(back.atd, '10:55');
  assert.deepEqual(back.special, { hr: false, aog: true });
  assert.equal(back.status, 'draft');
  assert.equal(back.updated, Date.parse('2026-10-28T12:00:00Z'));
});

test('fromRow shows a zero weight with no raw text as blank', () => {
  const back = fromRow({ id: 'x', flight_date: '2026-10-28', form_id: 'PC12', status: 'draft', updated_at: null,
    flight_stops: [{ id: S1, seq: 0, dest: 'YSB', cargo_lb: '0.0', post_lb: '12.0', fast_lb: 0, bag_lb: 0, raw_entry: {} }],
    zone_allocations: [] });
  assert.equal(back.rows[0].cargo, '');
  assert.equal(back.rows[0].post, '12');
  assert.equal(back.etd, '');
  assert.deepEqual(back.special, { hr: false, aog: false });
});
```

- [ ] **Step 4: Run to see them fail** — Run: `npm test` — Expected: FAIL, `Cannot find module .../js/db-map.js`.

- [ ] **Step 5: Write `js/db-map.js`**

```js
/* Converts between the app's flight object and the database shape.
   toPayload(flight) -> JSON for save_flight(); fromRow(row) -> flight, where row is a
   flights row with its flight_stops and zone_allocations embedded. No DOM, no network. */
import { n } from './calc.js';

const KEYS = ['cargo', 'post', 'fast', 'bag'];
const lb = v => Math.max(0, n(v));
const mins = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const hhmm = t => (t || '').slice(0, 5);
const shown = x => { const v = Number(x); return v ? String(v) : ''; };

// Minutes late against ETD; early counts as 0. A departure more than 12 h "before" ETD
// is taken as after midnight.
export function delayMinutes(etd, atd) {
  if (!etd || !atd) return null;
  let d = mins(atd) - mins(etd);
  if (d < -720) d += 1440;
  return Math.max(0, d);
}

export function toPayload(f) {
  const rowIds = new Set(f.rows.map(r => r.id));
  const allocations = [];
  Object.entries(f.alloc || {}).forEach(([stopId, kinds]) => {
    if (!rowIds.has(stopId)) return;
    Object.entries(kinds).forEach(([kind, zones]) => Object.entries(zones).forEach(([zone, v]) => {
      if (String(v ?? '').trim() !== '') allocations.push({ stop_id: stopId, kind, zone_id: zone, weight_lb: lb(v) });
    }));
  });
  return {
    id: f.id, flight_date: f.date, flight_no: f.flightNo, registration: f.reg, form_id: f.form,
    etd: f.etd || null, actual_departure: f.atd || null, delay_minutes: delayMinutes(f.etd, f.atd),
    special_hr: !!f.special?.hr, special_aog: !!f.special?.aog, dg_note: f.dgNote || '',
    loadmaster: f.loadmaster || '', notes: f.notes || '', manual_alloc: !!f.manual,
    tag_positions: f.pos || {}, status: f.status || 'draft',
    stops: f.rows.map(r => ({
      id: r.id, dest: r.dest || '',
      ...Object.fromEntries(KEYS.map(k => [`${k}_lb`, lb(r[k])])),
      raw_entry: Object.fromEntries(KEYS.map(k => [k, String(r[k] ?? '')])),
    })),
    allocations,
  };
}

export function fromRow(row) {
  const alloc = {};
  (row.zone_allocations || []).forEach(a => {
    ((alloc[a.stop_id] ||= {})[a.kind] ||= {})[a.zone_id] = String(Number(a.weight_lb));
  });
  return {
    id: row.id, date: row.flight_date, flightNo: row.flight_no || '', reg: row.registration || '', form: row.form_id,
    etd: hhmm(row.etd), atd: hhmm(row.actual_departure),
    special: { hr: !!row.special_hr, aog: !!row.special_aog }, dgNote: row.dg_note || '',
    rows: [...(row.flight_stops || [])].sort((a, b) => a.seq - b.seq).map(s => ({
      id: s.id, dest: s.dest || '',
      ...Object.fromEntries(KEYS.map(k => [k, s.raw_entry?.[k] ?? shown(s[`${k}_lb`])])),
    })),
    alloc, pos: row.tag_positions || {}, manual: !!row.manual_alloc,
    notes: row.notes || '', loadmaster: row.loadmaster || '', status: row.status || 'draft',
    updated: row.updated_at ? Date.parse(row.updated_at) : Date.now(),
  };
}
```

- [ ] **Step 6: Run tests** — Run: `npm test` — Expected: all pass (5 existing + 7 new).

---

### Task 4: Supabase config (user pastes the key)

**Files:**
- Create: `js/supabase-config.js`

- [ ] **Step 1: Claude writes the file with an empty key**

```js
/* The browser's connection to Supabase. Both values are public by design: anyone can
   read them from the page. The data is protected by RLS in the database, not by hiding
   this key. Never put the service_role (secret) key here. */
export const SUPABASE_URL = 'https://zjafthfktjfncwhycxej.supabase.co';
export const SUPABASE_KEY = ''; // Project Settings -> API Keys -> Publishable key (sb_publishable_...)
```

- [ ] **Step 2: User pastes the publishable key** between the quotes and saves. (Dashboard → Project Settings → API Keys. If only legacy keys are shown, use the `anon` `public` one.) Claude confirms the value starts with `sb_publishable_` or is a JWT whose payload role is `anon`, and never `service_role`/`sb_secret_`.

---

### Task 5: Database client and autosave queue

**Files:**
- Create: `js/db.js`

- [ ] **Step 1: Write `js/db.js`**

```js
/* Supabase access for the app: sign-in, loading flights, autosave and delete.
   Saving goes through save_flight(), which writes a flight, its stops and its
   allocations in one transaction under the caller's RLS policies. */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './supabase-config.js';
import { toPayload, fromRow } from './db-map.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function currentUser() { return (await sb.auth.getSession()).data.session?.user ?? null; }
export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}
export async function signOut() { await sb.auth.signOut(); }

// Explicit foreign keys: zone_allocations also links to flight_stops, so PostgREST
// could otherwise read it as a join table between flights and flight_stops.
const SELECT = '*, flight_stops!flight_stops_flight_id_fkey(*), zone_allocations!zone_allocations_flight_id_fkey(*)';
export async function loadFlights() {
  const { data, error } = await sb.from('flights').select(SELECT).order('flight_date', { ascending: false });
  if (error) throw error;
  return data.map(fromRow);
}

/* Autosave. queueSave(flight) waits DELAY ms after the last call, then saves.
   One pending save per flight, so switching flights never drops an edit. Saves run one
   at a time. onStatus receives 'saving' | 'saved' | 'error' (with the error). */
const DELAY = 600;
const pending = new Map();   // flight id -> { payload, json } waiting to be saved
const lastSaved = new Map(); // flight id -> JSON of the last payload saved
const deleted = new Set();   // never save these again
let timer = null, running = false, inflight = Promise.resolve(), onStatus = () => {};

export function onSaveStatus(fn) { onStatus = fn; }
export const hasUnsaved = () => pending.size > 0 || running;
export const markSaved = flight => lastSaved.set(flight.id, JSON.stringify(toPayload(flight)));

export function queueSave(flight, { now = false } = {}) {
  const payload = toPayload(flight), json = JSON.stringify(payload);
  if (deleted.has(payload.id)) return;
  if (lastSaved.get(payload.id) === json) { pending.delete(payload.id); return; } // nothing changed
  pending.set(payload.id, { payload, json });
  clearTimeout(timer);
  timer = setTimeout(run, now ? 0 : DELAY);
}

// Saves the next pending flight. Returns true if it saved, false on error or nothing to do.
async function run() {
  if (running) return false;
  const next = pending.values().next().value;
  if (!next) return false;
  const id = next.payload.id;
  pending.delete(id); running = true;
  onStatus('saving');
  // A supabase-js query runs each time it is awaited, so turn it into one promise
  // first; awaiting the builder twice would send the save twice.
  const call = sb.rpc('save_flight', { p: next.payload }).then(r => r, error => ({ error }));
  inflight = call;
  const { error } = await call;
  running = false;
  if (error) {
    if (!pending.has(id) && !deleted.has(id)) pending.set(id, next); // keep it for the retry
    onStatus('error', error);
    return false;
  }
  lastSaved.set(id, next.json);
  if (pending.size) timer = setTimeout(run, 0); else onStatus('saved');
  return true;
}
export const retrySave = () => run();

// Saves everything now. Returns false if a save failed.
export async function flush() {
  clearTimeout(timer);
  await inflight;
  while (pending.size) { clearTimeout(timer); if (!(await run())) return false; }
  return true;
}

// A save already on its way must land before the delete, or save_flight would
// re-insert the flight after it was deleted.
export async function deleteFlight(id) {
  deleted.add(id); pending.delete(id);
  await inflight;
  const { error } = await sb.from('flights').delete().eq('id', id);
  if (error) { deleted.delete(id); throw error; }
}
```

`queueSave` with the same JSON as the last save does nothing, so re-renders and flight switches don't cause saves. A deleted flight is never saved again, even if a save for it failed earlier.

---

### Task 6: Sign-in screen and top bar

**Files:**
- Modify: `index.html`
- Modify: `css/app.css`

- [ ] **Step 1: In `index.html`**, mark the flight controls so they hide when signed out, add the status, Close and Sign out, and a sign-in dialog. Replace the six buttons/select between `<span class="spacer"></span>` and `</header>` with:

```html
  <span class="save-status" id="saveStatus" role="status" aria-live="polite"></span>
  <select id="flightPick" class="needs-auth" aria-label="Saved flights"></select>
  <button class="btn small needs-auth" data-act="newFlight">New</button>
  <button class="btn small needs-auth" data-act="dupFlight">Duplicate</button>
  <button class="btn small needs-auth" data-act="closeFlight" id="closeBtn">Close flight</button>
  <button class="btn small danger needs-auth" data-act="delFlight" id="delBtn">Delete</button>
  <button class="btn small" data-act="theme" id="themeBtn" aria-label="Colour theme"></button>
  <button class="btn small needs-auth" data-act="pdf">Save as PDF</button>
  <button class="btn small primary needs-auth" data-act="print">Print</button>
  <button class="btn small needs-auth" data-act="signOut">Sign out</button>
```

Add before `<div id="print-root">`:

```html
<section class="card signin" id="signin" hidden>
  <h2>Sign in</h2>
  <form id="signinForm">
    <label class="f">Email<input type="email" id="signinEmail" autocomplete="username" required></label>
    <label class="f">Password<input type="password" id="signinPassword" autocomplete="current-password" required></label>
    <p class="hint" id="signinError" role="alert"></p>
    <div class="toolbar"><button class="btn primary" type="submit">Sign in</button></div>
  </form>
</section>
```

- [ ] **Step 2: In `css/app.css`**, append:

```css
/* signed out: only the sign-in card and the theme button */
body.signed-out .needs-auth, body.signed-out #view { display: none; }
.signin { max-width: 380px; margin: 48px auto; }
.save-status { font-size: 12px; color: #c9d6df; white-space: nowrap; }
.save-status.error { color: #ffb4a8; font-weight: 600; cursor: pointer; text-decoration: underline; }
/* closed flight: read-only */
.locked { border: 0; padding: 0; margin: 0; min-width: 0; }
.closed-banner { background: var(--brand-2); color: #fff; border-radius: 8px; padding: 8px 14px; margin: 0 0 12px; font-weight: 600; }
```

---

### Task 7: Wire the app to the database

**Files:**
- Modify: `js/app.js`

- [ ] **Step 1: Imports and ids.** Add `import * as db from './db.js';` and `import { delayMinutes } from './db-map.js';`. Replace `const uid = () => Math.random().toString(36).slice(2, 10);` with `const uid = () => crypto.randomUUID(); // database ids are uuids`.

- [ ] **Step 2: New flights carry the new fields.** In `newFlight()`, add `atd: '', status: 'draft',` after `etd: '',`.

- [ ] **Step 3: State and save.** Replace the state block (`let flights = store.get('lcl.flights', null);` through the end of `function save()`) with:

```js
/* ------------------------------ state ------------------------------ */
// Flights live in Supabase; localStorage keeps only per-viewer choices.
let flights = [];
let currentId = null;
let printPages = { layout: 'one', manifest: true, form: true, ...store.get('lcl.pages', {}) };
let theme = store.get('lcl.theme', 'auto');
const cur = () => flights.find(f => f.id === currentId);
const isClosed = f => f?.status === 'closed';
function save() {
  const f = cur();
  if (f && !isClosed(f)) { f.updated = Date.now(); db.queueSave(f); }
  store.set('lcl.current', currentId); store.set('lcl.pages', printPages);
}

async function boot() {
  const user = await db.currentUser();
  document.body.classList.toggle('signed-out', !user);
  document.getElementById('signin').hidden = !!user;
  if (!user) { setStatus(''); render(); return; }
  try {
    flights = await db.loadFlights();
  } catch (err) {
    // Don't create or save anything: an empty list here would look like lost data.
    console.error(err);
    document.getElementById('view').innerHTML = `<section class="card"><h2>Couldn't load flights</h2>
      <p>${esc(err.message || String(err))}</p><button class="btn primary" data-act="reload">Try again</button></section>`;
    return;
  }
  flights.forEach(db.markSaved);
  if (!flights.length) { const f = newFlight(); flights.push(f); db.queueSave(f, { now: true }); }
  const last = store.get('lcl.current', null);
  currentId = flights.some(f => f.id === last) ? last : flights[0].id;
  render();
}

function setStatus(state, err) {
  const el = document.getElementById('saveStatus');
  el.className = 'save-status' + (state === 'error' ? ' error' : '');
  el.textContent = { saving: 'Saving…', saved: 'Saved', error: 'Not saved — retry' }[state] || '';
  el.title = err?.message || '';
  if (err) console.error(err);
}
db.onSaveStatus(setStatus);
document.getElementById('saveStatus').addEventListener('click', () => db.retrySave());
window.addEventListener('beforeunload', e => { if (db.hasUnsaved()) e.preventDefault(); });

document.getElementById('signinForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('signinError');
  msg.textContent = '';
  try {
    await db.signIn(document.getElementById('signinEmail').value, document.getElementById('signinPassword').value);
    document.getElementById('signinPassword').value = '';
    boot();
  } catch (err) { msg.textContent = err.message || 'Sign-in failed'; }
});
```

Remove `sampleFlight()` (no longer used; M3 seeds data). Keep `newFlight()`.

- [ ] **Step 4: Render.** In `render()`:
  - Move the line that sets `themeBtn.textContent` to the top of `render()`, then return early when there is no flight: `if (!cur()) return;`. The theme button then works on the sign-in screen.
  - Picker label adds the status: change the option text to `` `${esc(x.flightNo || 'New flight')} · ${esc(x.reg || '—')} · ${fmtDate(x.date)}${isClosed(x) ? ' · closed' : ''}` ``.
  - Replace the `view` assignment with:

```js
  const locked = isClosed(f);
  document.getElementById('view').innerHTML =
    (locked ? `<p class="closed-banner">Closed flight — read-only. Duplicate it to make changes.</p><fieldset class="locked" disabled>` : '')
    + viewFlight(f) + viewManifest(f) + viewLoad(f, c) + (locked ? '</fieldset>' : '') + viewPrint();
  document.getElementById('closeBtn').disabled = locked;
  document.getElementById('delBtn').disabled = locked;
```

- [ ] **Step 5: Actual departure field.** In `viewFlight(f)`, after the ETD label add:

```js
    <label class="f">Actual departure<input type="time" data-bind="flight:atd" value="${esc(f.atd || '')}"></label>
    <p class="f hint">${delayMinutes(f.etd, f.atd) ? `Delay: ${delayMinutes(f.etd, f.atd)} min` : ''}</p>
```

- [ ] **Step 6: Guard edits on closed flights.** First line of `setBound(el)`: `if (isClosed(cur()) && !el.dataset.bind.startsWith('pp:')) return;`. In its `case 'flight':` branch, add first `if (a === 'date' && !val) break; // a flight always needs a date` (the re-render puts the old date back). In the `pointerdown` handler at `js/app.js:572`, return at the top when `isClosed(cur())`.

- [ ] **Step 7: Duplicates start as drafts.** In `actions.dupFlight`, add `status: 'draft', atd: ''` to the `Object.assign`. (Switching flights needs no change: each flight has its own pending save.)

- [ ] **Step 8: Delete, close, sign out.** Replace `actions.delFlight` and add two actions:

```js
  delFlight() {
    const f = cur();
    if (isClosed(f)) return false;
    if (!confirm(`Delete flight ${f.flightNo || '(no number)'} on ${fmtDate(f.date)}?`)) return false;
    db.deleteFlight(f.id).then(() => {
      flights = flights.filter(x => x.id !== f.id);
      if (!flights.length) { const nf = newFlight(); flights.push(nf); db.queueSave(nf, { now: true }); }
      currentId = flights[0].id; save(); render();
    }).catch(err => setStatus('error', err));
    return false;
  },
  closeFlight() {
    const f = cur();
    if (isClosed(f) || blockedByLimits()) return false;
    if (!confirm(`Close flight ${f.flightNo || '(no number)'}? It becomes read-only and can't be reopened.`)) return false;
    f.status = 'closed';
    db.queueSave(f, { now: true });
    render();
    return false;
  },
  signOut() {
    db.flush().then(ok => {
      if (!ok && !confirm('Some changes could not be saved. Sign out anyway and lose them?')) return;
      return db.signOut().then(() => { flights = []; currentId = null; boot(); });
    });
    return false;
  },
  reload() { location.reload(); return false; },
```

- [ ] **Step 9: Start.** Replace the final `render();` with `boot();`, and change the `beforeprint` listener to `if (!printing && cur()) fillPrint();` so Cmd+P on the sign-in screen does nothing instead of throwing.

- [ ] **Step 10: Tests still pass** — Run: `npm test` — Expected: all pass.

---

### Task 8: Preview setup

**Files:**
- Modify: `/Users/raph/Documents/Resume/Porter Airlines/.claude/launch.json` (outside the repo)

- [ ] **Step 1: Point the preview at this session's scratchpad.** Set the `cd` path in `runtimeArgs` to `<scratchpad>/site` (the session's scratchpad directory), keeping port 8411.

- [ ] **Step 2: Sync** — Run: `rsync -a --delete --exclude .git --exclude node_modules "/Users/raph/Documents/Resume/Porter Airlines/load-control-lite/" "<scratchpad>/site/"`. Re-run after every code change.

- [ ] **Step 3: Start** with `preview_start {name: "load-control-lite"}`. Expected: the sign-in card, no console errors (`read_console_messages`). If supabase-js fails to load from jsDelivr, stop and report.

---

### Task 9: End-to-end check in the browser

- [ ] **Step 1: User signs in** to the preview pane with the demo user. Claude does not type the password.

- [ ] **Step 2: Claude checks, using the preview tools:**
  1. A first flight appears (database was empty). Fill flight number `214`, registration `C-FNBQ`, ETD `10:30`, actual departure `10:55` → "Delay: 25 min"; status goes `Saving…` → `Saved`.
  2. Manifest: quick-add `YSB c545 b40` and `YTS 310 45 20 60` (tokens are numbers in cargo/post/fast/bag order, or prefixed c/p/f/b), auto-place runs, tags show on the drawn form.
  3. Reload the page: the flight, stops, allocations and tag positions come back unchanged.
  4. `supabase db query --linked "select flight_no, delay_minutes, status from public.flights"` shows the row with `delay_minutes = 25`.
  5. New, Duplicate, switching flights: each persists after reload.
  6. Close flight: confirm, banner shows, inputs disabled, Close/Delete disabled, Print still works. Reload: still closed.
  7. Delete a draft flight: gone after reload.
  8. Network tab (`read_network_requests`): `rpc/save_flight` returns 200; no 4xx.
  9. Sign out: sign-in card; flights hidden.
  10. `scripts/check-debrand.sh ../debrand-terms.txt` passes.

- [ ] **Step 3: Clean up test flights** only if the user asks (M3 replaces the data anyway).

- [ ] **Step 4: Commit (only when the user says so)**

```bash
git add js/ index.html css/app.css package.json supabase/ docs/plans/m2-db.md
git commit -m "M2: flights persist in Supabase behind sign-in"
```

## Added during execution

- Browser testing found that every save was sent twice: a supabase-js query runs each time it is awaited, and `run()` awaited the builder in two places. New flights raced into a duplicate-key error and closing hit the closed check. Fixed by turning the query into one promise (`.then(r => r, error => ({ error }))`) before awaiting. Verified with request logging: one request per save.
- The save status is cleared on the sign-in screen.
- The print dialog itself was not opened during testing; Print stays enabled on closed flights and the print code is unchanged from M0.

## Done when

- `npm test` passes; `save_flight_check.sql` passes and can be made to fail.
- Signed in, every M0 feature works and survives a reload; closed flights are read-only.
- No `service_role` or secret key anywhere in `js/`.

## Known limits (later milestones)

- All flights load at once. After the M3 seed (400–600 flights) the picker needs a date filter or search.
- Last write wins if two people edit the same flight; fine for a one-user demo.
- Flights saved in localStorage by the M0 app (`lcl.flights`) are not imported. The sample flight is gone; an empty database opens one blank flight until M3 seeds data.
- A weight over 9,999,999.9 lb overflows `numeric(8,1)` and the save shows "Not saved" with the database message.
