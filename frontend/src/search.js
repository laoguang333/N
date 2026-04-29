import { normalizeChinese, normalizeChineseQuery } from "./chinese";

export function buildSearchIndex(paragraphs) {
  let totalLength = 0;
  const entries = [];

  for (const paragraph of paragraphs || []) {
    const rawText = String(paragraph.text || "");
    const normalizedText = normalizeChinese(rawText);
    const length = Math.max(1, rawText.length);
    entries.push({
      offset: Number(paragraph.offset) || 0,
      text: rawText,
      normalizedText,
      length,
    });
    totalLength += length;
  }

  return { entries, totalLength: Math.max(1, totalLength) };
}

export function searchParagraphs(paragraphs, query) {
  const normalizedQuery = normalizeChineseQuery(query);
  if (!normalizedQuery) {
    return [];
  }

  const { entries, totalLength } = buildSearchIndex(paragraphs);
  const results = [];

  for (const entry of entries) {
    let fromIndex = 0;
    while (fromIndex <= entry.normalizedText.length) {
      const matchIndex = entry.normalizedText.indexOf(normalizedQuery, fromIndex);
      if (matchIndex === -1) {
        break;
      }

      const matchText = entry.text.slice(matchIndex, matchIndex + normalizedQuery.length);
      const absoluteOffset = entry.offset + matchIndex;
      results.push({
        id: `${entry.offset}-${matchIndex}-${results.length}`,
        paragraphOffset: entry.offset,
        offset: absoluteOffset,
        percent: clampPercent(absoluteOffset / totalLength),
        text: matchText || entry.text,
        query: normalizedQuery,
        matchStart: matchIndex,
        matchEnd: matchIndex + normalizedQuery.length,
      });
      fromIndex = matchIndex + Math.max(1, normalizedQuery.length);
    }
  }

  return results;
}

export function highlightParagraph(text, matches, activeId = "") {
  const source = String(text || "");
  const relevant = (matches || [])
    .filter((match) => match && match.matchStart >= 0 && match.matchEnd > match.matchStart)
    .slice()
    .sort((a, b) => a.matchStart - b.matchStart);

  if (relevant.length === 0) {
    return [{ text: source, highlight: false }];
  }

  const parts = [];
  let cursor = 0;

  for (const match of relevant) {
    if (match.matchStart > cursor) {
      parts.push({ text: source.slice(cursor, match.matchStart), highlight: false });
    }
    parts.push({
      text: source.slice(match.matchStart, match.matchEnd),
      highlight: true,
      active: match.id === activeId,
      id: match.id,
    });
    cursor = Math.max(cursor, match.matchEnd);
  }

  if (cursor < source.length) {
    parts.push({ text: source.slice(cursor), highlight: false });
  }

  return parts;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
