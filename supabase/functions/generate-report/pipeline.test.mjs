import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeReport } from './pipeline.js';
import { SECTIONS } from './report-core.js';

const GOOD = SECTIONS.map(s => `## ${s}\n- x`).join('\n\n');
const ok = text => ({ ok: true, status: 'ok', text, cost_usd: 0.001 });
const fail = transient => ({ ok: false, status: 'error', transient, error: 'boom', cost_usd: 0 });

// Feeds canned results in order and records what was sent and logged.
function rig(results) {
  const sent = [], logged = [], slept = [];
  return {
    sent, logged, slept,
    deps: {
      messages: [{ role: 'user', content: 'data' }],
      callModel: async m => { sent.push(m); return results.shift(); },
      onCall: async c => { logged.push(c.purpose); },
      sleep: async ms => { slept.push(ms); },
    },
  };
}

test('one good answer: one call, logged, returned trimmed', async () => {
  const r = rig([ok(GOOD + '\n\n')]);
  const out = await writeReport(r.deps);
  assert.equal(out.ok, true); assert.equal(out.content, GOOD);
  assert.deepEqual(r.logged, ['claude_write_report']); assert.equal(out.calls.length, 1);
});

test('a transient failure waits 2 s and retries once', async () => {
  const r = rig([fail(true), ok(GOOD)]);
  const out = await writeReport(r.deps);
  assert.equal(out.ok, true); assert.deepEqual(r.slept, [2000]);
  assert.deepEqual(r.logged, ['claude_write_report', 'claude_write_report']);
});

test('two transient failures: error, no third try', async () => {
  const r = rig([fail(true), fail(true), ok(GOOD)]);
  const out = await writeReport(r.deps);
  assert.equal(out.ok, false); assert.equal(r.sent.length, 2);
});

test('a permanent failure is not retried', async () => {
  const r = rig([fail(false)]);
  const out = await writeReport(r.deps);
  assert.equal(out.ok, false); assert.equal(r.sent.length, 1); assert.deepEqual(r.slept, []);
});

test('missing headings get one corrective call that sees the first answer', async () => {
  const r = rig([ok('## Summary\n- x'), ok(GOOD)]);
  const out = await writeReport(r.deps);
  assert.equal(out.ok, true);
  assert.deepEqual(r.logged, ['claude_write_report', 'claude_fix_headings']);
  const fix = r.sent[1];
  assert.equal(fix.at(-2).role, 'assistant'); assert.equal(fix.at(-2).content, '## Summary\n- x');
  assert.match(fix.at(-1).content, /Volume and freight by route/);
});

test('each call gets the time left, and no retry starts with under 20 s to go', async () => {
  let t = 0; const timeouts = [];
  const out = await writeReport({
    messages: [{ role: 'user', content: 'data' }], sleep: async () => {}, deadline: 25000, now: () => t,
    callModel: async (m, ms) => { timeouts.push(ms); t += 10000; return fail(true); },
  });
  assert.deepEqual(timeouts, [25000]);
  assert.equal(out.ok, false); assert.match(out.error, /out of time/i);
});

test('a fenced answer is stored without the fence', async () => {
  const r = rig([ok('```markdown\n' + GOOD + '\n```')]);
  assert.equal((await writeReport(r.deps)).content, GOOD);
});

test('still wrong after the fix: error, never a half report', async () => {
  const r = rig([ok('## Summary\n- x'), ok('## Summary\n- y')]);
  const out = await writeReport(r.deps);
  assert.equal(out.ok, false); assert.equal(out.content, undefined);
  assert.match(out.error, /missing sections/i);
});
