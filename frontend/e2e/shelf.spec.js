import { expect, test } from "@playwright/test";

test("opens a mocked book in the browser", async ({ page }) => {
  const progressWrites = [];

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
    const book = {
      id: 1,
      title: "Fixture Book",
      file_path: "fixture-library/fixture-book.txt",
      file_hash: "fixture-hash",
      size: 2048,
      mtime: 1,
      encoding: "UTF-8",
      folder_tag: null,
      rating: null,
      created_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:00:00.000Z",
      progress: null,
    };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [{ type: "book", book }],
        books: [book],
        folders: [],
      }),
    });
  });

  await page.route("**/api/books/1/content", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        book_id: 1,
        title: "Fixture Book",
        content: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
        length: 52,
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

  const row = page.locator(".book-row", { hasText: "Fixture Book" });
  await expect(row).toBeVisible();
  await row.click();

  await expect(page).toHaveURL(/#\/reader\/1$/);
  await expect(page.locator(".reader-content")).toContainText("First paragraph.");
  await expect(page.locator(".reader-content")).toContainText("Third paragraph.");

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => progressWrites.length).toBeGreaterThan(0);
});
