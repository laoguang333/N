# React + Vite Migration Spec

## Goal

Migrate the current `frontend/` app from Vue 3 + Vite to React + Vite while preserving the Rust/Axum backend, JSON API contract, static production hosting model, reading-progress safety behavior, and existing user workflows.

This is a frontend migration, not a backend rewrite. The Rust server continues to serve `/api/*` and the built `frontend/dist/` assets.

## Recommended Stack

Use the Build Web Apps default stack for a complex app UI:

- React 19 + Vite
- TypeScript for new React source
- shadcn/ui as the component source system
- Tailwind CSS with semantic design tokens
- lucide-react for icons
- @tanstack/react-virtual for shelf and reader virtualization
- Vitest for pure helper tests
- Playwright for browser workflows

Do not add React Router unless a real navigation need appears. The current hash routes are small and should remain code-owned:

- `#/` -> shelf
- `#/reader/:id` -> reader
- `#/a` -> placeholder tab

## Non-Goals

- Do not change backend endpoints or response shapes.
- Do not change SQLite schema as part of this migration.
- Do not replace TXT parsing, encoding detection, or scanning logic.
- Do not introduce remote auth, cloud sync, or user accounts.
- Do not make this a marketing site. The first screen remains the usable bookshelf.

## Current Behavior To Preserve

### Shelf

- Load runtime config from `GET /api/config`.
- Load mixed shelf from `GET /api/shelf`.
- Support filters mapped to query params:
  - `search`
  - `status`
  - `min_rating`
  - `sort`
- Show mixed folder and book rows from `items`.
- Fall back to legacy `books` and `folders` arrays if `items` is absent.
- Scan library with `POST /api/library/scan`.
- Rate books with `PUT /api/books/{id}/rating`.
- Preserve shelf scroll when returning from a reader route.
- Keep the bottom `N` / `A` tab bar behavior.

### Folder Overlay

- Open a folder item from the shelf.
- Load folder-scoped books through `GET /api/books?folder_tag=...`.
- Inherit shelf filters.
- If current search matches the folder name, do not pass the search term into the folder request.
- Paginate locally at 9 books per page.
- Support Escape, ArrowLeft, and ArrowRight.
- Allow rating changes inside the overlay.

### Reader

- Load book content and progress in parallel:
  - `GET /api/books/{id}/content`
  - `GET /api/books/{id}/progress`
- Split TXT content into paragraphs while preserving character offsets.
- Restore scroll from server progress first, then local cached progress.
- Virtualize paragraphs for large books.
- Persist reading settings to `localStorage`.
- Re-measure virtual layout when font size, line height, or paragraph spacing changes.
- Save progress on scroll, interaction end, periodic timer, route change, page hide, visibility hidden, and before unload.
- Keep local dirty progress cache under `txt-reader-progress`.
- Prevent suspicious local reset saves unless an action explicitly allows backward movement.
- Use regular PUT for normal saves, keepalive POST for background saves, and `sendBeacon` when possible.
- Maintain source/client/session metadata in progress payloads.
- Show save failure toast.
- Support progress range seek.
- Support in-book search with result panel and highlighted active match.
- Support auto-scroll with speed control and user interruption.
- Support reader settings:
  - font size
  - line height
  - paragraph spacing
  - paper/night theme

## API Compatibility

Create `frontend/src/api/client.ts` with one `request(path, options)` wrapper. All HTTP calls must use it.

Export functions equivalent to the current API:

- `getShelf(query)`
- `listBooks(query | search)`
- `getPublicConfig()`
- `scanLibrary()`
- `getBook(id)`
- `getBookContent(id)`
- `getProgress(id)`
- `saveProgress(id, progress, options)`
- `saveProgressKeepalive(id, progress)`
- `saveProgressBeacon(id, progress)`
- `saveRating(id, rating)`

Keep backend response keys in snake_case. Convert only where a UI model benefits from camelCase, and keep that conversion close to the API boundary.

One backend compatibility issue must be verified before migration: the current frontend uses `POST /api/books/{id}/progress` for keepalive saves. The API docs list `PUT` only. The React migration should either confirm the backend supports POST or update docs/tests before relying on it.

## Proposed File Structure

```text
frontend/
  components.json
  index.html
  package.json
  src/
    main.tsx
    App.tsx
    styles.css
    api/
      client.ts
      types.ts
    app/
      routes.ts
      storage.ts
    components/
      ui/                  # shadcn generated source
      AppShell.tsx
      IconButton.tsx
      RatingStars.tsx
      EmptyState.tsx
    features/
      shelf/
        ShelfView.tsx
        ShelfFilters.tsx
        ShelfVirtualList.tsx
        FolderOverlay.tsx
        shelfModels.ts
      reader/
        ReaderView.tsx
        ReaderToolbar.tsx
        ReaderContent.tsx
        ReaderProgress.tsx
        ReaderSettingsPanel.tsx
        ReaderSearchPanel.tsx
        AutoScroll.tsx
        useReaderController.ts
        useProgressSaver.ts
    lib/
      reader.ts
      progress.ts
      search.ts
      ids.ts
      format.ts
```

