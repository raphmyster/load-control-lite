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
