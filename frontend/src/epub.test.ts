import { describe, expect, it, vi } from "vitest";

import { epubProgressFromLocation, resolveEpubTocHref } from "./epub";

describe("resolveEpubTocHref", () => {
  it("resolves EPUB 3 navigation links relative to the nav document", () => {
    const knownSections = new Set(["Text/episode1.xhtml", "Text/episode2.xhtml"]);
    const book = {
      packaging: { navPath: "Text/nav.xhtml" },
      spine: { get: vi.fn((target: string) => knownSections.has(target)) },
    };

    expect(resolveEpubTocHref(book, "episode2.xhtml")).toBe("Text/episode2.xhtml");
  });

  it("preserves fragments while resolving parent path segments", () => {
    const book = {
      packaging: { navPath: "OPS/nav/toc.xhtml" },
      spine: { get: vi.fn((target: string) => target === "OPS/Text/chapter.xhtml#part-2") },
    };

    expect(resolveEpubTocHref(book, "../Text/chapter.xhtml#part-2")).toBe(
      "OPS/Text/chapter.xhtml#part-2",
    );
  });

  it("keeps an href that already resolves against the spine", () => {
    const book = {
      packaging: { navPath: "Text/nav.xhtml" },
      spine: { get: vi.fn((target: string) => target === "Text/chapter.xhtml") },
    };

    expect(resolveEpubTocHref(book, "Text/chapter.xhtml")).toBe("Text/chapter.xhtml");
  });
});

describe("epubProgressFromLocation", () => {
  it("does not overwrite progress before EPUB locations are generated", () => {
    const locations = {
      length: () => 0,
      percentageFromCfi: vi.fn(() => 0),
    };

    expect(epubProgressFromLocation(locations, { start: { cfi: "epubcfi(/6/4)" } })).toBeNull();
    expect(locations.percentageFromCfi).not.toHaveBeenCalled();
  });

  it("returns clamped progress after locations are generated", () => {
    const locations = {
      length: () => 12,
      percentageFromCfi: () => 1.2,
    };

    expect(epubProgressFromLocation(locations, { start: { cfi: "epubcfi(/6/4)" } })).toEqual({
      percent: 1,
      locator: "epubcfi(/6/4)",
    });
  });
});
