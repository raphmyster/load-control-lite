import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacityOf, formRows, formsSql } from './forms-sql.mjs';

const toy = {
  zones: [
    { id: 'DOOR', label: 'DOOR', na: true },
    { id: 'A', label: 'A', max: 100 },
    { id: 'B', label: 'B', max: 200 },
    { id: 'C', label: 'C', max: 300 },
    { id: 'BIN', label: 'BIN', max: 50 },
  ],
  groups: [
    { id: 'ab', label: 'A+B', zones: ['A', 'B'], max: 250 },
    { id: 'abc', label: 'A+B+C', zones: ['A', 'B', 'C'], max: 500 },
  ],
};

test('capacity counts the widest group once plus zones outside every group', () => {
  assert.equal(capacityOf(toy), 500 + 50);
});

test('capacity with no groups is the sum of zone maxima', () => {
  assert.equal(capacityOf({ zones: [{ id: 'X', max: 10 }, { id: 'Y', max: 5 }, { id: 'N', na: true }], groups: [] }), 15);
});

test('real config capacities', async () => {
  const { FORMS } = await import('../js/config.js');
  assert.equal(capacityOf(FORMS.PC12), 3200 + 350);
  assert.equal(capacityOf(FORMS.B1900D19), 950 + 550);
  assert.equal(capacityOf(FORMS.B1900D12), 6 * 250 + 1700 + 650 + 550);
  assert.equal(capacityOf(FORMS.DH8300), 2400 + 1000 + 1000);
});

test('formRows skips zones that cannot hold freight', async () => {
  const { FORMS } = await import('../js/config.js');
  const { zones } = formRows(FORMS);
  assert.ok(!zones.some(z => z.zone_id === 'DOOR' || z.zone_id === 'CABIN' || z.zone_id === 'CLOSET'));
  assert.deepEqual(zones.find(z => z.form_id === 'DH8300' && z.zone_id === 'Z1B'),
    { form_id: 'DH8300', zone_id: 'Z1B', label: 'ZONE 1B', max_lb: 950, seq: 2 });
});

test('formsSql upserts all three tables and escapes quotes', () => {
  const sql = formsSql({ T: { type: "O'Type", name: 'Toy', zones: toy.zones, groups: toy.groups } });
  assert.match(sql, /insert into public\.forms .*\son conflict \(form_id\) do update/s);
  assert.match(sql, /'O''Type'/);
  assert.match(sql, /insert into public\.form_zones/);
  assert.match(sql, /insert into public\.form_groups/);
  assert.match(sql, /array\['A','B','C'\]/);
});
