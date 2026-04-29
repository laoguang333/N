import { describe, expect, test } from "vitest";
import { buildParagraphs, formatPercent, formatSize, parseSettings } from "./reader";

describe("reader helpers", () => {
  test("buildParagraphs normalizes line endings and tracks offsets", () => {
    expect(buildParagraphs("第一段\r\n\r\n 第二段\n第三段")).toEqual([
      { offset: 0, text: "第一段" },
      { offset: 5, text: "第二段" },
      { offset: 10, text: "第三段" },
    ]);
  });

  test("parseSettings falls back and clamps invalid values", () => {
    expect(parseSettings("{bad json").fontSize).toBe(20);
    expect(
      parseSettings(
        JSON.stringify({
          fontSize: 99,
          lineHeight: 0,
          paragraphSpacing: Number.NaN,
          theme: "unknown",
        }),
      ),
    ).toEqual({
      fontSize: 32,
      lineHeight: 1.4,
      paragraphSpacing: 16,
      theme: "paper",
    });
  });

  test("format helpers keep shelf labels compact", () => {
    expect(formatSize(100)).toBe("1 KB");
    expect(formatSize(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatPercent(null)).toBe("未读");
    expect(formatPercent({ percent: 0.425 })).toBe("43%");
    expect(formatPercent({ percent: 1 })).toBe("已读");
  });
});
