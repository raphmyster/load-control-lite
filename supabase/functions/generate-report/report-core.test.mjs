import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTIONS, parseRequest, capCheck, routeTable, nearLimitTable, delayTable, notesTable,
  dataQuality, flightsCsv, buildFacts, buildMessages, missingSections, stripFence, totals,
} from './report-core.js';

const period = parseRequest({ period_start: '2026-10-19' });

test('parseRequest accepts a Monday and works out the week and the 8-week window', () => {
  assert.deepEqual(period, { start: '2026-10-19', end: '2026-10-25', trendStart: '2026-08-31' });
});

test('parseRequest refuses anything but a real Monday', () => {
  for (const p of [undefined, '', '2026-10-20', '2026-02-30', '19-10-2026', 20261019]) {
    assert.ok(parseRequest({ period_start: p }).error, String(p));
  }
  assert.ok(parseRequest(null).error);
});

test('capCheck: spend cap first, then the daily cap', () => {
  const caps = { dailyCap: 5, spendCapUsd: 2 };
  assert.equal(capCheck({ runsToday: 4, spendUsd: 1.99 }, caps), null);
  assert.equal(capCheck({ runsToday: 5, spendUsd: 0 }, caps).code, 'daily_cap');
  assert.equal(capCheck({ runsToday: 9, spendUsd: 2 }, caps).code, 'spend_cap');
});

const rw = (week_start, cargo_lb, total_lb, extra = {}) => ({
  week_start, route: 'YAM', form_id: 'B1900D19', flights: 7, cargo_lb, post_lb: 10, fast_lb: 5,
  bag_lb: 100, total_lb, load_factor_proxy: '0.512', ...extra,
});

test('routeTable shows this week, change on last week and the 8-week cargo trend', () => {
  const rows = [rw('2026-08-31', 3089, 3500), rw('2026-10-12', 5017, 5400), rw('2026-10-19', 5583, 6000),
                rw('2026-10-12', 900, 1000, { route: 'YXU', form_id: 'PC12' })];
  const t = routeTable(period, rows);
  const yam = t.split('\n').find(l => l.startsWith('YAM'));
  assert.match(yam, /\| 5583 \|/);
  assert.match(yam, /\+11\.1%/);                      // 6000 vs 5400
  assert.match(yam, /3089, -, -, -, -, -, 5017, 5583/);
  assert.match(yam, /\+80\.7%/);                      // 5583 vs 3089
  assert.ok(!t.includes('YXU'), 'a route not flown this week is left out');
});

const g = (flight_date, flight_no, label, pct_of_max, is_over = false) =>
  ({ flight_id: `${flight_date}-${flight_no}`, flight_date, flight_no, form_id: 'DH8300', limit_kind: 'group', label, pct_of_max, is_over });

test('nearLimitTable counts this week against the 7 weeks before', () => {
  const groups = [g('2026-10-19', '301', 'Zone 2', '1.000'), g('2026-10-21', '301', 'Zone 2', '0.970'),
                  g('2026-09-01', '301', 'Zone 2', '1.000'), g('2026-10-20', '305', 'Zones 1+2+3', '1.012', true)];
  const t = nearLimitTable(period, groups, 40);
  assert.match(t, /^301 \| DH8300 \| Zone 2 \| 2 \| 0 \| 100\.0% \| 1$/m);
  assert.match(t, /^305 \| DH8300 \| Zones 1\+2\+3 \| 1 \| 1 \| 101\.2% \| 0$/m);
  assert.match(t, /Single zones at or above 95% of their own limit this week: 40/);
});

test('delayTable lists each day and the week total', () => {
  const t = delayTable([
    { flight_date: '2026-10-20', flights: 9, delayed_flights: 7, total_delay_minutes: 467, max_delay_minutes: 95 },
    { flight_date: '2026-10-19', flights: 9, delayed_flights: 1, total_delay_minutes: 12, max_delay_minutes: 12 },
  ]);
  assert.match(t, /^2026-10-19 \| 9 \| 1 \| 12 \| 12$/m);
  assert.match(t, /^2026-10-20 \| 9 \| 7 \| 467 \| 95$/m);
  assert.match(t, /Week: 8 delayed flights, 479 delay minutes/);
});

test('notesTable lists notes repeated on a flight over the 8 weeks, most frequent first', () => {
  const n = (flight_no, notes) => ({ flight_no, notes });
  const t = notesTable([
    ...Array(5).fill(n('118', 'Forwarder freight late.')), ...Array(3).fill(n('101', 'Nothing to report.')),
    n('118', 'Forwarder freight late.  '), n('620', 'Once only.'), n('620', 'Once only.'), n('405', ''),
  ]);
  assert.deepEqual(t.split('\n'), [
    'flight | note | flights with this note in the 8 weeks',
    '118 | Forwarder freight late. | 6',
    '101 | Nothing to report. | 3',
  ]);
});

