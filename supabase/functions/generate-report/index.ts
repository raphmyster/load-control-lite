/* generate-report: writes the weekly ops report with Claude (Mode A, claude_only).
   Wiring only; the logic is in report-core.js, openrouter.js and pipeline.js.
   Reads go through the caller's own client, so RLS applies. Writes to reports and
   ai_calls use the service role, because those tables have no write policies. */
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import { parseRequest, capCheck, buildFacts, flightsCsv, buildMessages, totals } from './report-core.js';
import { callOpenRouter } from './openrouter.js';
import { writeReport } from './pipeline.js';

const env = (k: string, d = '') => Deno.env.get(k) ?? d;
const FLIGHT_COLS = 'id, flight_date, flight_no, registration, form_id, etd, delay_minutes, dg_note, notes, status, '
  + 'flight_stops!flight_stops_flight_id_fkey(seq, dest, cargo_lb, post_lb, fast_lb, bag_lb)';

function corsHeaders(req: Request) {
  const allowed = env('ALLOWED_ORIGINS', 'http://localhost:8411,http://127.0.0.1:8411').split(',').map(s => s.trim());
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    // echo what the preflight asks for: supabase-js adds x-supabase-client-* headers in newer versions
    'Access-Control-Allow-Headers': req.headers.get('Access-Control-Request-Headers') ?? 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

Deno.serve(async req => {
  const cors = corsHeaders(req);
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  const model = env('CLAUDE_MODEL', 'anthropic/claude-haiku-5.5');
  const caps = { dailyCap: Number(env('REPORT_DAILY_CAP', '5')), spendCapUsd: Number(env('AI_SPEND_CAP_USD', '2')) };
  const noSession = { persistSession: false, autoRefreshToken: false };
  let reportId: string | null = null;
  const t0 = Date.now();
  try {
    // The legacy service_role/anon keys are injected while they're enabled on the project.
    // If they're ever turned off, set SB_SECRET_KEY / SB_PUBLISHABLE_KEY as secrets instead.
    const url = env('SUPABASE_URL');
    const admin = createClient(url, env('SB_SECRET_KEY') || env('SUPABASE_SERVICE_ROLE_KEY'), { auth: noSession });
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth } = jwt ? await admin.auth.getUser(jwt) : { data: null };
    const user = auth?.user;
    if (!user) return reply(401, { error: 'Sign in first.' });

    const period = parseRequest(await req.json().catch(() => null));
    if ('error' in period) return reply(400, { error: period.error });

    const { data: usage, error: uErr } = await admin.rpc('ai_usage', { p_user: user.id }).single();
    if (uErr) throw uErr;
    const capped = capCheck({ runsToday: Number(usage.runs_today), spendUsd: Number(usage.spend_usd) }, caps);
    if (capped) return reply(429, { error: capped.message, code: capped.code });

    const db = createClient(url, env('SB_PUBLISHABLE_KEY') || env('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: noSession,
    });
    const [rw, ng, zn, dl, fl, tn] = await Promise.all([
      db.from('v_route_week').select('*').gte('week_start', period.trendStart).lte('week_start', period.start),
      db.from('v_near_limit').select('flight_id, flight_date, flight_no, form_id, label, pct_of_max, is_over')
        .eq('limit_kind', 'group').gte('flight_date', period.trendStart).lte('flight_date', period.end),
      db.from('v_near_limit').select('flight_id', { count: 'exact', head: true })
        .eq('limit_kind', 'zone').gte('flight_date', period.start).lte('flight_date', period.end),
      db.from('v_delays').select('*').gte('flight_date', period.start).lte('flight_date', period.end),
      db.from('flights').select(FLIGHT_COLS).gte('flight_date', period.start).lte('flight_date', period.end),
      db.from('flights').select('flight_no, notes').neq('notes', '').gte('flight_date', period.trendStart).lte('flight_date', period.end),
    ]);
    for (const r of [rw, ng, zn, dl, fl, tn]) if (r.error) throw r.error;
    if (!fl.data.length) return reply(422, { error: `No flights between ${period.start} and ${period.end}.` });

    const weekGroups = ng.data.filter(r => r.flight_date >= period.start);
    const facts = buildFacts({ period, routeWeeks: rw.data, nearGroups: ng.data, zoneNearCount: zn.count ?? 0,
      delays: dl.data, trendNotes: tn.data, flights: fl.data });
    const messages = buildMessages({ facts, csv: flightsCsv(fl.data, weekGroups) });

    const { data: rep, error: rErr } = await admin.from('reports').insert({
      mode: 'claude_only', period_start: period.start, period_end: period.end, model_claude: model,
      status: 'error', created_by: user.id,   // 'error' until a complete report is stored
    }).select('id').single();
    if (rErr) throw rErr;
    reportId = rep.id;

    const apiKey = env('OPENROUTER_API_KEY');
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
    const result = await writeReport({
      messages,
      callModel: (m: unknown, ms: number) => callOpenRouter({ apiKey, model, messages: m, timeoutMs: ms, reasoningEffort: env('CLAUDE_REASONING', 'low') }),
      timeoutMs: Number(env('CLAUDE_TIMEOUT_MS', '45000')),
      deadline: t0 + 135000,
      onCall: async (c: any) => {
        const row = { report_id: reportId, provider_model: c.model, purpose: c.purpose, input_tokens: c.input_tokens,
          output_tokens: c.output_tokens, cost_usd: c.cost_usd, latency_ms: c.latency_ms, status: c.status, error_message: c.error };
        console.log(JSON.stringify({ event: 'ai_call', ...row }));
        if (c.ok && !c.cost_reported) console.warn(JSON.stringify({ event: 'cost_missing', report_id: reportId, model: c.model }));
        const { error } = await admin.from('ai_calls').insert(row);
        if (error) console.error(JSON.stringify({ event: 'ai_call_log_failed', report_id: reportId, message: error.message }));
      },
    });

    const update = { ...totals(result.calls), total_latency_ms: Date.now() - t0,
      ...(result.ok ? { status: 'ok', content_md: result.content } : {}) };
    const { error: uErr2 } = await admin.from('reports').update(update).eq('id', reportId);
    if (uErr2) throw uErr2;
    console.log(JSON.stringify({ event: 'report', report_id: reportId, status: result.ok ? 'ok' : 'error', ...totals(result.calls) }));
    return result.ok ? reply(200, { report_id: reportId }) : reply(502, { error: result.error, report_id: reportId });
  } catch (e) {
    console.error(JSON.stringify({ event: 'report_failed', report_id: reportId, message: String((e as Error)?.message ?? e) }));
    return reply(500, { error: 'The report could not be generated. Try again later.', report_id: reportId });
  }
});
