import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callJev } from './jev.js';

const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });
const Q = { mention: { type: 'noul', instructions: 'Mention?', criteria: { true: 'yes', false: 'no' } } };
const call = fetchFn => callJev({ apiKey: 'k', model: 'typesafe/jev-1.14', state: { flight: '512' }, questions: Q, fetchFn });
const ANSWERS = { mention: { type: 'noul', noul: 0.93 } };

test('a good answer comes back with answers, tokens, cost and the model that answered', async () => {
  const r = await call(reply(200, { id: 'd1', model: 'typesafe/jev-1.14-20261001', answers: ANSWERS,
    usage: { input_tokens: 410, output_tokens: 3, cost: 0.0000172 } }));
  assert.equal(r.ok, true); assert.equal(r.status, 'ok'); assert.deepEqual(r.answers, ANSWERS);
  assert.equal(r.input_tokens, 410); assert.equal(r.output_tokens, 3); assert.equal(r.cost_usd, 0.0000172);
  assert.equal(r.cost_reported, true); assert.equal(r.model, 'typesafe/jev-1.14-20261001'); assert.ok(r.latency_ms >= 0);
});

test('the request goes to the Decisions endpoint with model, state and questions', async () => {
  let seen;
  await call(async (url, init) => { seen = { url, init }; return new Response('{}', { status: 500 }); });
  assert.equal(seen.url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(seen.init.body), { model: 'typesafe/jev-1.14', state: { flight: '512' }, questions: Q });
  assert.ok(seen.init.signal);
});

test('402 (no credit) is an error that a retry will not fix', async () => {
  const r = await call(reply(402, { error: { code: 402, message: 'Insufficient credits' } }));
  assert.equal(r.ok, false); assert.equal(r.transient, false); assert.match(r.error, /^Jev 402: Insufficient credits/);
});

test('429 and 5xx are transient', async () => {
  for (const s of [429, 503, 529]) assert.equal((await call(reply(s, { error: { code: s, message: 'x' } }))).transient, true, String(s));
});

test('a timeout is reported as a timeout and never throws', async () => {
  const r = await call(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
  assert.equal(r.ok, false); assert.equal(r.status, 'timeout'); assert.match(r.error, /No answer within 10 s/);
});

test('a network failure is an error and never throws', async () => {
  const r = await call(async () => { throw new TypeError('fetch failed'); });
  assert.equal(r.status, 'error'); assert.equal(r.error, 'Could not reach OpenRouter');
});

test('a 200 without answers is an error, with its cost still counted', async () => {
  const r = await call(reply(200, { model: 'm', usage: { input_tokens: 400, output_tokens: 0, cost: 0.00002 } }));
  assert.equal(r.ok, false); assert.equal(r.error, 'No answers in the response'); assert.equal(r.cost_usd, 0.00002);
});

test('missing cost is flagged so the spend cap is not silently fed zeros', async () => {
  const r = await call(reply(200, { model: 'm', answers: ANSWERS, usage: { input_tokens: 400, output_tokens: 0 } }));
  assert.equal(r.ok, true); assert.equal(r.cost_usd, 0); assert.equal(r.cost_reported, false);
});
