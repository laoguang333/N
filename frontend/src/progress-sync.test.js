import { expect, test, vi } from "vitest";
import { createProgressSync } from "./progress-sync";

function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
}

function baseProgress(bookId, overrides = {}) {
  return {
    book_id: bookId,
    char_offset: 100,
    percent: 0.1,
    version: 7,
    mutation_id: "before",
    position_kind: "paragraph_utf16_lf_v1",
    paragraph_fraction: 0,
    updated_at: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

function position(charOffset, percent) {
  return {
    char_offset: charOffset,
    percent,
    position_kind: "paragraph_utf16_lf_v1",
    paragraph_fraction: 0,
  };
}

function epubPosition(locator, percent) {
  return { char_offset: 0, percent, locator };
}

function createTestSync({ storage = makeStorage(), save = vi.fn(), sendOnExit = vi.fn() } = {}) {
  let counter = 0;
  return {
    storage,
    sendOnExit,
    sync: createProgressSync({
      storage,
      save,
      sendOnExit,
      makeMutationId: () => `M${++counter}`,
      onState: vi.fn(),
    }),
    save,
  };
}

test("acknowledging M1 retains and then sends the newer M2", async () => {
  const firstResponse = {};
  let releaseFirst;
  const firstSave = new Promise((resolve) => { releaseFirst = resolve; });
  const save = vi.fn()
    .mockImplementationOnce(() => firstSave)
    .mockImplementationOnce(async (bookId, payload) => ({
      ...baseProgress(bookId, {
        char_offset: payload.char_offset,
        percent: payload.percent,
        version: 9,
        mutation_id: payload.mutation_id,
      }),
    }));
  const { sync } = createTestSync({ save });

  sync.reconcile(101, baseProgress(101));
  sync.observe(101, position(200, 0.2));
  const draining = sync.flush(101);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  sync.observe(101, position(300, 0.3));

  releaseFirst({ ...baseProgress(101), char_offset: 200, percent: 0.2, version: 8, mutation_id: "M1" });
  await draining;

  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1]).toEqual([
    101,
    expect.objectContaining({ char_offset: 300, percent: 0.3, base_version: 8, mutation_id: "M2" }),
  ]);
  expect(sync.getState(101).confirmed).toEqual(expect.objectContaining({ char_offset: 300, version: 9 }));
  expect(sync.getState(101).pending).toBeNull();
  expect(sync.getState(101).submitted).toBeNull();
  expect(firstResponse).toEqual({});
});

test("different books flush independently", async () => {
  let releaseA;
  const saveA = new Promise((resolve) => { releaseA = resolve; });
  const save = vi.fn()
    .mockImplementationOnce(() => saveA)
    .mockImplementationOnce(async (bookId, payload) => baseProgress(bookId, {
      char_offset: payload.char_offset,
      percent: payload.percent,
      version: 2,
      mutation_id: payload.mutation_id,
    }));
  const { sync } = createTestSync({ save });

  sync.reconcile(1, baseProgress(1, { version: 1 }));
  sync.reconcile(2, baseProgress(2, { version: 1 }));
  sync.observe(1, position(10, 0.1));
  sync.observe(2, position(20, 0.2));
  const first = sync.flush(1);
  const second = sync.flush(2);

  await expect(second).resolves.toBeUndefined();
  expect(save).toHaveBeenCalledTimes(2);
  expect(sync.getState(2).submitted).toBeNull();
  releaseA(baseProgress(1, { char_offset: 10, percent: 0.1, version: 2, mutation_id: "M1" }));
  await first;
});

test("a failed flush keeps the same submitted mutation for retry", async () => {
  const save = vi.fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(async (bookId, payload) => baseProgress(bookId, {
      char_offset: payload.char_offset,
      percent: payload.percent,
      version: 2,
      mutation_id: payload.mutation_id,
    }));
  const { sync } = createTestSync({ save });

  sync.reconcile(7, baseProgress(7, { version: 1 }));
  sync.observe(7, position(70, 0.7));
  await sync.flush(7);
  const failedPayload = sync.getState(7).submitted;
  expect(failedPayload).toEqual(expect.objectContaining({ mutation_id: "M1", base_version: 1, char_offset: 70 }));

  await sync.flush(7);
  expect(save.mock.calls[1][1]).toEqual(failedPayload);
  expect(sync.getState(7).submitted).toBeNull();
});

test("pending cache survives a new sync instance and can recover", async () => {
  const storage = makeStorage();
  const first = createTestSync({ storage, save: vi.fn().mockRejectedValue(new Error("offline")) });
  first.sync.reconcile(9, baseProgress(9, { version: 4 }));
  first.sync.observe(9, position(900, 0.9));
  await first.sync.flush(9);

  const save = vi.fn(async (bookId, payload) => baseProgress(bookId, {
    char_offset: payload.char_offset,
    percent: payload.percent,
    version: 5,
    mutation_id: payload.mutation_id,
  }));
  const second = createTestSync({ storage, save });
  expect(second.sync.getState(9).submitted).toEqual(expect.objectContaining({ mutation_id: "M1", char_offset: 900 }));
  await second.sync.flush(9);
  expect(save).toHaveBeenCalledWith(9, expect.objectContaining({ mutation_id: "M1", base_version: 4 }));
});

