/** Light markdown for answers (headings, lists, tables, code, bold, italic, links), as the CMS dashboard's Ask. */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((\/p\/[\w-]+(?:\?[\w=&:.-]*)?)\)/g, '<a href="$2" data-internal="1">$1</a>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function md(src: string): string {
  const lines = String(src || '')
    .replace(/\r/g, '')
    .split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      out.push(`<h4>${inline(h[2])}</h4>`);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || '')) {
      const cells = (r: string) =>
        r
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      const head = cells(l);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(cells(lines[i++]));
      out.push(
        `<div class="table-wrap"><table class="tbl"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}
