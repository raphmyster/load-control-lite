# M3: Seed data with planted patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reproducible set of 504 flights over 8 weeks, loaded into Supabase, with the PRD's seven planted patterns and a `seed/ground_truth.json` that lists them; the app's flight list works at that size.

**Architecture:** A Node generator builds app-shaped flight objects from a fixed-seed random number generator and places freight with the app's own `autoPlace()`, moved into a DOM-free module so Node can import it. Each planted pattern is checked on the generated flights, retrying a flight until it fits its role. A loader converts flights with the M2 `toPayload()` and writes them through the Supabase CLI. A verify script reads the database views and compares them with the ground truth.

**Tech Stack:** Node 22 (`node --test`, no dependencies), Supabase CLI 2.122 (`db query --linked`), plain ES modules in the browser.

**Decisions made with the user:**
- The flight list becomes "pick a date, then a flight": a date field next to the dropdown, which lists only that day's flights.
- The loader wipes every flight and reloads the generated set, so a re-run always gives the same database.

**Who does what:** Claude writes and runs everything, including the load (the user approved the wipe). The user signs in to the preview for the browser check. Commit only when the user says so.

**Constraints:**
- Only short regional routes for these turboprops, all from Northbound Air's implied base at Toronto City (YTZ), using codes from `AIRPORTS` in `js/config.js`.
- No real airline data beyond public airport codes. Registrations, names and notes are invented.
- The seed runs as the database owner through the CLI (RLS doesn't apply), so it sets `created_by` to the demo user itself (noted in M1).
- Same seed, same data: no `Math.random()`, no `Date.now()` in generated values.

---

## The data set

| Flight | Route | Form | ETD | Role |
|---|---|---|---|---|
| 101 | YXU | PC12 | 06:45 | normal |
| 214 | YSB-YTS | DH8300 | 07:30 | normal, two stops |
| 301 | YOW | DH8300 | 08:15 | **near limit** (75% of days) |
| 405 | YAM | B1900D19 | 09:00 | **cargo growth** |
| 512 | YTS | B1900D12 | 10:30 | normal |
| 118 | YQG | PC12 | 12:00 | **late freight** notes |
| 620 | YUL | DH8300 | 13:45 | normal |
| 133 | YSB | PC12 | 15:20 | normal |
| 305 | YOW | DH8300 | 17:30 | **near limit** (75% of days) |

9 flights a day × 56 days (Mon 2026-08-31 to Sun 2026-10-25) = 504 flights. All closed except the two flights after 15:00 on the last day, which stay draft so the demo has something editable.

**Planted patterns (PRD section 6):**
1. **Cargo growth:** flight 405 to YAM, cargo about 430 lb a flight in week 1, growing about 9% a week.
2. **Near limit:** on most YOW Dash 8 days, a combined-zone group is at or above 95% of its limit. Auto-place fills Zone 2 first, so on those flights Zone 2 (2A+2B) sits at its 900 lb maximum, and on about half of them the zones 1+2+3 total is also within 5% of 2,400 lb. No other flight is near a group limit.
3. **De-icing cluster:** on Tue 2026-10-20, every flight before 14:00 (7 flights) is 35–95 min late with a de-icing note.
4. **Late freight:** flight 118 to YQG carries a "forwarder freight late" note on about half of days.
5. **Safety notes:** five specific flights carry a handling or safety note.
6. **Data quality:** flight 512 on 2026-09-17 has a second stop with 140 lb of cargo and no destination.
7. **Noise:** about half the remaining flights carry a routine note; about 15% have a small routine delay.

---

## File structure

| File | Responsibility |
|---|---|
| `js/load.js` | Load maths moved out of `app.js`: `compute()`, `autoPlace()` and their helpers. No DOM. |
| `js/load.test.mjs` | Tests that auto-place never breaks a limit and keeps stops whole when it can. |
| `scripts/db-query.mjs` | `query(sql)`: runs `supabase db query --linked` and returns rows. Shared by the sync and seed checks. |
| `scripts/check-forms-sync.mjs` | Modified: uses `scripts/db-query.mjs`. |
| `seed/generate.mjs` | The generator, `limitHits()` and `groundTruth()`. Run as a CLI it prints the ground truth. |
| `seed/generate.test.mjs` | Tests every planted pattern and determinism. |
| `seed/ground_truth.json` | Generated, committed: the answers the AI report should find. |
| `seed/load.mjs` | Wipes flights and loads the generated set through the CLI. |
| `seed/verify.mjs` | Compares the database views with the ground truth. |
| `index.html`, `css/app.css`, `js/app.js` | Modified: date field and a per-day flight list. |
| `package.json` | Modified: test globs and `seed`, `seed:truth`, `seed:verify` scripts. |

---

### Task 1: Move the load maths into `js/load.js` (TDD)

**Files:**
- Create: `js/load.test.mjs`
- Create: `js/load.js`
- Modify: `js/app.js` (remove the moved code, import it)
- Modify: `package.json`

- [ ] **Step 1: Update `package.json` scripts**

```json
  "scripts": {
    "test": "node --test scripts/*.test.mjs js/*.test.mjs seed/*.test.mjs",
    "seed": "node seed/load.mjs",
    "seed:truth": "node seed/generate.mjs > seed/ground_truth.json",
    "seed:verify": "node seed/verify.mjs"
  }
```

- [ ] **Step 2: Write the failing tests** in `js/load.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMS } from './config.js';
import { autoPlace, compute } from './load.js';

// small fixed-seed generator so the test is repeatable
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const flight = (form, rows) => ({ form, rows: rows.map((r, i) => ({ id: 'r' + i, dest: 'YSB', cargo: '', post: '', fast: '', bag: '', ...r })), alloc: {}, pos: {}, manual: false });

test('auto-place never puts more than a zone or group allows, and accounts for every pound', () => {
  const r = rng(7), int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  for (const form of Object.keys(FORMS)) {
    for (let i = 0; i < 200; i++) {
      const f = flight(form, Array.from({ length: int(1, 3) }, () => ({ cargo: String(int(0, 1500)), post: String(int(0, 200)), bag: String(int(0, 500)) })));
      autoPlace(f);
      const c = compute(f);
      c.zones.forEach(z => { if (z.max) assert.ok(c.planned[z.id] <= z.max + 1e-9, `${form} ${z.id} over`); });
      c.groups.forEach(g => assert.ok(g.total <= g.max + 1e-9, `${form} group ${g.id} over`));
      c.rs.forEach(x => x.parts.forEach(p => assert.ok(Math.abs(p.placed + p.unplaced - p.amount) < 1e-6)));
    }
  }
});

test('a stop that fits in one zone stays in one zone', () => {
  const f = flight('DH8300', [{ cargo: '545' }]);
  autoPlace(f);
  assert.deepEqual(f.alloc.r0.cargo, { Z1A: '545' });
});

test('a light load is placed in full', () => {
  const f = flight('PC12', [{ cargo: '545', bag: '40' }, { cargo: '310', post: '45', bag: '60' }]);
  autoPlace(f);
  assert.ok(compute(f).rs.every(x => x.parts.every(p => Math.abs(p.unplaced) < 1e-9)));
});
```

- [ ] **Step 3: Run to see them fail** — Run: `npm test` — Expected: FAIL, `Cannot find module .../js/load.js`. (`seed/*.test.mjs` matching nothing yet is fine; if Node errors on the empty glob, create the seed test in Task 2 first and come back.)

- [ ] **Step 4: Create `js/load.js`** by moving from `js/app.js`, unchanged except for `export`: `sum`, the five helpers under `/* --- calculations --- */` (`formOf`, `kindsOf`, `placeable`, `activeRows`, `allocOf`), `compute()` and `autoPlace()`. Header and imports:

```js
/* Load maths shared by the app and the seed generator: what each zone holds and
   the auto-place rule. No DOM, so Node can run it. */
import { FORMS, SPLIT_KINDS, WHOLE_KIND, FREIGHT_KEYS } from './config.js';
import { n } from './calc.js';

export const sum = a => a.reduce((s, x) => s + x, 0);
export const formOf = f => FORMS[f.form] || FORMS.PC12;
// ... kindsOf, placeable, activeRows, allocOf, compute, autoPlace, each with `export`
```

In `js/app.js`, delete the moved definitions and add after the other imports:
`import { sum, formOf, kindsOf, placeable, activeRows, allocOf, compute, autoPlace } from './load.js';`
Drop `SPLIT_KINDS` and `WHOLE_KIND` from the `config.js` import if `app.js` no longer uses them (`grep -n "SPLIT_KINDS\|WHOLE_KIND" js/app.js`).

- [ ] **Step 5: Run tests** — Run: `npm test` — Expected: all pass. Also `node --check js/app.js`.

---

### Task 2: Generator with planted patterns (TDD)

**Files:**
- Create: `seed/generate.test.mjs`
- Create: `seed/generate.mjs`

- [ ] **Step 1: Write the failing tests** in `seed/generate.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIRPORTS } from '../js/config.js';
import { compute } from '../js/load.js';
import { delayMinutes } from '../js/db-map.js';
import { generate, groundTruth, limitHits, SEED, START, DAYS, DEICE_DAY, LATE_FREIGHT, SAFETY } from './generate.mjs';

const flights = generate();
const gt = groundTruth(flights);
const pattern = id => gt.patterns.find(p => p.id === id);
const codes = new Set(AIRPORTS.map(a => a.code));

test('same seed, same data; another seed differs', () => {
  assert.equal(JSON.stringify(generate()), JSON.stringify(flights));
  assert.notEqual(JSON.stringify(generate(SEED + 1)), JSON.stringify(flights));
});

test('504 flights, 9 a day, over the 8-week window', () => {
  assert.equal(flights.length, 504);
  assert.equal(new Set(flights.map(f => f.date)).size, DAYS);
  assert.equal(flights[0].date, START);
  assert.equal(gt.window.end, '2026-10-25');
});

test('only the two late flights on the last day are drafts', () => {
  const drafts = flights.filter(f => f.status === 'draft');
  assert.deepEqual(drafts.map(f => [f.date, f.flightNo]).sort(), [['2026-10-25', '133'], ['2026-10-25', '305']]);
});

test('every stop has a known airport except the one planted blank', () => {
  const stops = flights.flatMap(f => f.rows.map(r => ({ f, r })));
  const bad = stops.filter(({ r }) => !codes.has(r.dest));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].r.dest, '');
  assert.equal(bad[0].r.cargo, '140');
  assert.deepEqual([bad[0].f.date, bad[0].f.flightNo], ['2026-09-17', '512']);
});

test('no flight is over a limit, and all freight is placed except the planted blank stop', () => {
  for (const f of flights) {
    assert.ok(!limitHits(f).some(h => h.load > h.max), `${f.date} ${f.flightNo} over a limit`);
    const unplaced = compute(f).rs.flatMap(x => x.parts).reduce((s, p) => s + p.unplaced, 0);
    const planted = f.date === '2026-09-17' && f.flightNo === '512';
    assert.equal(Math.round(unplaced), planted ? 140 : 0, `${f.date} ${f.flightNo} unplaced ${unplaced}`);
  }
});

test('pattern 1: flight 405 cargo grows week over week', () => {
  const w = pattern('cargo_growth').weekly_cargo_lb;
  assert.equal(w.length, 8);
  assert.ok(w[7] >= 1.6 * w[0], `growth too small: ${w}`);
  assert.ok(w.slice(1).filter((v, i) => v > w[i]).length >= 6, `not steady: ${w}`);
});

test('pattern 2: only the Dash 8 runs near a combined-zone limit', () => {
  const p = pattern('near_limit');
  assert.ok(p.flights_near / p.of >= 0.3, `${p.flights_near} of ${p.of}`);
  assert.equal(p.other_forms_near, 0);
  const groupNear = f => limitHits(f).some(h => h.kind === 'group');
  assert.ok(!flights.some(f => ['214', '620'].includes(f.flightNo) && groupNear(f)));
});

test('pattern 3: de-icing delay cluster on one day only', () => {
  const p = pattern('deice_delays');
  assert.equal(p.date, DEICE_DAY);
  assert.equal(p.delayed_flights, 7);
  const delayedOn = d => flights.filter(f => f.date === d && delayMinutes(f.etd, f.atd) > 0).length;
  const others = [...new Set(flights.map(f => f.date))].filter(d => d !== DEICE_DAY).map(delayedOn);
  assert.ok(Math.max(...others) <= 5, `another day has ${Math.max(...others)} delays`);
  assert.ok(flights.filter(f => /de-?ic/i.test(f.notes)).every(f => f.date === DEICE_DAY));
});

test('pattern 4: late-freight notes only on flight 118', () => {
  const p = pattern('late_freight');
  assert.ok(p.flights_with_note / p.of >= 0.4, `${p.flights_with_note} of ${p.of}`);
  assert.ok(flights.filter(f => LATE_FREIGHT.some(x => f.notes.includes(x))).every(f => f.flightNo === '118'));
});

test('pattern 5: exactly five safety notes', () => {
  assert.equal(flights.filter(f => SAFETY.some(x => f.notes.includes(x))).length, 5);
  assert.equal(pattern('safety_notes').flights.length, 5);
});

test('pattern 7: routine notes are the bulk', () => {
  const p = pattern('routine_noise');
  assert.ok(p.routine_notes > 150, `${p.routine_notes}`);
});
```

- [ ] **Step 2: Run to see them fail** — Run: `npm test` — Expected: FAIL, `Cannot find module .../seed/generate.mjs`.

- [ ] **Step 3: Write `seed/generate.mjs`**

```js
#!/usr/bin/env node
/* Generates the demo data set: 8 weeks of Northbound Air flights from its Toronto
   City (YTZ) base, with planted patterns for the AI report to find. Same seed, same
   data. Flights are app-shaped objects; seed/load.mjs writes them to Supabase.
   Usage: npm run seed:truth  (writes seed/ground_truth.json) */
import { pathToFileURL } from 'node:url';
import { autoPlace, compute } from '../js/load.js';
import { n } from '../js/calc.js';
import { delayMinutes } from '../js/db-map.js';

export const SEED = 214;
export const START = '2026-08-31';  // a Monday, so weeks line up with date_trunc('week')
export const DAYS = 56;
export const NEAR = 0.95;            // same threshold as v_near_limit
export const DEICE_DAY = '2026-10-20';
const BAD_STOP = ['2026-09-17', '512'];

// kind: which freight profile the flight uses (see freight())
export const SCHEDULE = [
  { no: '101', route: ['YXU'], form: 'PC12', etd: '06:45', kind: 'pc12' },
  { no: '214', route: ['YSB', 'YTS'], form: 'DH8300', etd: '07:30', kind: 'dash' },
  { no: '301', route: ['YOW'], form: 'DH8300', etd: '08:15', kind: 'heavy' },
  { no: '405', route: ['YAM'], form: 'B1900D19', etd: '09:00', kind: 'growth' },
  { no: '512', route: ['YTS'], form: 'B1900D12', etd: '10:30', kind: 'combi' },
  { no: '118', route: ['YQG'], form: 'PC12', etd: '12:00', kind: 'pc12' },
  { no: '620', route: ['YUL'], form: 'DH8300', etd: '13:45', kind: 'dash' },
  { no: '133', route: ['YSB'], form: 'PC12', etd: '15:20', kind: 'pc12' },
  { no: '305', route: ['YOW'], form: 'DH8300', etd: '17:30', kind: 'heavy' },
];
const REGS = {
  PC12: ['C-FNPA', 'C-FNPB', 'C-FNPC'], B1900D19: ['C-GNBA', 'C-GNBB'],
  B1900D12: ['C-GNBC', 'C-GNBD'], DH8300: ['C-FNBQ', 'C-FNBR', 'C-FNBS'],
};
const LOADMASTERS = ['J. Tremblay', 'A. Singh', 'M. Okafor', 'L. Chen', 'S. Roy', 'K. Martin'];
export const ROUTINE = ['Load as planned.', 'Nothing to report.', 'All bags tagged and counted.',
  'Weights checked against manifest.', 'Smooth turn.', 'Cargo secured, nets checked.'];
const MINOR_DELAY = ['Late connecting passengers.', 'ATC flow control at departure.', 'Fuel truck late to the aircraft.',
  'Waited for a late bag transfer.', 'Crew late from the hotel.'];
const DEICE = ['De-icing queue, about {m} min wait.', 'Held for de-ice; pad congested.',
  'Second de-ice application after holdover time ran out.', 'Frost on the wings, de-iced before departure.',
  'De-ice truck shortage, delayed {m} min.'];
export const LATE_FREIGHT = ['Forwarder freight arrived 10 min before ETD.', 'Forwarder cargo late again; loaded at the last minute.',
  'Late freight drop-off from the forwarder, held the door.', 'Forwarder freight arrived after cut-off; accepted to avoid an offload.'];
export const SAFETY = ['Cargo strap frayed; replaced before departure.', 'DG paperwork missing at the gate; shipment offloaded.',
  'Unsecured box found in Zone 3 on the walkaround; secured.', 'Bag cart brakes failing; cart tagged out of service.',
  'Net anchor fitting loose in the AFT hold; maintenance informed.'];
const SAFETY_FLIGHTS = [['2026-09-04', '405'], ['2026-09-15', '620'], ['2026-09-29', '101'], ['2026-10-08', '301'], ['2026-10-22', '512']];

// mulberry32: small, fast, repeatable
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function tools(r) {
  return {
    r,
    int: (lo, hi) => lo + Math.floor(r() * (hi - lo + 1)),
    pick: a => a[Math.floor(r() * a.length)],
    chance: p => r() < p,
    uuid() {
      const h = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16));
      h[12] = '4'; h[16] = '89ab'[Math.floor(r() * 4)];
      const s = h.join('');
      return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    },
  };
}
const addDays = (iso, d) => new Date(Date.parse(iso + 'T00:00:00Z') + d * 864e5).toISOString().slice(0, 10);
const addMins = (hhmm, m) => {
  const t = (((+hhmm.slice(0, 2) * 60 + +hhmm.slice(3) + m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
export const END = addDays(START, DAYS - 1);
const weekOf = date => Math.floor((Date.parse(date) - Date.parse(START)) / 6048e5);

// lb per stop before splitting across a multi-stop route
function freight(t, kind, week) {
  const { int, chance } = t;
  switch (kind) {
    case 'pc12': return { cargo: int(150, 650), post: chance(0.6) ? int(20, 120) : 0, fast: chance(0.4) ? int(10, 60) : 0, bag: int(40, 180) };
    case 'growth': return { cargo: Math.round(430 * 1.09 ** week * (0.92 + 0.16 * t.r())), post: int(30, 90), fast: chance(0.5) ? int(10, 40) : 0, bag: int(120, 220) };
    case 'combi': return { cargo: int(400, 1100), post: chance(0.7) ? int(30, 150) : 0, fast: chance(0.5) ? int(10, 80) : 0, bag: int(80, 200) };
    case 'dash': return { cargo: int(450, 1000), post: int(40, 150), fast: int(20, 90), bag: int(150, 350) };
    case 'heavy': return { cargo: int(1600, 1800), post: int(80, 160), fast: int(30, 90), bag: int(330, 450) };
  }
  throw new Error('unknown freight kind ' + kind);
}

// Zone and group loads at or above NEAR of their max. Mirrors v_near_limit.
export function limitHits(f) {
  const c = compute(f), hits = [];
  c.form.zones.forEach(z => { const v = c.planned[z.id] || 0; if (z.max && v >= NEAR * z.max) hits.push({ kind: 'zone', id: z.id, load: v, max: z.max }); });
  c.groups.forEach(g => { if (g.total >= NEAR * g.max) hits.push({ kind: 'group', id: g.id, load: g.total, max: g.max }); });
  return hits;
}
const groupNear = f => limitHits(f).some(h => h.kind === 'group');
const fullyPlaced = f => compute(f).rs.every(x => x.parts.every(p => Math.abs(p.unplaced) < 0.05));

function makeFlight(t, s, date, kind) {
  const share = 1 / s.route.length;
  const rows = s.route.map(dest => {
    const w = freight(t, kind, weekOf(date));
    return { id: t.uuid(), dest, ...Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v ? String(Math.round(v * share)) : ''])) };
  });
  const f = {
    id: t.uuid(), date, flightNo: s.no, reg: t.pick(REGS[s.form]), form: s.form, etd: s.etd, atd: '',
    special: { hr: t.chance(0.01), aog: t.chance(0.02) }, dgNote: t.chance(0.85) ? 'na' : 'crew',
    rows, alloc: {}, pos: {}, manual: false, notes: '', loadmaster: t.pick(LOADMASTERS), status: 'closed',
  };
  autoPlace(f);
  return f;
}

export function generate(seed = SEED) {
  const t = tools(rng(seed));
  const flights = [];
  for (let d = 0; d < DAYS; d++) {
    const date = addDays(START, d);
    for (const s of SCHEDULE) {
      const heavy = s.kind === 'heavy' && t.chance(0.75);
      const kind = s.kind === 'heavy' && !heavy ? 'dash' : s.kind;
      // retry until the flight fits its role: everything placed, nothing over,
      // near a group limit only when planted
      for (let tries = 0; ; tries++) {
        const f = makeFlight(t, s, date, kind);
        if (fullyPlaced(f) && !limitHits(f).some(h => h.load > h.max) && groupNear(f) === heavy) { flights.push(f); break; }
        if (tries > 500) throw new Error(`could not generate flight ${s.no} on ${date} (heavy=${heavy})`);
      }
    }
  }
  annotate(t, flights);
  return flights;
}

function annotate(t, flights) {
  for (const f of flights) {
    let delay = 0, note = '';
    if (f.date === DEICE_DAY && f.etd < '14:00') { delay = t.int(35, 95); note = t.pick(DEICE).replace('{m}', delay); }
    else if (f.flightNo === '118' && t.chance(0.55)) { delay = t.chance(0.7) ? t.int(5, 20) : 0; note = t.pick(LATE_FREIGHT); }
    else if (f.date !== DEICE_DAY && t.chance(0.15)) { delay = t.int(5, 25); note = t.pick(MINOR_DELAY); } // keep the cluster clean
    else if (t.chance(0.5)) note = t.pick(ROUTINE);
    f.atd = addMins(f.etd, delay > 0 ? delay : -t.int(0, 3)); // on time or a few minutes early
    f.notes = note;
    if (f.date === END && f.etd >= '15:00') Object.assign(f, { status: 'draft', atd: '', notes: '' });
  }
  SAFETY_FLIGHTS.forEach(([date, no], i) => {
    const f = flights.find(x => x.date === date && x.flightNo === no);
    f.notes = (f.notes ? f.notes + ' ' : '') + SAFETY[i];
  });
  // data-quality problem: weights typed on a row with no destination, never placed
  const bad = flights.find(x => x.date === BAD_STOP[0] && x.flightNo === BAD_STOP[1]);
  bad.rows.push({ id: t.uuid(), dest: '', cargo: '140', post: '', fast: '', bag: '' });
}

export function groundTruth(flights, seed = SEED) {
  const cargoLb = f => f.rows.reduce((s, r) => s + n(r.cargo), 0);
  const count = (xs, p) => xs.filter(p).length;
  const dash = flights.filter(f => f.form === 'DH8300');
  const near = dash.filter(groupNear);
  const byGroup = {};
  near.forEach(f => limitHits(f).filter(h => h.kind === 'group').forEach(h => { byGroup[h.id] = (byGroup[h.id] || 0) + 1; }));
  const deice = flights.filter(f => f.date === DEICE_DAY && delayMinutes(f.etd, f.atd) > 0);
  const f118 = flights.filter(f => f.flightNo === '118');
  return {
    seed, base: 'YTZ', window: { start: START, end: END }, flights: flights.length,
    routes: SCHEDULE.map(s => ({ flight_no: s.no, route: s.route.join('-'), form: s.form, etd: s.etd })),
    patterns: [
      { id: 'cargo_growth', description: 'Cargo on flight 405 to YAM (1900D 19-seat) grows week over week.',
        flight_no: '405', route: 'YAM',
        weekly_cargo_lb: Array.from({ length: DAYS / 7 }, (_, w) => flights.filter(f => f.flightNo === '405' && weekOf(f.date) === w).reduce((s, f) => s + cargoLb(f), 0)) },
      { id: 'near_limit', description: 'Dash 8-300 flights on the YOW route regularly load at or within 5% of a combined-zone limit: Zone 2 (2A+2B) filled to its 900 lb maximum, and on about half of them zones 1+2+3 within 5% of 2,400 lb.',
        form: 'DH8300', flights_near: near.length, of: dash.length, by_group: byGroup,
        by_flight_no: Object.fromEntries(['214', '301', '620', '305'].map(no => [no, count(near, f => f.flightNo === no)])),
        other_forms_near: count(flights, f => f.form !== 'DH8300' && groupNear(f)) },
      { id: 'deice_delays', description: 'A cluster of de-icing delays on one day.', date: DEICE_DAY,
        delayed_flights: deice.length, total_delay_minutes: deice.reduce((s, f) => s + delayMinutes(f.etd, f.atd), 0), cause: 'de-icing' },
      { id: 'late_freight', description: 'Recurring notes about late forwarder freight on one route.', flight_no: '118', route: 'YQG',
        flights_with_note: count(f118, f => LATE_FREIGHT.some(x => f.notes.includes(x))), of: f118.length },
      { id: 'safety_notes', description: 'Notes raising a handling or safety concern.',
        flights: SAFETY_FLIGHTS.map(([date, no], i) => ({ date, flight_no: no, note: SAFETY[i] })) },
      { id: 'data_quality', description: 'A stop with weights but no destination.', date: BAD_STOP[0], flight_no: BAD_STOP[1],
        issue: 'second stop has 140 lb of cargo and a blank destination; the freight was never placed' },
      { id: 'routine_noise', description: 'Routine notes and small delays with nothing to report.',
        routine_notes: count(flights, f => ROUTINE.includes(f.notes)), empty_notes: count(flights, f => !f.notes) },
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(groundTruth(generate()), null, 2) + '\n');
}
```

- [ ] **Step 4: Run tests** — Run: `npm test` — Expected: all pass. If a pattern test fails, change the generator's ranges or probabilities (for example the `heavy` cargo range, or the 0.15 minor-delay chance), never the test's thresholds, and say what changed in the plan's "Added during execution" section.

- [ ] **Step 5: Write the ground truth** — Run: `npm run seed:truth && head -40 seed/ground_truth.json`. Expected (checked against the plan during review): 504 flights; `weekly_cargo_lb` [3089, 3275, 3518, 3743, 4236, 4697, 5017, 5583]; `near_limit` 83 of 224 (z2 83, all 41; only 301 and 305); `deice_delays` 7 flights, 467 min; `late_freight` 28 of 56; `other_forms_near` 0.

---

### Task 3: Shared CLI query helper

**Files:**
- Create: `scripts/db-query.mjs`
- Modify: `scripts/check-forms-sync.mjs`

- [ ] **Step 1: Write `scripts/db-query.mjs`**

```js
/* Runs SQL against the linked Supabase project through the CLI and returns the rows.
   Uses the saved CLI login; never needs the database password. */
import { execFileSync } from 'node:child_process';

// On a SQL error the CLI prints {"_tag":"Error",...} on stdout and exits 1, so the
// real message is in the thrown error's stdout, not stderr.
function cli(args) {
  try {
    return execFileSync('supabase', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    let msg = e.stdout || e.message;
    try { msg = JSON.parse(e.stdout).error?.message || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
}

export function query(sql) {
  return JSON.parse(cli(['db', 'query', '--linked', '--output-format', 'json', sql])).rows; // numerics arrive as strings
}

export const runFile = file => cli(['db', 'query', '--linked', '-f', file]);
```

- [ ] **Step 2: Use it in `scripts/check-forms-sync.mjs`**: replace its `execFileSync` import and local `query` function with `import { query } from './db-query.mjs';`.

- [ ] **Step 2b: Check errors surface** — Run: `node -e "import('./scripts/db-query.mjs').then(m => m.query('select nope'))"` — Expected: an error mentioning `column \"nope\" does not exist`, not just "Initialising login role".

- [ ] **Step 3: Run** `node scripts/check-forms-sync.mjs` — Expected: `Form limits in the database match js/config.js.`

---

### Task 4: Loader

**Files:**
- Create: `seed/load.mjs`

- [ ] **Step 1: Write `seed/load.mjs`**

```js
#!/usr/bin/env node
/* Wipes every flight in the linked Supabase project and loads the generated seed.
   Runs through the Supabase CLI as the database owner, so RLS doesn't apply and
   created_by is set to the demo user here. Usage: npm run seed */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from './generate.mjs';
import { toPayload } from '../js/db-map.js';
import { runFile } from '../scripts/db-query.mjs';

const CHUNK = 100; // flights per request, to keep each request small
const TAG = '$seed$';
const dir = mkdtempSync(join(tmpdir(), 'lcl-seed-'));
const run = (name, sql) => { const file = join(dir, name); writeFileSync(file, sql); runFile(file); };

// Same columns and casts as save_flight(), plus created_by.
const chunkSql = payloads => `begin;
create temp table seed_src (p jsonb) on commit drop;
insert into seed_src select jsonb_array_elements(${TAG}${JSON.stringify(payloads)}${TAG}::jsonb);

insert into public.flights (id, flight_date, flight_no, registration, form_id, etd, actual_departure, delay_minutes,
  special_hr, special_aog, dg_note, loadmaster, notes, manual_alloc, tag_positions, status, created_by)
select (p->>'id')::uuid, (p->>'flight_date')::date, p->>'flight_no', p->>'registration', p->>'form_id',
  nullif(p->>'etd', '')::time, nullif(p->>'actual_departure', '')::time, (p->>'delay_minutes')::int,
  (p->>'special_hr')::boolean, (p->>'special_aog')::boolean, p->>'dg_note', p->>'loadmaster', p->>'notes',
  (p->>'manual_alloc')::boolean, p->'tag_positions', p->>'status',
  (select id from auth.users order by created_at limit 1)
from seed_src;

insert into public.flight_stops (id, flight_id, seq, dest, cargo_lb, post_lb, fast_lb, bag_lb, raw_entry)
select (s->>'id')::uuid, (p->>'id')::uuid, (t.ord - 1)::int, s->>'dest',
  (s->>'cargo_lb')::numeric, (s->>'post_lb')::numeric, (s->>'fast_lb')::numeric, (s->>'bag_lb')::numeric, s->'raw_entry'
from seed_src, jsonb_array_elements(p->'stops') with ordinality as t(s, ord);

insert into public.zone_allocations (flight_id, stop_id, kind, zone_id, weight_lb)
select (p->>'id')::uuid, (a->>'stop_id')::uuid, a->>'kind', a->>'zone_id', (a->>'weight_lb')::numeric
from seed_src, jsonb_array_elements(p->'allocations') as a;
commit;
`;

const payloads = generate().map(toPayload);
if (payloads.some(p => JSON.stringify(p).includes(TAG))) throw new Error(`seed text contains ${TAG}`);

run('00-wipe.sql', `do $$ begin
  if not exists (select 1 from auth.users) then raise exception 'No demo user: create one under Authentication first'; end if;
end $$;
delete from public.flights;`);
console.log('wiped flights');
for (let i = 0; i < payloads.length; i += CHUNK) {
  run(`chunk-${String(i).padStart(3, '0')}.sql`, chunkSql(payloads.slice(i, i + CHUNK)));
  console.log(`loaded ${Math.min(i + CHUNK, payloads.length)} / ${payloads.length}`);
}
```

If a chunk fails, earlier chunks stay loaded; re-running the loader wipes and starts again.

- [ ] **Step 2: Load** — Run: `npm run seed` — Expected: `wiped flights`, then `loaded 100 / 504` … `loaded 504 / 504`. If the first chunk is rejected for size, set `CHUNK = 50` and re-run.

---

### Task 5: Verify the database against the ground truth

**Files:**
- Create: `seed/verify.mjs`

- [ ] **Step 1: Write `seed/verify.mjs`**

```js
#!/usr/bin/env node
/* Checks the loaded database against the ground truth, through the same SQL views
   the AI report will read. A mismatch means the views and the app's load maths
   disagree, or the load went wrong. Usage: npm run seed:verify */
import { generate, groundTruth, LATE_FREIGHT } from './generate.mjs';
import { query } from '../scripts/db-query.mjs';

const gt = groundTruth(generate());
const p = id => gt.patterns.find(x => x.id === id);
const one = sql => Number(Object.values(query(sql)[0])[0]);
const lit = s => `'${s.replace(/'/g, "''")}'`;
let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) failed++;
};

