export const DEFAULT_SETTINGS = {
  fontSize: 20,
  lineHeight: 1.85,
  paragraphSpacing: 16,
  theme: "paper",
  autoScrollSpeed: 5,
};

export function parseSettings(raw) {
  if (!raw) {
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const parsed = JSON.parse(raw);
    return normalizeSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function normalizeSettings(value) {
  const settings = { ...DEFAULT_SETTINGS, ...(value || {}) };

  return {
    fontSize: clampNumber(settings.fontSize, 16, 32, DEFAULT_SETTINGS.fontSize),
    lineHeight: clampNumber(settings.lineHeight, 1.4, 2.4, DEFAULT_SETTINGS.lineHeight),
    paragraphSpacing: clampNumber(
      settings.paragraphSpacing,
      4,
      36,
      DEFAULT_SETTINGS.paragraphSpacing,
    ),
    theme: settings.theme === "night" ? "night" : "paper",
    autoScrollSpeed: Math.round(clampNumber(settings.autoScrollSpeed, 1, 10, DEFAULT_SETTINGS.autoScrollSpeed)),
  };
}

export function normalizeLineEndings(content) {
  return String(content ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function buildParagraphs(content) {
  const normalized = normalizeLineEndings(content);
  const lines = normalized.split("\n");
  const paragraphs = [];
  let offset = 0;

  for (const line of lines) {
    const text = line.trim();
    if (text) {
      paragraphs.push({ offset: offset + line.length - line.trimStart().length, text });
    }
    offset += line.length + 1;
  }

  if (paragraphs.length === 0 && normalized.length > 0) {
    paragraphs.push({ offset: 0, text: normalized });
  }

  return paragraphs;
}

const CHAPTER_PATTERNS = [
  /^(?:第\s*[零〇一二两三四五六七八九十百千万\d]{1,12}\s*[章节卷部篇回话]|卷\s*[零〇一二两三四五六七八九十百千万\d]{1,12})(?:\s*[：:、.．—-]?\s*.*)?$/,
  /^(?:序章|序言|前言|楔子|引子|后记|终章|尾声|大结局|番外(?:\s*[零〇一二两三四五六七八九十百千万\d]+)?)(?:\s*[：:、.．—-]?\s*.*)?$/,
  /^(?:chapter|part|volume)\s+[\divxlcdm]+(?:\s*[：:、.．—-]?\s*.*)?$/i,
];

const MAX_CHAPTER_TITLE_LENGTH = 30;

function limitChapterTitle(title) {
  return Array.from(title).slice(0, MAX_CHAPTER_TITLE_LENGTH).join("");
}

export function buildChapters(paragraphs) {
  return paragraphs.flatMap((paragraph, paragraphIndex) => {
    const title = String(paragraph.text || "").trim();
    if (!title || !CHAPTER_PATTERNS.some((pattern) => pattern.test(title))) {
      return [];
    }
    return [{
      id: `chapter-${paragraph.offset}-${paragraphIndex}`,
      title: limitChapterTitle(title),
      offset: paragraph.offset,
      paragraphIndex,
    }];
  });
}

export function findChapterIndex(chapters, targetOffset) {
  if (!chapters || chapters.length === 0) return -1;
  let low = 0;
  let high = chapters.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (chapters[middle].offset <= targetOffset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return chapters[low].offset <= targetOffset ? low : -1;
}

export function buildParagraphOffsetMap(paragraphs) {
  const map = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    map.push({
      index: i,
      offset: p.offset,
      endOffset: p.offset + (p.text ? p.text.length : 0),
    });
  }
  return map;
}

export function findParagraphIndex(targetOffset, offsetMap) {
  if (!offsetMap || offsetMap.length === 0) {
    return 0;
  }
  let lo = 0;
  let hi = offsetMap.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsetMap[mid].offset <= targetOffset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

export function formatSize(size) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function formatPercent(progress) {
  if (!progress) {
    return "未读";
  }
  if (progress.percent <= 0) {
    return "0%";
  }
  if (progress.percent >= 1) {
    return "已读";
  }
  return `${Math.round(progress.percent * 100)}%`;
}

function clampNumber(value, min, max, fallback) {
  if (value === null || value === "") {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}
