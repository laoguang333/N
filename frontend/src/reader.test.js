import { describe, expect, test } from "vitest";
import { chooseProgressForOpen, isRemoteAhead, savePayload } from "./progress";
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

  test("chooses server progress unless local cache is unsynced or server is unread", () => {
    const server = {
      book_id: 1,
      char_offset: 100,
      percent: 0.5,
      version: 2,
      updated_at: "2026-04-29T10:00:00.000Z",
    };

    expect(
      chooseProgressForOpen(server, { ...server, percent: 0.1, updated_at: "2026-04-29T11:00:00.000Z" }, 1)
        .progress.percent,
    ).toBe(0.5);

    expect(
      chooseProgressForOpen(
        server,
        {
          book_id: 1,
          char_offset: 130,
          percent: 0.65,
          version: 2,
          base_version: 2,
          dirty: true,
          updated_at: "2026-04-29T11:00:00.000Z",
        },
        1,
      ),
    ).toMatchObject({ progress: { percent: 0.65 }, shouldSync: true });

    expect(
      chooseProgressForOpen(
        { ...server, char_offset: 0, percent: 0, version: 1 },
        { book_id: 1, char_offset: 20, percent: 0.2, updated_at: "2026-04-29T11:00:00.000Z" },
        1,
      ),
    ).toMatchObject({ progress: { percent: 0.2 }, shouldSync: true });
  });

  test("progress payload carries base version and detects remote-ahead conflicts", () => {
    expect(savePayload({ char_offset: 20, percent: 0.2 }, 3)).toEqual({
      char_offset: 20,
      percent: 0.2,
      base_version: 3,
    });
    expect(isRemoteAhead({ percent: 0.8 }, { percent: 0.2 })).toBe(true);
    expect(isRemoteAhead({ percent: 0.2 }, { percent: 0.8 })).toBe(false);
  });
});
