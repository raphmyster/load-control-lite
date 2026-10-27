import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callOpenRouter } from './openrouter.js';

const MSG = [{ role: 'user', content: 'hi' }];
const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });
const call = fetchFn => callOpenRouter({ apiKey: 'k', model: 'anthropic/claude-haiku-5.5', messages: MSG, fetchFn });

test('a good answer comes back with text, tokens, cost and the model that answered', async () => {
  const r = await call(reply(200, {
    model: 'anthropic/claude-haiku-5.5',
    choices: [{ message: { content: '## Summary\n- ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 9000, completion_tokens: 1200, cost: 0.0015 },
  }));
  assert.equal(r.ok, true); assert.equal(r.status, 'ok'); assert.equal(r.text, '## Summary\n- ok');
  assert.equal(r.input_tokens, 9000); assert.equal(r.output_tokens, 1200); assert.equal(r.cost_usd, 0.0015);
  assert.ok(r.latency_ms >= 0); assert.equal(r.cost_reported, true);
});

test('the request carries the key, the model, a token cap and no streaming', async () => {
  let seen;
  await call(async (url, init) => { seen = { url, init }; return new Response('{}', { status: 500 }); });
  assert.equal(seen.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, 'anthropic/claude-haiku-5.5'); assert.equal(body.max_tokens, 8000); assert.ok(!body.stream);
  assert.deepEqual(body.usage, { include: true }, 'asks OpenRouter for usage.cost');
  assert.deepEqual(body.reasoning, { effort: 'low' }, 'sets reasoning effort instead of the medium default');
  assert.equal(body.temperature, undefined, 'no temperature: Anthropic models refuse it with reasoning on');
  assert.ok(seen.init.signal, 'has a timeout signal');
});

test('429 and 5xx are worth one retry; other errors are not', async () => {
  assert.equal((await call(reply(429, { error: { message: 'slow down' } }))).transient, true);
  assert.equal((await call(reply(502, { error: { message: 'upstream' } }))).transient, true);
  const bad = await call(reply(400, { error: { message: 'not a valid model ID' } }));
  assert.equal(bad.ok, false); assert.equal(bad.transient, false); assert.equal(bad.status, 'error');
  assert.match(bad.error, /400: not a valid model ID/);
});

test('a timeout is reported as a timeout and is worth a retry', async () => {
  const r = await call(async () => { throw new DOMException('timed out', 'TimeoutError'); });
  assert.equal(r.ok, false); assert.equal(r.status, 'timeout'); assert.equal(r.transient, true);
});

test('an answer cut off at the token cap is an error, with its cost kept', async () => {
  const r = await call(reply(200, { choices: [{ message: { content: '## Summary' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 1, completion_tokens: 8000, cost: 0.002, completion_tokens_details: { reasoning_tokens: 7990 } } }));
  assert.equal(r.ok, false); assert.equal(r.transient, false); assert.equal(r.cost_usd, 0.002);
  assert.match(r.error, /8000-token cap .*7990 reasoning tokens, 10 characters/);
});

test('an empty answer is an error worth a retry', async () => {
  const r = await call(reply(200, { choices: [{ message: { content: '  ' }, finish_reason: 'stop' }] }));
  assert.equal(r.ok, false); assert.equal(r.transient, true);
});