check('flights', one('select count(*) from public.flights'), gt.flights);
check('drafts', one(`select count(*) from public.flights where status = 'draft'`), 2);
check('cargo growth, flight 405 by week',
  query(`select cargo_lb from public.v_route_week where route = 'YAM' order by week_start`).map(r => Number(r.cargo_lb)),
  p('cargo_growth').weekly_cargo_lb);
check('Dash 8 flights near a group limit',
  one(`select count(distinct flight_id) from public.v_near_limit where form_id = 'DH8300' and limit_kind = 'group'`),
  p('near_limit').flights_near);
check('other forms near a group limit',
  one(`select count(distinct flight_id) from public.v_near_limit where form_id <> 'DH8300' and limit_kind = 'group'`), 0);
check(`delayed flights on ${p('deice_delays').date}`,
  one(`select delayed_flights from public.v_delays where flight_date = '${p('deice_delays').date}'`),
  p('deice_delays').delayed_flights);
check('late-freight notes on 118',
  one(`select count(*) from public.flights where flight_no = '118' and notes in (${LATE_FREIGHT.map(lit).join(', ')})`),
  p('late_freight').flights_with_note);
check('stops with weight and no destination',
  one(`select count(*) from public.flight_stops where dest = '' and cargo_lb + post_lb + fast_lb + bag_lb > 0`), 1);

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('Database matches seed/ground_truth.json.');
```

- [ ] **Step 2: Run** — `npm run seed:verify` — Expected: every line `ok`, then `Database matches seed/ground_truth.json.`

- [ ] **Step 3: Advisor** — `supabase db advisors --linked --type performance </dev/null` and note anything about the new data volume (expected: none that block).

---

### Task 6: Pick a date, then a flight

**Files:**
- Modify: `index.html`
- Modify: `css/app.css`
- Modify: `js/app.js`

- [ ] **Step 1: `index.html`** — add before `<select id="flightPick"`:

```html
  <input type="date" id="dayPick" class="needs-auth" aria-label="Flight date">
