#!/usr/bin/env node
/* Fails if the form limits in the linked database differ from js/config.js.
   Uses the saved CLI login; never needs the database password. */
import { execFileSync } from 'node:child_process';
import { FORMS } from '../js/config.js';
import { formRows } from './forms-sql.mjs';

const query = sql => {
  const out = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  return parsed.rows ?? parsed;
};
const key = r => JSON.stringify(Object.keys(r).sort().map(k => [k, Array.isArray(r[k]) ? r[k] : r[k] === null ? null : String(Number(r[k]) || r[k])]));
const same = (a, b) => JSON.stringify(a.map(key).sort()) === JSON.stringify(b.map(key).sort());

const want = formRows(FORMS);
const got = {
  forms: query('select form_id, aircraft_type, name, is_split, capacity_lb from public.forms'),
  zones: query('select form_id, zone_id, label, max_lb, seq from public.form_zones'),
  groups: query('select form_id, group_id, label, zone_ids, max_lb from public.form_groups'),
};
const bad = Object.keys(want).filter(t => !same(want[t], got[t]));
if (bad.length) {
  console.error(`Out of sync with js/config.js: ${bad.join(', ')}. Generate a new migration with scripts/forms-sql.mjs.`);
  process.exit(1);
}
console.log('Form limits in the database match js/config.js.');
