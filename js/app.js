
import { OPERATOR, DEMO_LABEL, LIMITS_NOTE, FORMS, SPLIT_KINDS, WHOLE_KIND, FREIGHT_KEYS, FORM_POS, AIRPORTS } from './config.js';
import { LOGO } from './brand.js';
import { drawForm } from './draw.js';
import { calc, n } from './calc.js';
import * as db from './db.js';
import { delayMinutes } from './db-map.js';

/* ---------------------------- helpers ---------------------------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable: keep in memory */ } },
};
const uid = () => crypto.randomUUID(); // database ids are uuids
const isExpr = v => { const c = calc(v); return c.terms.length > 1 || /[*/()]/.test(String(v ?? '')); };
const sum = a => a.reduce((s, x) => s + x, 0);
const fmt = v => Math.round(v).toLocaleString('en-CA');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}-${MONTHS[+m - 1]}-${y.slice(2)}`; };
const blankIfZero = v => v ? fmt(v) : '';
const AIRPORT_CODES = new Set(AIRPORTS.map(a => a.code));

function newRow() { return { id: uid(), dest: '', cargo: '', post: '', fast: '', bag: '' }; }
function newFlight() {
  return {
    id: uid(), date: todayISO(), flightNo: '', reg: '', form: 'PC12', etd: '', atd: '', status: 'draft',
    special: { hr: false, aog: false }, dgNote: '',
    rows: [newRow(), newRow()], alloc: {}, pos: {}, manual: false,
    notes: '', loadmaster: '', updated: Date.now(),
  };
}
/* --------------------------- calculations --------------------------- */
const formOf = f => FORMS[f.form] || FORMS.PC12;
const kindsOf = form => form.split ? SPLIT_KINDS : WHOLE_KIND;
const placeable = form => form.zones.filter(z => !z.na && !z.unavailable);
const activeRows = f => f.rows.filter(r => r.dest.trim() || FREIGHT_KEYS.some(([k]) => n(r[k])));
const allocOf = (f, rowId, kind) => (f.alloc[rowId] || {})[kind] || {};

function compute(f) {
  const form = formOf(f), kinds = kindsOf(form), zones = placeable(form);
  const rs = activeRows(f).map(r => {
    const parts = kinds.map(k => {
      const amount = sum(k.from.map(key => n(r[key])));
      const a = allocOf(f, r.id, k.id);
      const placed = sum(zones.map(z => n(a[z.id])));
      return { kind: k, amount, placed, unplaced: amount - placed };
    });
    return { r, total: sum(FREIGHT_KEYS.map(([k]) => n(r[k]))), parts };
  });
  const planned = {}, byKind = {}, tags = {};
  form.zones.forEach(z => { planned[z.id] = 0; byKind[z.id] = Object.fromEntries(kinds.map(k => [k.id, 0])); tags[z.id] = []; });
  rs.forEach(x => {
    zones.forEach(z => {
      let t = 0;
      kinds.forEach(k => { const v = n(allocOf(f, x.r.id, k.id)[z.id]); byKind[z.id][k.id] += v; t += v; });
      planned[z.id] += t;
      if (t) tags[z.id].push({ dest: x.r.dest || '?', w: t, rowId: x.r.id, pos: f.pos?.[x.r.id]?.[z.id] });
    });
  });
  const groups = form.groups.map(g => { const total = sum(g.zones.map(id => planned[id])); return { ...g, total, over: total > g.max }; });
  const plannedTotal = sum(Object.values(planned));
  const manifestTotal = sum(rs.map(x => x.total));
  return { form, kinds, zones, rs, planned, byKind, tags, groups, plannedTotal, manifestTotal };
}

// zone and combined-zone maximums that the planned load goes over
function overLimits(c) {
  return [
    ...c.zones.filter(z => z.max && c.planned[z.id] > z.max).map(z => `${z.label}: ${fmt(c.planned[z.id])} lb, max ${fmt(z.max)} lb`),
    ...c.groups.filter(g => g.over).map(g => `${g.short}: ${fmt(g.total)} lb, max ${fmt(g.max)} lb`),
  ];
}
// Print and Save as PDF stay blocked while anything is over a limit
function blockedByLimits() {
  const over = overLimits(compute(cur()));
  if (!over.length) return false;
  document.getElementById('limitList').innerHTML = over.map(x => `<li>${esc(x)}</li>`).join('');
  document.getElementById('limitDialog').showModal();
  return true;
}

function warnings(f, c) {
  const w = [], add = (level, msg) => w.push({ level, msg });
  const { rs, zones, planned, groups } = c;
  rs.forEach(x => {
    const d = x.r.dest.trim();
    if (!d) add('warn', 'A manifest row has weights but no destination.');
    else if (!AIRPORT_CODES.has(d)) add('warn', `${d} isn't in the airport list. Check the destination code.`);
  });
  zones.forEach(z => { if (z.max && planned[z.id] > z.max) add('error', `${z.label}: ${fmt(planned[z.id])} lb planned, max ${fmt(z.max)} lb.`); });
  groups.forEach(g => { if (g.over) add('error', `${g.short}: ${fmt(g.total)} lb planned, max ${fmt(g.max)} lb.`); });
  rs.forEach(x => x.parts.forEach(p => {
    const what = `${x.r.dest || '(no destination)'}${p.kind.label ? ' ' + p.kind.label.toLowerCase() : ''}`;
    if (p.unplaced > 0.5) add('warn', `${what}: ${fmt(p.unplaced)} lb not placed in a zone.`);
    if (p.unplaced < -0.5) add('error', `${what}: ${fmt(-p.unplaced)} lb more placed than the manifest shows.`);
  }));
  if (!f.dgNote) add('info', 'DG pilot notification: choose "Signed by crew" or "N/A".');
  if (!f.reg.trim()) add('info', 'Enter the aircraft registration.');
  return w;
}

