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

test('shouldAlert: urgency at the threshold (default 4) alerts, just under it does not', () => {
  assert.deepEqual(shouldAlert(label({ category: 'handling_issue', urgency: 4 }), fl()), { alert: true, reason: 'urgency' });
  assert.deepEqual(shouldAlert(label({ category: 'delay_weather', urgency: 3.9 }), fl()), { alert: false, reason: null });
  assert.deepEqual(shouldAlert(label({ category: 'delay_weather', urgency: 3 }), fl(), 3), { alert: true, reason: 'urgency' });
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
  const u = alertEmail({ flight: fl(), label: label({ category: 'handling_issue', urgency: 4.2 }), reason: 'urgency', appUrl: 'u' });
  assert.match(u.subject, /^Follow-up alert/);
  assert.match(u.text, /rated follow-up urgency 4\.2 of 5/);
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
