#!/usr/bin/env node
/* Fails if the form limits in the linked database differ from js/config.js.
   Uses the saved CLI login; never needs the database password. */
import { existsSync, readFileSync } from 'node:fs';
import { FORMS } from '../js/config.js';
import { formRows } from './forms-sql.mjs';
import { query } from './db-query.mjs';

const key = r => JSON.stringify(Object.keys(r).sort().map(k => [k, Array.isArray(r[k]) ? r[k] : r[k] === null ? null : String(Number(r[k]) || r[k])]));
const same = (a, b) => JSON.stringify(a.map(key).sort()) === JSON.stringify(b.map(key).sort());

// With a private operator pack next to the repo, the database should hold its limits.
const packFile = new URL('../../operator-pack/profile.json', import.meta.url);
const source = existsSync(packFile) ? 'the operator pack' : 'js/config.js';
const want = formRows(existsSync(packFile) ? JSON.parse(readFileSync(packFile, 'utf8')).forms : FORMS);
const got = {
  forms: query('select form_id, aircraft_type, name, is_split, capacity_lb from public.forms'),
  zones: query('select form_id, zone_id, label, max_lb, seq from public.form_zones'),
  groups: query('select form_id, group_id, label, zone_ids, max_lb from public.form_groups'),
};
const bad = Object.keys(want).filter(t => !same(want[t], got[t]));
if (bad.length) {
  console.error(`Out of sync with ${source}: ${bad.join(', ')}. Push the pack, or generate a migration with scripts/forms-sql.mjs.`);
  process.exit(1);
}
console.log(`Form limits in the database match ${source}.`);
