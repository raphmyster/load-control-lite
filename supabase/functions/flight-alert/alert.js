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
// decide(): without a usable label, any note at all is enough. The default of 4 ("follow up
// within a day") comes from the M5 labels: only safety flights reached it, while weather and
// freight delays reached 3 and can wait for the weekly report.
export function shouldAlert(label, flight, minUrgency = 4) {
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
  const no = oneLine(f.flight_no, 12) || '(no number)';
  const kind = reason === 'safety_concern' ? 'Safety' : 'Follow-up';
  const subject = oneLine(`${kind} alert: flight ${no} on ${f.flight_date}`, 120);
  const text = [
    `Flight ${no} on ${f.flight_date}, ${oneLine(f.registration, 12) || 'no registration'}, route ${routeOf(f) || '?'}, was closed.`,
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
