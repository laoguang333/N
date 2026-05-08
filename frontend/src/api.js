const jsonHeaders = {
  "Content-Type": "application/json",
};

async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      message = body.error || message;
    } catch {
      // Keep the HTTP status as the visible error.
    }
    throw new Error(message);
  }

  return response.json();
}

export function getShelf() {
  return request("/api/shelf");
}

export function listBooks(search = "") {
  if (typeof search === "object") {
    return listBooksWithQuery(search);
  }

  return listBooksWithQuery({ search });
}

function listBooksWithQuery({ search = "", status = "all", minRating = "", sort = "recent", folderTag = "" } = {}) {
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
  const suffix = params.toString() ? `?${params}` : "";
  return request(`/api/books${suffix}`);
}

export function getPublicConfig() {
  return request("/api/config");
}

export function scanLibrary() {
  return request("/api/library/scan", { method: "POST" });
}

export function getBook(id) {
  return request(`/api/books/${id}`);
}

export function getBookContent(id) {
  return request(`/api/books/${id}/content`);
}

export function getProgress(id) {
  return request(`/api/books/${id}/progress`);
}

export function saveProgress(id, progress, options = {}) {
  return request(`/api/books/${id}/progress`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(progress),
    keepalive: Boolean(options.keepalive),
  });
}

export function saveProgressKeepalive(id, progress) {
  return request(`/api/books/${id}/progress`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(progress),
    keepalive: true,
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
