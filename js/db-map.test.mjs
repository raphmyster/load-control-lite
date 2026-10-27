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
