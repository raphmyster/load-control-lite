/* One chat completion through OpenRouter, normalised for logging. Never throws.
   Result: { ok, status: 'ok'|'error'|'timeout', transient, text, error, model,
             input_tokens, output_tokens, cost_usd, cost_reported, latency_ms }.
   cost_usd is OpenRouter's own usage.cost (requested with usage.include), so the logged
   spend is what we're billed. cost_reported is false when OpenRouter sent no cost.
   Reasoning tokens count against maxTokens, and OpenRouter turns reasoning on at medium
   effort for Claude by default, so the effort is set explicitly (low unless told otherwise). */
const URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function callOpenRouter({ apiKey, model, messages, timeoutMs = 30000, maxTokens = 8000, reasoningEffort = 'low', fetchFn = fetch }) {
  const t0 = Date.now();
  const base = { model, text: '', error: null, input_tokens: 0, output_tokens: 0, cost_usd: 0, cost_reported: false };
  let res;
  try {
    res = await fetchFn(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Load Control Lite' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, reasoning: { effort: reasoningEffort }, usage: { include: true } }),
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
  const out = { ...base, model: body?.model ?? model, input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0,
    cost_usd: Number(u.cost ?? 0), cost_reported: u.cost != null, latency_ms: Date.now() - t0 };
  if (!res.ok || body?.error) {
    const msg = String(body?.error?.message ?? 'request failed').slice(0, 300);
    return { ...out, ok: false, status: 'error', transient: res.status === 429 || res.status >= 500, error: `OpenRouter ${res.status}: ${msg}` };
  }
  const choice = body?.choices?.[0];
  const text = choice?.message?.content ?? '';
  if (choice?.finish_reason === 'length') {
    const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
    return { ...out, ok: false, status: 'error', transient: false,
      error: `The answer hit the ${maxTokens}-token cap and was cut off (${reasoning} reasoning tokens, ${text.length} characters of report)` };
  }
  if (!text.trim()) return { ...out, ok: false, status: 'error', transient: true, error: 'Empty answer' };
  return { ...out, ok: true, status: 'ok', transient: false, text };
}
