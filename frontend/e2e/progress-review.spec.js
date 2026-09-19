import { expect, test } from "@playwright/test";

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function json(route, body) {
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

const BOOK = {
  id: 501,
  title: "Progress timing fixture",
  file_path: "fixture-library/progress-timing.txt",
  file_hash: "progress-timing-hash",
  format: "txt",
  size: 2048,
  mtime: 1,
  encoding: "UTF-8",
  folder_tag: null,
  rating: null,
  created_at: "2026-09-19T00:00:00.000Z",
  updated_at: "2026-09-19T00:00:00.000Z",
};

function makeFixture() {
  const lines = [
    "第一章 进度时序",
    ...Array.from({ length: 50 }, (_, index) => `段落 ${index} ${"用于恢复时序回归的正文。".repeat((index % 4) + 1)}`),
  ];
  let offset = 0;
  const offsets = lines.map((line) => {
    const result = offset;
    offset += line.length + 2;
    return result;
  });
  return { lines, offsets, content: lines.join("\n\n") };
}

async function runProgressTimingScenario(page, timing, { interact = false } = {}) {
  const fixture = makeFixture();
  const targetIndex = 32;
  const remoteProgress = {
    book_id: BOOK.id,
    char_offset: fixture.offsets[targetIndex],
    percent: fixture.offsets[targetIndex] / fixture.content.length,
    version: 7,
    position_kind: "paragraph_utf16_lf_v1",
    paragraph_fraction: 0,
    updated_at: "2026-09-19T00:00:00.000Z",
  };
  const progressGate = deferred();
  const progressFinished = deferred();
  const summaryReturned = deferred();
  const writes = [];
  let progressStarted = false;

  await page.addInitScript(() => { navigator.sendBeacon = () => false; });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
    if (url.pathname === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
    if (url.pathname === "/api/shelf") return json(route, {
      items: [{ type: "book", book: BOOK }],
      books: [BOOK],
      folders: [],
    });
    if (url.pathname === `/api/books/${BOOK.id}`) {
      if (timing === "between") summaryReturned.resolve();
      return json(route, { ...BOOK, book_id: BOOK.id });
    }
    if (url.pathname === `/api/books/${BOOK.id}/content`) {
      if (timing === "between") {
        await progressFinished.promise;
      }
      return json(route, {
        book_id: BOOK.id,
        title: BOOK.title,
        content: fixture.content,
        length: fixture.content.length,
        encoding: "UTF-8",
      });
    }
    if (url.pathname === `/api/books/${BOOK.id}/progress` && request.method() === "GET") {
      progressStarted = true;
      if (timing === "before") {
        await json(route, remoteProgress);
        progressFinished.resolve();
        return;
      }
      if (timing === "between") {
        await summaryReturned.promise;
        await json(route, remoteProgress);
        progressFinished.resolve();
        return;
      }
      await progressGate.promise;
      await json(route, remoteProgress);
      progressFinished.resolve();
      return;
    }
    if (url.pathname === `/api/books/${BOOK.id}/progress`) {
      writes.push(request.postDataJSON() || {});
      return json(route, { ...remoteProgress, ...writes.at(-1) });
    }
    throw new Error(`Unexpected API request: ${request.method()} ${request.url()}`);
  });

  await page.goto("/");
  await page.locator(".book-row", { hasText: BOOK.title }).click();
  await expect(page.locator(".reader-content")).toBeVisible();
  await expect(page.locator(".reader-content p").first()).toBeVisible();

  if (timing === "after") {
    await expect.poll(() => progressStarted).toBe(true);
    let userScrollTop = null;
    if (interact) {
      await page.locator(".reader-content").hover();
      await page.mouse.wheel(0, 900);
      userScrollTop = await page.locator(".reader-content").evaluate((element) => element.scrollTop);
    }
    progressGate.resolve();
    if (interact) {
      await page.waitForTimeout(300);
      const finalScrollTop = await page.locator(".reader-content").evaluate((element) => element.scrollTop);
      expect(Math.abs(finalScrollTop - userScrollTop)).toBeLessThan(30);
      return;
    }
  }

  const target = page.locator(`p[data-offset="${fixture.offsets[targetIndex]}"]`);
  await expect(target).toBeInViewport();
  await page.waitForTimeout(700);
  expect(writes).toHaveLength(0);
}

