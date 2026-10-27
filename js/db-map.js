/* Converts between the app's flight object and the database shape.
   toPayload(flight) -> JSON for save_flight(); fromRow(row) -> flight, where row is a
   flights row with its flight_stops and zone_allocations embedded. No DOM, no network. */
import { n } from './calc.js';

const KEYS = ['cargo', 'post', 'fast', 'bag'];
const lb = v => Math.max(0, n(v));
const mins = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const hhmm = t => (t || '').slice(0, 5);
const shown = x => { const v = Number(x); return v ? String(v) : ''; };

// Minutes late against ETD; early counts as 0. A departure more than 12 h "before" ETD
// is taken as after midnight.
export function delayMinutes(etd, atd) {
  if (!etd || !atd) return null;
  let d = mins(atd) - mins(etd);
  if (d < -720) d += 1440;
  return Math.max(0, d);
}

export function toPayload(f) {
  const rowIds = new Set(f.rows.map(r => r.id));
  const allocations = [];
  Object.entries(f.alloc || {}).forEach(([stopId, kinds]) => {
    if (!rowIds.has(stopId)) return;
    Object.entries(kinds).forEach(([kind, zones]) => Object.entries(zones).forEach(([zone, v]) => {
      if (String(v ?? '').trim() !== '') allocations.push({ stop_id: stopId, kind, zone_id: zone, weight_lb: lb(v) });
    }));
  });
  return {
    id: f.id, flight_date: f.date, flight_no: f.flightNo, registration: f.reg, form_id: f.form,
    etd: f.etd || null, actual_departure: f.atd || null, delay_minutes: delayMinutes(f.etd, f.atd),
    special_hr: !!f.special?.hr, special_aog: !!f.special?.aog, dg_note: f.dgNote || '',
    loadmaster: f.loadmaster || '', notes: f.notes || '', manual_alloc: !!f.manual,
    tag_positions: f.pos || {}, status: f.status || 'draft',
    stops: f.rows.map(r => ({
      id: r.id, dest: r.dest || '',
      ...Object.fromEntries(KEYS.map(k => [`${k}_lb`, lb(r[k])])),
      raw_entry: Object.fromEntries(KEYS.map(k => [k, String(r[k] ?? '')])),
    })),
    allocations,
  };
}

export function fromRow(row) {
  const alloc = {};
  (row.zone_allocations || []).forEach(a => {
    ((alloc[a.stop_id] ||= {})[a.kind] ||= {})[a.zone_id] = String(Number(a.weight_lb));
  });
  return {
    id: row.id, date: row.flight_date, flightNo: row.flight_no || '', reg: row.registration || '', form: row.form_id,
    etd: hhmm(row.etd), atd: hhmm(row.actual_departure),
    special: { hr: !!row.special_hr, aog: !!row.special_aog }, dgNote: row.dg_note || '',
    rows: [...(row.flight_stops || [])].sort((a, b) => a.seq - b.seq).map(s => ({
      id: s.id, dest: s.dest || '',
      ...Object.fromEntries(KEYS.map(k => [k, s.raw_entry?.[k] ?? shown(s[`${k}_lb`])])),
    })),
    alloc, pos: row.tag_positions || {}, manual: !!row.manual_alloc,
    notes: row.notes || '', loadmaster: row.loadmaster || '', status: row.status || 'draft',
    updated: row.updated_at ? Date.parse(row.updated_at) : Date.now(),
  };
}
