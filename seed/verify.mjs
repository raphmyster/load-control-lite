#!/usr/bin/env node
/* Checks the loaded database against the ground truth, through the same SQL views
   the AI report will read. A mismatch means the views and the app's load maths
   disagree, or the load went wrong. Usage: npm run seed:verify */
import { generate, groundTruth, LATE_FREIGHT } from './generate.mjs';
import { query } from '../scripts/db-query.mjs';

const gt = groundTruth(generate());
const p = id => gt.patterns.find(x => x.id === id);
const one = sql => Number(Object.values(query(sql)[0])[0]);
const lit = s => `'${s.replace(/'/g, "''")}'`;
let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) failed++;
};

check('flights', one('select count(*) from public.flights'), gt.flights);
check('drafts', one(`select count(*) from public.flights where status = 'draft'`), 2);
check('cargo growth, flight 405 by week',
  query(`select cargo_lb from public.v_route_week where route = 'YAM' order by week_start`).map(r => Number(r.cargo_lb)),
  p('cargo_growth').weekly_cargo_lb);
check('Dash 8 flights near a group limit',
  one(`select count(distinct flight_id) from public.v_near_limit where form_id = 'DH8300' and limit_kind = 'group'`),
  p('near_limit').flights_near);
check('other forms near a group limit',
  one(`select count(distinct flight_id) from public.v_near_limit where form_id <> 'DH8300' and limit_kind = 'group'`), 0);
check(`delayed flights on ${p('deice_delays').date}`,
  one(`select delayed_flights from public.v_delays where flight_date = '${p('deice_delays').date}'`),
  p('deice_delays').delayed_flights);
check('late-freight notes on 118',
  one(`select count(*) from public.flights where flight_no = '118' and notes in (${LATE_FREIGHT.map(lit).join(', ')})`),
  p('late_freight').flights_with_note);
check('stops with weight and no destination',
  one(`select count(*) from public.flight_stops where dest = '' and cargo_lb + post_lb + fast_lb + bag_lb > 0`), 1);

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('Database matches seed/ground_truth.json.');
