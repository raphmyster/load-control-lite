/* Renders the report's Markdown subset (## headings, - bullets, **bold**, paragraphs).
   Everything is escaped first, so model output can't add markup. */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

export function renderMarkdown(md) {
  const out = [];
  let para = [], inList = false;
  const endPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const endList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const line of String(md ?? '').split(/\r?\n/).map(l => l.trim())) {
    let m;
    if (!line) { endPara(); endList(); }
    else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { endPara(); endList(); const h = Math.min(m[1].length + 1, 5); out.push(`<h${h}>${inline(m[2])}</h${h}>`); }
    else if ((m = line.match(/^[-*]\s+(.*)$/))) { endPara(); if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inline(m[1])}</li>`); }
    else { endList(); para.push(line); }
  }
  endPara(); endList();
  return out.join('\n');
}
