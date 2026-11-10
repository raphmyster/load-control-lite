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

/* ------------------------- hand placement sync -------------------------
   Once placement is edited by hand, auto-place no longer re-runs. These keep each
   stop's placed weight equal to its manifest weight instead, one stop and one kind
   at a time, without moving any other stop. */
const r1 = v => Math.round(v * 10) / 10;
function setCell(f, rowId, kindId, zoneId, v) {
  const a = ((f.alloc[rowId] ||= {})[kindId] ||= {});
  if (v > 0.05) a[zoneId] = String(r1(v)); else delete a[zoneId];
}
// Room left in a zone after everything planned: its own max and every group it's in.
function roomOf(c, z) {
  const own = z.max == null ? Infinity : z.max - c.planned[z.id];
  const groups = c.form.groups.filter(g => g.zones.includes(z.id)).map(g => g.max - sum(g.zones.map(id => c.planned[id])));
  return Math.max(0, Math.min(own, ...groups));
}

/* keep: the zone the user just typed in. It stays as typed, the weight comes from (or
   goes back to) the stop's other zones, largest first, and never moves to a new zone.
   Without keep (the manifest changed): extra weight goes to the largest zone the stop
   already uses, then to zones in load order with room; less weight comes off the
   smallest zones first. Automatic changes never go past a limit. */
export function balanceRow(f, rowId, kindId, keep) {
  const x = compute(f).rs.find(x => x.r.id === rowId);
  const p = x?.parts.find(p => p.kind.id === kindId);
  if (!p) return;
  let diff = p.amount - p.placed; // > 0: more to place, < 0: too much placed
  if (Math.abs(diff) < 0.05) return;
  const form = formOf(f), zones = placeable(form);
  const held = () => allocOf(f, rowId, kindId);
  const holders = zones.filter(z => z.id !== keep && n(held()[z.id]) > 0);
  if (diff < 0) {
    holders.sort((a, b) => keep ? n(held()[b.id]) - n(held()[a.id]) : n(held()[a.id]) - n(held()[b.id]));
    for (const z of holders) {
      if (diff > -0.05) break;
      const v = n(held()[z.id]), cut = Math.min(v, -diff);
      setCell(f, rowId, kindId, z.id, v - cut); diff += cut;
    }
    return;
  }
  holders.sort((a, b) => n(held()[b.id]) - n(held()[a.id]));
  const order = form.loadOrder.map(id => zones.find(z => z.id === id)).filter(z => z && !holders.includes(z));
  for (const z of keep ? holders : [...holders, ...order]) {
    if (diff < 0.05) break;
    const put = Math.min(diff, roomOf(compute(f), z));
    if (put > 0) { setCell(f, rowId, kindId, z.id, n(held()[z.id]) + put); diff -= put; }
  }
}

// After a manifest change: bring every part of one stop back in line with the manifest.
export const syncRow = (f, rowId) => kindsOf(formOf(f)).forEach(k => balanceRow(f, rowId, k.id));