/* --------------------------- load planning --------------------------- */
// Last stop first, starting from the deepest zone. A stop moves on to the next zone
// when the current one has no individual limit, so each stop gets its own zone;
// zones with their own limit, and every zone on a `shared` form (the PC12, which
// fills J first), are shared until full.
function autoPlace(f) {
  const c = compute(f), form = c.form;
  const order = form.loadOrder.map(id => form.zones.find(z => z.id === id)).filter(Boolean);
  const room = Object.fromEntries(order.map(z => [z.id, z.max ?? Infinity]));
  const groupRoom = Object.fromEntries(form.groups.map(g => [g.id, g.max]));
  const capOf = z => Math.min(room[z.id], ...form.groups.filter(g => g.zones.includes(z.id)).map(g => groupRoom[g.id]));
  const take = (z, v) => { room[z.id] -= v; form.groups.forEach(g => { if (g.zones.includes(z.id)) groupRoom[g.id] -= v; }); };
  f.alloc = {};
  let start = 0;
  [...c.rs].reverse().forEach(x => {
    const a = f.alloc[x.r.id] = {};
    let last = -1;
    x.parts.forEach(p => {
      let left = p.amount;
      const seq = [...order.slice(start), ...order.slice(0, start)];
      // keep a stop in one zone when one has room for all of it; split only if none does
      const whole = left > 0 && seq.find(z => capOf(z) >= left);
      for (const z of whole ? [whole] : seq) {
        if (left <= 0) break;
        const put = Math.min(left, capOf(z));
        if (put > 0) {
          (a[p.kind.id] ||= {})[z.id] = String(Math.round(put * 10) / 10);
          take(z, put); left -= put; last = Math.max(last, order.indexOf(z));
        }
      }
    });
    if (last >= 0 && !form.shared) start = order[last].max == null ? Math.min(last + 1, order.length - 1) : last;
  });
  f.manual = false;
}

function parseQuick(text) {
  const out = [], pre = { c: 'cargo', p: 'post', f: 'fast', b: 'bag' };
  for (const chunk of text.split(/[\n;]+/)) {
    const toks = chunk.trim().split(/[\s,]+/).filter(Boolean);
    if (!toks.length) continue;
    const r = { dest: toks.shift().toUpperCase().replace(/[^A-Z0-9]/g, '') };
    let pos = 0;
    for (const tok of toks) {
      const m = tok.match(/^([cpfb])?(\d+(?:\.\d+)?)$/i);
      if (!m) continue;
      const key = m[1] ? pre[m[1].toLowerCase()] : FREIGHT_KEYS[pos++]?.[0];
      if (key) r[key] = r[key] ? `${r[key]}+${m[2]}` : m[2];
    }
    out.push(r);
  }
  return out;
}

/* ------------------------------ printed forms ------------------------------
   Each form is drawn blank in SVG (draw.js) and the flight's data goes on top in the
   same SVG. Positions are in the form's own units (FORM_POS in config.js), so the
   overlay scales with the drawing on screen and on paper. */

const pageFoot = (f, title) => `<div class="foot"><span>${esc(title)} · Flight ${esc(f.flightNo)} · ${esc(f.reg)} · ${fmtDate(f.date)}</span><span>${esc(OPERATOR.app)} · ${esc(DEMO_LABEL)}</span></div>`;
// DG, human remains and AOG are flagged at the door on the form
const hazards = f => [f.dgNote === 'crew' && 'DG', f.special.hr && 'HUM', f.special.aog && 'AOG'].filter(Boolean);

const svgText = ([x, y], s, size = 20, anchor = 'middle', cls = 'v') =>
  s === '' || s == null ? '' : `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" dominant-baseline="middle" class="${cls}">${esc(s)}</text>`;
