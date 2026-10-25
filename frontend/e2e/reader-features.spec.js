import { expect, test } from "@playwright/test";

const BOOK = {
  id: 1,
  title: "Reader Features Fixture",
  file_path: "fixture-library/reader-features.txt",
  file_hash: "reader-features-hash",
  format: "txt",
  size: 4096,
  mtime: 1,
  encoding: "UTF-8",
  folder_tag: null,
  rating: null,
  created_at: "2026-10-25T00:00:00.000Z",
  updated_at: "2026-10-25T00:00:00.000Z",
};

const FILLER = (label, count) => Array.from({ length: count }, (_, index) => (
  `${label} ${index + 1}：${"山风穿过长廊，灯火在夜色里摇晃。".repeat((index % 4) + 2)}`
));

const DEFAULT_LINES = [
  "第一章 开端",
  "他推开门，看见老人坐在窗边。",
  "“好。”",
  "老人点了点头，转身走向书架。",
  ...FILLER("前段", 40),
  "第二章 远行",
  "雨停之后，少年背起了行囊。",
  "“好。”",
  "风从山口吹来，带着松针的气味。",
  ...FILLER("后段", 40),
];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function paragraphOffsets(lines) {
  let offset = 0;
  return lines.map((line) => {
    const result = offset;
    offset += line.length + 1;
    return result;
  });
}

async function setupReader(page, { lines = DEFAULT_LINES, books = [BOOK] } = {}) {
  const content = lines.join("\n");
  const bookmarks = [];
  const bookmarkRequests = [];
  let nextBookmarkId = 1;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/config") return json(route, { library_dirs: ["fixture-library"] });
    if (path === "/api/anime/tools") return json(route, { ffmpeg: null, ffprobe: null });
    if (path === "/api/shelf") {
      return json(route, { items: books.map((book) => ({ type: "book", book: { ...book, progress: null } })) });
    }
    if (path === "/api/books/1") return json(route, { ...BOOK, book_id: 1 });
    if (path === "/api/books/1/content") {
      return json(route, { book_id: 1, title: BOOK.title, content, length: content.length, encoding: "UTF-8" });
    }
    if (path === "/api/books/1/progress") {
      if (request.method() === "GET") return json(route, null);
      const body = request.postDataJSON() || {};
      return json(route, { book_id: 1, ...body, version: (body.base_version || 0) + 1, updated_at: "2026-10-25T00:00:01.000Z" });
    }
    if (path === "/api/books/1/bookmarks") {
      bookmarkRequests.push(request.method());
      if (request.method() === "GET") return json(route, bookmarks);
      const body = request.postDataJSON();
      const created = { id: nextBookmarkId++, book_id: 1, created_at: "2026-10-25T08:30:00.000Z", ...body };
      bookmarks.push(created);
      return json(route, created);
    }
    const deleteMatch = path.match(/^\/api\/books\/1\/bookmarks\/(\d+)$/);
    if (deleteMatch && request.method() === "DELETE") {
      bookmarkRequests.push("DELETE");
      const index = bookmarks.findIndex((item) => item.id === Number(deleteMatch[1]));
      if (index < 0) return json(route, { error: "bookmark not found" }, 404);
      bookmarks.splice(index, 1);
      return json(route, { ok: true });
    }
    throw new Error(`Unexpected API request: ${request.method()} ${request.url()}`);
  });

  return { content, offsets: paragraphOffsets(lines), bookmarks, bookmarkRequests };
}

async function openReader(page) {
  await page.goto("/");
  await page.locator(".book-row", { hasText: BOOK.title }).click();
  await expect(page.locator(".reader-content")).toBeVisible();
  await expect(page.locator(".reader-content")).not.toHaveClass(/is-restoring/);
  await expect(page.locator(".reader-content p").first()).toBeVisible();
}

