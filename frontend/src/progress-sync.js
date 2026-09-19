import { normalizeProgress, PROGRESS_CACHE_KEY, PROGRESS_CACHE_V2_KEY } from "./progress";

const LEGACY_CACHE_KEY = PROGRESS_CACHE_KEY;
const CONFLICT_MESSAGE = "存在未同步的本地位置，与服务端进度不同";
const STORAGE_MESSAGE = "本地进度备份失败，当前阅读仍会继续";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function defaultStorage() {
  return {
    getItem: (key) => globalThis.localStorage?.getItem(key) ?? null,
    setItem: (key, value) => globalThis.localStorage?.setItem(key, value),
  };
}

function isVersion(value) {
  return Number.isInteger(value) && value >= 0;
}

function positionFrom(value, bookId) {
  if (!value) return null;
  const normalized = normalizeProgress(bookId, value, { dirty: true });
  return {
    book_id: Number(bookId),
    char_offset: normalized.char_offset,
    percent: normalized.percent,
    position_kind: normalized.position_kind,
    paragraph_fraction: normalized.paragraph_fraction,
    base_version: isVersion(value.base_version) ? value.base_version : null,
    source: value.source || null,
    client_id: value.client_id || value.clientId || null,
    session_id: value.session_id || value.sessionId || null,
    allow_backward: Boolean(value.allow_backward ?? value.allowBackward),
    recorded_at: value.recorded_at || value.updated_at || new Date().toISOString(),
  };
}

function samePosition(left, right) {
  if (!left || !right) return false;
  if ((Number(left.char_offset) || 0) !== (Number(right.char_offset) || 0)) return false;
  if ((Number(left.percent) || 0) !== (Number(right.percent) || 0)) return false;
  if ((left.position_kind || null) !== (right.position_kind || null)) return false;
  const leftFraction = Number.isFinite(left.paragraph_fraction) ? left.paragraph_fraction : null;
  const rightFraction = Number.isFinite(right.paragraph_fraction) ? right.paragraph_fraction : null;
  return leftFraction === rightFraction;
}

function publicState(record) {
  return {
    confirmed: clone(record.confirmed),
    submitted: clone(record.submitted),
    pending: clone(record.pending),
    conflict: clone(record.conflict),
    error: record.error || null,
    storage_error: record.storage_error || null,
  };
}

function parseObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function createProgressSync({
  storage = defaultStorage(),
  save,
  sendOnExit = () => {},
  makeMutationId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  onState = () => {},
}) {
  const records = new Map();
  const flights = new Map();
  let loaded = false;
  let storageReadError = null;

  function emit(bookId, record) {
    try {
      onState(Number(bookId), publicState(record));
    } catch {
      // State observers must not break the sync queue.
    }
  }

  function newRecord() {
    return {
      confirmed: null,
      submitted: null,
      pending: null,
      conflict: null,
      error: null,
      storage_error: storageReadError,
      knownBaseVersion: null,
    };
  }

  function hydrateRecord(bookId, raw) {
    const record = newRecord();
    if (!raw || typeof raw !== "object") return record;
    record.confirmed = normalizeProgress(bookId, raw.confirmed, { dirty: false });
    record.submitted = raw.submitted ? clone(raw.submitted) : null;
    record.pending = raw.pending ? positionFrom(raw.pending, bookId) : null;
    record.conflict = raw.conflict ? {
      local: positionFrom(raw.conflict.local, bookId),
      remote: normalizeProgress(bookId, raw.conflict.remote, { dirty: false }),
    } : null;
    record.knownBaseVersion = isVersion(record.confirmed?.version)
      ? record.confirmed.version
      : (isVersion(record.pending?.base_version) ? record.pending.base_version : null);
    return record;
  }

  function readLegacyRecord(bookId, legacyCache) {
    const legacy = legacyCache?.[bookId];
    if (!legacy) return null;
    const record = newRecord();
    const normalized = normalizeProgress(bookId, legacy, { dirty: Boolean(legacy.dirty) });
    if (!normalized) return null;
    if (normalized.dirty) {
      record.pending = positionFrom({ ...normalized, base_version: normalized.version }, bookId);
      record.knownBaseVersion = isVersion(normalized.version) ? normalized.version : null;
    } else {
      record.confirmed = normalized;
      record.knownBaseVersion = isVersion(normalized.version) ? normalized.version : null;
    }
    return record;
  }

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    let v2 = {};
    let legacy = {};
    try {
      v2 = parseObject(storage.getItem(PROGRESS_CACHE_V2_KEY));
    } catch {
      storageReadError = STORAGE_MESSAGE;
    }
    try {
      legacy = parseObject(storage.getItem(LEGACY_CACHE_KEY));
    } catch {
      storageReadError = STORAGE_MESSAGE;
    }
    for (const [bookId, raw] of Object.entries(v2)) {
      records.set(String(bookId), hydrateRecord(Number(bookId), raw));
    }
    for (const [bookId, raw] of Object.entries(legacy)) {
      if (!records.has(String(bookId))) {
        const record = readLegacyRecord(Number(bookId), legacy);
        if (record) records.set(String(bookId), record);
      }
    }
    if (Object.keys(legacy).length > 0) {
      const cache = {};
      for (const [key, value] of records.entries()) cache[key] = serializeRecord(value);
      try {
        storage.setItem(PROGRESS_CACHE_V2_KEY, JSON.stringify(cache));
      } catch {
        for (const record of records.values()) {
          record.storage_error = STORAGE_MESSAGE;
          record.error = STORAGE_MESSAGE;
        }
      }
    }
  }

  function getRecord(bookId) {
    ensureLoaded();
    const key = String(bookId);
    if (!records.has(key)) records.set(key, newRecord());
    return records.get(key);
  }

  function serializeRecord(record) {
    return {
      confirmed: record.confirmed,
      submitted: record.submitted,
      pending: record.pending,
      conflict: record.conflict,
    };
  }

  function persist(bookId, record) {
    const cache = {};
    for (const [key, value] of records.entries()) cache[key] = serializeRecord(value);
    try {
      storage.setItem(PROGRESS_CACHE_V2_KEY, JSON.stringify(cache));
      record.storage_error = null;
      return true;
    } catch {
      record.storage_error = STORAGE_MESSAGE;
      record.error = STORAGE_MESSAGE;
      emit(bookId, record);
      return false;
    }
  }

  function persistAndEmit(bookId, record) {
    persist(bookId, record);
    emit(bookId, record);
  }

  function positionFromSubmitted(bookId, payload) {
    return positionFrom(payload, bookId);
  }

  function currentLocalPosition(bookId, record) {
    return record.pending
      || positionFromSubmitted(bookId, record.submitted)
      || positionFrom(record.confirmed, bookId);
  }

  function updatePendingBase(record, version) {
    if (record.pending && isVersion(version)) record.pending.base_version = version;
  }

  function makeSubmitted(bookId, record) {
    if (record.submitted || !record.pending || !isVersion(record.pending.base_version)) return false;
    let mutationId;
    try {
      mutationId = makeMutationId(bookId, clone(record.pending));
    } catch (error) {
      record.error = error?.message || "无法创建进度 mutation";
      persistAndEmit(bookId, record);
      return false;
    }
    record.submitted = Object.freeze({
      book_id: Number(bookId),
      char_offset: record.pending.char_offset,
      percent: record.pending.percent,
      position_kind: record.pending.position_kind,
      paragraph_fraction: record.pending.paragraph_fraction,
      base_version: record.pending.base_version,
      mutation_id: mutationId,
      source: record.pending.source,
      client_id: record.pending.client_id,
      session_id: record.pending.session_id,
      allow_backward: record.pending.allow_backward,
    });
    record.pending = null;
    return persist(bookId, record);
  }

  function setConflict(bookId, record, remote) {
    const local = currentLocalPosition(bookId, record);
    record.conflict = {
      local: clone(local),
      remote: remote ? normalizeProgress(bookId, remote, { dirty: false }) : null,
    };
    record.error = CONFLICT_MESSAGE;
    persistAndEmit(bookId, record);
  }

  function handleSaveFailure(bookId, record, error) {
    if (error?.status === 409 || error?.status === 428) {
      setConflict(bookId, record, error.current || null);
      return;
    }
    record.error = error?.message || "进度同步失败";
    persistAndEmit(bookId, record);
  }

  async function drain(bookId) {
    const record = getRecord(bookId);
    while (true) {
      if (record.conflict) return;
      if (record.submitted) {
        const payload = clone(record.submitted);
        try {
          const response = await save(Number(bookId), payload);
          const saved = normalizeProgress(bookId, response, { dirty: false });
          if (!saved || (saved.book_id != null && Number(saved.book_id) !== Number(bookId))) {
            record.error = "进度响应与当前书籍不匹配";
            persistAndEmit(bookId, record);
            return;
          }
          if (saved.mutation_id && saved.mutation_id !== payload.mutation_id) {
            setConflict(bookId, record, saved);
            return;
          }
          record.confirmed = saved;
          record.knownBaseVersion = isVersion(saved.version) ? saved.version : record.knownBaseVersion;
          record.submitted = null;
          updatePendingBase(record, saved.version);
          record.error = null;
          persistAndEmit(bookId, record);
          continue;
        } catch (error) {
          handleSaveFailure(bookId, record, error);
          return;
        }
      }
      if (!record.pending || !isVersion(record.pending.base_version)) return;
      if (!makeSubmitted(bookId, record)) return;
      emit(bookId, record);
    }
  }

  function reconcile(bookId, remoteProgress) {
    const record = getRecord(bookId);
    const remote = remoteProgress ? normalizeProgress(bookId, remoteProgress, { dirty: false }) : null;
    if (remote) record.knownBaseVersion = isVersion(remote.version) ? remote.version : record.knownBaseVersion;
    else record.knownBaseVersion = 0;

    if (record.submitted && remote?.mutation_id === record.submitted.mutation_id) {
      record.confirmed = remote;
      record.submitted = null;
      updatePendingBase(record, remote.version);
      record.conflict = null;
      record.error = null;
      persistAndEmit(bookId, record);
      return getState(bookId);
    }

    record.confirmed = remote;
    if (record.pending) {
      if (!remote && !isVersion(record.pending.base_version)) {
        record.pending.base_version = 0;
      } else if (remote && !isVersion(record.pending.base_version)) {
        setConflict(bookId, record, remote);
        return getState(bookId);
      } else if (remote && record.pending.base_version !== remote.version) {
        setConflict(bookId, record, remote);
        return getState(bookId);
      } else if (remote && samePosition(record.pending, remote)) {
        record.pending = null;
      }
    }
    if (record.submitted && remote && record.submitted.base_version !== remote.version) {
      setConflict(bookId, record, remote);
      return getState(bookId);
    }
    record.error = null;
    persistAndEmit(bookId, record);
    return getState(bookId);
  }

  function observe(bookId, position) {
    const record = getRecord(bookId);
    const next = positionFrom({
      ...position,
      base_version: position.base_version ?? (
        record.pending?.base_version
        ?? record.confirmed?.version
        ?? record.knownBaseVersion
      ),
    }, bookId);
    const current = currentLocalPosition(bookId, record);
    if (samePosition(current, next)) return getState(bookId);
    record.pending = next;
    if (record.conflict) record.conflict.local = clone(next);
    record.error = record.storage_error || (record.conflict ? CONFLICT_MESSAGE : null);
    persistAndEmit(bookId, record);
    return getState(bookId);
  }

  function flush(bookId) {
    const key = String(bookId);
    if (flights.has(key)) return flights.get(key);
    const flight = drain(Number(bookId)).finally(() => {
      if (flights.get(key) === flight) flights.delete(key);
    });
    flights.set(key, flight);
    return flight;
  }

  function flushOnExit(bookId) {
    const record = getRecord(bookId);
    if (record.conflict) return;
    if (!record.submitted && record.pending && isVersion(record.pending.base_version)) {
      if (!makeSubmitted(bookId, record)) return;
      emit(bookId, record);
    }
    if (!record.submitted) return;
    try {
      sendOnExit(Number(bookId), clone(record.submitted));
    } catch (error) {
      record.error = error?.message || "退出时进度发送失败";
      persistAndEmit(bookId, record);
    }
  }

  function getState(bookId) {
    return publicState(getRecord(bookId));
  }

  function resolveConflict(bookId, choice) {
    const record = getRecord(bookId);
    if (!record.conflict || !["local", "remote"].includes(choice)) return getState(bookId);
    if (choice === "remote") {
      record.confirmed = record.conflict.remote;
      record.knownBaseVersion = isVersion(record.confirmed?.version) ? record.confirmed.version : 0;
      record.pending = null;
      record.submitted = null;
    } else {
      const local = record.pending || record.conflict.local;
      record.submitted = null;
      record.pending = local ? {
        ...clone(local),
        base_version: isVersion(record.conflict.remote?.version) ? record.conflict.remote.version : 0,
      } : null;
      record.knownBaseVersion = isVersion(record.conflict.remote?.version) ? record.conflict.remote.version : 0;
    }
    record.conflict = null;
    record.error = null;
    persistAndEmit(bookId, record);
    return getState(bookId);
  }

  return { reconcile, observe, flush, flushOnExit, getState, resolveConflict };
}
