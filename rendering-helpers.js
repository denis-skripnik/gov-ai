// Only renderer-owned markup is emitted; report values are always text.
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

export function safeHref(value) {
  const href = String(value ?? '');
  // Reject browser-normalized controls, attribute delimiters and backslashes.
  if (!href || /[\s\u0000-\u001f\u007f<>"'\\]/u.test(href)) return null;
  if (/^https?:\/\//i.test(href)) {
    try {
      const parsed = new URL(href);
      return parsed.hostname ? href : null;
    } catch { return null; }
  }
  if (/^\/(?!\/)/.test(href) || href.startsWith('#')) return href;
  return null;
}

export function renderLink(destination, label = destination) {
  const href = safeHref(destination);
  return href === null ? escapeHtml(label) : `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

export function classToken(value, allowed) {
  return allowed.includes(value) ? value : 'neutral';
}

export function clampPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0;
}

// Tokenize source text, never re-run substitutions over generated attributes.
function inline(text) {
  const tokens = /(`[^`]+`|\[[^\]\n]+\]\([^\)\n]*\)|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let html = '';
  let end = 0;
  for (const match of text.matchAll(tokens)) {
    html += escapeHtml(text.slice(end, match.index));
    const token = match[0];
    if (token.startsWith('`')) html += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    else if (token.startsWith('[')) {
      const split = token.indexOf('](');
      const destination = token.slice(split + 2, -1);
      html += safeHref(destination) === null ? escapeHtml(token) : renderLink(destination, token.slice(1, split));
    } else if (token.startsWith('**')) html += `<strong>${inline(token.slice(2, -2))}</strong>`;
    else html += `<em>${inline(token.slice(1, -1))}</em>`;
    end = match.index + token.length;
  }
  return html + escapeHtml(text.slice(end));
}

export function formatMarkdown(value) {
  const text = String(value ?? '');
  if (!text) return '';
  return text.split(/(```[\s\S]*?```)/g).map(part => {
    if (part.startsWith('```') && part.endsWith('```')) {
      return `<pre><code>${escapeHtml(part.slice(3, -3))}</code></pre>`;
    }
    return part.split(/\n\s*\n/).filter(Boolean).map(block => {
      const lines = block.split('\n');
      const rendered = lines.map(line => {
        const heading = /^(#{1,3}) (.*)$/.exec(line);
        return heading ? `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>` : inline(line);
      }).join('<br>');
      return /^(#{1,3}) /.test(block) ? rendered : `<p>${rendered}</p>`;
    }).join('');
  }).join('');
}
