import { describe, expect, test } from "vitest";
import { buildAnimeQueryParams, formatVideoDuration, formatVideoStatus } from "./anime";

describe("anime helpers", () => {
  test("formats duration labels", () => {
    expect(formatVideoDuration(65.2)).toBe("1:05");
    expect(formatVideoDuration(3661)).toBe("1:01:01");
  });

  test("formats watch status labels", () => {
    expect(formatVideoStatus(null)).toBe("未看");
    expect(formatVideoStatus({ percent: 0.4 })).toBe("观看中");
    expect(formatVideoStatus({ percent: 0.95 })).toBe("已看");
  });

  test("builds compact anime search params", () => {
    expect(
      buildAnimeQueryParams({
        search: " eva ",
        status: "watching",
        availability: "missing",
        minRating: 4,
        sort: "rating",
      }).toString(),
    ).toBe("search=eva&status=watching&availability=missing&min_rating=4&sort=rating");
  });
});
