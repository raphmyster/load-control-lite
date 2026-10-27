import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMS } from './config.js';
import { autoPlace, compute } from './load.js';

// small fixed-seed generator so the test is repeatable
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const flight = (form, rows) => ({ form, rows: rows.map((r, i) => ({ id: 'r' + i, dest: 'YSB', cargo: '', post: '', fast: '', bag: '', ...r })), alloc: {}, pos: {}, manual: false });

test('auto-place never puts more than a zone or group allows, and accounts for every pound', () => {
  const r = rng(7), int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  for (const form of Object.keys(FORMS)) {
    for (let i = 0; i < 200; i++) {
      const f = flight(form, Array.from({ length: int(1, 3) }, () => ({ cargo: String(int(0, 1500)), post: String(int(0, 200)), bag: String(int(0, 500)) })));
      autoPlace(f);
      const c = compute(f);
      c.zones.forEach(z => { if (z.max) assert.ok(c.planned[z.id] <= z.max + 1e-9, `${form} ${z.id} over`); });
      c.groups.forEach(g => assert.ok(g.total <= g.max + 1e-9, `${form} group ${g.id} over`));
      c.rs.forEach(x => x.parts.forEach(p => assert.ok(Math.abs(p.placed + p.unplaced - p.amount) < 1e-6)));
    }
  }
});

test('a stop that fits in one zone stays in one zone', () => {
  const f = flight('DH8300', [{ cargo: '545' }]);
  autoPlace(f);
  assert.deepEqual(f.alloc.r0.cargo, { Z1A: '545' });
});

test('a light load is placed in full', () => {
  const f = flight('PC12', [{ cargo: '545', bag: '40' }, { cargo: '310', post: '45', bag: '60' }]);
  autoPlace(f);
  assert.ok(compute(f).rs.every(x => x.parts.every(p => Math.abs(p.unplaced) < 1e-9)));
});
