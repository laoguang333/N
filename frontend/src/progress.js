export const PROGRESS_CACHE_KEY = "txt-reader-progress";

const ZERO_RESET_PERCENT = 0.001;
const START_RESET_PERCENT = 0.02;

export function normalizeProgress(bookId, progress, fallback = {}) {
  if (!progress) {
    return null;
  }

  return {
    book_id: progress.book_id ?? bookId,
    char_offset: Math.max(0, Number(progress.char_offset) || 0),
    percent: clampPercent(progress.percent),
    updated_at: progress.updated_at || fallback.updated_at || new Date().toISOString(),
    dirty: Boolean(progress.dirty ?? fallback.dirty),
  };
}

export function progressKey(progress) {
  if (!progress) {
    return "";
  }
  return `${progress.char_offset}:${Math.round((progress.percent || 0) * 10000)}`;
}

export function savePayload(progress, meta = {}) {
  return {
    char_offset: progress.char_offset,
    percent: progress.percent,
    source: meta.source || "unknown",
    client_id: meta.clientId || null,
    session_id: meta.sessionId || null,
    allow_backward: Boolean(meta.allowBackward),
  };
}

export function isSuspiciousLocalReset(nextProgress, previousProgress, options = {}) {
  if (options.allowBackward || !nextProgress || !previousProgress) {
    return false;
  }

  const hasReadingTrace = previousProgress.char_offset > 0 || previousProgress.percent > ZERO_RESET_PERCENT;
  const zeroReset = hasReadingTrace && nextProgress.percent <= ZERO_RESET_PERCENT && nextProgress.char_offset === 0;
  const startJump =
    previousProgress.percent > START_RESET_PERCENT
    && nextProgress.percent <= START_RESET_PERCENT
    && previousProgress.percent > nextProgress.percent + START_RESET_PERCENT;

  return zeroReset || startJump;
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.min(1, Math.max(0, number));
}
