import { describe, expect, test } from "vitest";
import { isSuspiciousLocalReset, savePayload } from "./progress";
import { buildParagraphs, formatPercent, formatSize, parseSettings } from "./reader";
import { highlightParagraph, searchParagraphs } from "./search";

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
    expect(formatPercent({ percent: 0 })).toBe("0%");
    expect(formatPercent({ percent: 0.425 })).toBe("43%");
    expect(formatPercent({ percent: 1 })).toBe("已读");
  });

  test("progress payload includes the current position and metadata", () => {
    expect(
      savePayload({ char_offset: 20, percent: 0.2 }, {
        source: "scroll",
        clientId: "client",
        sessionId: "session",
      }),
    ).toEqual({
      char_offset: 20,
      percent: 0.2,
      source: "scroll",
      client_id: "client",
      session_id: "session",
      allow_backward: false,
    });
  });

  test("detects suspicious local reset snapshots unless explicitly allowed", () => {
    expect(
      isSuspiciousLocalReset(
        { char_offset: 0, percent: 0 },
        { char_offset: 3000, percent: 0.2 },
      ),
    ).toBe(true);
    expect(
      isSuspiciousLocalReset(
        { char_offset: 0, percent: 0 },
        { char_offset: 25, percent: 0.0005 },
      ),
    ).toBe(true);
    expect(
      isSuspiciousLocalReset(
        { char_offset: 900, percent: 0.01 },
        { char_offset: 3000, percent: 0.2 },
      ),
    ).toBe(true);
    expect(
      isSuspiciousLocalReset(
        { char_offset: 9000, percent: 0.2 },
        { char_offset: 30000, percent: 0.5 },
      ),
    ).toBe(false);
    expect(
      isSuspiciousLocalReset(
        { char_offset: 0, percent: 0 },
        { char_offset: 3000, percent: 0.2 },
        { allowBackward: true },
      ),
    ).toBe(false);
  });

  test("search results use original text indexes when whitespace repeats", () => {
    const paragraphs = [{ offset: 10, text: "Alpha   Beta\tGamma" }];
    const [result] = searchParagraphs(paragraphs, "beta");

    expect(result).toMatchObject({
      paragraphOffset: 10,
      offset: 18,
      matchStart: 8,
      matchEnd: 12,
      text: "Beta",
    });

    expect(highlightParagraph(paragraphs[0].text, [result])).toEqual([
      { text: "Alpha   ", highlight: false },
      { text: "Beta", highlight: true, active: false, id: result.id },
      { text: "\tGamma", highlight: false },
    ]);
  });
});