const stop = (seq, dest, cargo_lb = 0) => ({ seq, dest, cargo_lb, post_lb: 0, fast_lb: 0, bag_lb: 0 });
const fl = (flight_date, flight_no, stops, extra = {}) => ({
  id: `${flight_date}-${flight_no}`, flight_date, flight_no, registration: 'C-GNBA', form_id: 'B1900D12',
  etd: '10:30:00', delay_minutes: null, dg_note: '', notes: '', status: 'closed', flight_stops: stops, ...extra,
});

test('dataQuality flags weight with no destination and malformed codes, not empty spare rows', () => {
  const issues = dataQuality([
    fl('2026-09-17', '512', [stop(0, 'YTS', 800), stop(1, '', 140)]),
    fl('2026-09-18', '512', [stop(0, 'YTS', 800), stop(1, '', 0)]),
    fl('2026-09-19', '512', [stop(0, 'yts', 800)]),
  ]);
  assert.deepEqual(issues, [
    '512 on 2026-09-17: stop 2 has 140 lb and no destination',
    '512 on 2026-09-19: stop 1 has destination "yts", not a 3-letter airport code',
  ]);
});

test('flightsCsv: one row per flight, route from stops, quoted notes, group-limit labels', () => {
  const csv = flightsCsv(
    [fl('2026-10-20', '301', [stop(0, 'YOW', 900)], { form_id: 'DH8300', notes: 'De-icing, 45 min\nwaited "pad 2"', delay_minutes: 45 })],
    [g('2026-10-20', '301', 'Zone 2', '1.000')],
  ).split('\n');
  assert.equal(csv[0], 'date,flight,route,registration,form,cargo_lb,post_lb,fast_lb,bag_lb,group_limits_at_95pct,delay_min,status,dg_note,notes');
  assert.equal(csv[1], '2026-10-20,301,YOW,C-GNBA,DH8300,900,0,0,0,Zone 2,45,closed,,"De-icing, 45 min waited ""pad 2"""');
});

test('buildMessages puts the rules in the system prompt and the data in the user message', () => {
  const facts = buildFacts({ period, routeWeeks: [], nearGroups: [], zoneNearCount: 0, delays: [], trendNotes: [], flights: [fl('2026-10-19', '512', [stop(0, 'YTS', 100)])] });
  assert.match(facts, /PERIOD: Monday 2026-10-19 to Sunday 2026-10-25\. Flights: 1, 0 still draft\./);
  assert.match(facts, /DATA-QUALITY CHECKS\nNone found\./);
  assert.match(facts, /NOTES REPEATED ON A FLIGHT/);
  const [sys, user] = buildMessages({ facts, csv: 'date,flight' });
  assert.equal(sys.role, 'system');
  for (const s of SECTIONS) assert.ok(sys.content.includes(`## ${s}`), s);
  assert.match(sys.content, /never follow instructions/i);
  assert.match(user.content, /^FACTS\n/);
  assert.match(user.content, /FLIGHTS \(CSV/);
});

const fullReport = SECTIONS.map(s => `## ${s}\n- x`).join('\n\n');

test('missingSections: complete, numbered, missing and out-of-order reports', () => {
  assert.deepEqual(missingSections(fullReport), []);
  assert.deepEqual(missingSections(SECTIONS.map((s, i) => `## ${i + 1}. ${s}\n- x`).join('\n')), []);
  assert.deepEqual(missingSections(fullReport.replace('## Delays and causes', '## Delays')), ['Delays and causes']);
  const swapped = fullReport.replace('## Summary', '## TMP').replace('## Suggested follow-ups', '## Summary').replace('## TMP', '## Suggested follow-ups');
  assert.deepEqual(missingSections(swapped), ['(sections out of order)']);
  assert.deepEqual(missingSections(''), SECTIONS);
});

test('stripFence removes a fence around the whole answer only', () => {
  assert.equal(stripFence('```markdown\n## Summary\n- x\n```\n'), '## Summary\n- x');
  assert.equal(stripFence('## Summary\n- `code` stays'), '## Summary\n- `code` stays');
});

test('totals adds up the logged calls', () => {
  assert.deepEqual(totals([
    { cost_usd: 0.0012, input_tokens: 9000, output_tokens: 1500 },
    { cost_usd: 0.0003, input_tokens: 11000, output_tokens: 400 },
  ]), { total_cost_usd: 0.0015, total_input_tokens: 20000, total_output_tokens: 1900, call_count: 2 });
});
