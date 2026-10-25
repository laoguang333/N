function normalizeText(text) {
  return String(text).toLowerCase();
}

const SNIPPET_CONTEXT_LENGTH = 35;
const CONTEXT_BEFORE_LENGTH = 40;
const CONTEXT_AFTER_LENGTH = 64;
const CONTEXT_MAX_PARAGRAPHS = 2;

export function buildSearchIndex(paragraphs, explicitTotalLength) {
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
  const inferredTotalLength = entries.reduce(
    (end, entry) => Math.max(end, entry.offset + entry.length),
    0,
  );

  const totalLength = Number.isFinite(explicitTotalLength) && explicitTotalLength >= 0
    ? explicitTotalLength
    : inferredTotalLength;
  return { entries, totalLength: Math.max(1, totalLength) };
}

export function searchWithIndex(index, query) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery || !index) {
    return [];
  }

  const { entries, totalLength } = index;
  const results = [];

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
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
        entryIndex,
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

// Builds the text around a hit for display. Unlike the in-paragraph snippet,
// this crosses paragraph boundaries so that short lines such as dialogue
// still show what was written before and after them. Paragraph breaks are
// returned as "\n" so the caller can render them as line breaks.
export function buildSearchContext(index, result, options = {}) {
  const entries = index?.entries || [];
  const entryIndex = Number.isInteger(result?.entryIndex)
    ? result.entryIndex
    : entries.findIndex((entry) => entry.offset === result?.paragraphOffset);
  const entry = entries[entryIndex];
  if (!entry || !result) {
    return {
      before: result?.snippetBefore || "",
      match: result?.snippetMatch || "",
      after: result?.snippetAfter || "",
      clippedStart: false,
      clippedEnd: false,
    };
  }

  const beforeLength = options.before ?? CONTEXT_BEFORE_LENGTH;
  const afterLength = options.after ?? CONTEXT_AFTER_LENGTH;
  const maxParagraphs = options.maxParagraphs ?? CONTEXT_MAX_PARAGRAPHS;

  const beforeParts = [];
  let budget = beforeLength;
  let cursor = entryIndex;
  let start = safeSliceStart(entry.text, Math.max(0, result.matchStart - budget));
  beforeParts.push(entry.text.slice(start, result.matchStart));
  budget -= result.matchStart - start;
  while (start === 0 && budget > 0 && cursor > 0 && entryIndex - cursor < maxParagraphs) {
    cursor -= 1;
    const text = entries[cursor].text;
    start = safeSliceStart(text, Math.max(0, text.length - budget));
    beforeParts.unshift(text.slice(start));
    budget -= text.length - start;
  }
  const clippedStart = start > 0 || cursor > 0;

  const afterParts = [];
  budget = afterLength;
  cursor = entryIndex;
  let end = safeSliceEnd(entry.text, Math.min(entry.text.length, result.matchEnd + budget));
  afterParts.push(entry.text.slice(result.matchEnd, end));
  budget -= end - result.matchEnd;
  while (end === entries[cursor].text.length && budget > 0 && cursor < entries.length - 1 && cursor - entryIndex < maxParagraphs) {
    cursor += 1;
    const text = entries[cursor].text;
    end = safeSliceEnd(text, Math.min(text.length, budget));
    afterParts.push(text.slice(0, end));
    budget -= end;
  }
  const clippedEnd = end < entries[cursor].text.length || cursor < entries.length - 1;

  return {
    before: beforeParts.join("\n"),
    match: entry.text.slice(result.matchStart, result.matchEnd),
    after: afterParts.join("\n"),
    clippedStart,
    clippedEnd,
  };
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

// Avoid splitting a UTF-16 surrogate pair at the edge of a context slice.
function safeSliceStart(text, start) {
  const code = text.charCodeAt(start);
  return start > 0 && code >= 0xdc00 && code <= 0xdfff ? start + 1 : start;
}

function safeSliceEnd(text, end) {
  const code = text.charCodeAt(end - 1);
  return end < text.length && code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
