/* One Jev decision through OpenRouter's Decisions API, normalised like callOpenRouter so
   the same logging and totals work. Never throws.
   Result: { ok, status: 'ok'|'error'|'timeout', transient, answers, error, model,
             input_tokens, output_tokens, cost_usd, cost_reported, latency_ms }.
   Jev answers typed questions with probabilities instead of text, and bills input tokens
   only. The endpoint is alpha, so the answers are checked in hybrid.js before use. */
const URL = 'https://openrouter.ai/api/alpha/decisions';

export async function callJev({ apiKey, model, state, questions, timeoutMs = 10000, fetchFn = fetch }) {
  const t0 = Date.now();
  const base = { model, answers: null, error: null, input_tokens: 0, output_tokens: 0, cost_usd: 0, cost_reported: false };
  let res;
  try {
    res = await fetchFn(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Load Control Lite' },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ...base, ok: false, status: timeout ? 'timeout' : 'error', transient: true,
      error: timeout ? `No answer within ${timeoutMs / 1000} s` : 'Could not reach OpenRouter', latency_ms: Date.now() - t0 };
  }
  let body = null;
  try { body = await res.json(); } catch { /* empty or cut-off body: handled below */ }
  const u = body?.usage ?? {};
  const out = { ...base, model: body?.model ?? model, input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0,
    cost_usd: Number(u.cost ?? 0), cost_reported: u.cost != null, latency_ms: Date.now() - t0 };
  if (!res.ok || body?.error) {
    const msg = String(body?.error?.message ?? 'request failed').slice(0, 300);
    return { ...out, ok: false, status: 'error', transient: res.status === 429 || res.status >= 500, error: `Jev ${res.status}: ${msg}` };
  }
  if (!body?.answers || typeof body.answers !== 'object') {
    return { ...out, ok: false, status: 'error', transient: true, error: 'No answers in the response' };
  }
  return { ...out, ok: true, status: 'ok', transient: false, answers: body.answers };
}
