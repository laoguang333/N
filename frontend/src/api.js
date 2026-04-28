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

export function listBooks(search = "") {
  const params = new URLSearchParams();
  if (search.trim()) {
    params.set("search", search.trim());
  }
  const suffix = params.toString() ? `?${params}` : "";
  return request(`/api/books${suffix}`);
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

export function saveProgress(id, progress) {
  return request(`/api/books/${id}/progress`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(progress),
  });
}
