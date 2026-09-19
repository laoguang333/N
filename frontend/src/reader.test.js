import { describe, expect, test } from "vitest";
import { chooseProgress, isSuspiciousLocalReset, savePayload } from "./progress";
import { buildChapters, buildParagraphs, findChapterIndex, formatPercent, formatSize, normalizeLineEndings, parseSettings } from "./reader";
import { highlightParagraph, searchParagraphs } from "./search";

describe("reader helpers", () => {
  test("buildParagraphs normalizes line endings and tracks offsets", () => {
    expect(buildParagraphs("第一段\r\n\r\n 第二段\n第三段")).toEqual([
      { offset: 0, text: "第一段" },
      { offset: 6, text: "第二段" },
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
      autoScrollSpeed: 5,
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
      savePayload({ char_offset: 20, percent: 0.2, version: 7 }, {
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
      base_version: 7,
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

  test("normalizes mixed line endings with UTF-16 offsets", () => {
    const text = normalizeLineEndings("  甲\r\n\r\n　乙😀\r丙");
    const paragraphs = buildParagraphs(text);
    expect(paragraphs).toEqual([
      { offset: 2, text: "甲" },
      { offset: 6, text: "乙😀" },
      { offset: 10, text: "丙" },
    ]);
    expect(text.slice(paragraphs[1].offset, paragraphs[1].offset + paragraphs[1].text.length)).toBe("乙😀");
  });

  test("detects common TXT chapter headings and finds the active chapter", () => {
    const paragraphs = buildParagraphs([
      "序章",
      "开场内容。",
      "第一章 初见",
      "正文内容。",
      "Chapter 2 A New Day",
      "这里提到第二章标题但不应被识别。",
      "番外 三",
    ].join("\n\n"));
    const chapters = buildChapters(paragraphs);

    expect(chapters.map((chapter) => chapter.title)).toEqual([
      "序章",
      "第一章 初见",
      "Chapter 2 A New Day",
      "番外 三",
    ]);
    expect(findChapterIndex(chapters, chapters[2].offset + 4)).toBe(2);
    expect(findChapterIndex([], 100)).toBe(-1);
  });

  test("detects 话 headings with inline content and limits displayed titles", () => {
    const inlineContent = "第一话：正文内容直接接在这里，章节标题后仍然属于本段正文。";
    const longHeading = `第二话：${"这是章节标题后面的正文内容。".repeat(10)}`;
    const paragraphs = buildParagraphs([inlineContent, longHeading].join("\n\n"));
    const chapters = buildChapters(paragraphs);

    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe(inlineContent);
    expect(chapters[1].title).toBe(Array.from(longHeading).slice(0, 30).join(""));
    expect(chapters[1].title).toHaveLength(30);
    expect(paragraphs[0].text).toBe(inlineContent);
  });

  test("allows spaces between 第, the number, and the chapter unit", () => {
    const paragraphs = buildParagraphs([
      "第 1 话：带空格的章节标题",
      "第\t2\t章：另一个章节",
    ].join("\n\n"));
    const chapters = buildChapters(paragraphs);

    expect(chapters.map((chapter) => chapter.title)).toEqual([
      "第 1 话：带空格的章节标题",
      "第\t2\t章：另一个章节",
    ]);
  });

  test("search results use original text indexes when whitespace repeats", () => {
    const paragraphs = [{ offset: 10, text: "Alpha   Beta\tGamma" }];
    const [result] = searchParagraphs(paragraphs, "beta");

    expect(result).toMatchObject({
      paragraphOffset: 10,
      offset: 18,
      matchStart: 8,
      matchEnd: 12,
      text: "Alpha   Beta\tGamma",
    });

    expect(highlightParagraph(paragraphs[0].text, [result])).toEqual([
      { text: "Alpha   ", highlight: false },
      { text: "Beta", highlight: true, active: false, id: result.id },
      { text: "\tGamma", highlight: false },
    ]);
  });

  test("restoration prefers newer unsynced local text but adopts server version", () => {
    const server = { char_offset: 20, percent: 0.2, version: 7, updated_at: "2026-09-16 10:00:00" };
    const local = { char_offset: 10, percent: 0.1, dirty: true, updated_at: "2026-09-16T10:01:00.000Z" };
    expect(chooseProgress(server, local)).toEqual({ ...local, version: 7 });
    expect(chooseProgress(server, { ...local, dirty: false })).toBe(server);
    expect(chooseProgress(server, { ...local, updated_at: "2026-09-16T09:59:00Z" })).toBe(server);
    expect(chooseProgress(null, local)).toBe(local);
    expect(chooseProgress(server, null)).toBe(server);
  });

  test("automatic reading speed is restored and bounded", () => {
    expect(parseSettings(JSON.stringify({ autoScrollSpeed: 2 })).autoScrollSpeed).toBe(2);
    expect(parseSettings(JSON.stringify({ autoScrollSpeed: 100 })).autoScrollSpeed).toBe(10);
    expect(parseSettings(JSON.stringify({ autoScrollSpeed: null })).autoScrollSpeed).toBe(5);
  });
});
