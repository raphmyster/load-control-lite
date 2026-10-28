/* One email through Resend's API. Never throws: { ok, id, error }.
   The idempotency key makes a repeated send of the same alert a no-op on Resend's side. */
export async function sendEmail({ apiKey, from, to, subject, text, idempotencyKey, timeoutMs = 8000, fetchFn = fetch }) {
  let res;
  try {
    res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, id: null, error: timeout ? `No answer from Resend within ${timeoutMs / 1000} s` : 'Could not reach Resend' };
  }
  let body = null;
  try { body = await res.json(); } catch { /* empty body: handled below */ }
  if (!res.ok || !body?.id) return { ok: false, id: null, error: `Resend ${res.status}: ${String(body?.message ?? 'request failed').slice(0, 300)}` };
  return { ok: true, id: body.id, error: null };
}
