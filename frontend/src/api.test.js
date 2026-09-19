import { afterEach, expect, test, vi } from "vitest";
import {
  getBook,
  getBookContent,
  getProgress,
  getShelf,
  listBooks,
  saveProgress,
  saveProgressKeepalive,
} from "./api";

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body, init = {}) {
  return {
    ok: init.status ? init.status >= 200 && init.status < 300 : true,
    status: init.status || 200,
    statusText: init.statusText || "OK",
    json: async () => body,
  };
}

test("query and book APIs forward optional AbortSignal without changing old call shapes", async () => {
  const signal = new AbortController().signal;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ items: [] }));

  await getShelf({ search: "alpha" }, { signal });
  await listBooks("beta", { signal });
  await listBooks({ folderTag: "folder" }, { signal });
  await getBook(7, { signal });
  await getBookContent(7, { signal });
  await getProgress(7, { signal });

  expect(fetchMock.mock.calls.map(([, options]) => options?.signal)).toEqual([
    signal,
    signal,
    signal,
    signal,
    signal,
    signal,
  ]);
});

test("HTTP errors retain status, code, and current response fields", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(
    { error: "conflict", code: "version_conflict", current: { version: 3 } },
    { status: 409, statusText: "Conflict" },
  ));

  await expect(getProgress(7)).rejects.toMatchObject({
    message: "conflict",
    status: 409,
    code: "version_conflict",
    current: { version: 3 },
  });
});

test("AbortError from fetch is propagated unchanged", async () => {
  const abortError = new DOMException("The operation was aborted", "AbortError");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(abortError);

  await expect(getProgress(7)).rejects.toBe(abortError);
});

test("normal progress save channels carry the same versioned JSON payload", async () => {
  const payload = {
    char_offset: 42,
    percent: 0.42,
    mutation_id: "M42",
    base_version: 7,
    position_kind: "paragraph_utf16_lf_v1",
    paragraph_fraction: 0.25,
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ book_id: 7, ...payload, version: 8 }));
  await saveProgress(7, payload);
  await saveProgressKeepalive(7, payload);

  expect(fetchMock.mock.calls.slice(-2).map(([, options]) => JSON.parse(options.body))).toEqual([payload, payload]);
});
