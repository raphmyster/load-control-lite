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

test('readAnswers rounds probabilities to the 3 places the table keeps', () => {
  const { label } = readAnswers({ ...ANSWERS, mention: { type: 'noul', noul: 0.49962 } });
  assert.equal(label.mention_p, 0.5);
  assert.equal(decide(label, false, 0.7).reason, 'jev_mention');
});

test('decide: a NaN threshold sends unsure flights instead of dropping them', () => {
  assert.equal(decide({ ...LABEL, mention_p: 0.05 }, false, NaN).reason, 'low_confidence');
});

test('runJev: a NaN or 0 concurrency still asks about every flight', async () => {
  for (const concurrency of [NaN, 0]) {
    const results = await runJev({ flights: [fl('a'), fl('b')], concurrency,
      ask: async () => ({ ok: true, status: 'ok', answers: ANSWERS }) });
    assert.equal(results.filter(r => r?.label).length, 2, String(concurrency));
  }
});
