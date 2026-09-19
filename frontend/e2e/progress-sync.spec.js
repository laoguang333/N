import { expect, test } from "@playwright/test";

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function book(id, title) {
  return {
    id,
    title,
    file_path: `fixture-library/${id}.txt`,
    file_hash: `hash-${id}`,
    format: "txt",
    size: 2048,
    mtime: 1,
    encoding: "UTF-8",
    folder_tag: null,
    rating: null,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
  };
}

async function routeCommon(route, books) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/config") { await json(route, { library_dirs: ["fixture-library"] }); return true; }
  if (url.pathname === "/api/anime/tools") { await json(route, { ffmpeg: null, ffprobe: null }); return true; }
  if (url.pathname === "/api/shelf") {
    await json(route, {
      items: books.map((item) => ({ type: "book", book: item })),
      books,
      folders: [],
    });
    return true;
  }
  const match = url.pathname.match(/^\/api\/books\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    await json(route, { ...books.find((item) => item.id === id), book_id: id });
    return true;
  }
  return false;
}

test.describe("per-book progress sync", () => {
  test("keeps book B saves independent while book A is slow", async ({ page }) => {
    const books = [book(1, "Book A"), book(2, "Book B")];
    const releaseA = deferred();
    let aStarted = false;
    const bWrites = [];

    await page.addInitScript(() => { navigator.sendBeacon = () => false; });
    await page.route("**/api/**", async (route) => {
      const common = await routeCommon(route, books);
      if (common) return;
      const request = route.request();
      const url = new URL(request.url());
      const progressMatch = url.pathname.match(/^\/api\/books\/(\d+)\/progress$/);
      if (!progressMatch) throw new Error(`Unexpected API request: ${request.method()} ${request.url()}`);
      const id = Number(progressMatch[1]);
      if (request.method() === "GET") return json(route, { book_id: id, char_offset: 1, percent: 0.01, version: 1 });
      const body = request.postDataJSON() || {};
      if (id === 1) {
        aStarted = true;
        await releaseA.promise;
      } else {
        bWrites.push(body);
      }
      return json(route, { book_id: id, ...body, version: 2, mutation_id: body.mutation_id });
    });
    await page.route("**/api/books/1/content", (route) => json(route, { book_id: 1, title: "Book A", content: "A\n\n".repeat(80), length: 238, encoding: "UTF-8" }));
    await page.route("**/api/books/2/content", (route) => json(route, { book_id: 2, title: "Book B", content: "B\n\n".repeat(80), length: 238, encoding: "UTF-8" }));

    await page.goto("/");
    await page.locator(".book-row", { hasText: "Book A" }).click();
    await expect(page.locator(".reader-content")).toContainText("A");
    await expect(page.locator(".reader-content")).not.toHaveClass(/is-restoring/);
    await page.locator(".reader-content").hover();
    await page.mouse.wheel(0, 2400);
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.location.hash = "#/reader/2"; });
    await expect(page.locator(".reader-title")).toContainText("Book B");
    await expect.poll(() => aStarted).toBe(true);
    await page.locator(".reader-content").hover();
    await page.mouse.wheel(0, 1200);
    await expect.poll(() => bWrites.length).toBeGreaterThan(0);
    releaseA.resolve();
  });

  test("shows正文 when progress GET fails", async ({ page }) => {
    const fixture = book(3, "Readable despite sync failure");
    await page.route("**/api/**", async (route) => {
      const common = await routeCommon(route, [fixture]);
      if (common) return;
      const url = new URL(route.request().url());
      if (url.pathname === "/api/books/3/content") return json(route, { book_id: 3, title: fixture.title, content: "正文仍然可读", length: 7, encoding: "UTF-8" });
      if (url.pathname === "/api/books/3/progress" && route.request().method() === "GET") return json(route, { error: "progress unavailable" }, 500);
      if (url.pathname === "/api/books/3/progress") return json(route, { book_id: 3, char_offset: 0, percent: 0, version: 1 });
      throw new Error(`Unexpected API request: ${route.request().method()} ${route.request().url()}`);
    });
    await page.goto("/");
    await page.locator(".book-row", { hasText: fixture.title }).click();
    await expect(page.locator(".reader-content")).toContainText("正文仍然可读");
    await expect(page.locator(".reader-error")).toHaveCount(0);
  });

  test("retries the persisted submitted mutation after reload", async ({ page }) => {
    const fixture = book(4, "Retry submitted");
    const writes = [];
    let first = true;
    await page.route("**/api/**", async (route) => {
      const common = await routeCommon(route, [fixture]);
      if (common) return;
      const url = new URL(route.request().url());
      if (url.pathname === "/api/books/4/content") return json(route, { book_id: 4, title: fixture.title, content: "第一段\n\n第二段\n\n第三段\n\n".repeat(40), length: 640, encoding: "UTF-8" });
      if (url.pathname === "/api/books/4/progress" && route.request().method() === "GET") return json(route, null);
      if (url.pathname === "/api/books/4/progress") {
        const body = route.request().postDataJSON() || {};
        writes.push(body);
        if (first) {
          first = false;
          return json(route, { error: "offline" }, 503);
        }
        return json(route, { book_id: 4, ...body, version: 1, mutation_id: body.mutation_id });
      }
      throw new Error(`Unexpected API request: ${route.request().method()} ${route.request().url()}`);
    });
    await page.goto("/");
    await page.locator(".book-row", { hasText: fixture.title }).click();
    await expect(page.locator(".reader-content")).toBeVisible();
    await page.locator(".reader-content").hover();
    await page.mouse.wheel(0, 2400);
    await expect.poll(() => writes.length).toBeGreaterThan(0);
    const firstMutation = writes[0].mutation_id;
    await page.reload();
    await expect(page.locator(".reader-content")).toBeVisible();
    await expect.poll(() => writes.length).toBeGreaterThan(1);
    expect(writes[1].mutation_id).toBe(firstMutation);
  });
});
