import { expect, test } from "vitest";
import { createRequestScope } from "./request-scope";

test("older request is invalid after a new request or leaving the view", () => {
  const scope = createRequestScope();
  const first = scope.begin();
  const second = scope.begin();

  expect(first.signal.aborted).toBe(true);
  expect(scope.isCurrent(first)).toBe(false);
  expect(scope.isCurrent(second)).toBe(true);

  scope.invalidate();

  expect(second.signal.aborted).toBe(true);
  expect(scope.isCurrent(second)).toBe(false);
});