test.describe("late progress restoration", () => {
  test("restores when progress arrives before the book summary", async ({ page }) => {
    await runProgressTimingScenario(page, "before");
  });

  test("restores when progress arrives between summary and content", async ({ page }) => {
    await runProgressTimingScenario(page, "between");
  });

  test("restores when progress arrives after content is already visible", async ({ page }) => {
    await runProgressTimingScenario(page, "after");
  });

  test("does not replace a position chosen before late progress arrives", async ({ page }) => {
    await runProgressTimingScenario(page, "after", { interact: true });
  });
});

test("uses successful server progress instead of an older clean shelf cache", async ({ page }) => {
  const book = {
    ...BOOK,
    id: 502,
    title: "Shelf cache precedence fixture",
    progress: {
      book_id: 502,
      char_offset: 800,
      percent: 0.8,
      version: 4,
      updated_at: "2026-09-19T00:00:00.000Z",
    },
  };
  await page.addInitScript(() => {
    localStorage.setItem("txt-reader-progress-v2:502", JSON.stringify({
      confirmed: {
        book_id: 502,
        char_offset: 200,
        percent: 0.2,
        version: 3,
        updated_at: "2026-09-18T00:00:00.000Z",
      },
      submitted: null,
      pending: null,
      conflict: null,
    }));
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
    if (url.pathname === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
    if (url.pathname === "/api/shelf") return json(route, {
      items: [{ type: "book", book }],
      books: [book],
      folders: [],
    });
    throw new Error(`Unexpected API request: ${route.request().method()} ${route.request().url()}`);
  });

  await page.goto("/");
  const row = page.locator(".book-row", { hasText: book.title });
  await expect(row).toBeVisible();
  await expect(row.locator(".book-progress")).toHaveText("80%");
  await expect(page.getByRole("button", { name: /继续阅读.*Shelf cache precedence fixture/ })).toContainText("80%");
});

test("refreshes the current shelf query when returning from a reader", async ({ page }) => {
  const book = { ...BOOK, id: 503, title: "Shelf refresh fixture" };
  const shelfProgress = {
    book_id: 503,
    char_offset: 900,
    percent: 0.9,
    version: 2,
    updated_at: "2026-09-19T00:00:00.000Z",
  };
  const initialProgress = {
    ...shelfProgress,
    char_offset: 0,
    percent: 0,
    position_kind: "paragraph_utf16_lf_v1",
    paragraph_fraction: 0,
  };
  let shelfCalls = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
    if (url.pathname === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
    if (url.pathname === "/api/shelf") {
      shelfCalls += 1;
      return json(route, {
        items: [{ type: "book", book: { ...book, progress: shelfCalls === 1 ? initialProgress : shelfProgress } }],
        books: [{ ...book, progress: shelfCalls === 1 ? initialProgress : shelfProgress }],
        folders: [],
      });
    }
    if (url.pathname === `/api/books/${book.id}`) return json(route, { ...book, book_id: book.id });
    if (url.pathname === `/api/books/${book.id}/content`) return json(route, {
      book_id: book.id,
      title: book.title,
      content: "可返回书架的正文",
      length: 9,
      encoding: "UTF-8",
    });
    if (url.pathname === `/api/books/${book.id}/progress` && request.method() === "GET") return json(route, initialProgress);
    if (url.pathname === `/api/books/${book.id}/progress`) return json(route, shelfProgress);
    throw new Error(`Unexpected API request: ${request.method()} ${request.url()}`);
  });

  await page.goto("/");
  await page.locator(".book-row", { hasText: book.title }).click();
  await expect(page.locator(".reader-content")).toContainText("可返回书架的正文");
  await page.getByRole("button", { name: "返回书架" }).click();
  await expect(page.locator(".shelf-view")).toBeVisible();
  await expect.poll(() => shelfCalls).toBeGreaterThan(1);
  await expect(page.locator(".book-row", { hasText: book.title }).locator(".book-progress")).toHaveText("90%");
});