`App.tsx` should compose routes and feature views only. It should not become a direct translation of the current large `App.vue`.

## State Design

Use local React state and hooks, not Redux, Zustand, Pinia, or global stores.

Recommended split:

- `useHashRoute()` owns hash parsing and hashchange subscription.
- `useShelfController()` owns shelf query state, scan state, rating state, and shelf scroll restore.
- `useReaderController(bookId)` owns loading content, paragraph/search indexes, settings, panel state, and scroll restoration.
- `useProgressSaver()` owns progress snapshots, local cache, save timers, in-flight state, failure backoff, and unload/pagehide hooks.
- `useAutoScroll()` or `AutoScroll.tsx` owns RAF scrolling and dial interactions.

Use refs for frequently updated transient values that should not trigger React renders:

- save timers
- scroll timers
- requestAnimationFrame ids
- search index
- paragraph offset map
- match map
- in-flight save flag
- restore-saving block flag

Use `useMemo` for derived lists and indexes, but avoid memoizing simple primitives.

## UI System

Initialize shadcn/ui for a Vite React project. Use shadcn source components where they fit:

- Button
- Input
- Select
- Sheet or Dialog for settings/search panels if the resulting mobile behavior is better
- Slider for font/progress controls only if it can match the reader ergonomics
- Badge or small text treatment for status labels
- Skeleton or Spinner for loading states
- Separator where visual dividers are needed

Do not force every repeated row into a Card. This app is a reading tool; shelf rows should remain dense, scannable list rows. Cards are acceptable for folder overlay book tiles because the current UI already uses a grid-like panel there.

Use lucide-react icons for direct equivalents:

- Search
- RefreshCw
- LoaderCircle
- BookOpen
- FolderClosed
- Star
- ArrowLeft
- Settings
- X
- Type
- Sun
- Moon
- Play
- AlertTriangle

Use tooltips or `title`/accessible labels for icon-only buttons.

## Styling Tokens

Move the existing visual language into Tailwind/shadcn semantic tokens rather than copying all CSS literally.

Required semantic tokens:

- `background`
- `foreground`
- `muted`
- `muted-foreground`
- `card`
- `card-foreground`
- `border`
- `input`
- `primary`
- `primary-foreground`
- `accent`
- `accent-foreground`
- `destructive`
- `ring`

Preserve the two reader themes:

- `paper`
- `night`

Reader text layout should still be controlled by CSS variables:

- `--reader-font-size`
- `--reader-line-height`
- `--reader-paragraph-spacing`

Avoid one-note decorative redesign. This is an operational reading interface: quiet, dense where needed, and optimized for repeated use.

## Virtualization

Replace `@tanstack/vue-virtual` with `@tanstack/react-virtual`.

Reader virtualization:

- Scroll element is the `.reader-content` element.
- Estimated row height starts near the current `80`.
- Overscan remains around `12`.
- Call virtualizer measurement after:
  - content loads
  - font size changes
  - line height changes
  - paragraph spacing changes
  - search highlight state changes if row heights can change

Shelf virtualization:

- Continue virtualizing mixed folder/book rows.
- Prefer a container-based virtualizer if the redesigned shelf uses an internal scroll area.
- If keeping window scroll, preserve the current scroll-margin behavior and test return-from-reader restoration.

## Progress Saving Contract

Port `progress.js` behavior first and test it before wiring UI.

Required payload:

```json
{
  "char_offset": 300,
  "percent": 0.35,
  "source": "scroll",
  "client_id": "client-id",
  "session_id": "session-id",
  "allow_backward": false
}
```

Save sources to preserve:

- `open_mark`
- `scroll`
- `periodic`
- `interaction_end`
- `search`
- `seek`
- `route_change`
- `go_shelf`
- `visibility_hidden`
- `flush`

Rules:

- Never save progress while restoring initial scroll.
- Never save suspicious reset snapshots unless `allowBackward` is true.
- Snapshot locally before async network saves.
- Update shelf item progress after local or server save.
- On normal scroll, debounce network writes.
- On background/unload, prefer `sendBeacon`, then keepalive request.
- On repeated failures, back off periodic saves.

## Search Contract

Port `search.js` as pure TypeScript first.

Required behavior:

- Case-insensitive search.
- Preserve original-text indexes for highlight slicing.
- Return all matches in paragraph order.
- Maintain stable result ids in the format currently used or a documented equivalent.
- Selecting a result scrolls to the paragraph and allows backward progress save.
- Highlight active match differently from other matches.

## Routing Contract

Use a small hash router:

