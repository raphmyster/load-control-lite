/* Sends a sample flight to Jev 8 times in parallel and prints the first answer in full,
   then each call's status and latency. That confirms the Decisions API's answer fields
   before generate-report depends on them, and shows whether 8 at a time is fast enough
   and free of 429s. Costs well under a cent.
   Run from the repo root (the key stays in the git-ignored env file; nothing prints it):
     set -a; . supabase/.env.local; set +a; node scripts/jev-probe.mjs */
import { callJev } from '../supabase/functions/generate-report/jev.js';
import { QUESTIONS, flightState, readAnswers } from '../supabase/functions/generate-report/hybrid.js';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) { console.error('OPENROUTER_API_KEY is not set in this shell.'); process.exit(1); }

const flight = {
  flight_no: '512', flight_date: '2026-10-22', form_id: 'DH8300', delay_minutes: 0,
  dg_note: '', notes: 'Cargo strap damaged at ramp, replaced before departure. Report filed.',
  flight_stops: [{ seq: 0, dest: 'YOW', cargo_lb: 900, post_lb: 120, fast_lb: 0, bag_lb: 640 }],
};
const model = process.env.JEV_MODEL ?? 'typesafe/jev-1.14';
const all = await Promise.all(Array.from({ length: 8 }, () => callJev({ apiKey, model, state: flightState(flight), questions: QUESTIONS })));
const { answers, ...meta } = all[0];
console.log(JSON.stringify(meta, null, 2));
console.log(JSON.stringify(answers, null, 2));
console.log('readAnswers:', JSON.stringify(all[0].ok ? readAnswers(answers) : null));
const ms = all.map(r => r.latency_ms).sort((a, b) => a - b);
console.log('8 parallel calls:', all.map(r => `${r.status}${r.error ? ` (${r.error})` : ''}`).join(', '));
console.log(`latency ms: min ${ms[0]}, median ${ms[4]}, max ${ms[7]}`);
