---
name: vitest-testing
description: Vitest unit testing best practices — mocking dependencies, describe/test grouping, test file co-location, and testing pure functions. Use when writing or reviewing unit tests.
license: MIT
compatibility: opencode
metadata:
  audience: frontend
  framework: vitest
---

## When to use me
Use this skill when writing unit tests for JavaScript utility functions, composing test suites with Vitest, or reviewing existing test files.

## Test Location and Naming

- **Co-locate test files** next to source: `reader.test.js` next to `reader.js`.
- Use `*.test.js` suffix (not `*.spec.js`).
- Group tests in `describe()` blocks; use `test()` (not `it()`).
- Write descriptive test names: "formats file size in KB/MB", "handles empty input gracefully".

## Import Pattern

```js
import { describe, expect, test } from "vitest";
import { functionToTest } from "./source";
```

- `vi` is imported separately only when mocking is needed: `import { vi } from "vitest";`.

## Testing Focus

### Test pure functions, not components
- Focus on business logic, utility functions, data transformation.
- Do NOT mount Vue components — this project uses Playwright for component/integration tests.
- No `@vue/test-utils` usage unless explicitly requested.

### What to test
1. **Valid inputs** — normal/happy path.
2. **Edge cases** — empty strings, zero values, boundary conditions.
3. **Invalid inputs** — null, undefined, wrong types (if function handles them).

### Test quantity
- 3-5 focused tests per function is ideal.
- One test file per source module.

## Mocking

- Use `vi.mock()` before imports when mocking external modules.
- Mock API calls and browser APIs (like `localStorage`, `fetch`).
- Use `vi.clearAllMocks()` in `beforeEach` when using mocks.
- Prefer mock implementations that return realistic data.

## Structure

```js
import { describe, expect, test } from "vitest";
import { buildParagraphs } from "./reader";

describe("buildParagraphs", () => {
  test("normalizes line endings and creates paragraph boundaries", () => {
    const result = buildParagraphs("第一段\r\n\r\n第二段");
    expect(result).toEqual([
      { text: "第一段", start: 0, end: 4 },
      { text: "第二段", start: 7, end: 11 }
    ]);
  });

  test("handles empty content", () => {
    const result = buildParagraphs("");
    expect(result).toEqual([]);
  });

  test("handles content with no paragraph breaks", () => {
    const result = buildParagraphs("single paragraph");
    expect(result.length).toBe(1);
  });
});
```

## Running Tests

```bash
npm run test --prefix frontend
# or
vitest run src --config frontend/vite.config.js
```

## Do NOT
- Create component mount tests unless explicitly requested.
- Test Vue lifecycle hooks or internal implementation details.
- Skip writing tests for utility functions that have known edge cases.
- Use Jest imports (`jest.fn()`, etc.) — always use Vitest equivalents (`vi.fn()`).
