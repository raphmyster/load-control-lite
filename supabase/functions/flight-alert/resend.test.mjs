import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendEmail } from './resend.js';

const args = { apiKey: 'k', from: 'A <a@x.test>', to: 'dm@x.test', subject: 'S', text: 'T', idempotencyKey: 'flight-alert/1' };
const res = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('sendEmail posts plain text with the idempotency key and returns the id', async () => {
  let seen;
  const out = await sendEmail({ ...args, fetchFn: async (url, init) => { seen = { url, init }; return res(200, { id: 'em_1' }); } });
  assert.deepEqual(out, { ok: true, id: 'em_1', error: null });
  assert.equal(seen.url, 'https://api.resend.com/emails');
  assert.equal(seen.init.headers['Idempotency-Key'], 'flight-alert/1');
  assert.deepEqual(JSON.parse(seen.init.body), { from: 'A <a@x.test>', to: ['dm@x.test'], subject: 'S', text: 'T' });
});

test('sendEmail reports an API error without throwing', async () => {
  const out = await sendEmail({ ...args, fetchFn: async () => res(403, { message: 'You can only send testing emails to your own address' }) });
  assert.equal(out.ok, false);
  assert.match(out.error, /^Resend 403: You can only send/);
});

test('sendEmail reports a network failure or timeout without throwing', async () => {
  const out = await sendEmail({ ...args, fetchFn: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } });
  assert.deepEqual(out, { ok: false, id: null, error: 'No answer from Resend within 8 s' });
});
