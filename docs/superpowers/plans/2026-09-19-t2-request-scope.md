# T2 Request Scope Isolation Implementation Plan

> **For agentic workers:** This plan is executed inline in the current session; do not dispatch subagents.

**Goal:** Isolate shelf, folder, and reader asynchronous work by abortable request generations so stale responses cannot mutate current React state.

**Architecture:** Add a tiny `createRequestScope()` helper that owns one generation and one `AbortController`. Pass optional `AbortSignal` values through the existing API wrapper while retaining legacy call shapes. `App.tsx` owns independent shelf and reader scopes; `FolderOverlay.tsx` owns a folder scope and guards mounted/open state, while reader timers/RAF work capture the active route, book id, and generation.

**Tech Stack:** React 19, TypeScript/TSX, Vite, Vitest, Playwright, Fetch `AbortController`.

**Spec:** `C:/Users/nillouise/.codex/attachments/80769530-dd03-456c-a087-58091cf6fd61/已粘贴的文本.txt`, section T2.

## Global Constraints

- Implement T2 only; do not implement T3 version protocol, T4 progress queue, T5 position rewrite, or T7 search virtualization.
- Do not touch Rust files.
- Preserve existing API call compatibility and treat `AbortError` as an identifiable untouched error, not a user-facing error.
- Use controllable Playwright route delays; every `/api/**` request in new race tests must be mocked and unsupported requests must fail.
- Run RED before production code for each new behavior, then run frontend unit tests, build, focused E2E, and existing shelf E2E.

### Task 1: Request scope helper and API signal compatibility

**Files:**
- Create: `frontend/src/request-scope.js`
- Create: `frontend/src/request-scope.test.js`
- Modify: `frontend/src/api.js`

**Interfaces:**
- `createRequestScope().begin()` returns `{ generation: number, signal: AbortSignal }`.
- `createRequestScope().isCurrent(ticket)` checks generation and signal state.
- `createRequestScope().invalidate()` advances the generation and aborts the active controller.
- `getShelf`, `listBooks`, `getBook`, `getBookContent`, `getProgress`, and save helpers accept trailing optional options without changing old calls.

- [ ] Write the scope test asserting a previous ticket is aborted/invalid after `begin()` and invalid after `invalidate()`.
- [ ] Run `npm run test --prefix frontend -- src/request-scope.test.js` and observe the expected missing-module failure.
- [ ] Implement the exact generation/abort lifecycle and pass `{ signal }` into `request` from query/content/progress/book calls.
- [ ] Run the focused Vitest test and API-compatible frontend tests.

### Task 2: Shelf and folder stale-query protection

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/FolderOverlay.tsx`
- Create/modify: `frontend/e2e/shelf-races.spec.js`

**Interfaces:**
- App shelf query uses an independent request scope and invalidates immediately on query/filter changes, before the 180 ms timer.
- Folder overlay uses its own scope, aborts/invalidates on query/tag/close/unmount, and only applies results when the tag/query ticket is current.

- [ ] Add controllable-delay E2E cases for slow A/fast B shelf queries, input changes during debounce, and slow folder X/fast folder Y followed by close.
- [ ] Run the new E2E file before implementation and verify each test fails for stale-state behavior.
- [ ] Add ticket checks after await/catch/finally and suppress AbortError display.
- [ ] Run the new E2E file plus the existing shelf E2E.

### Task 3: Reader open lifecycle and timer/RAF fences

**Files:**
- Modify: `frontend/src/App.tsx`
- Create/modify: `frontend/e2e/reader-races.spec.js`

**Interfaces:**
- Every `openBook` call begins a fresh reader ticket, including reopening the same book.
- Async reader work mutates state only when route is reader, route book id, and reader ticket/book id all match.
- Route/book switches invalidate the reader ticket, clear reader timers/RAF/pending seek state, but do not cancel already-issued writes as rollback.

- [ ] Add controllable-delay E2E cases for slow A/fast B content, slow A save after switching to B, and stale restore timer/RAF after switching books.
- [ ] Run the new E2E file before implementation and record the expected failures.
- [ ] Guard open `await`, `catch`, `finally`, `afterNextPaint`, restore navigation, seek callbacks, and delayed cleanup by the captured ticket.
- [ ] Run reader races and the existing reader regression suite if the environment supports it.

### Task 4: Save response fence and verification report

**Files:**
- Modify: `frontend/src/App.tsx`
- Create: `.superpowers/sdd/已粘贴的文本.txt/task-2-report.md`

**Interfaces:**
- Save captures `savingBookId` and the reader generation/ticket, validates `saved.book_id`, updates that book's cache by id, and only updates the visible reader when book id and generation still match.

- [ ] Add/adjust a focused race assertion that a late A save cannot affect B's visible progress or the payload of B's next save.
- [ ] Run frontend unit tests, production build, focused reader/shelf E2E with `PW_CHANNEL=chrome` when available, and existing shelf E2E.
- [ ] Inspect `git diff --check`, changed-file scope, and git status.
- [ ] Write the report with start/end commit or uncommitted state, T0–T7 status, exact test commands/results, platform/browser scope, concerns, and explicit T2-only exclusions.
- [ ] Commit only T2 implementation/tests/report/plan files if the worktree state allows it; never include unrelated user changes.

## Self-review checklist

- Scope helper has a direct unit test and no production implementation precedes its RED run.
- API compatibility covers shelf, folder, reader content/progress, and save response paths.
- Debounce invalidation occurs at input/filter change, not at timer fire.
- Folder close cannot be undone by an old response.
- Reader reopening the same book creates a distinct generation.
- Save acknowledgements cannot be inferred from the current book after a switch.
- No Rust or out-of-scope T3/T4/T5/T7 code is changed.
