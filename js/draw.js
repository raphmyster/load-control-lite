import { FORM_VERSION, DEMO_LABEL, LIMITS_NOTE } from './config.js';
import { markSvg } from './brand.js';

/* ------------------------------ blank forms ------------------------------
   Each load control form is drawn here in SVG from its config: no scanned images.
   Every printed limit comes from the same FORMS entry the limit check uses, so the
   paper and the check can't disagree. Geometry is in FORM_POS (config.js). */

const INK = '#1a1f24', GREY = '#8a939b', FAINT = '#c9d0d5', RED = '#c62828', PEN = '#12355b';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = v => Math.round(v).toLocaleString('en-CA');
const mid = ([a, b]) => (a + b) / 2;

const T = (x, y, s, { size = 14, anchor = 'start', weight = 400, fill = INK } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" dominant-baseline="middle">${s}</text>`;
const L = (x1, y1, x2, y2, w = 2, stroke = INK) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${w}"/>`;
const R = (x, y, w, h, { sw = 2, stroke = INK, fill = 'none', dash = '' } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const ring = ([x, y]) => `<circle cx="${x}" cy="${y}" r="11" fill="#fff" stroke="${INK}" stroke-width="2.5"/>`;
const opBox = (x, y, s) => `<rect x="${x - 9}" y="${y - 10}" width="18" height="20" fill="#e3e7ea"/>` + T(x, y + 1, s, { size: 18, anchor: 'middle', weight: 700 });
const hatch = `<defs><pattern id="nb-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#f1f3f5"/><line x1="0" y1="0" x2="0" y2="8" stroke="${FAINT}" stroke-width="3"/></pattern></defs>`;

// Header: mark, form title, date / registration / flight, special handling.
function header(form, P) {
  const H = P.head, [y0, ym, y1] = H.y, lab = { size: 11, weight: 700, fill: '#4b555d' };
  let o = L(H.logo[0], y1, H.special[1], y1, 2.5);
  o += [H.title[0], H.date[0], H.reg[0], H.special[0]].map(x => L(x, y0, x, y1, 2)).join('');
  o += L(H.date[0], ym, H.special[1], ym, 1.5);
  o += markSvg(H.logo[0] + 12, y0 + 10, H.logo[1] - H.logo[0] - 24, y1 - y0 - 20, PEN);
  // text sized to the cell: the Dash 8 header cells are narrower than the strip forms'
  const tw = H.title[1] - H.title[0], narrow = H.reg[1] - H.reg[0] < 120;
  o += T(mid(H.title), y0 + (y1 - y0) * 0.33, esc(form.type), { size: Math.min(30, tw / (0.62 * form.type.length)), anchor: 'middle', weight: 800 });
  o += T(mid(H.title), y0 + (y1 - y0) * 0.74, 'LOAD CONTROL', { size: Math.min(14, tw / 8), anchor: 'middle', weight: 600 });
  o += T(H.date[0] + 6, y0 + 11, 'DATE', lab) + T(H.date[0] + 6, ym + 11, 'FORM', lab);
  o += T(mid(H.date), ym + (y1 - ym) * 0.62, FORM_VERSION, { size: 12, anchor: 'middle' });
  o += T(H.reg[0] + 6, y0 + 11, narrow ? 'REG' : 'A/C REGISTRATION', lab) + T(H.reg[0] + 6, ym + 11, narrow ? 'FLIGHT' : 'FLIGHT NUMBER', lab);
  // ring labels sit left of the ring on strip forms, right of it on the Dash 8
  const D = P.dots, right = P.dotLabels === 'right';
  const ringLabel = ([x, y], s) => T(right ? x + 18 : x - 18, y, s, { size: 13, anchor: right ? 'start' : 'end', weight: 600 });
  o += right ? T(H.special[0] + 6, y0 + 11, 'SPECIAL HANDLING', lab) : T(H.special[0] + 10, D.hr[1], 'SPECIAL HANDLING', { size: 13, weight: 800 });
  o += T(H.special[0] + 10, D.crew[1], 'DG PILOT NOTIFICATION', { size: 13, weight: 800 });
  o += ringLabel(D.hr, 'Human remains') + ringLabel(D.aog, 'AOG') + ringLabel(D.crew, 'Signed by crew') + ringLabel(D.na, 'N/A');
  o += [D.hr, D.aog, D.crew, D.na].map(ring).join('');
  return o;
}

// One limit-band cell per zone, merging a span group and a run of seat rows into one cell.
function bandCells(form, span) {
  const cells = [], done = new Set();
  form.zones.forEach((z, i) => {
    if (done.has(z.id)) return;
    const g = form.groups.find(g => g.span && g.zones.includes(z.id));
    if (g) {
      g.zones.forEach(id => done.add(id));
      cells.push({ x: [span(g.zones[0])[0], span(g.zones[g.zones.length - 1])[1]], text: `MAX ${fmt(g.max)} LB · ${esc(g.label)}` });
    } else if (z.seat) {
      let j = i; while (form.zones[j + 1]?.seat) j++;
      form.zones.slice(i, j + 1).forEach(s => done.add(s.id));
      cells.push({ x: [span(z.id)[0], span(form.zones[j].id)[1]], text: `MAX ${fmt(z.max)} LB PER ROW` });
    } else {
      cells.push({ x: span(z.id), text: z.na ? 'N/A' : z.unavailable ? esc(z.unavailable) : z.max ? `MAX ${fmt(z.max)} LB` : '', muted: !!(z.na || z.unavailable) });
    }
  });
  return cells;
}

// PC-12 and 1900D: a side-on strip of zones above three rows (plan, adjust, confirm).
function stripForm(form, P) {
  const [fx0, fy0, fx1, fy1] = P.frame, [s0, s1, s2, s3] = P.steps, lc = P.labelCol, [sc0, sc1] = P.sumCol, fl = P.floor;
  const span = id => P.cols[id] || P.spans[id];
  const zs = form.zones.map(z => ({ z, x: span(z.id) }));
  let o = hatch + R(fx0, fy0, fx1 - fx0, fy1 - fy0, { sw: 3 }) + header(form, P);

  // banner
  o += L(fx0, s0, fx1, s0, 3);
  o += `<text x="${(fx0 + fx1) / 2}" y="${mid(P.banner) + 1}" font-size="22" text-anchor="middle" dominant-baseline="middle" fill="${INK}">FOR PLANNING AND CONTROL IN <tspan font-weight="800">${esc(form.banner)}</tspan></text>`;

  // step rows and their labels
  o += L(lc, s0, lc, s3, 3) + L(fx0, s1, fx1, s1, 2.5) + L(fx0, s2, fx1, s2, 2.5);
  [['1 · PLAN', ['Planned load']], ['2 · ADJUST', ['Note any', 'change here']], ['3 · CONFIRM', ['Weight loaded', 'and where']]].forEach(([h, sub], i) => {
    const y = ([s0, s1, s2, s3][i] + [s0, s1, s2, s3][i + 1]) / 2 - 8 * sub.length;
    o += T((fx0 + lc) / 2, y, h, { size: 17, anchor: 'middle', weight: 800 });
    sub.forEach((s, k) => { o += T((fx0 + lc) / 2, y + 24 + k * 17, s, { size: 13, anchor: 'middle', fill: '#4b555d' }); });
  });

  // unavailable zones are hatched from the floor down
  zs.filter(({ z }) => z.unavailable).forEach(({ x }) => { o += `<rect x="${x[0]}" y="${fl}" width="${x[1] - x[0]}" height="${s3 - fl}" fill="url(#nb-hatch)"/>`; });

  // fuselage, side on: open at the nose end, tapering through the tail zone
  const top = s0 + 8, tz = zs.find(({ z }) => z.tail).x, tx = tz[0] + (tz[1] - tz[0]) * 0.45, tip = tz[1] - 6;
  o += `<path d="M${lc + 4} ${top} H${tx} Q${tip} ${top} ${tip} ${top + (fl - top) * 0.4} V${fl - 16} Q${tip} ${fl} ${tx + 30} ${fl}" fill="none" stroke="${INK}" stroke-width="2.5"/>`;
  o += L(lc, fl, sc0, fl, 3);

  // zone labels in the strip
  zs.forEach(({ z, x }, i) => {
    if (i) o += L(x[0], z.seat && zs[i - 1].z.seat ? fl - 30 : top, x[0], fl, z.seat ? 1 : 1.5, z.seat ? GREY : INK);
    if (z.boxed) o += R(x[0] + 8, top + 10, x[1] - x[0] - 16, 34, { sw: 2 }) + T(mid(x), top + 28, esc(z.label), { size: 13, anchor: 'middle', weight: 800 });
    else if (z.unavailable) o += T(mid(x), (top + fl) / 2 + 20, 'NO CARGO', { size: 20, anchor: 'middle', weight: 800, fill: FAINT });
    else if (z.seat) o += T(mid(x), fl - 13, esc(z.label.replace(/\D/g, '')), { size: 13, anchor: 'middle', weight: 700 });
    else o += T(mid(x), fl - 26, esc(z.label), { size: z.label.length > 3 ? 22 : 30, anchor: 'middle', weight: 800, fill: GREY });
    if (z.door) o += L(x[0] + (x[1] - x[0]) * 0.2, fl, x[1] - (x[1] - x[0]) * 0.2, fl, 7) + T(mid(x), fl + 11, 'DOOR', { size: 10, anchor: 'middle', weight: 800 });
  });
  const seats = zs.filter(({ z }) => z.seat);
  if (seats.length) o += T((seats[0].x[0] + seats[seats.length - 1].x[1]) / 2, fl - 44, 'SEAT ROWS', { size: 12, anchor: 'middle', weight: 800 });

  // columns through the three rows, + between zones and = into the totals column
  const edges = zs.slice(1).filter(({ z }, i) => !(z.seat && zs[i].z.seat)).map(({ x }) => x[0]);
  zs.slice(1).forEach(({ z, x }, i) => { o += L(x[0], fl, x[0], s3, z.seat && zs[i].z.seat ? 1 : 2.5, z.seat && zs[i].z.seat ? GREY : INK); });
  o += L(sc0, fl, sc0, s3, 3);
  [mid(P.plan) - 8, (s2 + s3) / 2].forEach(y => { o += edges.map(x => opBox(x, y, '+')).join('') + opBox(sc0, y, '='); });

  // limit band
  o += bandCells(form, span).map(c => R(c.x[0] + 1, P.lim[0], c.x[1] - c.x[0] - 2, P.lim[1] - P.lim[0], { sw: 2.5, stroke: RED, dash: '10 5' })
    + T(mid(c.x), mid(P.lim) + 1, c.text, { size: 13, anchor: 'middle', weight: 700, fill: c.muted ? '#5f6970' : INK })).join('');

  // totals column
  o += T(mid(P.sumCol), fl + 12, 'PLANNED', { size: 11, anchor: 'middle', weight: 800 });
  o += T(mid(P.sumCol), s1 + 14, 'ADJUSTED', { size: 11, anchor: 'middle', weight: 800 });
  o += T(mid(P.sumCol), s2 + 14, 'BOARDED', { size: 11, anchor: 'middle', weight: 800 });

  // loadmaster sign-off and the demo footnote
  const [bx0, by0, bx1, by1] = P.lmBox, cx = bx0 + 140, sx = 2 * P.lm[0] - cx;
  o += R(bx0, by0, bx1 - bx0, by1 - by0, { sw: 2.5 }) + L(cx, by0, cx, by0 + 88) + L(sx, by0, sx, by0 + 88);
  o += L(cx, by0 + 70, bx1, by0 + 70, 1.5) + L(bx0, by0 + 88, bx1, by0 + 88, 2);
  o += T((bx0 + cx) / 2, by0 + 44, 'LOADMASTER', { size: 15, anchor: 'middle', weight: 800 });
  o += T((cx + sx) / 2, by0 + 79, 'PRINT NAME', { size: 10, anchor: 'middle', weight: 700 }) + T((sx + bx1) / 2, by0 + 79, 'SIGNATURE', { size: 10, anchor: 'middle', weight: 700 });
  o += T((bx0 + bx1) / 2, (by0 + 88 + by1) / 2, 'I confirm the aircraft is loaded as shown on this form.', { size: 13, anchor: 'middle', weight: 600 });
  [...lines(LIMITS_NOTE + '.', 26).map(s => [s, 400, '#4b555d']), ...lines(DEMO_LABEL + '.', 26).map(s => [s, 700, RED])]
    .forEach(([s, weight, fill], i) => { o += T(bx1 + 14, by0 + 22 + i * 17, esc(s), { size: 12, weight, fill }); });
  return o;
}

// split long labels onto lines of at most `n` characters
function lines(s, n) {
  return s.split(' ').reduce((a, w) => { const l = a[a.length - 1]; if (l && (l + ' ' + w).length <= n) a[a.length - 1] = l + ' ' + w; else a.push(w); return a; }, []);
}

// Dash 8-300: top-down plan of the cabin zones, totals boxes, then the two stowage bins.
function dash8Form(form, P) {
  const [fx0, fy0, fx1, fy1] = P.frame, zone = id => form.zones.find(z => z.id === id);
  let o = R(fx0, fy0, fx1 - fx0, fy1 - fy0, { sw: 3 }) + header(form, P);

  // cabin outline: zone 1 box, zone 2 with the rounded end, zone 3 off to the side, the door in 1B
  o += R(205, 208, 378, 504, { sw: 4 }) + `<path d="M583 208 H880 Q958 214 960 300 V620 Q958 706 880 712 H583" fill="none" stroke="${INK}" stroke-width="4"/>`;
  o += R(35, 522, 170, 190, { sw: 4 }) + L(205, 470, 583, 470, 3) + L(583, 475, 960, 475, 3);
  o += R(230, 676, 320, 28, { sw: 2 }) + T(540, 691, 'DOOR', { size: 11, anchor: 'end', weight: 800 });

  // per zone: name, limit, and the Bags / Cargo / Total fields
  form.zones.forEach(z => {
    const q = P.zones[z.id], [mx, my, mw, mh] = q.max;
    o += T(mx + mw / 2, my + mh / 2 + 1, `MAX ${fmt(z.max)} LB`, { size: 14, anchor: 'middle', weight: 800, fill: RED });
    if (q.end) return;
    o += T(mx + mw / 2, my - 16, esc(z.label), { size: 22, anchor: 'middle', weight: 800, fill: GREY });
    const vertical = q.bag[1] !== q.cargo[1];
    [['Bags', q.bag], ['Cargo', q.cargo], ['Total', q.total]].forEach(([s, [x, y]]) => {
      o += vertical ? T(x - 74, y, s, { size: 14, weight: 700 }) : T(x - 26, y, s, { size: 14, anchor: 'end', weight: 700 });
      o += L(x - 22, y + 11, x + 22, y + 11, 1.2, GREY);
    });
  });

  // combined-zone limits
  form.groups.forEach(g => {
    const [x, y, w, h] = P.groups[g.id], ls = lines(g.label, g.id === 'all' ? 16 : 40);
    ls.forEach((s, i) => { o += T(x + w / 2, y - 12 - (ls.length - 1 - i) * 19, esc(s), { size: 13, anchor: 'middle', weight: 800 }); });
    o += T(x + w / 2, y + h / 2 + 1, `MAX ${fmt(g.max)} LB`, { size: 14, anchor: 'middle', weight: 800, fill: RED });
  });

  // totals boxes
  [['Total zone 3', 50, 157], ['Total zone 1', 313, 157], ['Total zone 2', 626, 158], ['Total loaded', 810, 156]].forEach(([s, x, w]) => {
    o += R(x, 793, w, 75, { sw: 2.5 }) + T(x + w / 2, 806, s, { size: 13, anchor: 'middle', weight: 800 });
  });
  o += opBox(262, 832, '+') + opBox(549, 832, '+') + opBox(797, 832, '=');

  // stowage bins
  o += L(fx0, 890, fx1, 890, 3) + L(fx0, 1120, fx1, 1120, 3) + L(495, 890, 495, 1120, 2.5);
  [['BINF', fx0, 495], ['BINA', 495, fx1]].forEach(([id, x0, x1]) => {
    const q = P.zones[id];
    o += `<rect x="${x0 + 1.5}" y="891.5" width="${x1 - x0 - 3}" height="28" fill="#e3e7ea"/>` + T((x0 + x1) / 2, 906, esc(zone(id).label), { size: 15, anchor: 'middle', weight: 800 });
    o += `<rect x="${x0 + 1.5}" y="1094" width="${x1 - x0 - 3}" height="24" fill="#eef0f2"/>`;
    [['BAGS', q.bag], ['CARGO', q.cargo], ['TOTAL IN THIS BIN', q.total]].forEach(([s, [x, y]]) => { o += T(x0 + 10, y, s, { size: 13, weight: 800 }) + L(x - 70, y + 13, x + 4, y + 13, 1.2, GREY); });
  });
  o += T(fx1 - 10, 1185, `${esc(LIMITS_NOTE)} · ${esc(DEMO_LABEL)}`, { size: 12, anchor: 'end', weight: 700, fill: RED });
  return o;
}

export const drawForm = (form, P) => `<g class="blank" font-family="Arial, Helvetica, sans-serif">${form.layout === 'dh8' ? dash8Form(form, P) : stripForm(form, P)}</g>`;
