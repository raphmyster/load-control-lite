/* Load maths shared by the app and the seed generator: what each zone holds and
   the auto-place rule. No DOM, so Node can run it. */
import { FORMS, SPLIT_KINDS, WHOLE_KIND, FREIGHT_KEYS } from './config.js';
import { n } from './calc.js';

export const sum = a => a.reduce((s, x) => s + x, 0);
export const formOf = f => FORMS[f.form] || FORMS.PC12;
export const kindsOf = form => form.split ? SPLIT_KINDS : WHOLE_KIND;
export const placeable = form => form.zones.filter(z => !z.na && !z.unavailable);
export const activeRows = f => f.rows.filter(r => r.dest.trim() || FREIGHT_KEYS.some(([k]) => n(r[k])));
export const allocOf = (f, rowId, kind) => (f.alloc[rowId] || {})[kind] || {};

export function compute(f) {
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

export function autoPlace(f) {
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
