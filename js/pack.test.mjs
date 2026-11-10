import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPERATOR, FORMS, FORM_POS, AIRPORTS } from './config.js';
import { compute } from './load.js';
import { applyPack, themeCss } from './pack.js';

const TESTX = {
  type: 'Test', name: 'Test form', version: 'v9', layout: 'strip', orientation: 'landscape',
  zones: [{ id: 'A', label: 'A', max: 100, tail: true, w: 1 }], groups: [], loadOrder: ['A'],
};

test('no pack leaves the defaults alone', () => {
  const before = Object.keys(FORMS);
  assert.equal(applyPack(null), null);
  assert.deepEqual(Object.keys(FORMS), before);
});

test('a pack replaces forms, positions, operator and adds airports once', () => {
  const out = applyPack({
    operator: { app: 'Load Control', limitsNote: '' }, forms: { TESTX }, pos: { TESTX: { w: 10 } },
    airports: [{ code: 'ZZZ', city: 'Test' }, { code: 'YYZ', city: 'Dup' }], extra: 1,
  });
  assert.deepEqual(Object.keys(FORMS), ['TESTX']);
  assert.deepEqual(Object.keys(FORM_POS), ['TESTX']);
  assert.equal(OPERATOR.app, 'Load Control');
  assert.equal(OPERATOR.name, 'Northbound Air'); // keys the pack leaves out stay
  assert.equal(AIRPORTS.filter(a => a.code === 'ZZZ').length, 1);
  assert.equal(AIRPORTS.filter(a => a.code === 'YYZ').length, 1);
  assert.deepEqual(out.features, { reports: true });
  assert.deepEqual(out.images, {});
});

test('the limit check uses the pack limits', () => {
  const f = { form: 'TESTX', rows: [{ id: 'r', dest: 'ZZZ', cargo: '150', post: '', fast: '', bag: '' }],
    alloc: { r: { all: { A: '150' } } }, pos: {}, manual: true };
  const c = compute(f);
  assert.equal(c.zones.find(z => z.id === 'A').max, 100);
  assert.equal(c.planned.A, 150);
});

test('themeCss writes light, auto-dark and forced-dark blocks', () => {
  const css = themeCss({ light: { '--brand': '#111' }, dark: { '--brand': '#222' } }, '.x{a:b}');
  assert.match(css, /^:root \{ --brand: #111; \}/);
  assert.match(css, /prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{ --brand: #222; \} \}/);
  assert.match(css, /:root\[data-theme="dark"\] \{ --brand: #222; \}/);
  assert.match(css, /\.x\{a:b\}$/);
});
