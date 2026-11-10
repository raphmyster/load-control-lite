import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMS } from './config.js';
import { autoPlace, compute, balanceRow, syncRow } from './load.js';

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

// Hand placement on the 1900D 19-seat form: FWD max 950, AFT max 550, load order AFT then FWD.
const handPlaced = (rows, alloc) => Object.assign(flight('B1900D19', rows), { alloc, manual: true });

test('typing a split takes it from the stop\'s largest section', () => {
  const f = handPlaced([{ cargo: '100', fast: '50', bag: '40' }], { r0: { all: { AFT: '190' } } });
  f.alloc.r0.all.FWD = '50';
  balanceRow(f, 'r0', 'all', 'FWD');
  assert.deepEqual(f.alloc.r0.all, { AFT: '140', FWD: '50' });
  f.alloc.r0.all.FWD = '20';
  balanceRow(f, 'r0', 'all', 'FWD');
  assert.deepEqual(f.alloc.r0.all, { AFT: '170', FWD: '20' });
});

test('clearing a typed cell gives its weight back, never to a new section', () => {
  const f = handPlaced([{ cargo: '190' }], { r0: { all: { AFT: '190' } } });
  f.alloc.r0.all.AFT = '';
  balanceRow(f, 'r0', 'all', 'AFT');
  assert.deepEqual(f.alloc.r0.all, { AFT: '' });
});

test('a stop added after hand placement is placed without moving the others', () => {
  const f = handPlaced([{ cargo: '200' }, { cargo: '400' }], { r0: { all: { AFT: '200' } } });
  syncRow(f, 'r1');
  assert.deepEqual(f.alloc.r0.all, { AFT: '200' });
  assert.deepEqual(f.alloc.r1.all, { AFT: '350', FWD: '50' }); // AFT has 350 left
});

test('a heavier stop grows in its largest section; a lighter one shrinks its smallest first', () => {
  const f = handPlaced([{ cargo: '250' }], { r0: { all: { AFT: '100', FWD: '50' } } });
  syncRow(f, 'r0');
  assert.deepEqual(f.alloc.r0.all, { AFT: '200', FWD: '50' });
  f.rows[0].cargo = '170';
  syncRow(f, 'r0');
  assert.deepEqual(f.alloc.r0.all, { AFT: '170' });
});

test('syncing never goes past a limit; what does not fit stays in the Difference', () => {
  const f = handPlaced([{ cargo: '2000' }], {});
  syncRow(f, 'r0');
  assert.deepEqual(f.alloc.r0.all, { AFT: '550', FWD: '950' });
  assert.equal(compute(f).rs[0].parts[0].unplaced, 500);
});

test('Dash 8 bags and cargo balance separately', () => {
  const f = Object.assign(flight('DH8300', [{ cargo: '200', bag: '100' }]), {
    alloc: { r0: { bag: { Z2A: '100' }, cargo: { Z2A: '200' } } }, manual: true });
  f.alloc.r0.cargo.Z2B = '50';
  balanceRow(f, 'r0', 'cargo', 'Z2B');
  assert.deepEqual(f.alloc.r0.cargo, { Z2A: '150', Z2B: '50' });
  assert.deepEqual(f.alloc.r0.bag, { Z2A: '100' });
});
