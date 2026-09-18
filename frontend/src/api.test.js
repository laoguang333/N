import { afterEach, expect, test, vi } from "vitest";
import { getBook, getBookContent, getProgress, getShelf, listBooks } from "./api";

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
