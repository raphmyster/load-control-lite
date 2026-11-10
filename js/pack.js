/* Operator pack: a private operator's name, mark, colours, forms and form images.
   It lives in the operator_profile table, which only signed-in users can read, and
   replaces the Northbound defaults in place, so every module that imported them
   sees the change. No pack means Northbound. */
import { OPERATOR, FORMS, FORM_POS, AIRPORTS } from './config.js';
import { setMark } from './brand.js';

const replace = (target, src) => { Object.keys(target).forEach(k => delete target[k]); Object.assign(target, src); };

export function applyPack(pack) {
  if (!pack) return null;
  if (pack.operator) Object.assign(OPERATOR, pack.operator);
  if (pack.forms) replace(FORMS, pack.forms);
  if (pack.pos) replace(FORM_POS, pack.pos);
  const known = new Set(AIRPORTS.map(a => a.code));
  (pack.airports || []).forEach(a => { if (!known.has(a.code)) { AIRPORTS.push(a); known.add(a.code); } });
  if (pack.logo) setMark(pack.logo);
  return { theme: pack.theme || null, css: pack.css || '', images: pack.images || {}, features: { reports: true, ...pack.features } };
}

const block = vars => Object.entries(vars || {}).map(([k, v]) => `${k}: ${v};`).join(' ');
export const themeCss = (theme, extra = '') => [
  `:root { ${block(theme?.light)} }`,
  `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${block(theme?.dark)} } }`,
  `:root[data-theme="dark"] { ${block(theme?.dark)} }`,
  extra,
].join('\n');

// Top bar, page title and colours. Runs once, after sign-in, on both pages.
export function dress(applied) {
  const brand = document.getElementById('brand');
  brand.querySelector('.app').textContent = OPERATOR.app;
  brand.querySelector('.poc').textContent = OPERATOR.label;
  document.title = OPERATOR.app;
  if (applied) {
    const style = document.createElement('style');
    style.textContent = themeCss(applied.theme, applied.css);
    document.head.appendChild(style);
    if (!applied.features.reports) document.getElementById('reportsLink')?.remove();
  }
}