const dot = ([x, y]) => `<circle cx="${x}" cy="${y}" r="7.5" fill="#000"/>`;
const dropRect = (zone, [x, y, w, h], cls = 'drop') => `<rect class="${cls}" data-zone="${zone}" x="${x}" y="${y}" width="${w}" height="${h}" fill="transparent"/>`;
const overBox = ([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(198,40,40,.14)" stroke="#c62828" stroke-width="3"/>`;
const overNote = ([x, y], s, anchor = 'end') => `<text x="${x}" y="${y}" font-size="13" font-weight="800" fill="#c62828" text-anchor="${anchor}" dominant-baseline="middle" font-family="Arial, sans-serif">${esc(s)}</text>`;

// One destination tag. data-* lets the screen drag it; print ignores them.
function chip(t, zone, x, y, s, bw) {
  return `<g class="chip" data-row="${esc(t.rowId)}" data-zone="${zone}" data-x="${x.toFixed(1)}" data-y="${y.toFixed(1)}" data-w="${(bw * s).toFixed(1)}" data-h="${(40 * s).toFixed(1)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${s.toFixed(2)})">
    <rect width="${bw.toFixed(1)}" height="40" rx="6" fill="#dcf2ef" stroke="#2a9d8f" stroke-width="1.5"/>
    <rect width="6" height="40" rx="2" fill="#2a9d8f"/>
    <text x="12" y="16" font-size="16" font-weight="800" font-family="Arial, sans-serif" fill="#000" letter-spacing=".5">${esc(t.dest)}</text>
    <text x="12" y="33" font-size="15" class="v">${fmt(t.w)}<tspan font-size="10" font-family="Arial, sans-serif" font-weight="600" fill="#555"> lb</tspan></text></g>`;
}
const chipWidth = t => Math.max(64, 11 * t.dest.length + 20, 9.5 * fmt(t.w).length + 38);
const clampIn = ([ax, ay, aw, ah], x, y, w, h) => [Math.min(Math.max(x, ax), ax + Math.max(0, aw - w)), Math.min(Math.max(y, ay), ay + Math.max(0, ah - h))];

// Destination tags: ones never dragged flow into `flow`, shrunk until they fit (or into the
// whole section when `flow` would make them too small to read); dragged ones sit where they
// were dropped, held inside the section's `area`, latest on top.
function chips(list, flow, right = false, zone = '', area = flow) {
  const free = list.filter(t => t.pos).sort((a, b) => (a.pos[2] || 0) - (b.pos[2] || 0)), rest = list.filter(t => !t.pos);
  const flowed = (area !== flow ? flowChips(rest, flow, right, zone, 0.75) : null) ?? flowChips(rest, area, right, zone);
  return flowed + free.map(t => {
    const bw = chipWidth(t), s = Math.min(1, area[2] / bw, area[3] / 40);
    const [x, y] = clampIn(area, t.pos[0], t.pos[1], bw * s, 40 * s);
    return chip(t, zone, x, y, s, bw);
  }).join('');
}
// Returns null when the tags don't fit even at scale `minS`, unless minS is the 0.5 floor.
function flowChips(list, [x, y, w, h], right, zone, minS = 0.5) {
  if (!list.length) return '';
  const base = list.map(chipWidth);
  // integer steps: repeated -= 0.05 drifts below 0.5 and skipped the last size
  for (let k = 0, s = 1; s >= minS - 1e-9; k++, s = 1 - k * 0.05) {
    const ch = 40 * s, gap = 5 * s, rows = [[]];
    let rowW = 0;
    base.forEach((bw, i) => {
      const cw = bw * s;
      if (rowW && rowW + gap + cw > w) { rows.push([]); rowW = 0; }
      rows[rows.length - 1].push({ i, cw }); rowW += (rowW ? gap : 0) + cw;
    });
    const tooTall = rows.length * ch + (rows.length - 1) * gap > h, tooWide = base.some(bw => bw * s > w);
    if ((tooTall || tooWide) && (s > 0.51 || minS > 0.5)) continue;
    return rows.map((row, r) => {
      const total = row.reduce((a, c) => a + c.cw, 0) + gap * (row.length - 1);
      let cx = right ? x + w - total : x;
      return row.map(({ i, cw }) => {
        const g = chip(list[i], zone, cx, y + r * (ch + gap), s, base[i]);
        cx += cw + gap;
        return g;
      }).join('');
    }).join('');
  }
  return minS > 0.5 ? null : '';
}

function badges(f, [x, y], anchor = 'middle') {
  const hz = hazards(f);
  if (!hz.length) return '';
  const ws = hz.map(h => h.length * 11 + 14), total = ws.reduce((a, b) => a + b, 0) + 5 * (hz.length - 1);
  let cx = anchor === 'middle' ? x - total / 2 : x;
  return hz.map((h, i) => {
    const g = `<g transform="translate(${cx} ${y - 10})"><rect width="${ws[i]}" height="20" rx="3" fill="#fff" stroke="#c40000" stroke-width="2.5"/>
      <text x="${ws[i] / 2}" y="11" text-anchor="middle" dominant-baseline="middle" font-size="13" font-weight="800" font-family="Arial, sans-serif" fill="#c40000">${h}</text></g>`;
    cx += ws[i] + 5;
    return g;
  }).join('');
}

function wrapLines(text, maxChars) {
  const out = [];
  String(text || '').split('\n').forEach(par => {
    let line = '';
    par.split(/\s+/).filter(Boolean).forEach(word => {
      if (line && (line + ' ' + word).length > maxChars) { out.push(line); line = word; } else line = line ? line + ' ' + word : word;
    });
    out.push(line);
  });
  return out.filter((l, i, a) => l || i < a.length - 1);
}
function notesSvg(text, [x, y, w, h], size = 17) {
  const lh = size * 1.25, max = Math.max(1, Math.floor(h / lh));
  const lines = wrapLines(text, Math.floor(w / (size * 0.56))).slice(0, max);
  return lines.map((l, i) => `<text x="${x}" y="${y + size + i * lh}" font-size="${size}" class="note">${esc(l)}</text>`).join('');
}

function drawnBody(f, c) {
  const { form, planned, byKind, tags, groups } = c, P = FORM_POS[f.form] || FORM_POS.PC12;
  const [bx, by, bw, bh] = P.box;
  let o = '';
  const hs = P.headSize || 22;
  o += svgText(P.date, fmtDate(f.date), hs) + svgText(P.reg, f.reg, hs) + svgText(P.flight, f.flightNo, hs);
  if (f.special.hr) o += dot(P.dots.hr);
  if (f.special.aog) o += dot(P.dots.aog);
  if (f.dgNote === 'crew') o += dot(P.dots.crew);
  if (f.dgNote === 'na') o += dot(P.dots.na);

  if (form.layout === 'dh8') {
    form.zones.forEach(z => {
      const q = P.zones[z.id], anchor = q.end ? 'end' : 'middle';
      o += svgText(q.bag, blankIfZero(byKind[z.id].bag), 17, anchor) + svgText(q.cargo, blankIfZero(byKind[z.id].cargo), 17, anchor) + svgText(q.total, blankIfZero(planned[z.id]), 17, anchor);
      o += dropRect(z.id, q.drop) + dropRect(z.id, q.drop, 'area') + chips(tags[z.id], q.tags, q.right, z.id, q.drop);
      if (planned[z.id] > z.max) { o += overBox(q.max); o += overNote([q.max[0], q.max[1] + q.max[3] + 12], `NOW ${fmt(planned[z.id])} LB`, 'start'); }
    });
    groups.forEach(g => { if (g.over) { const r = P.groups[g.id]; o += overBox(r); o += overNote([r[0] + r[2] / 2, r[1] + r[3] + 12], `NOW ${fmt(g.total)} LB`, 'middle'); } });
    const tot = ids => sum(ids.map(id => planned[id]));
    o += svgText(P.totals.z3, fmt(tot(['Z3'])), 26) + svgText(P.totals.z1, fmt(tot(['Z1A', 'Z1B'])), 26)
      + svgText(P.totals.z2, fmt(tot(['Z2A', 'Z2B'])), 26) + svgText(P.totals.all, fmt(tot(['Z3', 'Z1A', 'Z1B', 'Z2A', 'Z2B', 'BINF', 'BINA'])), 26);
    o += badges(f, P.door, 'start');
    o += notesSvg(f.loadmaster ? `Load master: ${f.loadmaster}.` : '', P.notes, 15);
  } else {
    c.zones.forEach(z => {
      const [x0, x1] = P.cols[z.id], mid = (x0 + x1) / 2, narrow = x1 - x0 < 60, pad = narrow ? 1 : 3;
      const area = [x0 + pad, P.sect[0], x1 - x0 - 2 * pad, P.floor - P.sect[0]];
      o += dropRect(z.id, [x0, P.sect[0], x1 - x0, P.plan[1] - P.sect[0]]) + dropRect(z.id, area, 'area');
      o += chips(tags[z.id], [x0 + 5, P.sect[0], x1 - x0 - 10, P.sect[1] - P.sect[0]], false, z.id, area);
      const total = blankIfZero(planned[z.id]);
      o += svgText([mid, (P.plan[0] + P.plan[1]) / 2], total, Math.min(24, (x1 - x0 - 4) / (0.62 * Math.max(1, total.length))));
      if (z.max && planned[z.id] > z.max) { o += overBox([x0, P.lim[0], x1 - x0, P.lim[1] - P.lim[0]]); o += overNote(narrow ? [mid, P.lim[0] - 9] : [x1 - 6, P.lim[0] - 9], `NOW ${fmt(planned[z.id])} LB`, narrow ? 'middle' : 'end'); }
    });
    groups.forEach(g => {
      if (!g.over || !g.span) return;
      const x0 = P.cols[g.zones[0]][0], x1 = P.cols[g.zones[g.zones.length - 1]][1];
      o += overBox([x0, P.lim[0], x1 - x0, P.lim[1] - P.lim[0]]); o += overNote([x1 - 6, P.lim[0] - 9], `CABIN NOW ${fmt(g.total)} LB`);
    });
    o += svgText(P.planned, fmt(c.plannedTotal), 26);
    o += svgText(P.lm, f.loadmaster, 22);
    o += badges(f, P.door);
  }
  return `<div class="drawn"><svg viewBox="${bx} ${by} ${bw} ${bh}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(form.name)} load control form">
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="#fff"/>${drawForm(form, P)}${o}</svg></div>`;
}

const formBody = (f, c) => drawnBody(f, c);
// every printed page wraps its content in .fit so it can be shrunk onto one sheet
const page = (orient, inner, cls = '') => `<div class="page ${orient} ${cls}"><div class="fit">${inner}</div></div>`;
const formPage = (f, c, { foot = true } = {}) => page(c.form.orientation, formBody(f, c) + (foot ? pageFoot(f, c.form.type + ' load control') : ''));

function flightMeta(f, c) {
  return `<div class="meta"><span>Flight</span><b>${esc(f.flightNo)}</b><span>Date</span><b>${fmtDate(f.date)}</b>
    <span>A/C registration</span><b>${esc(f.reg)}</b><span>Form</span><b>${esc(c.form.name)}</b>
    <span>ETD</span><b>${esc(f.etd || '—')}</b><span>DG</span><b>${f.dgNote === 'crew' ? 'YES, signed by crew' : f.dgNote === 'na' ? 'N/A' : '—'}</b>
    <span>Special</span><b>${[f.special.hr && 'Human remains', f.special.aog && 'AOG'].filter(Boolean).join(', ') || '—'}</b></div>`;
}
function manifestTable(f, c) {
  const t = { cargo: 0, post: 0, fast: 0, bag: 0 };
  const body = c.rs.map(x => {
    FREIGHT_KEYS.forEach(([k]) => t[k] += n(x.r[k]));
    return `<tr><td class="l"><b>${esc(x.r.dest)}</b></td>${FREIGHT_KEYS.map(([k]) => `<td>${blankIfZero(n(x.r[k]))}</td>`).join('')}<td><b>${fmt(x.total)}</b></td></tr>`;
  }).join('');
  return `<table><thead><tr><th class="l">Destination</th><th>Cargo</th><th>Post</th><th>Fast-Tracks</th><th>Baggage</th><th>Total (lb)</th></tr></thead>
    <tbody>${body}</tbody><tfoot><tr><td class="l">Totals</td>${FREIGHT_KEYS.map(([k]) => `<td>${fmt(t[k])}</td>`).join('')}<td>${fmt(c.manifestTotal)}</td></tr></tfoot></table>`;
}
function manifestPage(f, c) {
  return page('portrait', `<div class="mf"><div class="mf-h"><h1>Flight Manifest</h1>${LOGO('plogo')}</div>${flightMeta(f, c)}${manifestTable(f, c)}
    <p style="font-size:11px;margin:4px 0 10px">Weights in lb.</p>
    <b>Notes</b><div class="box">${esc(f.notes)}</div></div>${pageFoot(f, 'Manifest')}`);
}
// flight details and manifest above the load control form, on one sheet
function onePage(f, c) {
  return page(c.form.orientation, `<div class="mf one-top">
      <div><div class="one-h">${LOGO('plogo')}<h1>Flight ${esc(f.flightNo)}</h1></div>${flightMeta(f, c)}</div>
      <div>${manifestTable(f, c)}${f.notes.trim() ? `<div class="box"><b>Notes:</b> ${esc(f.notes)}</div>` : ''}</div>
    </div>${formBody(f, c)}${pageFoot(f, 'Load control')}`, 'one');
}

/* ------------------------------ screen ------------------------------ */
const inp = (bind, val, cls = '', extra = '') => `<input type="text" inputmode="decimal" class="${cls}" data-bind="${esc(bind)}" value="${esc(val)}" ${extra}>`;
const txt = (bind, val, cls = '', extra = '') => `<input type="text" class="${cls}" data-bind="${esc(bind)}" value="${esc(val)}" ${extra}>`;
const chk = (bind, on, label) => `<label class="check"><input type="checkbox" data-bind="${esc(bind)}" ${on ? 'checked' : ''}> ${label}</label>`;
const radio = (bind, value, cur, label) => `<label class="check"><input type="radio" name="${esc(bind)}" data-bind="${esc(bind)}" value="${value}" ${cur === value ? 'checked' : ''}> ${label}</label>`;

function viewFlight(f) {
  return `<section class="card"><h2>Flight</h2><div class="grid-form">
    <label class="f">Date<input type="date" data-bind="flight:date" value="${esc(f.date)}"></label>
    <label class="f">Flight number${txt('flight:flightNo', f.flightNo)}</label>
    <label class="f">A/C registration${txt('flight:reg', f.reg, '', 'style="text-transform:uppercase" placeholder="e.g. C-FNBQ"')}</label>
    <label class="f">Load control form<select data-bind="flight:form">${Object.entries(FORMS).map(([k, x]) => `<option value="${k}" ${k === f.form ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    <label class="f">ETD<input type="time" data-bind="flight:etd" value="${esc(f.etd)}"></label>
    <label class="f">Actual departure<input type="time" data-bind="flight:atd" value="${esc(f.atd || '')}"></label>
    <p class="f hint">${delayMinutes(f.etd, f.atd) ? `Delay: ${delayMinutes(f.etd, f.atd)} min` : ''}</p>
    <label class="f">Load master (print name)${txt('flight:loadmaster', f.loadmaster)}</label>
  </div>
  <h3>Special handling</h3><div class="checks">
    ${chk('special:hr', f.special.hr, 'Human remains (form req.)')}${chk('special:aog', f.special.aog, 'AOG')}
    <div class="radio-group"><span>DG pilot notification:</span>${radio('flight:dgNote', 'crew', f.dgNote, 'Signed by crew')}${radio('flight:dgNote', 'na', f.dgNote, 'N/A')}</div>
  </div></section>`;
}

function viewManifest(f) {
  const t = { cargo: 0, post: 0, fast: 0, bag: 0, total: 0 };
  const body = f.rows.map((r, i) => {
    const total = sum(FREIGHT_KEYS.map(([k]) => n(r[k])));
    FREIGHT_KEYS.forEach(([k]) => t[k] += n(r[k])); t.total += total;
    return `<tr><td class="l">${txt(`row:${r.id}:dest`, r.dest, 'dest', 'maxlength="4" list="airports" autocomplete="off" aria-label="Destination"')}</td>
      ${FREIGHT_KEYS.map(([k, lab]) => {
        const bind = `row:${r.id}:${k}`, sumCell = isExpr(r[k]);
        // a sum shows its total until the cell is focused, then the expression to edit
        const shown = sumCell && focusBind !== bind ? fmt(n(r[k])) : r[k];
        return `<td${sumCell ? ' class="has-calc"' : ''}>${inp(bind, shown, '', `aria-label="${lab}"`)}</td>`;
      }).join('')}
      <td class="calc">${blankIfZero(total)}</td>
      <td><div class="row-actions">
        <button class="btn small icon" data-act="rowUp" data-id="${r.id}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn small icon" data-act="rowDown" data-id="${r.id}" aria-label="Move down" ${i === f.rows.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn small icon danger" data-act="rowDel" data-id="${r.id}" aria-label="Remove row">✕</button></div></td></tr>`;
  }).join('');
  return `<section class="card"><h2>Manifest</h2>
    <p class="hint">One row per stop, in flying order. Type a destination code or pick one from the list. Weights in lb. A cell takes a sum such as <code>120+45+30</code>: it shows the total, and clicking it shows each number. The load control form below fills in from this table.</p>
    <div class="scroll" data-scroll="manifest"><table class="t"><thead><tr><th class="l">Destination</th>${FREIGHT_KEYS.map(([, l]) => `<th>${l}</th>`).join('')}<th>Total</th><th></th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><td class="l">Totals</td>${FREIGHT_KEYS.map(([k]) => `<td>${fmt(t[k])}</td>`).join('')}<td>${fmt(t.total)}</td><td></td></tr></tfoot></table></div>
    <div class="toolbar"><button class="btn" data-act="addRow">Add row</button><button class="btn" data-act="reverse">Reverse</button></div>
    <h3>Quick entry</h3>
    <p class="hint">One stop per line. <code>YSB 545 0 0 40</code> fills Cargo, Post, Fast-Tracks, Baggage in that order; <code>YTS c310 p45 f20 b60</code> uses prefixes. Weights for a destination already in the table are added to it.</p>
    <textarea id="quick" aria-label="Quick entry"></textarea>
    <div class="toolbar"><button class="btn" data-act="quickAdd">Add to manifest</button></div>
    <h3>Notes</h3><textarea data-bind="flight:notes" aria-label="Manifest notes">${esc(f.notes)}</textarea>
  </section>`;
}

function viewLoad(f, c) {
  const w = warnings(f, c), order = { error: 0, warn: 1, info: 2 };
  const alerts = (w.length ? [...w].sort((a, b) => order[a.level] - order[b.level]) : [{ level: 'ok', msg: 'All freight is placed and within the form limits.' }])
    .map(x => `<div class="alert ${x.level}"><b>${{ error: 'Over limit', warn: 'Check', info: 'Note', ok: 'OK' }[x.level]}</b><span>${esc(x.msg)}</span></div>`).join('');
  const { form, zones, rs, planned } = c;
  const rowsHtml = rs.map(x => x.parts.map((p, j) => `<tr>
      <td class="l">${j === 0 ? `<b>${esc(x.r.dest || '?')}</b>` : ''}${p.kind.label ? ` <span class="sub">${p.kind.label}</span>` : ''}</td>
      <td class="calc">${fmt(p.amount)}</td>
      ${zones.map(z => `<td>${inp(`alloc:${x.r.id}:${p.kind.id}:${z.id}`, allocOf(f, x.r.id, p.kind.id)[z.id] ?? '')}</td>`).join('')}
      <td class="${Math.abs(p.unplaced) > 0.5 ? (p.unplaced < 0 ? 'bad' : 'warnc') : 'good'}">${Math.abs(p.unplaced) > 0.5 ? fmt(p.unplaced) : '✓'}</td></tr>`).join('')).join('');
  return `<section class="card"><h2>Load control · ${esc(form.name)}
      <span class="pill ${f.manual ? 'muted' : 'ok'}">${f.manual ? 'Placement edited by hand' : 'Placement follows the manifest'}</span></h2>
    <div class="alerts">${alerts}</div>
    <h3>Where each stop's load goes</h3>
    <p class="hint">The table fills in from the manifest${form.shared ? ', every stop in J first' : ", last stop's load deepest first so each stop's load is nearest the door when it's due off"}.${form.split ? ' Bags are the Baggage column; Cargo is Cargo + Post + Fast-Tracks.' : ''} Typing in a cell or dragging a tag switches to hand placement, and from then on manifest changes don't move anything.</p>
    <div class="scroll" data-scroll="alloc"><table class="t"><thead><tr><th class="l">Destination</th><th>Weight</th>
      ${zones.map(z => `<th>${esc(z.label)}<br><span class="sub">${z.max ? 'max ' + fmt(z.max) : 'no zone max'}</span></th>`).join('')}<th>Difference</th></tr></thead>
      <tbody>${rowsHtml || `<tr><td class="l" colspan="${zones.length + 3}">Add a destination to the manifest.</td></tr>`}</tbody>
      <tfoot><tr><td class="l">Zone total</td><td>${fmt(c.manifestTotal)}</td>${zones.map(z => `<td class="${z.max && planned[z.id] > z.max ? 'bad' : ''}">${fmt(planned[z.id])}</td>`).join('')}<td></td></tr></tfoot></table></div>
    <p class="hint">${esc(LIMITS_NOTE)}.</p>
    <div class="toolbar"><button class="btn" data-act="clearAlloc">Clear placement</button></div>
    <h3>Form</h3>
    <p class="hint">Drag a destination tag anywhere inside a section of the aircraft. It stays where you drop it, and dropping it in another section moves that stop's load there. A tag let go outside the aircraft goes back. Tidy tags lines them up again.</p>
    <div class="toolbar" style="margin:0 0 8px"><button class="btn small" data-act="tidyTags" ${f.pos && Object.values(f.pos).some(p => Object.keys(p).length) ? '' : 'disabled'}>Tidy tags</button></div>
    <div class="preview-wrap" data-scroll="preview"><div class="sheet ${form.orientation}">${formPage(f, c, { foot: false })}</div></div>
  </section>`;
}

function viewPrint() {
  return `<section class="card"><h2>Print</h2>
    <div class="checks">${radio('pp:layout', 'one', printPages.layout, 'One page: flight details, manifest and form')}${radio('pp:layout', 'separate', printPages.layout, 'Separate pages')}</div>
    ${printPages.layout === 'separate' ? `<div class="checks">${chk('pp:manifest', printPages.manifest, 'Manifest page')}${chk('pp:form', printPages.form, 'Load control form page')}</div>` : ''}
    <div class="toolbar"><button class="btn primary" data-act="print">Print</button><button class="btn" data-act="pdf">Save as PDF</button></div>
    <p class="hint">Both buttons use these choices. PC-12 and 1900D print landscape, Dash 8-300 portrait. A long manifest is shrunk so everything stays on one sheet.</p></section>`;
}

/* ------------------------------ state ------------------------------ */
// Flights live in Supabase; localStorage keeps only per-viewer choices.
let flights = [];
let currentId = null;
let printPages = { layout: 'one', manifest: true, form: true, ...store.get('lcl.pages', {}) };
let theme = store.get('lcl.theme', 'auto');
const cur = () => flights.find(f => f.id === currentId);
const isClosed = f => f?.status === 'closed';
function save() {
  const f = cur();
  if (f && !isClosed(f)) { f.updated = Date.now(); db.queueSave(f); }
  store.set('lcl.current', currentId); store.set('lcl.pages', printPages);
}

async function boot() {
  const user = await db.currentUser();
  document.body.classList.toggle('signed-out', !user);
  document.getElementById('signin').hidden = !!user;
  if (!user) { setStatus(''); render(); return; }
  try {
    flights = await db.loadFlights();
  } catch (err) {
    // Don't create or save anything: an empty list here would look like lost data.
    console.error(err);
    document.getElementById('view').innerHTML = `<section class="card"><h2>Couldn't load flights</h2>
      <p>${esc(err.message || String(err))}</p><button class="btn primary" data-act="reload">Try again</button></section>`;
    return;
  }
  flights.forEach(db.markSaved);
  if (!flights.length) { const f = newFlight(); flights.push(f); db.queueSave(f, { now: true }); }
  const last = store.get('lcl.current', null);
  currentId = flights.some(f => f.id === last) ? last : flights[0].id;
  render();
}

function setStatus(state, err) {
  const el = document.getElementById('saveStatus');
  el.className = 'save-status' + (state === 'error' ? ' error' : '');
  el.textContent = { saving: 'Saving…', saved: 'Saved', error: 'Not saved — retry' }[state] || '';
  el.title = err?.message || '';
  if (err) console.error(err);
}
db.onSaveStatus(setStatus);
document.getElementById('saveStatus').addEventListener('click', () => db.retrySave());
window.addEventListener('beforeunload', e => { if (db.hasUnsaved()) e.preventDefault(); });

document.getElementById('signinForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('signinError');
  msg.textContent = '';
  try {
    await db.signIn(document.getElementById('signinEmail').value, document.getElementById('signinPassword').value);
    document.getElementById('signinPassword').value = '';
    boot();
  } catch (err) { msg.textContent = err.message || 'Sign-in failed'; }
});

/* ------------------------------ render ------------------------------ */
let focusBind = null;
function render() {
  document.getElementById('themeBtn').textContent = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' }[theme];
  if (!cur()) return;
  const f = cur(), c = compute(f);
  // keep focus, caret and horizontal scroll across re-renders
  const a = document.activeElement, key = a?.dataset?.bind;
  focusBind = key;
  let s0 = null, s1 = null; try { s0 = a.selectionStart; s1 = a.selectionEnd; } catch { }
  const scrolls = {}; document.querySelectorAll('[data-scroll]').forEach(el => scrolls[el.dataset.scroll] = el.scrollLeft);
  const quick = document.getElementById('quick')?.value;

  document.getElementById('flightPick').innerHTML = [...flights].sort((x, y) => (y.date || '').localeCompare(x.date || '') || y.updated - x.updated)
    .map(x => `<option value="${x.id}" ${x.id === currentId ? 'selected' : ''}>${esc(x.flightNo || 'New flight')} · ${esc(x.reg || '—')} · ${fmtDate(x.date)}${isClosed(x) ? ' · closed' : ''}</option>`).join('');
  const locked = isClosed(f);
  document.getElementById('view').innerHTML =
    (locked ? `<p class="closed-banner">Closed flight — read-only. Duplicate it to make changes.</p><fieldset class="locked" disabled>` : '')
    + viewFlight(f) + viewManifest(f) + viewLoad(f, c) + (locked ? '</fieldset>' : '') + viewPrint();
  document.getElementById('closeBtn').disabled = locked;
  document.getElementById('delBtn').disabled = locked;

  document.querySelectorAll('[data-scroll]').forEach(el => { if (scrolls[el.dataset.scroll]) el.scrollLeft = scrolls[el.dataset.scroll]; });
  if (quick) { const q = document.getElementById('quick'); if (q) q.value = quick; }
  if (key) {
    const sel = a.type === 'radio' ? `[data-bind="${CSS.escape(key)}"][value="${CSS.escape(a.value)}"]` : `[data-bind="${CSS.escape(key)}"]`;
    const el = document.querySelector(sel);
    if (el) { el.focus({ preventScroll: true }); try { if (s0 != null) el.setSelectionRange(s0, s1); } catch { } }
  }
  showCalc();
}

/* ------------------------------ events ------------------------------ */
// manifest freight cells: expression while focused, total otherwise, breakdown in a pop-up
const pop = document.createElement('div');
pop.className = 'calc-pop'; pop.hidden = true; pop.setAttribute('role', 'status');
document.body.appendChild(pop);
const freightCell = el => { const [kind, id, key] = el?.dataset?.bind?.split(':') || []; return kind === 'row' && FREIGHT_KEYS.some(([k]) => k === key) ? { r: cur().rows.find(x => x.id === id), key } : null; };
function showCalc() {
  const el = document.activeElement, fc = freightCell(el), c = fc && calc(fc.r?.[fc.key]);
  if (!c || c.terms.length < 2) { pop.hidden = true; return; }
  const label = FREIGHT_KEYS.find(([k]) => k === fc.key)[1];
  pop.innerHTML = `<div class="h">${esc(fc.r.dest || 'Row')} · ${esc(label)}</div><table>${c.terms.map((t, i) => {
    const op = i === 0 ? '' : t.text[0] === '-' ? '−' : '+', body = i === 0 ? t.text : t.text.slice(1);
    return `<tr><td class="op">${op}</td><td>${esc(body)}${/^\d*\.?\d+$/.test(body) ? '' : ` = ${fmt(Math.abs(t.value))}`}</td></tr>`;
  }).join('')}<tr class="tot"><td class="op">=</td><td>${fmt(c.value)} lb</td></tr></table>`;
  const r = el.getBoundingClientRect();
  pop.hidden = false;
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.style.top = (r.bottom + 6 + pop.offsetHeight > innerHeight ? r.top - pop.offsetHeight - 6 : r.bottom + 6) + 'px';
}
document.addEventListener('focusin', e => {
  const fc = freightCell(e.target);
  if (fc && isExpr(fc.r?.[fc.key])) { const el = e.target; el.value = fc.r[fc.key]; const end = el.value.length; el.setSelectionRange(end, end); }
  showCalc();
});
document.addEventListener('focusout', e => {
  const fc = freightCell(e.target);
  if (fc && isExpr(fc.r?.[fc.key])) e.target.value = fmt(n(fc.r[fc.key]));
  pop.hidden = true;
});
document.addEventListener('scroll', () => { if (!pop.hidden) showCalc(); }, true);
// Enter in a manifest cell finishes the entry, same as clicking out
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset?.bind?.startsWith('row:')) { e.preventDefault(); e.target.blur(); } });

