import { expect, test } from "vitest";
import { captureParagraphAnchor } from "./reader-position";

test("anchor selects the visible row rather than overscan or text percent", () => {
  expect(captureParagraphAnchor({
    paragraphs: [{ offset: 0, text: "甲" }, { offset: 3, text: "乙" }],
    virtualItems: [
      { index: 0, start: 0, end: 100, size: 100 },
      { index: 1, start: 100, end: 300, size: 200 },
    ],
    listOffset: 150,
  })).toEqual({
    char_offset: 3,
    paragraph_fraction: 0.25,
    position_kind: "paragraph_utf16_lf_v1",
  });
});

test("anchor returns null when a candidate row is not measurable", () => {
  expect(captureParagraphAnchor({
    paragraphs: [{ offset: 0, text: "甲" }],
    virtualItems: [{ index: 0, start: 0, end: 0, size: 0 }],
    listOffset: 0,
  })).toBeNull();
});
