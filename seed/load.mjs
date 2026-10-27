#!/usr/bin/env node
/* Wipes every flight in the linked Supabase project and loads the generated seed.
   Runs through the Supabase CLI as the database owner, so RLS doesn't apply and
   created_by is set to the demo user here. Usage: npm run seed */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from './generate.mjs';
import { toPayload } from '../js/db-map.js';
import { runFile } from '../scripts/db-query.mjs';

const CHUNK = 100; // flights per request, to keep each request small
const TAG = '$seed$';
const dir = mkdtempSync(join(tmpdir(), 'lcl-seed-'));
const run = (name, sql) => { const file = join(dir, name); writeFileSync(file, sql); runFile(file); };

// Same columns and casts as save_flight(), plus created_by.
const chunkSql = payloads => `begin;
create temp table seed_src (p jsonb) on commit drop;
insert into seed_src select jsonb_array_elements(${TAG}${JSON.stringify(payloads)}${TAG}::jsonb);

insert into public.flights (id, flight_date, flight_no, registration, form_id, etd, actual_departure, delay_minutes,
  special_hr, special_aog, dg_note, loadmaster, notes, manual_alloc, tag_positions, status, created_by)
select (p->>'id')::uuid, (p->>'flight_date')::date, p->>'flight_no', p->>'registration', p->>'form_id',
  nullif(p->>'etd', '')::time, nullif(p->>'actual_departure', '')::time, (p->>'delay_minutes')::int,
  (p->>'special_hr')::boolean, (p->>'special_aog')::boolean, p->>'dg_note', p->>'loadmaster', p->>'notes',
  (p->>'manual_alloc')::boolean, p->'tag_positions', p->>'status',
  (select id from auth.users order by created_at limit 1)
from seed_src;

insert into public.flight_stops (id, flight_id, seq, dest, cargo_lb, post_lb, fast_lb, bag_lb, raw_entry)
select (s->>'id')::uuid, (p->>'id')::uuid, (t.ord - 1)::int, s->>'dest',
  (s->>'cargo_lb')::numeric, (s->>'post_lb')::numeric, (s->>'fast_lb')::numeric, (s->>'bag_lb')::numeric, s->'raw_entry'
from seed_src, jsonb_array_elements(p->'stops') with ordinality as t(s, ord);

insert into public.zone_allocations (flight_id, stop_id, kind, zone_id, weight_lb)
select (p->>'id')::uuid, (a->>'stop_id')::uuid, a->>'kind', a->>'zone_id', (a->>'weight_lb')::numeric
from seed_src, jsonb_array_elements(p->'allocations') as a;
commit;
`;

const payloads = generate().map(toPayload);
if (payloads.some(p => JSON.stringify(p).includes(TAG))) throw new Error(`seed text contains ${TAG}`);

run('00-wipe.sql', `do $$ begin
  if not exists (select 1 from auth.users) then raise exception 'No demo user: create one under Authentication first'; end if;
end $$;
delete from public.flights;`);
console.log('wiped flights');
for (let i = 0; i < payloads.length; i += CHUNK) {
  run(`chunk-${String(i).padStart(3, '0')}.sql`, chunkSql(payloads.slice(i, i + CHUNK)));
  console.log(`loaded ${Math.min(i + CHUNK, payloads.length)} / ${payloads.length}`);
}
