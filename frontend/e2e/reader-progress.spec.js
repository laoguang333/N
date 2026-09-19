import { expect, test } from "@playwright/test";

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function makeBook() {
  return {
    id: 101,
    title: "Mock reader progress",
    file_path: "fixture-library/101.txt",
    file_hash: "mock-101",
    format: "txt",
    size: 1024,
    mtime: 1,
    encoding: "UTF-8",
    folder_tag: null,
    rating: null,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
  };
}

function makeContent() {
  return [
    "第一章 进度回归",
    ...Array.from({ length: 120 }, (_, index) => `P${String(index + 1).padStart(5, "0")} ${"用于验证最终位置保存和恢复的正文。".repeat((index % 5) + 1)}`),
  ].join("\n\n");
}

async function setup(page, { initialProgress = null, failWrites = false } = {}) {
  const book = makeBook();
  const content = makeContent();
  let storedProgress = initialProgress;
  const writes = [];

  await page.addInitScript(() => { navigator.sendBeacon = () => false; });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
    if (url.pathname === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
    if (url.pathname === "/api/shelf") return json(route, { items: [{ type: "book", book: { ...book, progress: storedProgress } }], books: [{ ...book, progress: storedProgress }], folders: [] });
    if (url.pathname === "/api/books/101") return json(route, { ...book, book_id: 101 });
    if (url.pathname === "/api/books/101/content") return json(route, { book_id: 101, title: book.title, content, length: content.length, encoding: "UTF-8" });
    if (url.pathname === "/api/books/101/progress") {
      if (route.request().method() === "GET") return json(route, storedProgress);
      const body = route.request().postDataJSON() || {};
      writes.push(body);
      if (failWrites) return json(route, { error: "offline" }, 503);
      storedProgress = { book_id: 101, ...body, version: (storedProgress?.version || 0) + 1, mutation_id: body.mutation_id, updated_at: new Date().toISOString() };
      return json(route, storedProgress);
    }
    throw new Error(`Unexpected API request: ${route.request().method()} ${route.request().url()}`);
  });

  await page.goto("/");
  await page.locator(".book-row", { hasText: book.title }).click();
  await expect(page.locator(".reader-content")).toBeVisible();
  await expect(page.locator(".reader-content")).not.toHaveClass(/is-restoring/);
  await expect(page.locator(".reader-content p").first()).toBeVisible();
  return { writes, getStoredProgress: () => storedProgress };
}

test.describe("safe reader progress lifecycle", () => {
  test("captures the final visible position before returning to the shelf", async ({ page }) => {
    const fixture = await setup(page);
    await page.locator(".reader-content").hover();
    await page.mouse.wheel(0, 5000);
    await expect.poll(() => page.locator(".reader-content").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.waitForTimeout(50);
    await page.getByRole("button", { name: "返回书架" }).evaluate((button) => button.click());
    await expect(page.locator(".shelf-view")).toBeVisible();
    await expect.poll(() => fixture.writes.length).toBeGreaterThan(0);
    expect(fixture.writes.at(-1)).toEqual(expect.objectContaining({
      mutation_id: expect.any(String),
      base_version: 0,
      position_kind: "paragraph_utf16_lf_v1",
    }));
    expect(fixture.writes.at(-1).char_offset).toBeGreaterThan(0);
  });

  test("allows a normal scroll back to the beginning to be saved", async ({ page }) => {
    const fixture = await setup(page, { initialProgress: { book_id: 101, char_offset: 800, percent: 0.5, version: 4, mutation_id: "remote", updated_at: "2026-09-19T00:00:00.000Z" } });
    await page.locator(".reader-content").hover();
    await page.mouse.wheel(0, 4000);
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => fixture.writes.some((write) => write.char_offset === 0 && write.percent === 0)).toBeTruthy();
  });

  test("keyboard seeking leaves no stale seek state and saves the chosen position", async ({ page }) => {
    const fixture = await setup(page);
    const slider = page.getByRole("slider", { name: /阅读进度/ });
    await slider.focus();
    await slider.press("End");
    await slider.blur();
    await expect.poll(() => fixture.writes.some((write) => write.percent === 1)).toBeTruthy();
    expect(fixture.writes.findLast((write) => write.percent === 1)).toEqual(expect.objectContaining({ percent: 1, allow_backward: true }));
  });

  test("a failed progress save does not block leaving the reader", async ({ page }) => {
    const fixture = await setup(page, { failWrites: true });
    await page.locator(".reader-content").hover();
    await page.mouse.wheel(0, 5000);
    await expect.poll(() => page.locator(".reader-content").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "返回书架" }).click();
    await expect(page.locator(".shelf-view")).toBeVisible();
    expect(fixture.writes.length).toBeGreaterThan(0);
  });

  test("repeated close events reuse the same submitted mutation", async ({ page }) => {
    const fixture = await setup(page);
    await page.locator(".reader-content").hover();
    await page.mouse.wheel(0, 5000);
    await expect.poll(() => page.locator(".reader-content").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
    });
    await expect.poll(() => fixture.writes.length).toBeGreaterThan(0);
    expect(new Set(fixture.writes.map((write) => write.mutation_id)).size).toBe(1);
  });
});
