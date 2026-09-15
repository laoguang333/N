import { expect, test } from "@playwright/test";

test("opens a mocked book in the browser", async ({ page }) => {
  const progressWrites = [];
  const book = {
    id: 1,
    title: "Fixture Book",
    file_path: "fixture-library/fixture-book.txt",
    file_hash: "fixture-hash",
    format: "txt",
    size: 2048,
    mtime: 1,
    encoding: "UTF-8",
    folder_tag: null,
    rating: null,
    created_at: "2026-04-30T00:00:00.000Z",
    updated_at: "2026-04-30T00:00:00.000Z",
    progress: {
      book_id: 1,
      char_offset: 420,
      percent: 0.42,
      version: 1,
      updated_at: "2026-04-30T00:00:01.000Z",
    },
  };

  await page.route("**/api/config", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        library_dirs: ["fixture-library"],
        scan_recursive: false,
        scan_on_startup: false,
      }),
    });
  });

  await page.route("**/api/shelf", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [{ type: "book", book }],
        books: [book],
        folders: [],
      }),
    });
  });

  await page.route("**/api/books/1", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(book),
    });
  });

  const content = [
    "第一章 开始",
    ...Array.from({ length: 500 }, (_, index) => (
      index === 99
        ? "第二章 中段"
        : `${index + 1}. ${"Variable length paragraph ".repeat((index % 9) + 1)}`
    )),
  ].join("\n\n");

  await page.route("**/api/books/1/content", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        book_id: 1,
        title: "Fixture Book",
        content,
        length: content.length,
        encoding: "UTF-8",
      }),
    });
  });

  await page.route("**/api/books/1/progress", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: "null",
      });
      return;
    }

    const body = route.request().postDataJSON();
    progressWrites.push(body);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        book_id: 1,
        char_offset: body.char_offset,
        percent: body.percent,
        version: 1,
        updated_at: "2026-04-30T00:00:01.000Z",
      }),
    });
  });

  await page.goto("/");

  await expect(page.getByRole("button", { name: /继续阅读.*Fixture Book/ })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" })).toContainText("小说");
  await expect(page.getByRole("navigation", { name: "主导航" })).toContainText("视频");

  const row = page.locator(".book-row", { hasText: "Fixture Book" });
  await expect(row).toBeVisible();
  await row.click();

  await expect(page).toHaveURL(/#\/reader\/1$/);
  await expect(page.locator(".reader-content")).toContainText("1. Variable length paragraph");

  await expect(page.getByRole("button", { name: "开始自动滚屏" })).toBeVisible();
  await page.getByRole("button", { name: "打开目录，共 2 章" }).click();
  await expect(page.getByRole("navigation", { name: "章节目录" })).toContainText("第一章 开始");
  await expect(page.getByRole("navigation", { name: "章节目录" })).toContainText("第二章 中段");
  await page.getByRole("button", { name: "关闭目录" }).click();

  await page.locator(".reader-content").evaluate((element) => {
    element.scrollTop = element.scrollHeight * 0.5;
  });
  await expect.poll(() => progressWrites.length).toBeGreaterThan(0);

  const slider = page.getByRole("slider", { name: /阅读进度/ });
  const sliderBox = await slider.boundingBox();
  expect(sliderBox).not.toBeNull();
  await page.mouse.move(sliderBox.x + sliderBox.width * 0.5, sliderBox.y + sliderBox.height / 2);
  await page.mouse.down();
  const positions = [];
  for (const percent of [0.65, 0.75, 0.85]) {
    await page.mouse.move(
      sliderBox.x + sliderBox.width * percent,
      sliderBox.y + sliderBox.height / 2,
      { steps: 4 },
    );
    await page.waitForTimeout(50);
    positions.push(await page.locator(".reader-content").evaluate((element) => element.scrollTop));
  }
  await page.mouse.up();

  expect(positions[1]).toBeGreaterThan(positions[0]);
  expect(positions[2]).toBeGreaterThan(positions[1]);
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(830);
  expect(Number(await slider.inputValue())).toBeLessThan(880);
  await expect.poll(() => progressWrites.at(-1)?.percent || 0).toBeGreaterThan(0.75);
});
