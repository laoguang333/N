import { expect, test } from "@playwright/test";

const ID = 501;
const CACHE_KEY = `txt-reader-progress-v2:${ID}`;
const WAIT_MS = 6500;

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function setupDelayedProgress(page) {
  const lines = Array.from({ length: 180 }, (_, i) =>
    `P${String(i).padStart(5, "0")} ${"正常阅读的测试正文。".repeat(5)}`);
  const content = lines.join("\n\n");
  const offset = lines.slice(0, 120).reduce((sum, line) => sum + line.length + 2, 0);
  let stored = {
    book_id: ID, char_offset: offset, percent: offset / content.length,
    version: 7, mutation_id: "remote-before-open",
    position_kind: "paragraph_utf16_lf_v1", paragraph_fraction: 0,
    updated_at: "2026-09-19T00:00:00.000Z",
  };
  const book = {
    id: ID, title: "Idle progress fixture", format: "txt", encoding: "UTF-8",
    size: content.length, mtime: 1, file_hash: "test-only",
    file_path: "fixture-library/501.txt", folder_tag: null, rating: null,
    created_at: stored.updated_at, updated_at: stored.updated_at,
  };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const writes = [];
  const unexpected = [];

  await page.addInitScript(() => { navigator.sendBeacon = () => false; });
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
    if (path === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
    if (path === "/api/shelf") return json(route, {
      items: [{ type: "book", book }], books: [book], folders: [],
    });
    if (path === `/api/books/${ID}`) return json(route, book);
    if (path === `/api/books/${ID}/content`) return json(route, {
      book_id: ID, title: book.title, content, length: content.length, encoding: "UTF-8",
    });
    if (path === `/api/books/${ID}/progress`) {
      if (req.method() === "GET") {
        await gate;
        return json(route, stored);
      }
      const payload = req.postDataJSON();
      writes.push(payload);
      if (!Number.isInteger(payload.base_version) || !payload.mutation_id) {
        return json(route, { code: "progress_protocol_upgrade_required" }, 428);
      }
      if (payload.mutation_id === stored.mutation_id) return json(route, stored);
      if (payload.base_version !== stored.version) {
        return json(route, { code: "progress_conflict", current: stored }, 409);
      }
      stored = { ...stored, ...payload, book_id: ID, version: stored.version + 1 };
      return json(route, stored);
    }
    unexpected.push(`${req.method()} ${path}`);
    return json(route, { error: "unexpected fixture request" }, 500);
  });
  await page.goto(`/#/reader/${ID}`);
  await expect(page.locator(".reader-content")).toBeVisible();
  return { release, writes, unexpected, offset };
}

async function assertNoNewLocalPosition(page) {
  const cache = await page.evaluate((key) =>
    JSON.parse(localStorage.getItem(key) || "null"), CACHE_KEY);
  expect(cache?.pending ?? null).toBeNull();
  expect(cache?.submitted ?? null).toBeNull();
  expect(cache?.conflict ?? null).toBeNull();
}

test("idle reader does not invent progress before or after a delayed restore", async ({ page }) => {
  test.setTimeout(30000);
  const fixture = await setupDelayedProgress(page);
  try {
    await page.waitForTimeout(WAIT_MS);
    await assertNoNewLocalPosition(page);
    expect(fixture.writes).toHaveLength(0);
    fixture.release();
    await expect(page.locator(`p[data-offset="${fixture.offset}"]`)).toBeInViewport();
    await expect(page.locator(".progress-conflict")).toHaveCount(0);
    await page.waitForTimeout(WAIT_MS);
    await assertNoNewLocalPosition(page);
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("returning without reading does not save the temporary book start", async ({ page }) => {
  const fixture = await setupDelayedProgress(page);
  try {
    await page.getByRole("button", { name: "返回书架" }).click();
    await expect(page.locator(".shelf-view")).toBeVisible();
    await page.waitForTimeout(1000);
    await assertNoNewLocalPosition(page);
    expect(fixture.writes).toHaveLength(0);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    fixture.release();
  }
});