// drag a destination tag on the form preview to another section
function moveStop(f, rowId, from, to) {
  Object.values(f.alloc[rowId] || {}).forEach(a => {
    const v = n(a[from]);
    if (!v) return;
    a[to] = String(Math.round((n(a[to]) + v) * 10) / 10);
    delete a[from];
  });
  f.manual = true;
}
let drag = null;
const svgPoint = (svg, e) => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
const rectOf = r => ['x', 'y', 'width', 'height'].map(k => +r.getAttribute(k));
const dropUnder = (svg, p) => [...svg.querySelectorAll('.drop')].find(r => {
  const [x, y, w, h] = rectOf(r);
  return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
});
// where the dragged tag would land: inside the section under the pointer, or nowhere
function landing(e) {
  const p = svgPoint(drag.svg, e), zone = dropUnder(drag.svg, p)?.dataset.zone;
  const want = [drag.x + p.x - drag.start.x, drag.y + p.y - drag.start.y];
  if (!zone) return { zone: null, area: null, at: want, moved: Math.hypot(p.x - drag.start.x, p.y - drag.start.y) };
  const area = drag.svg.querySelector(`.area[data-zone="${CSS.escape(zone)}"]`);
  return { zone, area, at: clampIn(rectOf(area), ...want, drag.w, drag.h), moved: Math.hypot(p.x - drag.start.x, p.y - drag.start.y) };
}
document.addEventListener('pointerdown', e => {
  if (isClosed(cur())) return;
  const g = e.target.closest?.('.sheet .chip');
  if (!g || e.button > 0) return;
  e.preventDefault();
  const svg = g.ownerSVGElement, ghost = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  ghost.setAttribute('class', 'ghost');
  ghost.appendChild(g.cloneNode(true));
  svg.appendChild(ghost);
  g.classList.add('dragging');
  const d = g.dataset;
  drag = { g, svg, ghost, start: svgPoint(svg, e), x: +d.x, y: +d.y, w: +d.w, h: +d.h, over: null, id: e.pointerId };
});
document.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  const { area, at } = landing(e);
  drag.ghost.setAttribute('transform', `translate(${at[0] - drag.x} ${at[1] - drag.y})`);
  if (area !== drag.over) { drag.over?.classList.remove('over'); area?.classList.add('over'); drag.over = area; }
});
function endDrag(e, cancel) {
  if (!drag || e.pointerId !== drag.id) return;
  const { g, ghost, over } = drag, end = cancel ? null : landing(e);
  drag = null;
  ghost.remove(); g.classList.remove('dragging'); over?.classList.remove('over');
  // dropped outside every section, or just a tap: the tag stays where it was
  if (!end?.zone || end.moved < 3) return;
  const f = cur(), row = g.dataset.row, from = g.dataset.zone, pos = ((f.pos ||= {})[row] ||= {});
  if (end.zone !== from) { moveStop(f, row, from, end.zone); delete pos[from]; }
  pos[end.zone] = [Math.round(end.at[0]), Math.round(end.at[1]), Date.now()];
  save(); render();
}
document.addEventListener('pointerup', e => endDrag(e, false));
document.addEventListener('pointercancel', e => endDrag(e, true));

