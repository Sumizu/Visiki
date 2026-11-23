/** Canvas-independent wrapping preserves explicit blank lines and grapheme clusters. */
export function wrapTextLines(text: string, width: number, measure: (text: string) => number): string[] {
  const maxWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  const lines: string[] = [];
  for (const paragraph of text.replace(/\t/g, '    ').split(/\r\n|\r|\n/)) {
    if (!paragraph) { lines.push(''); continue; }
    const paragraphStart = lines.length;
    // Keep ordinary Latin words together when possible; long words and CJK text
    // can still wrap at complete grapheme boundaries in a narrow text box.
    const graphemes = [...segmenter.segment(paragraph)].map(part => part.segment);
    const tokens: string[] = [];
    for (const grapheme of graphemes) {
      const previous = tokens.at(-1);
      if (previous && ((/^[a-zA-Z0-9_'’-]+$/.test(previous) && /^[a-zA-Z0-9_'’-]+$/.test(grapheme)) || (/^ +$/.test(previous) && grapheme === ' '))) tokens[tokens.length - 1] += grapheme;
      else tokens.push(grapheme);
    }
    let line = '';
    for (const token of tokens) {
      if (measure(line + token) <= maxWidth) { line += token; continue; }
      if (line) { lines.push(line.trimEnd()); line = ''; }
      if (!token.trim()) continue;
      if (measure(token) <= maxWidth) { line = token; continue; }
      for (const { segment } of segmenter.segment(token)) {
        if (line && measure(line + segment) > maxWidth) { lines.push(line); line = ''; }
        line += segment;
      }
    }
    if (line || lines.length === paragraphStart) lines.push(line.trimEnd());
  }
  return lines;
}
