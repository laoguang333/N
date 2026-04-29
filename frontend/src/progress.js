export const PROGRESS_CACHE_KEY = "txt-reader-progress";

const CONFLICT_EPSILON = 0.005;

export function normalizeProgress(bookId, progress, fallback = {}) {
  if (!progress) {
    return null;
  }

  return {
    book_id: progress.book_id ?? bookId,
    char_offset: Math.max(0, Number(progress.char_offset) || 0),
    percent: clampPercent(progress.percent),
    version: Number.isFinite(Number(progress.version)) ? Number(progress.version) : null,
    updated_at: progress.updated_at || fallback.updated_at || new Date().toISOString(),
    dirty: Boolean(progress.dirty ?? fallback.dirty),
    base_version: progress.base_version ?? fallback.base_version ?? null,
  };
}

export function progressKey(progress) {
  if (!progress) {
    return "";
  }
  return `${progress.char_offset}:${Math.round((progress.percent || 0) * 10000)}:${progress.version ?? "local"}`;
}

export function savePayload(progress, baseVersion) {
  return {
    char_offset: progress.char_offset,
    percent: progress.percent,
    base_version: baseVersion ?? null,
  };
}

export function chooseProgressForOpen(serverProgress, cachedProgress, bookId) {
  const server = normalizeProgress(bookId, serverProgress, { dirty: false });
  const cached = normalizeProgress(bookId, cachedProgress);

  if (!server) {
    return { progress: cached, shouldSync: Boolean(cached?.dirty || cached?.percent > 0) };
  }
  if (!cached) {
    return { progress: server, shouldSync: false };
  }

  const cachedIsUnsyncedFromSameServer =
    cached.dirty && cached.base_version !== null && cached.base_version === server.version;
  if (cachedIsUnsyncedFromSameServer && Date.parse(cached.updated_at) > Date.parse(server.updated_at)) {
    return { progress: cached, shouldSync: true };
  }

  const serverLooksUnread = server.percent <= CONFLICT_EPSILON;
  const cachedLooksRead = cached.percent > CONFLICT_EPSILON;
  if (serverLooksUnread && cachedLooksRead) {
    return { progress: cached, shouldSync: true };
  }

  return { progress: server, shouldSync: false };
}

export function isRemoteAhead(savedProgress, attemptedProgress) {
  if (!savedProgress || !attemptedProgress) {
    return false;
  }
  return savedProgress.percent > attemptedProgress.percent + CONFLICT_EPSILON;
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.min(1, Math.max(0, number));
}
