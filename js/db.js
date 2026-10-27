/* Supabase access for the app: sign-in, loading flights, autosave and delete.
   Saving goes through save_flight(), which writes a flight, its stops and its
   allocations in one transaction under the caller's RLS policies. */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './supabase-config.js';
import { toPayload, fromRow } from './db-map.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function currentUser() { return (await sb.auth.getSession()).data.session?.user ?? null; }
export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}
export async function signOut() { await sb.auth.signOut(); }

// Explicit foreign keys: zone_allocations also links to flight_stops, so PostgREST
// could otherwise read it as a join table between flights and flight_stops.
const SELECT = '*, flight_stops!flight_stops_flight_id_fkey(*), zone_allocations!zone_allocations_flight_id_fkey(*)';
export async function loadFlights() {
  const { data, error } = await sb.from('flights').select(SELECT).order('flight_date', { ascending: false });
  if (error) throw error;
  return data.map(fromRow);
}

/* Autosave. queueSave(flight) waits DELAY ms after the last call, then saves.
   One pending save per flight, so switching flights never drops an edit. Saves run one
   at a time. onStatus receives 'saving' | 'saved' | 'error' (with the error). */
const DELAY = 600;
const pending = new Map();   // flight id -> { payload, json } waiting to be saved
const lastSaved = new Map(); // flight id -> JSON of the last payload saved
const deleted = new Set();   // never save these again
let timer = null, running = false, inflight = Promise.resolve(), onStatus = () => {};

export function onSaveStatus(fn) { onStatus = fn; }
export const hasUnsaved = () => pending.size > 0 || running;
export const markSaved = flight => lastSaved.set(flight.id, JSON.stringify(toPayload(flight)));

export function queueSave(flight, { now = false } = {}) {
  const payload = toPayload(flight), json = JSON.stringify(payload);
  if (deleted.has(payload.id)) return;
  if (lastSaved.get(payload.id) === json) { pending.delete(payload.id); return; } // nothing changed
  pending.set(payload.id, { payload, json });
  clearTimeout(timer);
  timer = setTimeout(run, now ? 0 : DELAY);
}

// Saves the next pending flight. Returns true if it saved, false on error or nothing to do.
async function run() {
  if (running) return false;
  const next = pending.values().next().value;
  if (!next) return false;
  const id = next.payload.id;
  pending.delete(id); running = true;
  onStatus('saving');
  // A supabase-js query runs each time it is awaited, so turn it into one promise
  // first; awaiting the builder twice would send the save twice.
  const call = sb.rpc('save_flight', { p: next.payload }).then(r => r, error => ({ error }));
  inflight = call;
  const { error } = await call;
  running = false;
  if (error) {
    if (!pending.has(id) && !deleted.has(id)) pending.set(id, next); // keep it for the retry
    onStatus('error', error);
    return false;
  }
  lastSaved.set(id, next.json);
  if (pending.size) timer = setTimeout(run, 0); else onStatus('saved');
  return true;
}
export const retrySave = () => run();

// Saves everything now. Returns false if a save failed.
export async function flush() {
  clearTimeout(timer);
  await inflight;
  while (pending.size) { clearTimeout(timer); if (!(await run())) return false; }
  return true;
}

// A save already on its way must land before the delete, or save_flight would
// re-insert the flight after it was deleted.
export async function deleteFlight(id) {
  deleted.add(id); pending.delete(id);
  await inflight;
  const { error } = await sb.from('flights').delete().eq('id', id);
  if (error) { deleted.delete(id); throw error; }
}
