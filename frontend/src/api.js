const jsonHeaders = {
  "Content-Type": "application/json",
};

async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let body = null;
    try {
      body = await response.json();
      message = body.error || message;
    } catch {
      // Keep the HTTP status as the visible error.
    }
    const error = new Error(message);
    error.status = response.status;
    if (body && typeof body === "object") {
      error.code = body.code;
      error.current = body.current;
    }
    throw error;
  }

  return response.json();
}

export function getShelf(query = {}, options = {}) {
  const params = buildBookQueryParams(query);
  const suffix = params.toString() ? `?${params}` : "";
  return request(`/api/shelf${suffix}`, options);
}

export function listBooks(search = "", options = {}) {
  if (typeof search === "object") {
    return listBooksWithQuery(search, options);
  }

  return listBooksWithQuery({ search }, options);
}

function listBooksWithQuery({ search = "", status = "all", minRating = "", sort = "recent", folderTag = "" } = {}, options = {}) {
  const params = buildBookQueryParams({ search, status, minRating, sort, folderTag });
  const suffix = params.toString() ? `?${params}` : "";
  return request(`/api/books${suffix}`, options);
}

function buildBookQueryParams({ search = "", status = "all", minRating = "", sort = "recent", folderTag = "" } = {}) {
  const params = new URLSearchParams();
  if (search.trim()) {
    params.set("search", search.trim());
  }
  if (status && status !== "all") {
    params.set("status", status);
  }
  if (minRating) {
    params.set("min_rating", String(minRating));
  }
  if (sort && sort !== "recent") {
    params.set("sort", sort);
  }
  if (folderTag) {
    params.set("folder_tag", folderTag);
  }
  return params;
}

export function getPublicConfig(options = {}) {
  return request("/api/config", options);
}

export function scanLibrary() {
  return request("/api/library/scan", { method: "POST" });
}

export function scanAnimeLibrary() {
  return request("/api/anime/library/scan", { method: "POST" });
}

export function getBook(id, options = {}) {
  return request(`/api/books/${id}`, options);
}

export function getBookContent(id, options = {}) {
  return request(`/api/books/${id}/content`, options);
}

export function bookFileUrl(id) {
  return `/api/books/${id}/file`;
}

export function getProgress(id, options = {}) {
  return request(`/api/books/${id}/progress`, options);
}

export function saveProgress(id, progress, options = {}) {
  return request(`/api/books/${id}/progress`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(progress),
    keepalive: Boolean(options.keepalive),
    signal: options.signal,
  });
}

export function saveProgressKeepalive(id, progress, options = {}) {
  return request(`/api/books/${id}/progress`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(progress),
    keepalive: true,
    signal: options.signal,
  });
}

export function saveProgressBeacon(id, progress) {
  if (!navigator.sendBeacon) {
    return false;
  }

  const body = new Blob([JSON.stringify(progress)], {
    type: "application/json",
  });
  return navigator.sendBeacon(`/api/books/${id}/progress`, body);
}

export function saveRating(id, rating) {
  return request(`/api/books/${id}/rating`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ rating }),
  });
}

export function animeTranscodeUrl(path) {
  const params = new URLSearchParams({ path });
  return `/api/anime/transcode?${params}`;
}

export function animeFileUrl(path) {
  const params = new URLSearchParams({ path });
  return `/api/anime/file?${params}`;
}

export function animeVideoFileUrl(id) {
  return `/api/anime/videos/${id}/file`;
}

export function listAnimeVideos(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "" && value !== "all") {
      params.set(key === "minRating" ? "min_rating" : key, String(value));
    }
  }
  const suffix = params.toString() ? `?${params}` : "";
  return request(`/api/anime/videos${suffix}`);
}

export function getAnimeVideo(id) {
  return request(`/api/anime/videos/${id}`);
}

export function getAnimeProgress(id) {
  return request(`/api/anime/videos/${id}/progress`);
}

export function saveAnimeProgress(id, progress) {
  return request(`/api/anime/videos/${id}/progress`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(progress),
  });
}

export function saveAnimeRating(id, rating) {
  return request(`/api/anime/videos/${id}/rating`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ rating }),
  });
}

export function startAnimeWatch(id, positionSeconds = 0) {
  return request(`/api/anime/videos/${id}/watch/start`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ position_seconds: positionSeconds }),
  });
}

export async function finishAnimeWatch(historyId, payload) {
  const response = await fetch(`/api/anime/watch-history/${historyId}/finish`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
    keepalive: true,
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
}

export function listAnimeHistory(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "" && value !== "all") {
      params.set(key, String(value));
    }
  }
  const suffix = params.toString() ? `?${params}` : "";
  return request(`/api/anime/watch-history${suffix}`);
}

export function getAnimeTools() {
  return request("/api/anime/tools");
}

export function probeAnime(path) {
  const params = new URLSearchParams({ path });
  return request(`/api/anime/probe?${params}`);
}

export function prepareAnimeHls(path) {
  return request("/api/anime/hls/prepare", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ path }),
  });
}

export function getAnimeHlsStatus(path) {
  const params = new URLSearchParams({ path });
  return request(`/api/anime/hls/status?${params}`);
}