// manifest edits re-run auto-place unless the placement was edited by hand
const manifestChanged = f => { if (!f.manual) autoPlace(f); };

function setBound(el) {
  if (isClosed(cur()) && !el.dataset.bind.startsWith('pp:')) return;
  const f = cur(), [kind, a, b, d] = el.dataset.bind.split(':');
  const val = el.type === 'checkbox' ? el.checked : el.value;
  switch (kind) {
    case 'flight':
      if (a === 'date' && !val) break; // a flight always needs a date
      if (a === 'reg') f.reg = String(val).toUpperCase();
      else if (a === 'form') { f.form = val; f.pos = {}; autoPlace(f); }
      else f[a] = val;
      break;
    case 'special': f.special[a] = val; break;
    case 'row': { const r = f.rows.find(x => x.id === a); if (r) { r[b] = b === 'dest' ? String(val).toUpperCase() : val; manifestChanged(f); } break; }
    case 'alloc': ((f.alloc[a] ||= {})[b] ||= {})[d] = val; f.manual = true; break;
    case 'pp': printPages[a] = val; break;
  }
  save(); render();
}
document.addEventListener('input', e => { const el = e.target; if (el.dataset?.bind && !['checkbox', 'radio'].includes(el.type) && el.tagName !== 'SELECT') setBound(el); });
document.addEventListener('change', e => { const el = e.target; if (el.dataset?.bind && (['checkbox', 'radio', 'date', 'time'].includes(el.type) || el.tagName === 'SELECT')) setBound(el); });
document.getElementById('flightPick').addEventListener('change', e => { currentId = e.target.value; save(); render(); });

