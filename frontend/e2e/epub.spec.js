import { expect, test } from "@playwright/test";
import JSZip from "jszip";

async function createEpubFixture() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">epub-scroll-fixture</dc:identifier>
    <dc:title>EPUB Scroll Fixture</dc:title>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-2" href="chapter-2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter-1"/>
    <itemref idref="chapter-2"/>
  </spine>
</package>`);
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>目录</title></head>
  <body><nav epub:type="toc"><ol>
    <li><a href="chapter-1.xhtml">第一章</a></li>
    <li><a href="chapter-2.xhtml">第二章</a></li>
  </ol></nav></body>
</html>`);

  const paragraphs = Array.from(
    { length: 120 },
    (_, index) => `<p>${index + 1}. 这是用于验证 EPUB 连续滚动和自动阅读的段落。</p>`,
  ).join("");
  for (const chapter of [1, 2]) {
    zip.file(`OEBPS/chapter-${chapter}.xhtml`, `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>第${chapter}章</title></head>
  <body><h1>第${chapter}章</h1>${paragraphs}</body>
</html>`);
  }

  return zip.generateAsync({ type: "nodebuffer", mimeType: "application/epub+zip" });
}

test("reads EPUB as continuous vertical content with auto scroll", async ({ page }) => {
  const epub = await createEpubFixture();
  const progressWrites = [];
  const book = {
    id: 7,
    title: "EPUB Scroll Fixture",
    file_path: "fixture-library/epub-scroll-fixture.epub",
    file_hash: "epub-fixture-hash",
    format: "epub",
    size: epub.length,
    mtime: 1,
    encoding: "EPUB",
    folder_tag: null,
    rating: null,
    created_at: "2026-08-06T00:00:00.000Z",
    updated_at: "2026-08-06T00:00:00.000Z",
    progress: null,
  };

  await page.route("**/api/config", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ library_dirs: ["fixture-library"], scan_recursive: false, scan_on_startup: false }),
  }));
  await page.route("**/api/shelf", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ items: [{ type: "book", book }], books: [book], folders: [] }),
  }));
  await page.route("**/api/books/7", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(book),
  }));
  await page.route("**/api/books/7/file", (route) => route.fulfill({
    contentType: "application/epub+zip",
    body: epub,
  }));
  await page.route("**/api/books/7/progress", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", body: "null" });
      return;
    }
    const payload = route.request().postDataJSON();
    progressWrites.push(payload);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ book_id: 7, ...payload, version: 1, updated_at: "2026-08-06T00:00:01.000Z" }),
    });
  });

  await page.goto("/");
  await page.locator(".book-row", { hasText: book.title }).click();

  const scroller = page.locator(".epub-stage .epub-container");
  await expect(scroller).toBeVisible();
  await expect.poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(page.getByTitle("上一页")).toHaveCount(0);
  await expect(page.getByTitle("下一页")).toHaveCount(0);

  const playButton = page.getByRole("button", { name: "开始自动滚屏" });
  await expect(playButton).toBeVisible();
  const startTop = await scroller.evaluate((element) => element.scrollTop);
  await playButton.click();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(startTop + 2);

  await scroller.hover();
  await page.mouse.wheel(0, 180);
  await expect(page.getByRole("button", { name: "开始自动滚屏" })).toBeVisible();
  await expect.poll(() => progressWrites.length).toBeGreaterThan(0);
  expect(progressWrites.at(-1).locator).toContain("epubcfi(");
});
