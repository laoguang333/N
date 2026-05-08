---
name: playwright-e2e
description: Playwright end-to-end testing best practices — API mocking, selector strategy, test structure, and reliability patterns. Use when writing or reviewing E2E tests.
license: MIT
compatibility: opencode
metadata:
  audience: frontend
  framework: playwright
---

## When to use me
Use this skill when writing end-to-end browser tests with Playwright, setting up test fixtures with API mocking, or debugging flaky E2E tests.

## Test Location and Naming

- Place tests in `frontend/e2e/` directory.
- Use `*.spec.js` suffix for E2E test files.
- Group tests in `test.describe()` blocks.
- Use descriptive test names that explain user behavior.

## Selector Strategy

### Priority order
1. **Semantic selectors** — `page.getByRole()`, `page.getByText()`, `page.getByLabel()`.
2. **CSS class selectors** — `.reader-toolbar`, `.book-row`, `.shelf-grid` (use project-specific classes).
3. **CSS selectors** only as last resort.

### Avoid
- XPath selectors.
- Fragile selectors based on DOM structure depth.
- Selectors depending on auto-generated class names.

## API Mocking

- Use `page.route()` to mock backend API responses.
- Mock at the HTTP level (not at the JS module level).
- Provide realistic response data matching `docs/api.md` schemas.
- Mock both success and error responses.

### Example
```js
test.beforeEach(async ({ page }) => {
  await page.route("**/api/shelf", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { book_id: 1, title: "测试小说", progress_percent: 45.5 }
      ])
    });
  });
  await page.goto("/");
});
```

## Test Structure

```js
import { test, expect } from "@playwright/test";

test.describe("Bookshelf", () => {
  test.beforeEach(async ({ page }) => {
    // Setup mocks and navigate
  });

  test("displays book list on load", async ({ page }) => {
    await expect(page.getByText("测试小说")).toBeVisible();
  });

  test("opens reader when book is clicked", async ({ page }) => {
    await page.locator(".book-row").first().click();
    await expect(page.locator(".reader-content")).toBeVisible();
  });

  test("shows error message on API failure", async ({ page }) => {
    await page.route("**/api/shelf", (route) => {
      route.fulfill({ status: 500 });
    });
    await page.reload();
    await expect(page.locator(".error-message")).toBeVisible();
  });
});
```

## Waiting Strategy

- **Rely on Playwright's auto-waiting** — `expect().toBeVisible()`, `expect().toHaveText()`.
- Avoid explicit `page.waitForTimeout()` unless absolutely necessary.
- Use `page.waitForResponse()` when waiting for API calls to complete.
- For scroll-based loading or virtual lists, wait for content to appear with auto-waiting assertions.

## Reliability Patterns

- Each test should be **independent** — setup fresh state in `beforeEach`.
- Don't rely on previous test state.
- Run before committing: `npx playwright test --config frontend/playwright.config.js`.
- For flaky tests, check for race conditions with animations or network requests.

## Running Tests

```bash
npx playwright test --config frontend/playwright.config.js
```

## Do NOT
- Test visual styling (colors, fonts, spacing).
- Use `waitForTimeout()` as a substitute for proper waiting.
- Hardcode server URLs — use relative URLs or config-based URLs.
- Commit tests that depend on real backend state — always mock.
