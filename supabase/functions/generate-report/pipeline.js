/* Gets a complete report out of the model: one retry on a transient failure, one
   corrective call if the headings are wrong. Every call is passed to onCall (which logs
   it) before anything else happens, so spend is recorded even if the run dies later. */
import { missingSections, fixPrompt, stripFence } from './report-core.js';

const pause = ms => new Promise(r => setTimeout(r, ms));
const MIN_CALL_MS = 20000; // don't start a call with less time than this before the deadline

/* deadline keeps the worst case (four calls) inside the edge function's 150 s limit:
   each call gets min(timeoutMs, time left), and no call starts with under 20 s left. */
export async function writeReport({ messages, callModel, onCall = async () => {}, sleep = pause,
  timeoutMs = 30000, deadline = Infinity, now = Date.now }) {
  const calls = [];
  const outOfTime = { ok: false, transient: false, error: 'Ran out of time before the report was complete' };
  async function once(msgs, purpose) {
    const left = deadline - now();
    if (left < MIN_CALL_MS) return outOfTime;
    const r = { ...(await callModel(msgs, Math.min(timeoutMs, left))), purpose };
    calls.push(r); await onCall(r);
    return r;
  }
  async function withRetry(msgs, purpose) {
    const r = await once(msgs, purpose);
    if (r.ok || !r.transient) return r;
    await sleep(2000);
    return once(msgs, purpose);
  }

  let r = await withRetry(messages, 'claude_write_report');
  if (!r.ok) return { ok: false, calls, error: r.error };
  let missing = missingSections(r.text);
  if (missing.length) {
    const fix = [...messages, { role: 'assistant', content: r.text }, { role: 'user', content: fixPrompt(missing) }];
    r = await withRetry(fix, 'claude_fix_headings');
    if (!r.ok) return { ok: false, calls, error: r.error };
    missing = missingSections(r.text);
    if (missing.length) return { ok: false, calls, error: `The report is still missing sections: ${missing.join(', ')}` };
  }
  return { ok: true, calls, content: stripFence(r.text) };
}
