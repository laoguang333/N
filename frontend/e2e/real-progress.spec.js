import { expect, test, request as playwrightRequest } from "@playwright/test";

const BASE_URL = "https://127.0.0.1:234";

test("real browser scroll saves and restores the current reading position", async ({ page }) => {
  const api = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
  let originalProgress = null;
  try {
    originalProgress = await readProgress(api);

    await page.goto(BASE_URL, { waitUntil: "networkidle" });

    const row = page.locator(".book-row", { hasText: "l" });
    await expect(row).toBeVisible();
    await row.click();

    await expect(page).toHaveURL(/#\/reader\/1$/);
    await expect(page.locator(".reader-content")).toContainText("l");

    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight * 0.6));
    const saved = await waitForProgressWrite(page);
    await expect(saved.percent).toBeGreaterThan(0.2);
    await expect(saved.char_offset).toBeGreaterThan(0);

    const beforeReload = await page.evaluate(() => ({
      scrollY: window.scrollY,
      maxScroll: document.scrollingElement.scrollHeight - window.innerHeight,
    }));

    await page.reload({ waitUntil: "networkidle" });
    await expect(page).toHaveURL(/#\/reader\/1$/);
    await expect(page.locator(".reader-content")).toContainText("l");

    const afterReload = await page.evaluate(() => ({
      scrollY: window.scrollY,
      maxScroll: document.scrollingElement.scrollHeight - window.innerHeight,
    }));
    expect(afterReload.scrollY).toBeGreaterThan(0);
    expect(Math.abs(afterReload.scrollY - beforeReload.scrollY)).toBeLessThanOrEqual(600);
    if (originalProgress) {
      await writeProgress(api, {
        char_offset: originalProgress.char_offset,
        percent: originalProgress.percent,
        base_version: originalProgress.version,
        source: "restore_after_e2e",
        client_id: "real-progress-e2e",
        session_id: "real-progress-e2e",
        allow_backward: true,
      });
    }
  } finally {
    await api.dispose();
  }
});

async function waitForProgressWrite(page) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await page.waitForResponse(
      (res) => res.url().includes("/api/books/1/progress") && ["PUT", "POST"].includes(res.request().method()),
      { timeout: 2_000 },
    ).catch(() => null);
    if (!response) {
      continue;
    }
    const body = await response.json();
    if (body?.percent > 0) {
      return body;
    }
  }

  throw new Error("timed out waiting for a scroll progress save");
}

async function readProgress(api) {
  const response = await api.get(`${BASE_URL}/api/books/1/progress`);
  return response.json();
}

async function writeProgress(api, body) {
  const response = await api.put(`${BASE_URL}/api/books/1/progress`, {
    data: body,
  });
  return response.json();
}
