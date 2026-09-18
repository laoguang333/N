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
    size: 1024,
    mtime: 1,
    encoding: "UTF-8",
    folder_tag: null,
    rating: null,
    created_at: "2026-04-30T00:00:00.000Z",
    updated_at: "2026-04-30T00:00:00.000Z",
    progress: null,
  };
}

test.describe("shelf and folder request races", () => {
  test("a slow shelf query cannot overwrite a newer query after the debounce", async ({ page }) => {
    const slowA = deferred();
    let aStarted = false;
    const aBook = book(1, "A result");
    const bBook = book(2, "B result");

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
      if (url.pathname === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
      if (url.pathname === "/api/shelf") {
        const search = url.searchParams.get("search") || "";
        if (search === "A") {
          aStarted = true;
          await slowA.promise;
          return json(route, { items: [{ type: "book", book: aBook }], books: [aBook], folders: [] });
        }
        if (search === "B") {
          return json(route, { items: [{ type: "book", book: bBook }], books: [bBook], folders: [] });
        }
        return json(route, { items: [], books: [], folders: [] });
      }
      throw new Error(`Unexpected API request: ${request.method()} ${request.url()}`);
    });

    await page.goto("/");
    const search = page.getByRole("searchbox", { name: "搜索小说" });
    await search.fill("A");
    await expect.poll(() => aStarted).toBe(true);
    await search.fill("B");
    await expect(page.locator(".book-row", { hasText: "B result" })).toBeVisible();

    slowA.resolve();
    await expect(page.locator(".book-row", { hasText: "B result" })).toBeVisible();
    await expect(page.locator(".book-row", { hasText: "A result" })).toHaveCount(0);
  });

  test("an old shelf response during the next debounce cannot become visible", async ({ page }) => {
    const releaseA = deferred();
    let aStarted = false;
    let bStarted = false;
    const aBook = book(1, "A result");
    const bBook = book(2, "B result");

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
      if (url.pathname === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
      if (url.pathname === "/api/shelf") {
        const search = url.searchParams.get("search") || "";
        if (search === "A") {
          aStarted = true;
          await releaseA.promise;
          return json(route, { items: [{ type: "book", book: aBook }], books: [aBook], folders: [] });
        }
        if (search === "B") {
          bStarted = true;
          return json(route, { items: [{ type: "book", book: bBook }], books: [bBook], folders: [] });
        }
        return json(route, { items: [], books: [], folders: [] });
      }
      throw new Error(`Unexpected API request: ${request.method()} ${request.url()}`);
    });

    await page.goto("/");
    const search = page.getByRole("searchbox", { name: "搜索小说" });
    await search.fill("A");
    await expect.poll(() => aStarted).toBe(true);
    await search.fill("B");
    expect(bStarted).toBe(false);
    releaseA.resolve();
    await expect(page.locator(".book-row", { hasText: "A result" })).toHaveCount(0);
    await expect(page.locator(".book-row", { hasText: "B result" })).toBeVisible();
  });

  test("a stale shelf query error cannot replace a newer successful result", async ({ page }) => {
    const slowA = deferred();
    let aStarted = false;
    const bBook = book(2, "B result");

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
      if (url.pathname === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
      if (url.pathname === "/api/shelf") {
        const search = url.searchParams.get("search") || "";
        if (search === "A") {
          aStarted = true;
          await slowA.promise;
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "A query failed" }) });
        }
        if (search === "B") return json(route, { items: [{ type: "book", book: bBook }], books: [bBook], folders: [] });
        return json(route, { items: [], books: [], folders: [] });
      }
      throw new Error(`Unexpected API request: ${request.method()} ${request.url()}`);
    });

    await page.goto("/");
    const search = page.getByRole("searchbox", { name: "搜索小说" });
    await search.fill("A");
    await expect.poll(() => aStarted).toBe(true);
    await search.fill("B");
    await expect(page.locator(".book-row", { hasText: "B result" })).toBeVisible();
    slowA.resolve();
    await expect(page.locator(".book-row", { hasText: "B result" })).toBeVisible();
    await expect(page.getByText("A query failed")).toHaveCount(0);
  });

  test("a stale shelf rating error cannot replace a newer query", async ({ page }) => {
    const slowRating = deferred();
    let ratingStarted = false;
    const aBook = book(1, "A result");
    const bBook = book(2, "B result");

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
      if (url.pathname === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
      if (url.pathname === "/api/shelf") {
        const search = url.searchParams.get("search") || "";
        if (search === "B") return json(route, { items: [{ type: "book", book: bBook }], books: [bBook], folders: [] });
        return json(route, { items: [{ type: "book", book: aBook }], books: [aBook], folders: [] });
      }
      if (url.pathname === "/api/books/1/rating") {
        ratingStarted = true;
        await slowRating.promise;
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "A rating failed" }) });
      }
      throw new Error(`Unexpected API request: ${request.method()} ${request.url()}`);
    });

    await page.goto("/");
    await page.locator(".book-row", { hasText: "A result" }).locator(".star-button").first().click();
    await expect.poll(() => ratingStarted).toBe(true);
    await page.getByRole("searchbox", { name: "搜索小说" }).fill("B");
    await expect(page.locator(".book-row", { hasText: "B result" })).toBeVisible();
    slowRating.resolve();
    await expect(page.getByText("A rating failed")).toHaveCount(0);
  });

  test("a closed folder stays closed when its delayed response arrives", async ({ page }) => {
    const slowX = deferred();
    let xStarted = false;
    const yBook = book(3, "Y result");

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
      if (url.pathname === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
      if (url.pathname === "/api/shelf") {
        return json(route, {
          items: [
            { type: "folder", folder: { name: "X", book_count: 1 } },
            { type: "folder", folder: { name: "Y", book_count: 1 } },
          ],
          books: [],
          folders: [{ name: "X", book_count: 1 }, { name: "Y", book_count: 1 }],
        });
      }
      if (url.pathname === "/api/books" && url.searchParams.get("folder_tag") === "X") {
        xStarted = true;
        await slowX.promise;
        return json(route, []);
      }
      if (url.pathname === "/api/books" && url.searchParams.get("folder_tag") === "Y") {
        return json(route, [yBook]);
      }
      throw new Error(`Unexpected API request: ${request.method()} ${request.url()}`);
    });

    await page.goto("/");
    await page.locator(".folder-row", { hasText: "X" }).click();
    await expect.poll(() => xStarted).toBe(true);
    await page.getByRole("button", { name: "关闭文件夹" }).click();
    await expect(page.locator(".folder-overlay")).toHaveCount(0);

    await page.locator(".folder-row", { hasText: "Y" }).click();
    await expect(page.locator(".folder-book-title", { hasText: "Y result" })).toBeVisible();
    slowX.resolve();
    await expect(page.locator(".folder-book-title", { hasText: "Y result" })).toBeVisible();
  });

  test("a stale folder rating error cannot replace a newer folder", async ({ page }) => {
    const slowRating = deferred();
    let ratingStarted = false;
    const xBook = book(10, "X result");
    const yBook = book(11, "Y result");

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
      if (url.pathname === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
      if (url.pathname === "/api/shelf") {
        return json(route, {
          items: [{ type: "folder", folder: { name: "X", book_count: 1 } }, { type: "folder", folder: { name: "Y", book_count: 1 } }],
          books: [],
          folders: [{ name: "X", book_count: 1 }, { name: "Y", book_count: 1 }],
        });
      }
      if (url.pathname === "/api/books" && url.searchParams.get("folder_tag") === "X") return json(route, [xBook]);
      if (url.pathname === "/api/books" && url.searchParams.get("folder_tag") === "Y") return json(route, [yBook]);
      if (url.pathname === "/api/books/10/rating") {
        ratingStarted = true;
        await slowRating.promise;
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "X rating failed" }) });
      }
      throw new Error(`Unexpected API request: ${request.method()} ${request.url()}`);
    });

    await page.goto("/");
    await page.locator(".folder-row", { hasText: "X" }).click();
    await expect(page.locator(".folder-book-title", { hasText: "X result" })).toBeVisible();
    await page.locator(".folder-star-button").first().click();
    await expect.poll(() => ratingStarted).toBe(true);
    await page.getByRole("button", { name: "关闭文件夹" }).click();
    await page.locator(".folder-row", { hasText: "Y" }).click();
    await expect(page.locator(".folder-book-title", { hasText: "Y result" })).toBeVisible();
    slowRating.resolve();
    await expect(page.getByText("X rating failed")).toHaveCount(0);
  });
});