test.describe("reader features", () => {
  test("search results show neighbouring paragraphs, chapters and step through hits", async ({ page }) => {
    const fixture = await setupReader(page);
    await openReader(page);

    await page.getByRole("button", { name: "书内搜索" }).click();
    await page.getByRole("searchbox", { name: "书内关键词" }).fill("好");
    const results = page.locator(".search-result");
    await expect(results).toHaveCount(2);
    await expect(page.locator(".search-count")).toHaveText("1 / 2 处");

    const first = results.nth(0);
    await expect(first.locator(".search-result-chapter")).toHaveText("第一章 开端");
    await expect(first.locator(".search-result-text")).toContainText("看见老人坐在窗边");
    await expect(first.locator(".search-result-text")).toContainText("老人点了点头");
    await expect(first.locator(".search-result-text mark")).toHaveText("好");
    await expect(results.nth(1).locator(".search-result-chapter")).toHaveText("第二章 远行");
    await expect(results.nth(1).locator(".search-result-text")).toContainText("少年背起了行囊");

    await page.getByRole("searchbox", { name: "书内关键词" }).press("Enter");
    await expect(page.locator(".search-panel")).toHaveCount(0);
    const nav = page.getByRole("toolbar", { name: "搜索结果导航" });
    await expect(nav).toContainText("1 / 2");

    await nav.getByRole("button", { name: "下一个搜索结果" }).click();
    await expect(nav).toContainText("2 / 2");
    const secondHit = page.locator(`p[data-offset="${fixture.offsets[DEFAULT_LINES.indexOf("第二章 远行") + 2]}"]`);
    await expect(secondHit.locator("mark.is-active-match")).toBeInViewport();

    await page.keyboard.press("F3");
    await expect(nav).toContainText("1 / 2");

    await nav.getByRole("button", { name: "结束搜索" }).click();
    await expect(nav).toHaveCount(0);
    await expect(page.locator(".reader-content mark")).toHaveCount(0);
  });

  test("switches skins from the shelf and the reader and keeps them after reload", async ({ page }) => {
    await setupReader(page);
    await page.goto("/");
    const shell = page.locator(".app-shell");
    await expect(shell).toHaveClass(/theme-paper/);

    await page.getByRole("button", { name: "切换皮肤" }).click();
    await page.getByRole("radio", { name: "深蓝" }).click();
    await expect(shell).toHaveClass(/theme-midnight/);
    await expect(shell).toHaveClass(/is-dark/);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0f1726");

    await page.locator(".book-row", { hasText: BOOK.title }).click();
    await expect(page.locator(".reader-content")).toBeVisible();
    await page.getByRole("button", { name: "阅读设置" }).click();
    await page.getByRole("radio", { name: "羊皮" }).click();
    await expect(shell).toHaveClass(/theme-sepia/);
    await expect(shell).not.toHaveClass(/is-dark/);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("txt-reader-settings") || "{}").theme)).toBe("sepia");

    await page.reload();
    await expect(page.locator(".reader-content")).toBeVisible();
    await expect(shell).toHaveClass(/theme-sepia/);

    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByRole("button", { name: "阅读设置" }).click();
    await page.getByRole("radio", { name: "跟随系统" }).click();
    await expect(shell).toHaveClass(/theme-night/);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(shell).toHaveClass(/theme-paper/);
  });

  test("typography options change the reading column and reset keeps the skin", async ({ page }) => {
    await setupReader(page);
    await openReader(page);
    const content = page.locator(".reader-content");
    await expect(content).toHaveClass(/has-indent/);
    await expect(content).toHaveClass(/is-justified/);
    await expect(page.locator(".reader-content p.is-chapter-title").first()).toHaveText("第一章 开端");

    await page.getByRole("button", { name: "阅读设置" }).click();
    await page.getByRole("radio", { name: "樱粉" }).click();
    await page.getByRole("radio", { name: "楷体" }).click();
    await page.getByRole("radio", { name: "全宽" }).click();
    await page.locator(".toggle-row", { hasText: "首行缩进" }).click();
    await expect(content).not.toHaveClass(/has-indent/);
    await expect(content).toHaveAttribute("style", /--reader-font-family: "LXGW WenKai"/);
    await expect(content).toHaveAttribute("style", /--reader-width: 100%/);

    await page.getByRole("button", { name: "恢复默认" }).click();
    await expect(content).toHaveClass(/has-indent/);
    await expect(content).toHaveAttribute("style", /--reader-width: 760px/);
    await expect(page.locator(".app-shell")).toHaveClass(/theme-pink/);
  });

  test("adds, opens and deletes bookmarks through the bookmark API", async ({ page }) => {
    const fixture = await setupReader(page);
    await openReader(page);
    expect(fixture.bookmarkRequests).toEqual([]);

    await page.locator(".reader-content").evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
      element.scrollTop = 2400;
    });
    await expect.poll(() => page.locator(".reader-content").evaluate((element) => element.scrollTop)).toBeGreaterThan(2000);
    await expect(page.locator(".reader-content p").first()).not.toBeInViewport();

    await page.getByRole("button", { name: "添加书签" }).click();
    await expect(page.getByRole("status")).toContainText("已添加书签");
    await expect(page.getByRole("button", { name: "删除此处书签" })).toBeVisible();
    expect(fixture.bookmarks).toHaveLength(1);
    expect(fixture.bookmarks[0]).toMatchObject({ chapter_title: "第一章 开端" });
    expect(fixture.bookmarks[0].excerpt.length).toBeGreaterThan(0);
    expect(fixture.offsets).toContain(fixture.bookmarks[0].char_offset);

    await page.locator(".reader-content").evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    });
    await expect(page.locator(".reader-content p").first()).toBeInViewport();

    await page.getByRole("button", { name: /打开目录/ }).click();
    await page.getByRole("tab", { name: /书签/ }).click();
    const item = page.locator(".bookmark-item");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(fixture.bookmarks[0].excerpt.slice(0, 10));
    await item.locator(".bookmark-jump").click();
    await expect(page.locator(".chapter-drawer")).toHaveCount(0);
    await expect(page.locator(`p[data-offset="${fixture.bookmarks[0].char_offset}"]`)).toBeInViewport();

    await page.getByRole("button", { name: /打开目录/ }).click();
    await page.getByRole("tab", { name: /书签/ }).click();
    await page.getByRole("button", { name: "删除书签" }).click();
    await expect(page.locator(".bookmark-item")).toHaveCount(0);
    await expect(page.locator(".chapter-drawer")).toContainText("还没有书签");
    expect(fixture.bookmarks).toHaveLength(0);
    expect(fixture.bookmarkRequests).toEqual(["GET", "POST", "DELETE"]);
  });

  test("pages with the keyboard and with tap zones", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("txt-reader-settings", JSON.stringify({ tapPaging: true }));
    });
    await setupReader(page);
    await openReader(page);
    const content = page.locator(".reader-content");
    const scrollTop = () => content.evaluate((element) => element.scrollTop);

    await page.keyboard.press("PageDown");
    await expect.poll(scrollTop).toBeGreaterThan(300);
    const afterPage = await scrollTop();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(scrollTop).toBeLessThan(afterPage - 300);

    // With controls hidden, the right edge pages forward and the centre toggles controls.
    const box = await content.boundingBox();
    const centre = { x: box.width / 2, y: 400 };
    await content.click({ position: centre });
    await expect(page.locator(".reader-toolbar")).not.toHaveClass(/is-visible/);
    const beforeTap = await scrollTop();
    await content.click({ position: { x: box.width - 30, y: 400 } });
    await expect.poll(scrollTop).toBeGreaterThan(beforeTap + 300);
    await expect(page.locator(".reader-toolbar")).not.toHaveClass(/is-visible/);
    await content.click({ position: centre });
    await expect(page.locator(".reader-toolbar")).toHaveClass(/is-visible/);
  });
});

test("shelf rows keep their measured height on a phone-sized screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const books = Array.from({ length: 6 }, (_, index) => ({
    ...BOOK,
    id: index + 10,
    title: `手机书架 ${index + 1}`,
    rating: (index % 5) + 1,
  }));
  await setupReader(page, { books });
  await page.goto("/");
  await expect(page.locator(".book-row")).toHaveCount(6);
  await page.waitForTimeout(400);
  const overlaps = await page.locator(".book-row").evaluateAll((rows) => {
    const rects = rows.map((row) => row.getBoundingClientRect()).sort((a, b) => a.top - b.top);
    return rects.slice(1).filter((rect, index) => rect.top < rects[index].bottom).length;
  });
  expect(overlaps).toBe(0);
});
