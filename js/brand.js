import { OPERATOR } from './config.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* The operator's mark: a north arrow in a ring, then the name on two lines
   (first word large, the rest small). Drawn in currentColor so the top bar and
   the printed forms can each set their own colour. */
function markInner() {
  const [first, ...rest] = OPERATOR.name.split(' ');
  return `<circle cx="40" cy="40" r="31" fill="none" stroke="currentColor" stroke-width="5"/>
    <polygon points="40,13 55,55 40,45 25,55" fill="currentColor"/>
    <text x="84" y="38" font-family="Inter, Arial, sans-serif" font-size="26" font-weight="800" letter-spacing=".5" fill="currentColor">${esc(first.toUpperCase())}</text>
    <text x="85" y="66" font-family="Inter, Arial, sans-serif" font-size="17" font-weight="600" letter-spacing="7" fill="currentColor">${esc(rest.join(' ').toUpperCase())}</text>`;
}
const VIEWBOX = '0 0 290 80';

// HTML element, sized by CSS through `cls`
export const LOGO = cls => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" role="img" aria-label="${esc(OPERATOR.name)}" class="${cls}">${markInner()}</svg>`;

// nested inside a form's SVG, fitted to the box x, y, w, h
export const markSvg = (x, y, w, h, color) =>
  `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${VIEWBOX}" preserveAspectRatio="xMidYMid meet" color="${color}">${markInner()}</svg>`;