const actions = {
  newFlight() { const f = newFlight(); flights.push(f); currentId = f.id; window.scrollTo(0, 0); },
  dupFlight() {
    const src = cur(), f = JSON.parse(JSON.stringify(src));
    Object.assign(f, { id: uid(), date: todayISO(), loadmaster: '', status: 'draft', atd: '', updated: Date.now() });
    const map = {}; f.rows.forEach(r => { map[r.id] = r.id = uid(); });
    f.alloc = Object.fromEntries(Object.entries(src.alloc).filter(([k]) => map[k]).map(([k, x]) => [map[k], x]));
    f.pos = Object.fromEntries(Object.entries(src.pos || {}).filter(([k]) => map[k]).map(([k, x]) => [map[k], x]));
    flights.push(f); currentId = f.id;
  },
  delFlight() {
    const f = cur();
    if (isClosed(f)) return false;
    if (!confirm(`Delete flight ${f.flightNo || '(no number)'} on ${fmtDate(f.date)}?`)) return false;
    db.deleteFlight(f.id).then(() => {
      flights = flights.filter(x => x.id !== f.id);
      if (!flights.length) { const nf = newFlight(); flights.push(nf); db.queueSave(nf, { now: true }); }
      currentId = flights[0].id; save(); render();
    }).catch(err => setStatus('error', err));
    return false;
  },
  closeFlight() {
    const f = cur();
    if (isClosed(f) || blockedByLimits()) return false;
    if (!confirm(`Close flight ${f.flightNo || '(no number)'}? It becomes read-only and can't be reopened.`)) return false;
    f.status = 'closed';
    db.queueSave(f, { now: true });
    render();
    return false;
  },
  signOut() {
    db.flush().then(ok => {
      if (!ok && !confirm('Some changes could not be saved. Sign out anyway and lose them?')) return;
      return db.signOut().then(() => { flights = []; currentId = null; boot(); });
    });
    return false;
  },
  reload() { location.reload(); return false; },
  addRow() { cur().rows.push(newRow()); },
  reverse() { const f = cur(); f.rows.reverse(); manifestChanged(f); },
  rowUp(id) { const f = cur(), r = f.rows, i = r.findIndex(x => x.id === id); if (i > 0) [r[i - 1], r[i]] = [r[i], r[i - 1]]; manifestChanged(f); },
  rowDown(id) { const f = cur(), r = f.rows, i = r.findIndex(x => x.id === id); if (i < r.length - 1) [r[i + 1], r[i]] = [r[i], r[i + 1]]; manifestChanged(f); },
  rowDel(id) { const f = cur(); f.rows = f.rows.filter(x => x.id !== id); delete f.alloc[id]; delete f.pos?.[id]; if (!f.rows.length) f.rows.push(newRow()); manifestChanged(f); },
  quickAdd() {
    const q = document.getElementById('quick'), f = cur();
    parseQuick(q.value).forEach(p => {
      let r = p.dest && f.rows.find(x => x.dest === p.dest);
      if (!r) {
        r = f.rows.find(x => !x.dest && !FREIGHT_KEYS.some(([k]) => n(x[k])));
        if (r) r.dest = p.dest; else { r = Object.assign(newRow(), { dest: p.dest }); f.rows.push(r); }
      }
      FREIGHT_KEYS.forEach(([k]) => { if (p[k]) r[k] = String(r[k] ?? '').trim() ? `${r[k]}+${p[k]}` : p[k]; });
    });
    q.value = '';
    manifestChanged(f);
  },
  tidyTags() { cur().pos = {}; },
  clearAlloc() { const f = cur(); f.alloc = {}; f.pos = {}; f.manual = true; },
  print() { if (!blockedByLimits()) doPrint(); return false; },
  theme() {
    theme = { auto: 'light', light: 'dark', dark: 'auto' }[theme] || 'auto';
    if (theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
    store.set('lcl.theme', theme);
  },
  pdf() { if (blockedByLimits()) return false; const d = document.getElementById('pdfDialog'); if (d.showModal) d.showModal(); else doPrint(); return false; },
  pdfGo() { document.getElementById('pdfDialog').close(); setTimeout(doPrint, 50); return false; },
  pdfCancel() { document.getElementById('pdfDialog').close(); return false; },
  limitClose() { document.getElementById('limitDialog').close(); return false; },
};

function fillPrint() {
  const f = cur(), c = compute(f), root = document.getElementById('print-root');
  const pages = printPages.layout === 'one' ? onePage(f, c)
    : (printPages.manifest ? manifestPage(f, c) : '') + (printPages.form ? formPage(f, c) : '');
  root.innerHTML = pages || formPage(f, c);
  fitPages(root);
}
// Shrink any page whose content is taller than its sheet. Sizes are letter paper minus
// the @page margins, in CSS pixels (96 per inch).
function fitPages(root) {
  root.style.cssText = 'display:block;position:absolute;left:-30000px;top:0;visibility:hidden';
  root.querySelectorAll('.page').forEach(p => {
    const land = p.classList.contains('landscape');
    const W = (land ? 11 - 0.6 : 8.5 - 0.8) * 96, H = (land ? 8.5 - 0.6 : 11 - 0.8) * 96 * 0.97;
    const fit = p.querySelector('.fit');
    // lay out at the sheet's full width, then zoom; with a % width the drawn form would grow back
    p.style.width = W + 'px'; fit.style.cssText = `width:${W}px`;
    const h = fit.scrollHeight;
    if (h > H) fit.style.cssText = `width:${W}px;zoom:${H / h};margin:0 auto`; else fit.style.cssText = '';
    p.style.width = '';
  });
  root.style.cssText = '';
}
let printing = false, savedTitle = document.title;
function doPrint() {
  const f = cur();
  fillPrint();
  // the browser suggests the page title as the PDF file name
  savedTitle = document.title;
  document.title = ['Load control', f.flightNo, f.reg, fmtDate(f.date)].filter(Boolean).join(' ');
  printing = true; window.print(); printing = false;
  document.title = savedTitle;
}
// printing from the browser menu (Ctrl/Cmd+P) gets the same pages
window.addEventListener('beforeprint', () => { if (!printing && cur()) fillPrint(); });
window.addEventListener('afterprint', () => { document.title = savedTitle; });

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b && actions[b.dataset.act]) { if (actions[b.dataset.act](b.dataset.id) !== false) { save(); render(); } }
});


document.getElementById('brand').insertAdjacentHTML('afterbegin', LOGO('logo'));
// one pick list shared by every destination cell
document.body.insertAdjacentHTML('beforeend', `<datalist id="airports">${AIRPORTS.map(a => `<option value="${a.code}">${esc(a.city)}</option>`).join('')}</datalist>`);
boot();
