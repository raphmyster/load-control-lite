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
