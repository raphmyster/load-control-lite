/* Mode B (hybrid): Jev labels every flight of the week, code decides which flights Claude
   reads, and Claude writes the report from those plus the same SQL facts as Mode A.
   Pure apart from the injected `ask`, so `node --test` covers all of it. */
import { stopWeight, usedStops, routeOf, stopIssues } from './report-core.js';

export const CATEGORIES = ['routine', 'delay_weather', 'delay_freight', 'delay_maintenance',
  'handling_issue', 'safety_concern', 'data_quality', 'other'];

// The three typed questions every flight gets. Keys are the answer names Jev sends back.
export const QUESTIONS = {
  category: {
    type: 'choice',
    instructions: "Which category best fits this flight's loadmaster note and DG note?",
    criteria: {
      routine: 'Normal operation; nothing the ops manager needs to know',
      delay_weather: 'A delay caused by weather or de-icing',
      delay_freight: 'A delay or problem caused by freight arriving late or not being ready',
      delay_maintenance: 'A delay caused by a technical or maintenance issue with the aircraft',
      handling_issue: 'Damaged equipment, wrong loading, or another ground-handling problem',
      safety_concern: 'A safety or dangerous-goods concern, such as missing DG paperwork',
      data_quality: 'The flight record itself looks wrong or incomplete',
      other: 'Notable, but none of the above',
    },
  },
  mention: {
    type: 'noul',
    instructions: 'Should this flight be mentioned in the weekly operations report for the load control team?',
    criteria: {
      true: 'Yes: a delay with a stated cause, a handling or safety issue, a problem likely to recur, or a record error',
      false: 'No: a routine flight with nothing the ops manager needs to see',
    },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgently does someone need to follow up on this flight?',
    criteria: [
      'No follow-up needed',
      'Worth knowing, no action',
      'Follow up this week',
      'Follow up within a day',
      'Act now: a safety risk',
    ],
  },
};

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// What Jev sees for one flight. Notes are clipped so a pasted wall of text can't push a
// request past ~32 KB, where Jev switches to its slower, less accurate long-context mode.
export function flightState(f) {
  return {
    flight: f.flight_no,
    date: f.flight_date,
    route: routeOf(f),
    aircraft_form: f.form_id,
    freight_lb: Math.round(usedStops(f).reduce((t, s) => t + stopWeight(s), 0)),
    delay_min: f.delay_minutes ?? 0,
    dg_note: clip(f.dg_note, 500),
    loadmaster_note: clip(f.notes, 2000),
  };
}

const prob = v => typeof v === 'number' && v >= 0 && v <= 1;
const r3 = v => v == null ? null : Math.round(v * 1000) / 1000;

// Jev's answers → { label } or { error }. The endpoint is alpha, so nothing is trusted
// unchecked. Score is a probability-weighted index into the 5 levels (0 = first), stored as 1-5.
// Probabilities are rounded here to the 3 places the table keeps, so the decision is made
// on the same numbers the page shows.
export function readAnswers(a) {
  const c = a?.category, m = a?.mention, u = a?.urgency;
  if (c?.type !== 'choice' || !CATEGORIES.includes(c.choice) || !prob(c.confidence)) return { error: 'category answer is malformed' };
  if (m?.type !== 'noul' || !prob(m.noul)) return { error: 'mention answer is malformed' };
  if (u?.type !== 'score' || typeof u.score !== 'number' || u.score < 0 || u.score > 4 || !prob(u.confidence)) return { error: 'urgency answer is malformed' };
  return { label: { category: c.choice, category_confidence: r3(c.confidence), mention_p: r3(m.noul),
    urgency: Math.round((u.score + 1) * 10) / 10, urgency_confidence: r3(u.confidence) } };
}

// Whether a flight goes to Claude, and why. Doubt always resolves toward sending it:
// a flight Claude didn't need costs a few tokens, a dropped safety note costs much more.
// Urgency confidence is left out: an ordered scale spreads probability over neighbouring
// levels, so it runs low even on clear cases.
export function decide(label, flagged, threshold) {
  if (label && label.mention_p >= 0.5) return { included: true, reason: 'jev_mention' };
  if (flagged) return { included: true, reason: 'flagged' };
  if (!label) return { included: true, reason: 'jev_failed' };
  const sure = Math.min(label.category_confidence, Math.max(label.mention_p, 1 - label.mention_p));
  if (!(sure >= threshold)) return { included: true, reason: 'low_confidence' }; // a NaN threshold sends, not drops
  return { included: false, reason: 'jev_routine' };
}

// Flights code already flags: a group limit at 95% or more this week (weekGroups are this
// week's v_near_limit group rows), or a stop that fails the data-quality check.
export function flaggedFlights(flights, weekGroups) {
  const ids = new Set(weekGroups.map(r => r.flight_id));
  for (const f of flights) if (stopIssues(f).length) ids.add(f.id);
  return ids;
}

const MIN_JEV_MS = 2000;   // don't start a request with less time than this left
const RETRY_JEV_MS = 5000; // retry a transient failure only with at least this much left

// Asks Jev about every flight, `concurrency` at a time, and never past the deadline:
// ask(flight, msLeft) must cap its timeout at msLeft. Never throws (ask never does).
// Result per flight, in flight order: { flight, calls, label, error }; calls holds every
// attempt (empty when the deadline passed before the flight's turn).
export async function runJev({ flights, ask, concurrency = 8, deadline = Infinity, now = Date.now }) {
  const results = new Array(flights.length);
  const left = () => deadline - now();
  let next = 0;
  async function worker() {
    while (next < flights.length) {
      const i = next++, flight = flights[i];
      if (left() < MIN_JEV_MS) { results[i] = { flight, calls: [], label: null, error: 'Jev ran out of time before this flight' }; continue; }
      const calls = [await ask(flight, left())];
      if (!calls[0].ok && calls[0].transient && left() >= RETRY_JEV_MS) calls.push(await ask(flight, left()));
      const last = calls.at(-1);
      if (!last.ok) { results[i] = { flight, calls, label: null, error: last.error }; continue; }
      const read = readAnswers(last.answers);
      results[i] = { flight, calls, label: read.label ?? null, error: read.error ?? null };
    }
  }
  // a NaN or 0 setting would start no workers and leave every flight unanswered
  const workers = Math.max(1, Math.floor(concurrency) || 8);
  await Promise.all(Array.from({ length: Math.min(workers, flights.length) }, worker));
  return results;
}

// Rows for flight_ai_labels: Jev's answers (null without one) and the decision.
export function labelRows(reportId, results, flagged, threshold) {
  return results.map(({ flight, label, error }) => ({
    report_id: reportId, flight_id: flight.id,
    category: label?.category ?? null, category_confidence: r3(label?.category_confidence),
    mention_p: r3(label?.mention_p), urgency: label?.urgency ?? null, urgency_confidence: r3(label?.urgency_confidence),
    ...decide(label, flagged.has(flight.id), threshold),
    error_message: error,
  }));
}

// Calls for ai_calls, in callOpenRouter's shape, one per attempt. An answer that came back
// but failed the check is an error; its cost is real and stays.
export const jevCallRows = results => results.flatMap(({ calls, label, error }) => calls.map((call, i) => {
  const last = i === calls.length - 1;
  return { ...call, purpose: 'jev_flight_decisions',
    status: last && call.ok && !label ? 'error' : call.status,
    error: last ? error : call.error };
}));

// Fall back to Mode A when more than a quarter of flights got no usable answer.
export const tooManyFailed = (results, maxShare = 0.25) => results.filter(r => !r.label).length > results.length * maxShare;
