export const DEFAULT_SETTINGS = {
  fontSize: 20,
  lineHeight: 1.85,
  paragraphSpacing: 16,
  theme: "paper",
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
  };
}

export function buildParagraphs(content) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const paragraphs = [];
  let offset = 0;

  for (const line of lines) {
    const text = line.trim();
    if (text) {
      paragraphs.push({ offset, text });
    }
    offset += line.length + 1;
  }

  if (paragraphs.length === 0 && normalized.length > 0) {
    paragraphs.push({ offset: 0, text: normalized });
  }

  return paragraphs;
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
