// Weights may be typed as sums, e.g. 120+45+30 or 3*20. Returns the value and the
// top-level terms (for the breakdown pop-up). No eval: a small recursive-descent parser.
export function calc(v) {
  const s = String(v ?? '').replace(/[,\s]/g, '').replace(/[x×]/gi, '*').replace(/[-+*/(]+$/, '');
  let i = 0;
  const peek = () => s[i];
  function factor() {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '(') { i++; const v = expr().value; if (peek() === ')') i++; return v; }
    const m = s.slice(i).match(/^(\d+\.?\d*|\.\d+)/);
    if (!m) throw 0;
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') { const op = s[i++], r = factor(); v = op === '*' ? v * r : v / r; }
    return v;
  }
  function expr() {
    const terms = [];
    let start = i, v = term();
    terms.push({ text: s.slice(start, i), value: v });
    while (peek() === '+' || peek() === '-') {
      const op = s[i++]; start = i;
      const t = term();
      terms.push({ text: op + s.slice(start, i), value: op === '-' ? -t : t });
      v += op === '-' ? -t : t;
    }
    return { value: v, terms };
  }
  if (!s) return { value: 0, terms: [] };
  try {
    const r = expr();
    if (i < s.length || !Number.isFinite(r.value)) throw 0;
    return r;
  } catch {
    const x = parseFloat(s);
    return { value: Number.isFinite(x) ? x : 0, terms: [] };
  }
}
export const n = v => calc(v).value;
