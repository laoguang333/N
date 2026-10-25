import { describe, expect, test } from "vitest";
import { buildSearchContext, searchParagraphs, searchWithIndex, buildSearchIndex } from "./search";
import { buildParagraphs, normalizeLineEndings } from "./reader";

describe("search helpers", () => {
  test("search percent uses the normalized full text length", () => {
    const text = "甲\n\n".repeat(100);
    const paragraphs = buildParagraphs(text);
    const index = buildSearchIndex(paragraphs, normalizeLineEndings(text).length);
    const results = searchWithIndex(index, "甲");

    expect(paragraphs.at(-1).offset).toBe(297);
    expect(index.totalLength).toBe(300);
    expect(results[34].percent).toBeCloseTo(102 / 300);
    expect(results.at(-1).percent).toBeCloseTo(297 / 300);
  });

  test("uses original offsets including paragraph separators for total length", () => {
    const paragraphs = [
      { offset: 0, text: "第一段" },
      { offset: 8, text: "第二段" },
      { offset: 14, text: "第三段" },
    ];
    const index = buildSearchIndex(paragraphs);

    expect(index.totalLength).toBe(17);
    expect(searchWithIndex(index, "三")[0]).toMatchObject({
      offset: 15,
      percent: 15 / 17,
    });
  });

  test("returns context around every hit in a long paragraph", () => {
    const text = `${"前置文字。".repeat(12)}目标一${"中间文字。".repeat(12)}目标二${"结尾文字。".repeat(12)}`;
    const results = searchParagraphs([{ offset: 42, text }], "目标");

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      text: `${results[0].snippetBefore}目标${results[0].snippetAfter}`,
      snippetMatch: "目标",
      matchStart: text.indexOf("目标"),
      matchEnd: text.indexOf("目标") + 2,
    });
    expect(results[0].snippetBefore.length).toBe(35);
    expect(results[0].snippetAfter.length).toBe(35);
    expect(results[1]).toMatchObject({
      snippetMatch: "目标",
      matchStart: text.lastIndexOf("目标"),
      matchEnd: text.lastIndexOf("目标") + 2,
    });
    expect(results[1].snippetBefore.length).toBe(35);
    expect(results[1].snippetAfter.length).toBe(35);
  });

  test("keeps match indexes in the original paragraph while matching repeated hits", () => {
    const text = "Alpha   Beta\tBeta Gamma";
    const results = searchParagraphs([{ offset: 10, text }], "beta");

    expect(results.map((result) => result.matchStart)).toEqual([8, 13]);
    expect(results.map((result) => result.offset)).toEqual([18, 23]);
    expect(results[0].snippetBefore).toBe("Alpha   ");
    expect(results[0].snippetMatch).toBe("Beta");
    expect(results[0].snippetAfter).toBe("\tBeta Gamma");
  });

  test("does not add context beyond paragraph boundaries", () => {
    const [result] = searchParagraphs([{ offset: 3, text: "prefix target suffix" }], "target");

    expect(result).toMatchObject({
      text: "prefix target suffix",
      snippetBefore: "prefix ",
      snippetMatch: "target",
      snippetAfter: " suffix",
    });
  });

  test("context crosses paragraph boundaries for short dialogue lines", () => {
    const paragraphs = buildParagraphs("他推开门，看见老人坐在窗边。\n“好。”\n老人点了点头，转身走向书架。");
    const index = buildSearchIndex(paragraphs);
    const [result] = searchWithIndex(index, "好");

    expect(result.snippetBefore).toBe("“");
    expect(buildSearchContext(index, result)).toEqual({
      before: "他推开门，看见老人坐在窗边。\n“",
      match: "好",
      after: "。”\n老人点了点头，转身走向书架。",
      clippedStart: false,
      clippedEnd: false,
    });
  });

  test("context stops at the length budget and reports clipping", () => {
    const paragraphs = [
      { offset: 0, text: "一".repeat(50) },
      { offset: 51, text: "前文命中后文" },
      { offset: 58, text: "二".repeat(50) },
    ];
    const index = buildSearchIndex(paragraphs);
    const [result] = searchWithIndex(index, "命中");
    const context = buildSearchContext(index, result, { before: 10, after: 12 });

    expect(context).toEqual({
      before: `${"一".repeat(8)}\n前文`,
      match: "命中",
      after: `后文\n${"二".repeat(10)}`,
      clippedStart: true,
      clippedEnd: true,
    });
  });

  test("context crosses at most the configured number of paragraphs", () => {
    const paragraphs = buildParagraphs(["甲", "乙", "丙", "丁", "目标", "戊", "己", "庚", "辛"].join("\n"));
    const index = buildSearchIndex(paragraphs);
    const [result] = searchWithIndex(index, "目标");
    const context = buildSearchContext(index, result, { maxParagraphs: 2 });

    expect(context.before).toBe("丙\n丁\n");
    expect(context.after).toBe("\n戊\n己");
    expect(context.clippedStart).toBe(true);
    expect(context.clippedEnd).toBe(true);
  });

  test("context never splits surrogate pairs", () => {
    const text = `${"😀".repeat(30)}目标${"😀".repeat(30)}`;
    const index = buildSearchIndex([{ offset: 0, text }]);
    const [result] = searchWithIndex(index, "目标");
    const context = buildSearchContext(index, result, { before: 7, after: 7 });

    expect(context.before).toBe("😀".repeat(3));
    expect(context.after).toBe("😀".repeat(3));
    expect(context.clippedStart).toBe(true);
    expect(context.clippedEnd).toBe(true);
  });
});
