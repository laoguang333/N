function normalizeText(text) {
  return String(text).toLowerCase();
}

const SNIPPET_CONTEXT_LENGTH = 35;

export function buildSearchIndex(paragraphs) {
  const entries = [];

  for (const paragraph of paragraphs || []) {
    const rawText = String(paragraph.text || "");
    const normalizedText = normalizeText(rawText);
    const length = rawText.length;
    entries.push({
      offset: Number(paragraph.offset) || 0,
      text: rawText,
      normalizedText,
      length,
    });
  }

  // Paragraph offsets refer to positions in the original book text. Summing
  // paragraph lengths loses the newlines and blank lines between paragraphs,
  // which makes the search percentage drift from the reader's position.
  const totalLength = entries.reduce(
    (end, entry) => Math.max(end, entry.offset + entry.length),
    0,
  );

  return { entries, totalLength: Math.max(1, totalLength) };
}

export function searchWithIndex(index, query) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery || !index) {
    return [];
  }

  const { entries, totalLength } = index;
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
      const snippetStart = Math.max(0, matchIndex - SNIPPET_CONTEXT_LENGTH);
      const snippetEnd = Math.min(
        entry.text.length,
        matchIndex + normalizedQuery.length + SNIPPET_CONTEXT_LENGTH,
      );
      const snippetBefore = entry.text.slice(snippetStart, matchIndex);
      const snippetAfter = entry.text.slice(matchIndex + normalizedQuery.length, snippetEnd);
      results.push({
        id: `${entry.offset}-${matchIndex}-${results.length}`,
        paragraphOffset: entry.offset,
        offset: absoluteOffset,
        percent: clampPercent(absoluteOffset / totalLength),
        text: `${snippetBefore}${matchText}${snippetAfter}`,
        snippetBefore,
        snippetMatch: matchText,
        snippetAfter,
        query: normalizedQuery,
        matchStart: matchIndex,
        matchEnd: matchIndex + normalizedQuery.length,
      });
      fromIndex = matchIndex + Math.max(1, normalizedQuery.length);
    }
  }

  return results;
}

export function searchParagraphs(paragraphs, query) {
  return searchWithIndex(buildSearchIndex(paragraphs), query);
}

export function buildMatchMap(results) {
  const map = new Map();
  for (const r of results) {
    const list = map.get(r.paragraphOffset);
    if (list) {
      list.push(r);
    } else {
      map.set(r.paragraphOffset, [r]);
    }
  }
  return map;
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
