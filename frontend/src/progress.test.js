import { expect, test } from "vitest";
import { normalizeProgress, savePayload } from "./progress";

test("normalizes T3 versioned position fields without losing optional values", () => {
  expect(normalizeProgress(3, {
    book_id: 3,
    char_offset: 42,
    percent: 0.42,
    version: 7,
    mutation_id: "M7",
    position_kind: "paragraph_utf16_lf_v1",
    paragraph_fraction: 0.25,
  })).toMatchObject({
    book_id: 3,
    version: 7,
    mutation_id: "M7",
    position_kind: "paragraph_utf16_lf_v1",
    paragraph_fraction: 0.25,
  });
});

test("builds an immutable versioned save payload from normalized progress", () => {
  expect(savePayload({
    char_offset: 42,
    percent: 0.42,
    version: 7,
    position_kind: "paragraph_utf16_lf_v1",
    paragraph_fraction: 0.25,
  }, {
    source: "scroll",
    clientId: "client-1",
    sessionId: "session-1",
    mutationId: "M7",
  })).toEqual(expect.objectContaining({
    char_offset: 42,
    percent: 0.42,
    base_version: 7,
    mutation_id: "M7",
    position_kind: "paragraph_utf16_lf_v1",
    paragraph_fraction: 0.25,
  }));
});
