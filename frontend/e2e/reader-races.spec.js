import { expect, test } from "@playwright/test";

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function json(route, body) {
  return route.fulfill({
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
    created_at: "2026-04-30T00:00:00.000Z",
    updated_at: "2026-04-30T00:00:00.000Z",
  };
}

test.describe("reader request races", () => {
  test("a late response from A cannot replace the current B reader", async ({ page }) => {
    const slowAContent = deferred();
    let aContentStarted = false;
    const aBook = book(1, "Book A");
    const bBook = book(2, "Book B");

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
      if (url.pathname === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
      if (url.pathname === "/api/shelf") {
        return json(route, {
          items: [{ type: "book", book: aBook }, { type: "book", book: bBook }],
          books: [aBook, bBook],
          folders: [],
        });
      }
      if (/^\/api\/books\/(1|2)$/.test(url.pathname)) {
        const id = Number(url.pathname.split("/").at(-1));
        return json(route, { ...(id === 1 ? aBook : bBook), book_id: id });
      }
      if (/^\/api\/books\/(1|2)\/progress$/.test(url.pathname) && request.method() === "GET") {
        const id = Number(url.pathname.split("/")[3]);
        return json(route, id === 1 ? { book_id: 1, char_offset: 10, percent: 0.1, version: 1 } : null);
      }
      if (url.pathname === "/api/books/1/content") {
        aContentStarted = true;
        await slowAContent.promise;
        return json(route, { book_id: 1, title: "Book A", content: "A late content", length: 14, encoding: "UTF-8" });
      }
      if (url.pathname === "/api/books/2/content") {
        return json(route, { book_id: 2, title: "Book B", content: "B current content", length: 16, encoding: "UTF-8" });
      }
      if (/^\/api\/books\/(1|2)\/progress$/.test(url.pathname) && ["PUT", "POST"].includes(request.method())) {
        const body = request.postDataJSON() || {};
        const id = Number(url.pathname.split("/")[3]);
        return json(route, { book_id: id, char_offset: body.char_offset || 0, percent: body.percent || 0, version: 1 });
      }
      throw new Error(`Unexpected API request: ${request.method()} ${request.url()}`);
    });

    await page.goto("/");
    await page.locator(".book-row", { hasText: "Book A" }).click();
    await expect.poll(() => aContentStarted).toBe(true);
    await page.evaluate(() => { window.location.hash = "#/reader/2"; });
    await expect(page.locator(".reader-title")).toContainText("Book B");
    await expect(page.locator(".reader-content")).toContainText("B current content");

    slowAContent.resolve();
    await expect(page.locator(".reader-title")).toContainText("Book B");
    await expect(page.locator(".reader-content")).not.toContainText("A late content");
  });

  test("a late A save cannot apply an A payload to B", async ({ page }) => {
    const slowASave = deferred();
    let aSaveStarted = false;
    let aSaveFinished = false;
    const aBook = book(1, "Book A");
    const bBook = book(2, "Book B");
    const bWrites = [];

    await page.addInitScript(() => {
      navigator.sendBeacon = () => false;
    });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
      if (url.pathname === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
      if (url.pathname === "/api/shelf") {
        return json(route, {
          items: [{ type: "book", book: aBook }, { type: "book", book: bBook }],
          books: [aBook, bBook],
          folders: [],
        });
      }
      if (/^\/api\/books\/(1|2)$/.test(url.pathname)) {
        const id = Number(url.pathname.split("/").at(-1));
        return json(route, { ...(id === 1 ? aBook : bBook), book_id: id });
      }
      if (/^\/api\/books\/(1|2)\/progress$/.test(url.pathname) && request.method() === "GET") {
        const id = Number(url.pathname.split("/")[3]);
        return json(route, id === 1 ? { book_id: 1, char_offset: 10, percent: 0.1, version: 1 } : null);
      }
      if (url.pathname === "/api/books/1/content") {
        return json(route, { book_id: 1, title: "Book A", content: "A content\n\n".repeat(30), length: 270, encoding: "UTF-8" });
      }
      if (url.pathname === "/api/books/2/content") {
        return json(route, { book_id: 2, title: "Book B", content: "B content\n\n".repeat(30), length: 270, encoding: "UTF-8" });
      }
      if (url.pathname === "/api/books/1/progress" && request.method() === "POST") {
        aSaveStarted = true;
        await slowASave.promise;
        aSaveFinished = true;
        return json(route, { book_id: 2, char_offset: 999, percent: 0.99, version: 1 });
      }
      if (url.pathname === "/api/books/2/progress" && ["PUT", "POST"].includes(request.method())) {
        bWrites.push(request.postDataJSON());
        const body = request.postDataJSON();
        return json(route, { book_id: 2, char_offset: body.char_offset, percent: body.percent, version: 1 });
      }
      throw new Error(`Unexpected API request: ${request.method()} ${request.url()}`);
    });

    await page.goto("/");
    await page.locator(".book-row", { hasText: "Book A" }).click();
    await expect(page.locator(".reader-content")).toContainText("A content");
    await page.locator(".reader-content").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await page.evaluate(() => { window.location.hash = "#/reader/2"; });
    await expect.poll(() => aSaveStarted).toBe(true);
    await expect(page.locator(".reader-content")).toContainText("B content");
    slowASave.resolve();
    await expect.poll(() => aSaveFinished).toBe(true);
    await page.locator(".reader-content").evaluate((element) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * 0.35);
      element.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(() => bWrites.length).toBeGreaterThan(0);
    await expect(page.locator(".reader-title")).toContainText("Book B");
    await expect(page.locator(".reader-content")).not.toContainText("999");
    expect(bWrites.at(-1).char_offset).not.toBe(999);
  });

  test("a stale periodic A save leaves B periodic attempts alive", async ({ page }) => {
    const releaseA = deferred();
    let aSaveStarted = false;
    const bWrites = [];
    const aBook = book(1, "Book A");
    const bBook = book(2, "Book B");

    await page.addInitScript(() => {
      const nativeSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 3000 ? 40 : delay, ...args);
      navigator.sendBeacon = () => false;
    });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
      if (url.pathname === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
      if (url.pathname === "/api/shelf") {
        return json(route, {
          items: [{ type: "book", book: aBook }, { type: "book", book: bBook }],
          books: [aBook, bBook],
          folders: [],
        });
      }
      if (/^\/api\/books\/(1|2)$/.test(url.pathname)) {
        const id = Number(url.pathname.split("/").at(-1));
        return json(route, { ...(id === 1 ? aBook : bBook), book_id: id });
      }
      if (/^\/api\/books\/(1|2)\/progress$/.test(url.pathname) && request.method() === "GET") {
        const id = Number(url.pathname.split("/")[3]);
        return json(route, { book_id: id, char_offset: 10, percent: 0.1, version: 1 });
      }
      if (url.pathname === "/api/books/1/content") {
        return json(route, { book_id: 1, title: "Book A", content: "A content", length: 9, encoding: "UTF-8" });
      }
      if (url.pathname === "/api/books/2/content") {
        return json(route, { book_id: 2, title: "Book B", content: "B content", length: 9, encoding: "UTF-8" });
      }
      if (url.pathname === "/api/books/1/progress" && ["PUT", "POST"].includes(request.method())) {
        aSaveStarted = true;
        await releaseA.promise;
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "A periodic failure" }) });
      }
      if (url.pathname === "/api/books/2/progress" && ["PUT", "POST"].includes(request.method())) {
        bWrites.push(request.postDataJSON());
        const body = request.postDataJSON();
        return json(route, { book_id: 2, char_offset: body.char_offset, percent: body.percent, version: 1 });
      }
      throw new Error(`Unexpected API request: ${request.method()} ${request.url()}`);
    });

    await page.goto("/");
    await page.locator(".book-row", { hasText: "Book A" }).click();
    await expect(page.locator(".reader-content")).toContainText("A content");
    await expect.poll(() => aSaveStarted).toBe(true);
    await page.evaluate(() => { window.location.hash = "#/reader/2"; });
    await expect(page.locator(".reader-content")).toContainText("B content");
    releaseA.resolve();
    await expect.poll(() => bWrites.length, { timeout: 5000 }).toBeGreaterThan(0);
    await expect(page.getByText("A periodic failure")).toHaveCount(0);
  });

  test("a stale restore callback cannot move B after switching from A", async ({ page }) => {
    await page.addInitScript(() => {
      const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
      const queued = [];
      let held = false;
      window.__holdReaderFrames = (next) => {
        held = next;
        if (!held) {
          const callbacks = queued.splice(0);
          callbacks.filter(Boolean).forEach((callback) => nativeRequestAnimationFrame(callback));
        }
      };
      window.requestAnimationFrame = (callback) => {
        if (!held) return nativeRequestAnimationFrame(callback);
        queued.push(callback);
        return queued.length;
      };
    });
    const aBook = book(1, "Book A");
    const bBook = book(2, "Book B");

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
      if (url.pathname === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
      if (url.pathname === "/api/shelf") {
        return json(route, {
          items: [{ type: "book", book: aBook }, { type: "book", book: bBook }],
          books: [aBook, bBook],
          folders: [],
        });
      }
      if (/^\/api\/books\/(1|2)$/.test(url.pathname)) {
        const id = Number(url.pathname.split("/").at(-1));
        return json(route, { ...(id === 1 ? aBook : bBook), book_id: id });
      }
      if (/^\/api\/books\/(1|2)\/progress$/.test(url.pathname) && request.method() === "GET") {
        const id = Number(url.pathname.split("/")[3]);
        return json(route, id === 1 ? { book_id: 1, char_offset: 120, percent: 0.8, version: 1 } : null);
      }
      if (url.pathname === "/api/books/1/content") {
        return json(route, { book_id: 1, title: "Book A", content: "A restore target\n\n".repeat(80), length: 1440, encoding: "UTF-8" });
      }
      if (url.pathname === "/api/books/2/content") {
        return json(route, { book_id: 2, title: "Book B", content: "B current content", length: 16, encoding: "UTF-8" });
      }
      if (/^\/api\/books\/(1|2)\/progress$/.test(url.pathname) && ["PUT", "POST"].includes(request.method())) {
        const body = request.postDataJSON() || {};
        const id = Number(url.pathname.split("/")[3]);
        return json(route, { book_id: id, char_offset: body.char_offset || 0, percent: body.percent || 0, version: 1 });
      }
      throw new Error(`Unexpected API request: ${request.method()} ${request.url()}`);
    });

    await page.goto("/");
    await page.evaluate(() => window.__holdReaderFrames(true));
    await page.locator(".book-row", { hasText: "Book A" }).click();
    await expect(page.locator(".reader-content")).toContainText("A restore target");
    await page.evaluate(() => { window.location.hash = "#/reader/2"; });
    await expect(page.locator(".reader-title")).toContainText("Book B");
    await expect(page.locator(".reader-content")).toContainText("B current content");
    await page.evaluate(() => window.__holdReaderFrames(false));
    await expect(page.locator(".reader-title")).toContainText("Book B");
    await expect(page.locator(".reader-content")).not.toContainText("A restore target");
  });
});