test("legacy dirty cache is readable and migrated without clearing the old key", () => {
  const storage = makeStorage({
    "txt-reader-progress": JSON.stringify({
      10: { book_id: 10, char_offset: 1000, percent: 0.8, version: 4, dirty: true },
    }),
  });
  const { sync } = createTestSync({ storage });

  expect(sync.getState(10).pending).toEqual(expect.objectContaining({ char_offset: 1000, base_version: 4 }));
  expect(storage.getItem("txt-reader-progress")).toContain("1000");
  expect(storage.getItem("txt-reader-progress-v2")).toContain("1000");
});

test("a version conflict keeps local and remote choices until explicitly resolved", async () => {
  const save = vi.fn().mockRejectedValue(Object.assign(new Error("conflict"), {
    status: 409,
    current: baseProgress(11, { char_offset: 110, percent: 0.11, version: 8, mutation_id: "other" }),
  }));
  const { sync } = createTestSync({ save });

  sync.reconcile(11, baseProgress(11, { version: 7 }));
  sync.observe(11, position(800, 0.8));
  await sync.flush(11);
  expect(sync.getState(11).conflict).toEqual({
    local: expect.objectContaining({ char_offset: 800 }),
    remote: expect.objectContaining({ char_offset: 110, version: 8 }),
  });

  sync.resolveConflict(11, "remote");
  expect(sync.getState(11)).toMatchObject({ confirmed: expect.objectContaining({ char_offset: 110, version: 8 }), pending: null, submitted: null, conflict: null });
});

test("same position does not create another write and exit send never confirms", () => {
  const sendOnExit = vi.fn();
  const { sync } = createTestSync({ sendOnExit });
  sync.reconcile(12, baseProgress(12, { version: 3, char_offset: 120, percent: 0.12 }));
  sync.observe(12, position(120, 0.12));
  expect(sync.getState(12).pending).toBeNull();

  sync.observe(12, position(121, 0.13));
  sync.flushOnExit(12);
  expect(sendOnExit).toHaveBeenCalledWith(12, expect.objectContaining({ mutation_id: "M1", base_version: 3 }));
  expect(sync.getState(12).submitted).toEqual(expect.objectContaining({ mutation_id: "M1" }));
  expect(sync.getState(12).confirmed).toEqual(expect.objectContaining({ char_offset: 120 }));
});

test("a position-format change is a real new position", () => {
  const { sync } = createTestSync();
  sync.reconcile(16, baseProgress(16, {
    position_kind: null,
    paragraph_fraction: null,
    char_offset: 160,
    percent: 0.16,
  }));

  sync.observe(16, position(160, 0.16));

  expect(sync.getState(16).pending).toEqual(expect.objectContaining({
    char_offset: 160,
    position_kind: "paragraph_utf16_lf_v1",
  }));
});

test("retains EPUB locators through pending and submitted progress", async () => {
  const save = vi.fn(async (bookId, payload) => ({
    book_id: bookId,
    ...payload,
    version: 2,
    updated_at: "2026-09-19T00:00:00.000Z",
  }));
  const { sync } = createTestSync({ save });
  sync.reconcile(17, baseProgress(17, { locator: "epubcfi(/6/2)", char_offset: 0 }));
  sync.observe(17, epubPosition("epubcfi(/6/4)", 0.4));
  await sync.flush(17);

  expect(save).toHaveBeenCalledWith(17, expect.objectContaining({ locator: "epubcfi(/6/4)" }));
  expect(sync.getState(17).confirmed.locator).toBe("epubcfi(/6/4)");
});

test("storage failure keeps memory state and does not retry unsafe writes in one flush", async () => {
  let writes = 0;
  const storage = {
    getItem: () => null,
    setItem: () => {
      writes += 1;
      throw new Error("quota");
    },
  };
  const save = vi.fn();
  const { sync } = createTestSync({ storage, save });
  sync.reconcile(13, baseProgress(13, { version: 1 }));
  sync.observe(13, position(130, 0.13));
  await sync.flush(13);

  expect(save).not.toHaveBeenCalled();
  expect(writes).toBe(3);
  expect(sync.getState(13)).toMatchObject({
    submitted: expect.objectContaining({ mutation_id: "M1", base_version: 1 }),
    storage_error: expect.any(String),
  });
});

test("repeated flush calls share one in-flight request for a book", async () => {
  let release;
  const save = vi.fn(() => new Promise((resolve) => { release = resolve; }));
  const { sync } = createTestSync({ save });
  sync.reconcile(14, baseProgress(14, { version: 1 }));
  sync.observe(14, position(140, 0.14));
  const first = sync.flush(14);
  const second = sync.flush(14);

  expect(second).toBe(first);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  release(baseProgress(14, { char_offset: 140, percent: 0.14, version: 2, mutation_id: "M1" }));
  await first;
});

test("choosing local after conflict retries from the latest remote version", async () => {
  const save = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error("conflict"), {
      status: 409,
      current: baseProgress(15, { char_offset: 150, percent: 0.15, version: 8, mutation_id: "other" }),
    }))
    .mockImplementationOnce(async (bookId, payload) => baseProgress(bookId, {
      char_offset: payload.char_offset,
      percent: payload.percent,
      version: 9,
      mutation_id: payload.mutation_id,
    }));
  const { sync } = createTestSync({ save });
  sync.reconcile(15, baseProgress(15, { version: 7 }));
  sync.observe(15, position(1500, 0.9));
  await sync.flush(15);
  sync.resolveConflict(15, "local");
  await sync.flush(15);

  expect(save.mock.calls[1][1]).toEqual(expect.objectContaining({ base_version: 8, mutation_id: "M2", char_offset: 1500 }));
});
