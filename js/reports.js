/* Reports page: pick a week, generate the report in either mode through the edge function,
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
const LIST_COLS = 'id, created_at, period_start, period_end, mode, status, triggered_by, model_claude, model_jev, total_cost_usd, total_latency_ms, call_count';
const MODE_NAME = { claude_only: 'Claude only', hybrid: 'Claude + Jev' };
const MODE_HINT = {
  claude_only: 'Claude reads every flight of the week and writes the report.',
  hybrid: 'Jev labels each flight, code picks the ones worth reading, and Claude writes the report from those.',
};
const pillClass = s => ({ ok: 'ok', fallback: 'warn' })[s] ?? 'err';
const modelsOf = r => [r.model_claude, r.model_jev].filter(Boolean).join(' + ');
const pct = v => v == null ? '–' : `${Math.round(Number(v) * 100)}%`;
const WHY = { jev_mention: 'Jev: mention', flagged: 'Flagged by a database check', jev_failed: 'No Jev answer',
  low_confidence: 'Jev unsure', jev_routine: 'Jev: routine' };
const showHint = () => { $('modeHint').textContent = `${MODE_HINT[$('modePick').value]} Every figure comes from the database.`; };

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
    <td>${esc(when(r.created_at))}</td><td>${esc(r.period_start)}</td><td>${esc(MODE_NAME[r.mode] ?? r.mode)}</td>
    <td><span class="pill ${pillClass(r.status)}">${esc(r.status)}</span></td>
    <td>${r.triggered_by === 'schedule' ? 'Scheduled' : 'Manual'}</td>
    <td>${usd(r.total_cost_usd)}</td><td>${secs(r.total_latency_ms)}</td><td>${esc(modelsOf(r))}</td>
    <td><button class="btn small" data-open="${esc(r.id)}">Open</button></td></tr>`).join('');
}

const ALERT_WHY = { safety_concern: 'Safety concern', urgency: 'Follow-up', no_label: 'No Jev label, has notes' };
const EMAIL_PILL = { sent: 'ok', capped: 'warn', off: 'muted', pending: 'warn' };

// Same-day alerts from closed flights (M9). Never throws: a failed query leaves the card
// hidden and History still loads.
async function loadAlerts() {
  const { data, error } = await sb.from('flight_close_labels')
    .select('created_at, alert_reason, category, urgency, email_status, flights(flight_no, flight_date, registration)')
    .not('alert_reason', 'is', null).order('created_at', { ascending: false }).limit(20);
  if (error) { console.warn('alerts', error.message); return; }
  $('alertsCard').hidden = false;
  $('alertsBody').innerHTML = data.length ? data.map(a => `<tr>
    <td>${esc(when(a.created_at))}</td>
    <td>${esc(a.flights?.flight_no || '–')} · ${esc(a.flights?.flight_date ?? '')} · ${esc(a.flights?.registration || '')}</td>
    <td>${esc(ALERT_WHY[a.alert_reason] ?? a.alert_reason)}</td>
    <td>${esc(a.category ?? '–')}</td>
    <td>${esc(a.urgency ?? '–')}</td>
    <td><span class="pill ${EMAIL_PILL[a.email_status] ?? 'err'}">${esc(a.email_status)}</span></td></tr>`).join('')
    : '<tr><td colspan="6">No alerts yet.</td></tr>';
}

// Jev's decision for each flight of a hybrid report: the flights Claude read first, then the rest.
// On a fallback run Claude read every flight, so the table says what Jev would have sent.
function labelsHtml(labels, fellBack) {
  if (!labels.length) return '';
  const sent = labels.filter(l => l.included).length;
  const rows = [...labels].sort((a, b) => b.included - a.included || Number(b.mention_p ?? 1) - Number(a.mention_p ?? 1)
    || String(a.flights?.flight_date).localeCompare(String(b.flights?.flight_date)));
  const summary = fellBack
    ? `Jev decisions: would have sent ${sent} of ${labels.length} flights (Claude read all ${labels.length})`
    : `Jev decisions: ${sent} of ${labels.length} flights sent to Claude`;
  return `<details class="report-labels"><summary>${summary}</summary>
    <div class="table-wrap"><table class="history"><thead><tr>
      <th>Flight</th><th>Date</th><th>Category</th><th>Sure</th><th>Mention</th><th>Urgency</th><th>${fellBack ? 'Would send' : 'Sent'}</th><th>Why</th>
    </tr></thead><tbody>${rows.map(l => `<tr>
      <td>${esc(l.flights?.flight_no ?? '')}</td><td>${esc(l.flights?.flight_date ?? '')}</td>
      <td>${esc(l.category ?? '–')}</td><td>${esc(pct(l.category_confidence))}</td><td>${esc(pct(l.mention_p))}</td>
      <td>${esc(l.urgency ?? '–')}</td><td>${l.included ? 'Yes' : 'No'}</td>
      <td>${esc(WHY[l.reason] ?? l.reason)}${l.error_message ? ` (${esc(l.error_message)})` : ''}</td></tr>`).join('')}
    </tbody></table></div></details>`;
}

async function showReport(id) {
  const [rep, calls, labs] = await Promise.all([
    sb.from('reports').select('*').eq('id', id).single().then(r => r, error => ({ error })),
    sb.from('ai_calls').select('purpose, provider_model, status, cost_usd, latency_ms, input_tokens, output_tokens, error_message')
      .eq('report_id', id).order('created_at').then(r => r, error => ({ error })),
    sb.from('flight_ai_labels').select('category, category_confidence, mention_p, urgency, included, reason, error_message, flights(flight_no, flight_date)')
      .eq('report_id', id).then(r => r, error => ({ error })),
  ]);
  if (rep.error) throw rep.error;
  if (labs.error) console.error('Could not load Jev labels', labs.error);
  const r = rep.data, list = calls.data ?? [], labels = labs.data ?? [];
  const failed = r.status === 'error';
  const jev = list.filter(c => c.purpose === 'jev_flight_decisions'), claude = list.filter(c => c.purpose !== 'jev_flight_decisions');
  const lastError = [...claude].reverse().find(c => c.error_message)?.error_message;
  const models = [...new Set(list.map(c => c.provider_model))].join(', ') || modelsOf(r); // what answered, not just what was asked
  $('reportCard').hidden = false;
  $('reportCard').innerHTML = `
    <h2>Week of ${esc(r.period_start)} to ${esc(r.period_end)} <span class="pill ${pillClass(r.status)}">${esc(r.status)}</span></h2>
    ${r.status === 'fallback' ? '<p class="alert warn">Jev didn\'t answer for enough flights, so Claude read every flight instead (the Claude-only input).</p>' : ''}
    ${failed
      ? `<p class="report-error">This run didn't produce a complete report.${lastError ? ` ${esc(lastError)}` : ''}</p>`
      : `<div class="report-body">${renderMarkdown(r.content_md)}</div>`}
    <p class="report-meta">${usd(r.total_cost_usd)} · ${secs(r.total_latency_ms)} · ${int(r.call_count)} call${r.call_count === 1 ? '' : 's'}
      · ${int(r.total_input_tokens)} in / ${int(r.total_output_tokens)} out tokens · ${esc(models)}
      · AI-written from database figures · ${esc(when(r.created_at))}</p>
    ${list.length > 1 ? `<details class="report-calls"><summary>Calls</summary><ul>
      ${jev.length ? `<li>jev_flight_decisions × ${jev.length} · ${jev.filter(c => c.status !== 'ok').length} failed
        · ${usd(jev.reduce((t, c) => t + Number(c.cost_usd), 0))} · longest ${secs(Math.max(...jev.map(c => c.latency_ms)))}</li>` : ''}
      ${claude.map(c => `<li>${esc(c.purpose)} · ${esc(c.status)} · ${usd(c.cost_usd)} · ${secs(c.latency_ms)}${c.error_message ? ` · ${esc(c.error_message)}` : ''}</li>`).join('')}
    </ul></details>` : ''}
    ${labelsHtml(labels, r.status === 'fallback')}`;
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
  const mode = $('modePick').value;
  const tick = setInterval(() => {
    status.textContent = `Writing the report… ${Math.round((Date.now() - started) / 1000)} s (usually ${mode === 'hybrid' ? '20 to 50' : '10 to 30'})`;
  }, 500);
  try {
    const { data, error } = await sb.functions.invoke('generate-report', { body: { period_start: $('weekPick').value, mode } });
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
  showHint();
  try { await Promise.all([loadWeeks(), loadHistory(), loadAlerts()]); }
  catch (err) { console.error(err); $('genStatus').className = 'report-status error'; $('genStatus').textContent = `Couldn't load: ${err.message}`; }
}

$('genForm').addEventListener('submit', generate);
$('modePick').addEventListener('change', showHint);
$('historyBody').addEventListener('click', e => {
  const id = e.target.closest('[data-open]')?.dataset.open;
  if (id) showReport(id).catch(err => { console.error(err); $('genStatus').textContent = err.message; });
});
boot();