```

- [ ] **Step 2: `css/app.css`** — change the selector `.topbar select {` to `.topbar select, .topbar input[type="date"] {` and append:

```css
.topbar input[type="date"] { color-scheme: dark; }
```

- [ ] **Step 3: `js/app.js`** — add a helper next to `cur`:

```js
// a day's flights in departure order
const byEtd = (a, b) => (a.etd || '99').localeCompare(b.etd || '99') || a.updated - b.updated;
const flightsOn = day => flights.filter(x => x.date === day).sort(byEtd);
```

In `render()`, replace the `flightPick` `innerHTML` assignment with:

```js
  document.getElementById('dayPick').value = f.date;
  document.getElementById('flightPick').innerHTML = flightsOn(f.date)
    .map(x => `<option value="${x.id}" ${x.id === currentId ? 'selected' : ''}>${esc(x.flightNo || 'New flight')} · ${esc(x.reg || '—')} · ${esc(x.etd || '--:--')}${isClosed(x) ? ' · closed' : ''}</option>`).join('');
```

Add the listener next to the `flightPick` one:

```js
// pick a day: open its first flight; a day with no flights says so and stays put
document.getElementById('dayPick').addEventListener('change', e => {
  const el = e.target;
  if (!(el.valueAsDate?.getUTCFullYear() > 2000)) return; // still typing the year
  const first = flightsOn(el.value)[0];
  if (!first) {
    el.setCustomValidity('No flights on this day'); el.reportValidity();
    setTimeout(() => { el.setCustomValidity(''); el.value = cur().date; }, 1500);
    return;
  }
  currentId = first.id; save(); render();
});
```

In `actions.delFlight`, replace `currentId = flights[0].id;` with `currentId = flightsOn(flights[0].date)[0].id;` so a delete lands on the first flight of the newest day.

In `boot()`, open the latest day's first flight when there is no remembered one: replace `currentId = flights.some(f => f.id === last) ? last : flights[0].id;` with

```js
  currentId = flights.some(f => f.id === last) ? last : flightsOn(flights[0].date)[0].id; // flights load newest date first
```

- [ ] **Step 4:** `npm test`, `node --check js/app.js`, `scripts/check-debrand.sh ../debrand-terms.txt`.

---

### Task 7: Browser check

- [ ] **Step 1:** Sync the preview: `rsync -a --delete --exclude .git --exclude node_modules ./ <scratchpad>/site/`; reload the preview tab.
- [ ] **Step 2: User signs in** in the browser pane.
- [ ] **Step 3: Claude checks:**
  1. Opens on 25 Oct with 9 flights in departure order; 133 and 305 are drafts, the rest show `· closed`.
  2. Date 20 Oct: de-icing notes and delays on the morning flights.
  3. Date 17 Sep, flight 512: the manifest shows the blank stop with 140 lb and the app's "Check" warning.
  4. A YOW Dash 8 flight with a group near its limit: the load form shows the combined total close to its max.
  5. A date with no flights (e.g. 1 Aug): the field says "No flights on this day" and stays on the current flight.
  6. Load time from sign-in to first render (`performance` timing); note it in the plan if over 3 s.
  7. New flight: the date jumps to today and the list shows today's flights; autosave still works; delete it afterwards.
  8. No console errors; every `supabase.co` request is 2xx.
- [ ] **Step 4: Commit (only when the user says so)**

```bash
git add js/ seed/ scripts/ index.html css/app.css package.json docs/plans/m3-seed.md
git commit -m "M3: reproducible seed data with planted patterns"
```

## Added during execution

- Built as planned. `js/load.js` matches the reviewer's tested copy; 26 tests pass; `seed/ground_truth.json` matches the numbers checked in review.
- `npm run seed` loaded 504 flights in six requests; `npm run seed:verify` matched on every check.
- Performance advisor: `multiple_permissive_policies` on `flight_stops` and `zone_allocations`. The "write ... of draft flights" policies are `for all`, so reads run their draft check alongside the plain read policy. Fixed in a follow-up migration that splits them into insert, update and delete.
- Browser check passed. Opening on a remembered flight (from the user's own clicks) is intended; with nothing remembered it opens on 25 Oct.

## Done when

- `npm test` passes, including every planted-pattern test.
- `npm run seed` loads 504 flights; `npm run seed:verify` reports a match through the SQL views.
- `seed/ground_truth.json` is committed and matches `npm run seed:truth` output.
- The app opens on the latest day, and every day is reachable through the date field.

## Known limits

- All 504 flights load at sign-in (one request). Fine for the demo; a real ops tool would load by date range.
- Zone-level near-limit rows (a single zone filled to its max by auto-place) are common in `v_near_limit` and are not a planted pattern; the report should weigh group limits.
- On planted flights Zone 2 is always exactly at its 900 lb maximum, because auto-place fills it first. That's at the limit, not just near it, and is how the app's own placement behaves.
- The retry loop rejects flights that don't fit their role, which trims the heaviest 'dash' loads on 214 and 620. Record retry counts per flight number in "Added during execution" if any exceed 3 per flight on average.