```ts
type Route =
  | { name: "shelf" }
  | { name: "reader"; bookId: number }
  | { name: "tab-a" };
```

Route transitions from reader must flush current progress before changing hash.

## Accessibility Requirements

- Book rows and folder rows must be keyboard-openable with Enter and Space.
- Folder overlay closes with Escape.
- Icon-only buttons must have accessible labels.
- Range controls must expose labels and current values.
- Dialog/sheet titles must exist, visually hidden if needed.
- Focus should move into overlays/panels and return to the initiating control when practical.
- Reader content click-to-toggle controls must not block text selection or panel interactions.

## Testing Plan

### Unit Tests

Keep the current pure helper coverage, migrated to TypeScript:

- paragraph splitting and offsets
- settings parse/clamp
- size/progress formatting
- progress payload metadata
- suspicious reset detection
- search indexes and highlight slicing

Add tests for:

- shelf item normalization from `items`
- legacy shelf fallback from `books`/`folders`
- folder effective search behavior
- hash route parsing

### Playwright

Migrate the existing mocked shelf test and keep `page.route()` based API mocks.

Required E2E flows:

- shelf loads mocked mixed items
- clicking book opens `#/reader/1`
- reader renders paragraphs
- scroll causes progress write
- rating toggles call rating API and update UI
- folder opens, paginates, closes by Escape
- reader settings update text layout and persist after reload
- search panel finds a match, scrolls to it, and highlights it
- progress seek writes an allow-backward payload

Keep the real-progress test as an optional/manual or separate script if it depends on a live backend at `https://127.0.0.1:234`.

### Required Commands

After migration changes:

```bash
npm run test --prefix frontend
npx playwright test --config frontend/playwright.config.js
npm run build --prefix frontend
cargo clippy
```

Use Browser plugin visual validation for UI work when available. Capture desktop and mobile screenshots for the shelf and reader.

## Migration Phases

### Phase 1: Tooling Baseline

- Replace Vue dependencies with React dependencies.
- Add TypeScript, React plugin, Tailwind, shadcn/ui, lucide-react, and @tanstack/react-virtual.
- Keep Vite dev proxy behavior.
- Keep `npm run dev`, `npm run build`, `npm run test`, and Playwright scripts.
- Build a minimal React app that can load `/api/config`.

### Phase 2: Pure Logic Port

- Port `reader.js`, `progress.js`, and `search.js` to TypeScript.
- Preserve current unit tests and add route/shelf normalization tests.
- Do not build UI behavior until these tests pass.

### Phase 3: API Client And Models

- Port `api.js` to typed API modules.
- Add model types for config, book summary, shelf item, folder summary, book content, progress, and scan result.
- Keep all request paths and query param names unchanged.

### Phase 4: Shelf

- Implement shelf controller and shell.
- Implement filters, scan button, empty/loading/error states, mixed virtual list, rating stars, and tab bar.
- Implement folder overlay.
- Port the mocked shelf Playwright test.

### Phase 5: Reader Core

- Implement reader content loading, paragraph virtualization, scroll restore, progress range, controls toolbar, settings panel, and paper/night themes.
- Port progress save behavior and verify with E2E.

### Phase 6: Reader Advanced Tools

- Implement in-book search panel and highlighting.
- Implement auto-scroll floating button and speed dial.
- Add responsive/mobile validation.

### Phase 7: Cleanup And Cutover

- Remove Vue-only files and dependencies.
- Remove `@vitejs/plugin-vue`, `vue`, `lucide-vue-next`, and `@tanstack/vue-virtual`.
- Ensure `frontend/dist/` is rebuilt by the React app.
- Update `AGENTS.md`, `docs/architecture.md`, and any frontend convention docs from Vue to React.

## Acceptance Criteria

- The app is React + Vite and no Vue runtime dependency remains.
- Production build emits static assets under `frontend/dist/` and is served by the existing Rust backend.
- All existing API calls remain compatible with `docs/api.md`, except any explicitly documented fix for progress keepalive POST.
- Unit tests pass.
- Mocked Playwright flows pass.
- `cargo clippy` passes.
- Browser visual QA confirms:
  - shelf is not blank
  - reader is not blank
  - no framework error overlay
  - no relevant console errors
  - desktop and mobile layouts do not overlap or clip controls
- No progress reset regression appears in scroll, reload, route-change, or unload flows.

## Key Risks

- Progress saving is the highest-risk behavior. Port and test it before visual polish.
- Virtualized scroll restoration can drift after typography changes. It needs browser validation, not just unit tests.
- shadcn components may introduce too much padding for a reader UI. Use source components selectively and keep shelf/reader density intentional.
- React StrictMode can expose duplicate effect behavior. Effects that save progress or start timers must be idempotent and cleaned up carefully.
- Current `App.vue` mixes many responsibilities. A direct component-by-component translation will preserve complexity instead of reducing it.

