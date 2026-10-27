/* Reports page: pick a week, generate the Claude-only report through the edge function,
   read it back from the reports table, and list earlier runs. The page never writes to
   the database itself; reports and ai_calls are read-only for signed-in users. */
import { sb, currentUser } from './db.js';
import { LOGO } from './brand.js';
import { renderMarkdown, esc } from './md.js';

const $ = id => document.getElementById(id);
const DAY = 864e5;
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const usd = v => { const n = Number(v); return esc(n > 0 && n < 0.0001 ? '<$0.0001' : `$${n.toFixed(4)}`); };
const secs = ms => `${(Number(ms) / 1000).toFixed(1)} s`;
const int = v => Number(v).toLocaleString('en-CA');
const when = iso => new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' });
const LIST_COLS = 'id, created_at, period_start, period_end, mode, status, triggered_by, model_claude, total_cost_usd, total_latency_ms, call_count';

async function loadWeeks() {
  const { data, error } = await sb.from('v_route_week').select('week_start').order('week_start', { ascending: false }).limit(1000);
  if (error) throw error;
  const weeks = [...new Set(data.map(r => r.week_start))].sort().reverse();
  const today = todayISO();
  const pick = weeks.find(w => addDays(w, 6) < today) ?? weeks[0];
  $('weekPick').innerHTML = weeks.map(w => `<option value="${esc(w)}" ${w === pick ? 'selected' : ''}>${esc(w)} to ${esc(addDays(w, 6))}</option>`).join('');
}

async function loadHistory() {
  const { data, error } = await sb.from('reports').select(LIST_COLS).order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  $('historyCard').hidden = !data.length;
  $('historyBody').innerHTML = data.map(r => `<tr>
    <td>${esc(when(r.created_at))}</td><td>${esc(r.period_start)}</td>
    <td><span class="pill ${r.status === 'ok' ? 'ok' : 'err'}">${esc(r.status)}</span></td>
    <td>${r.triggered_by === 'schedule' ? 'Scheduled' : 'Manual'}</td>
    <td>${usd(r.total_cost_usd)}</td><td>${secs(r.total_latency_ms)}</td><td>${esc(r.model_claude ?? '')}</td>
    <td><button class="btn small" data-open="${esc(r.id)}">Open</button></td></tr>`).join('');
}

async function showReport(id) {
  const [rep, calls] = await Promise.all([
    sb.from('reports').select('*').eq('id', id).single().then(r => r, error => ({ error })),
    sb.from('ai_calls').select('purpose, provider_model, status, cost_usd, latency_ms, input_tokens, output_tokens, error_message')
      .eq('report_id', id).order('created_at').then(r => r, error => ({ error })),
  ]);
  if (rep.error) throw rep.error;
  const r = rep.data, list = calls.data ?? [];
  const failed = r.status !== 'ok';
  const lastError = [...list].reverse().find(c => c.error_message)?.error_message;
  const models = [...new Set(list.map(c => c.provider_model))].join(', ') || r.model_claude || ''; // what answered, not just what was asked
  $('reportCard').hidden = false;
  $('reportCard').innerHTML = `
    <h2>Week of ${esc(r.period_start)} to ${esc(r.period_end)} <span class="pill ${failed ? 'err' : 'ok'}">${esc(r.status)}</span></h2>
    ${failed
      ? `<p class="report-error">This run didn't produce a complete report.${lastError ? ` ${esc(lastError)}` : ''}</p>`
      : `<div class="report-body">${renderMarkdown(r.content_md)}</div>`}
    <p class="report-meta">${usd(r.total_cost_usd)} · ${secs(r.total_latency_ms)} · ${int(r.call_count)} call${r.call_count === 1 ? '' : 's'}
      · ${int(r.total_input_tokens)} in / ${int(r.total_output_tokens)} out tokens · ${esc(models)}
      · AI-written from database figures · ${esc(when(r.created_at))}</p>
    ${list.length > 1 ? `<details class="report-calls"><summary>Calls</summary><ul>${list.map(c =>
      `<li>${esc(c.purpose)} · ${esc(c.status)} · ${usd(c.cost_usd)} · ${secs(c.latency_ms)}${c.error_message ? ` · ${esc(c.error_message)}` : ''}</li>`).join('')}</ul></details>` : ''}`;
  $('reportCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// The function's JSON error body is on error.context (a Response) for non-2xx answers.
async function errorText(error) {
  try { const b = await error.context.json(); return { message: b.error, reportId: b.report_id }; }
  catch { return { message: error.message || 'The report service did not answer.' }; }
}

async function generate(e) {
  e.preventDefault();
  const btn = $('genBtn'), status = $('genStatus'), started = Date.now();
  btn.disabled = true; status.className = 'report-status';
  const tick = setInterval(() => { status.textContent = `Writing the report… ${Math.round((Date.now() - started) / 1000)} s (usually 10 to 30)`; }, 500);
  try {
    const { data, error } = await sb.functions.invoke('generate-report', { body: { period_start: $('weekPick').value } });
    clearInterval(tick);
    if (error) {
      const { message, reportId } = await errorText(error);
      status.className = 'report-status error'; status.textContent = message;
      if (reportId) { await loadHistory(); await showReport(reportId); }
      return;
    }
    status.textContent = '';
    await loadHistory(); await showReport(data.report_id);
  } catch (err) {
    console.error(err);
    status.className = 'report-status error'; status.textContent = err.message || String(err);
  } finally { clearInterval(tick); btn.disabled = false; }
}

async function boot() {
  $('brand').insertAdjacentHTML('afterbegin', LOGO('logo'));
  const user = await currentUser();
  $('signedOut').hidden = !!user;
  if (!user) return;
  $('generator').hidden = false;
  try { await Promise.all([loadWeeks(), loadHistory()]); }
  catch (err) { console.error(err); $('genStatus').className = 'report-status error'; $('genStatus').textContent = `Couldn't load: ${err.message}`; }
}

$('genForm').addEventListener('submit', generate);
$('historyBody').addEventListener('click', e => {
  const id = e.target.closest('[data-open]')?.dataset.open;
  if (id) showReport(id).catch(err => { console.error(err); $('genStatus').textContent = err.message; });
});
boot();
