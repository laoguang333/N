import { expect, test } from "@playwright/test";

const BOOK = {
  id: 202,
  title: "Search Virtualization Fixture",
  file_path: "fixture-library/search-virtualization.txt",
  file_hash: "search-virtualization-hash",
  format: "txt",
  size: 512000,
  mtime: 1,
  encoding: "UTF-8",
  folder_tag: null,
  rating: null,
  created_at: "2026-09-19T00:00:00.000Z",
  updated_at: "2026-09-19T00:00:00.000Z",
};

function json(route, body) {
  return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
}

test("virtualizes a large search result list while keeping deep results clickable", async ({ page }) => {
  const lines = Array.from({ length: 20_000 }, (_, index) => `段落 ${index} NEEDLE 搜索内容`);
  const content = lines.join("\n\n");

  await page.route("**/api/config", (route) => json(route, {
    library_dirs: ["fixture-library"],
    scan_recursive: false,
    scan_on_startup: false,
  }));
  await page.route("**/api/anime/tools", (route) => json(route, { ffmpeg: null, ffprobe: null }));
  await page.route("**/api/shelf**", (route) => json(route, {
    items: [{ type: "book", book: { ...BOOK, progress: null } }],
    books: [{ ...BOOK, progress: null }],
    folders: [],
  }));
  await page.route("**/api/books/202", (route) => json(route, { ...BOOK, book_id: BOOK.id }));
  await page.route("**/api/books/202/content", (route) => json(route, {
    book_id: BOOK.id,
    title: BOOK.title,
    content,
    length: content.length,
    encoding: "UTF-8",
  }));
  await page.route("**/api/books/202/progress", (route) => json(route, null));

  await page.goto("/");
  await page.locator(".book-row", { hasText: BOOK.title }).click();
  await expect(page.locator(".reader-content")).toBeVisible();
  await expect(page.locator(".reader-content")).not.toHaveClass(/is-restoring/);
  await page.getByRole("button", { name: "书内搜索" }).click();

  await page.getByRole("searchbox", { name: "书内关键词" }).fill("NEEDLE");
  const resultList = page.locator(".search-result-list");
  await expect(resultList).toBeVisible();
  await expect(resultList).toHaveAttribute("data-result-count", "20000");
  await expect.poll(() => page.locator(".search-result").count()).toBeLessThan(100);
  await expect(page.locator(".search-result").first()).toContainText("NEEDLE");

  await resultList.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(() => resultList.locator(".search-result").evaluateAll((items) => (
    Math.max(...items.map((item) => Number(item.dataset.index)))
  ))).toBeGreaterThan(19_000);

  const deepResult = resultList.locator(".search-result").last();
  await expect(deepResult).toBeVisible();
  const deepIndex = await deepResult.getAttribute("data-index");
  expect(Number(deepIndex)).toBeGreaterThan(19_000);
  await deepResult.click();
  await expect(page.locator(".search-panel")).toHaveCount(0);
  await expect(page.locator("p.is-match-target")).toContainText(`段落 ${deepIndex} NEEDLE`);
});
