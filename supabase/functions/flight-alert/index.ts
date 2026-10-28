/* flight-alert: labels one just-closed flight with Jev and emails the duty manager when code
   decides it should. Wiring only; the logic is in alert.js, resend.js and generate-report's
   jev.js and hybrid.js. The only caller is the flights_closed_alert trigger, which proves
   itself with the x-flight-alert secret from Vault. Reads and writes use the service role. */
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import { callJev } from '../generate-report/jev.js';
import { QUESTIONS, flightState, runJev, jevCallRows } from '../generate-report/hybrid.js';
import { parseAlertRequest, hasNotes, shouldAlert, alertEmail, closeLabelRow } from './alert.js';
import { sendEmail } from './resend.js';

const env = (k: string, d = '') => Deno.env.get(k) ?? d;
// A typo in a numeric setting falls back to the default instead of becoming NaN.
const numEnv = (k: string, d: number) => { const v = Number(Deno.env.get(k)); return Number.isFinite(v) && v > 0 ? v : d; };
// Jev 12 s + DB calls + email 8 s stays inside pg_net's 30 s timeout, with room for a cold
// start that t0 doesn't see. A pg_net timeout only loses net._http_response, not the work.
const JEV_PHASE_MS = 12000;
const FLIGHT_COLS = 'id, flight_date, flight_no, registration, form_id, etd, delay_minutes, dg_note, notes, status, '
  + 'flight_stops!flight_stops_flight_id_fkey(seq, dest, cargo_lb, post_lb, fast_lb, bag_lb)';

Deno.serve(async req => {
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  const t0 = Date.now();
  let flightId: string | null = null;
  try {
    const admin = createClient(env('SUPABASE_URL'), env('SB_SECRET_KEY') || env('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: ok, error: sErr } = await admin.rpc('is_flight_alert_secret', { p_secret: req.headers.get('x-flight-alert') ?? '' });
    if (sErr) throw sErr;
    if (!ok) return reply(401, { error: 'Bad alert secret.' });

    const parsed = parseAlertRequest(await req.json().catch(() => null));
    if ('error' in parsed) return reply(400, { error: parsed.error });
    flightId = parsed.flightId;

    const { data: seen, error: dErr } = await admin.from('flight_close_labels').select('id').eq('flight_id', flightId).maybeSingle();
    if (dErr) throw dErr;
    if (seen) return reply(200, { flight_id: flightId, skipped: true });

    const { data: f, error: fErr } = await admin.from('flights').select(FLIGHT_COLS).eq('id', flightId).maybeSingle();
    if (fErr) throw fErr;
    if (!f) return reply(404, { error: 'No such flight.' });
    if (f.status !== 'closed') return reply(409, { error: 'Flight is not closed.' });

    // Anything that stops the Jev call (no notes, a failed spend check, no key, the spend cap)
    // stores the reason and leaves the flight to the "no label" rule; it never stops the alert.
    const jevModel = env('JEV_MODEL', 'typesafe/jev-1.14');
    const apiKey = env('OPENROUTER_API_KEY');
    let result: any = { flight: f, calls: [], label: null, error: null };
    const { data: usage, error: uErr } = hasNotes(f) ? await admin.rpc('ai_usage', { p_user: null }).single() : { data: null, error: null };
    if (!hasNotes(f)) result.error = 'No notes to label';
    else if (uErr) result.error = `Spend check failed: ${String(uErr.message).slice(0, 200)}`;
    else if (!apiKey) result.error = 'OPENROUTER_API_KEY is not set';
    else if (Number((usage as any).spend_usd) >= numEnv('AI_SPEND_CAP_USD', 2)) result.error = 'AI spend cap reached';
    else {
      [result] = await runJev({ flights: [f], concurrency: 1, deadline: t0 + JEV_PHASE_MS,
        ask: (fl: any, msLeft: number) => callJev({ apiKey, model: jevModel, state: flightState(fl), questions: QUESTIONS,
          timeoutMs: Math.min(numEnv('JEV_TIMEOUT_MS', 10000), msLeft) }) });
      const rows = jevCallRows([result]).map((c: any) => ({ report_id: null, provider_model: c.model, purpose: 'jev_flight_close',
        input_tokens: c.input_tokens, output_tokens: c.output_tokens, cost_usd: c.cost_usd, latency_ms: c.latency_ms,
        status: c.status, error_message: c.error }));
      for (const row of rows) console.log(JSON.stringify({ event: 'ai_call', flight_id: flightId, ...row }));
      if (rows.length) {
        const { error } = await admin.from('ai_calls').insert(rows);
        if (error) console.error(JSON.stringify({ event: 'ai_call_log_failed', flight_id: flightId, message: error.message }));
      }
    }

    const decision = shouldAlert(result.label, f, numEnv('ALERT_URGENCY', 4));
    // Inserted before the email: a second, concurrent call fails here on the unique key and sends nothing.
    const { data: row, error: iErr } = await admin.from('flight_close_labels')
      .insert(closeLabelRow(flightId, jevModel, result.label, result.error, decision)).select('id').single();
    if (iErr?.code === '23505') return reply(200, { flight_id: flightId, skipped: true });
    if (iErr) throw iErr;

    let emailStatus: string | null = null, emailError: string | null = null;
    if (decision.alert) {
      const to = env('ALERT_TO'), key = env('RESEND_API_KEY');
      // From here on a failure marks the row 'failed' instead of leaving it 'pending'.
      try {
        const { data: sentToday, error: cErr } = to && key ? await admin.rpc('alert_emails_today') : { data: 0, error: null };
        if (cErr) throw cErr;
        if (!to || !key) emailStatus = 'off';
        else if (Number(sentToday) >= numEnv('ALERT_DAILY_CAP', 10)) emailStatus = 'capped';
        else {
          const { subject, text } = alertEmail({ flight: f, label: result.label, reason: decision.reason, error: result.error,
            appUrl: env('ALERT_APP_URL', 'https://loadcontrol.raphaelattar.com/reports.html') });
          // Keyed on the row, so a deliberate re-send (row deleted) isn't swallowed by Resend.
          const sent = await sendEmail({ apiKey: key, from: env('ALERT_FROM', 'Load Control Lite <onboarding@resend.dev>'),
            to, subject, text, idempotencyKey: `flight-alert/${row.id}` });
          emailStatus = sent.ok ? 'sent' : 'failed';
          emailError = sent.error;
        }
      } catch (e) {
        emailStatus = 'failed';
        emailError = String((e as Error)?.message ?? e).slice(0, 300);
      }
      const { error } = await admin.from('flight_close_labels').update({ email_status: emailStatus, email_error: emailError,
        emailed_at: emailStatus === 'sent' ? new Date().toISOString() : null }).eq('id', row.id);
      if (error) throw error;
    }
    console.log(JSON.stringify({ event: 'flight_alert', flight_id: flightId, category: result.label?.category ?? null,
      urgency: result.label?.urgency ?? null, alert: decision.reason, email: emailStatus, ms: Date.now() - t0 }));
    return reply(200, { flight_id: flightId, alert: decision.alert, reason: decision.reason, email_status: emailStatus });
  } catch (e) {
    console.error(JSON.stringify({ event: 'flight_alert_failed', flight_id: flightId, message: String((e as Error)?.message ?? e) }));
    return reply(500, { error: 'The alert could not be processed.', flight_id: flightId });
  }
});
