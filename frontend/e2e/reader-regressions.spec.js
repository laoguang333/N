import { expect, test } from "@playwright/test";

const BOOK = {
  id: 1,
  title: "Reader Regression Fixture",
  file_path: "fixture-library/reader-regressions.txt",
  file_hash: "reader-regressions-hash",
  format: "txt",
  size: 4096,
  mtime: 1,
  encoding: "UTF-8",
  folder_tag: null,
  rating: null,
  created_at: "2026-04-30T00:00:00.000Z",
  updated_at: "2026-04-30T00:00:00.000Z",
};

function json(route, body) {
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function progressFor(charOffset, percent = 0) {
  return {
    book_id: 1,
    char_offset: charOffset,
    percent,
    version: 1,
    updated_at: "2026-04-30T00:00:01.000Z",
  };
}

function paragraphOffsets(lines) {
  let offset = 0;
  return lines.map((line) => {
    const result = offset;
    offset += line.length + 2;
    return result;
  });
}

async function setupReader(page, { lines, initialProgress = null } = {}) {
  const contentLines = lines || [
    "第一章 回归测试",
    ...Array.from({ length: 80 }, (_, index) => `${index + 1}. ${"用于滚动恢复的正文。".repeat((index % 8) + 2)}`),
  ];
  const content = contentLines.join("\n\n");
  const offsets = paragraphOffsets(contentLines);
  let storedProgress = initialProgress;
  const progressWrites = [];

  await page.route("**/api/config", (route) => json(route, {
    library_dirs: ["fixture-library"],
    scan_recursive: false,
    scan_on_startup: false,
  }));
  await page.route("**/api/anime/tools", (route) => json(route, { ffmpeg: null, ffprobe: null }));
  await page.route("**/api/shelf**", (route) => json(route, {
    items: [{ type: "book", book: { ...BOOK, progress: storedProgress } }],
    books: [{ ...BOOK, progress: storedProgress }],
    folders: [],
  }));
  await page.route("**/api/books/1", (route) => json(route, { ...BOOK, book_id: 1 }));
  await page.route("**/api/books/1/content", (route) => json(route, {
    book_id: 1,
    title: BOOK.title,
    content,
    length: content.length,
    encoding: "UTF-8",
  }));
  await page.route("**/api/books/1/progress", async (route) => {
    if (route.request().method() === "GET") {
      await json(route, storedProgress);
      return;
    }
    const body = route.request().postDataJSON() || {};
    storedProgress = progressFor(body.char_offset, body.percent);
    storedProgress.version = body.version || storedProgress.version;
    progressWrites.push(storedProgress);
    await json(route, storedProgress);
  });

  await page.goto("/");
  await page.locator(".book-row", { hasText: BOOK.title }).click();
  await expect(page).toHaveURL(/#\/reader\/1$/);
  await expect(page.locator(".reader-content")).toBeVisible();
  await expect.poll(() => page.locator(".reader-content p").count()).toBeGreaterThan(0);

  return { content, contentLines, offsets, progressWrites, getStoredProgress: () => storedProgress };
}

test.describe("reader regressions", () => {
  test("shows search context and scrolls to the exact long paragraph hit", async ({ page }) => {
    const before = "搜索结果前的文字。".repeat(200);
    const after = "搜索结果后的文字。".repeat(200);
    const lines = ["第一章 搜索", before + "SEARCH_NEEDLE" + after, ...Array.from({ length: 30 }, (_, index) => `填充段落 ${index}`)];
    const fixture = await setupReader(page, { lines });

    await page.getByRole("button", { name: "书内搜索" }).click();
    const input = page.getByRole("searchbox", { name: "书内关键词" });
    await input.fill("SEARCH_NEEDLE");
    const result = page.locator(".search-result").first();
    await expect(result).toBeVisible();
    await expect(result.locator(".search-result-text")).toContainText("SEARCH_NEEDLE");
    await expect(result.locator(".search-result-text")).toContainText("搜索结果前的文字");
    await expect(result.locator(".search-result-text")).toContainText("搜索结果后的文字");

    await result.click();
    const target = page.locator(`p[data-offset="${fixture.offsets[1]}"]`);
    await expect(target).toBeVisible();
    await expect(target.locator("mark.is-active-match")).toBeInViewport();
    await expect(target.locator("mark.is-active-match")).toContainText("SEARCH_NEEDLE");
  });

  test("toggles controls on a tap but keeps them visible after text selection", async ({ page }) => {
    await setupReader(page, { lines: ["可以选择的正文。".repeat(12), ...Array.from({ length: 10 }, (_, index) => `后续段落 ${index}`)] });
    const toolbar = page.locator(".reader-toolbar");
    const content = page.locator(".reader-content");
    await expect(toolbar).toHaveClass(/is-visible/);

    await content.click({ position: { x: 120, y: 200 } });
    await expect(toolbar).not.toHaveClass(/is-visible/);
    await content.click({ position: { x: 120, y: 200 } });
    await expect(toolbar).toHaveClass(/is-visible/);

    const paragraph = content.locator("p").first();
    const box = await paragraph.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.max(80, box.width - 4), box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().length || 0)).toBeGreaterThan(0);
    await expect(toolbar).toHaveClass(/is-visible/);
  });

  test("hides the auto reader controls after playback and persists its speed", async ({ page }) => {
    await setupReader(page);
    const speed = page.getByRole("slider", { name: "自动滚动速度" });
    await speed.fill("7");
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("txt-reader-settings") || "{}").autoScrollSpeed)).toBe(7);

    await page.getByRole("button", { name: "开始自动滚屏" }).click();
    await page.locator(".reader-content").click({ position: { x: 120, y: 200 } });
    await expect(page.locator(".auto-scroll-fab")).not.toHaveClass(/visible/);
    await expect(page.locator(".reader-toolbar")).not.toHaveClass(/is-visible/);

    await page.reload();
    await expect(page.locator(".reader-content")).toBeVisible();
    await expect(page.getByRole("slider", { name: "自动滚动速度" })).toHaveValue("7");
  });

  test("restores saved character offset and keeps it after a font size change", async ({ page }) => {
    const lines = [
      "开头短段落",
      "第二段也很短",
      ...Array.from({ length: 40 }, (_, index) => `前置内容 ${index} ${"扩展文本。".repeat((index % 6) + 1)}`),
      `RESTORE_TARGET ${"长正文。".repeat(35)}`,
      ...Array.from({ length: 40 }, (_, index) => `后续内容 ${index} ${"扩展文本。".repeat((index % 6) + 1)}`),
    ];
    const targetOffset = paragraphOffsets(lines)[42];
    const fixture = await setupReader(page, {
      lines,
      // Deliberately make percent point elsewhere; opening must use char_offset.
      initialProgress: progressFor(targetOffset + 12, 0.01),
    });
    const target = page.locator(`p[data-offset="${fixture.offsets[42]}"]`);
    await expect(target).toBeVisible();
    await expect(target).toBeInViewport();

    await page.getByRole("button", { name: "阅读设置" }).click();
    const fontSize = page.locator(".settings-panel input[type=range]").first();
    await fontSize.fill("30");
    await expect(target).toBeInViewport();
    await expect(target).toContainText("RESTORE_TARGET");
  });

  test("saves the paragraph reached by scrolling and restores it after reload", async ({ page }) => {
    const lines = [
      "滚动恢复起点",
      ...Array.from({ length: 100 }, (_, index) => `滚动段落 ${index} ${"用于实际滚动保存的内容。".repeat((index % 7) + 1)}`),
    ];
    const fixture = await setupReader(page, { lines });
    const content = page.locator(".reader-content");
    await content.hover();
    for (let index = 0; index < 6; index += 1) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(40);
    }
    await expect.poll(() => fixture.progressWrites.some((item) => item.char_offset > 0)).toBeTruthy();
    await page.waitForTimeout(200);
    const savedOffset = fixture.progressWrites.filter((item) => item.char_offset > 0).at(-1).char_offset;
    const savedParagraphOffset = fixture.offsets.reduce(
      (current, offset) => (offset <= savedOffset ? offset : current),
      fixture.offsets[0],
    );

    await page.reload();
    await expect(page.locator(".reader-content")).toBeVisible();
    await expect(page.locator(`p[data-offset="${savedParagraphOffset}"]`)).toBeInViewport();
  });
});
