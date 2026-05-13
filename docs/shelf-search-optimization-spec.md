# Shelf and Search Optimization Spec

## Background

The current shelf experience has two core problems:

- Folder entries and book entries are not truly mixed. `GET /api/shelf` returns `books` and `folders` as separate lists, and `frontend/src/App.vue` only sorts the combined list when `sort === "title"`. For the default `recent`, `progress`, and `rating` sorts, folders always render before books.
- Shelf search does not work. The search/filter watcher calls `loadBooks()`, but `loadBooks()` always calls `getShelf()` with no query parameters. `GET /api/books` supports `search`, `status`, `min_rating`, `sort`, and `folder_tag`, but the visible shelf no longer uses that endpoint for the root list.

There is also a likely reader-search correctness bug: `frontend/src/search.js` normalizes paragraph text by collapsing whitespace before searching, then uses match indexes from the normalized string to slice the original string. Any paragraph containing repeated whitespace or line-break-like spacing can highlight or jump to the wrong text.

## Goals

1. Display folders and root-level TXT novels in one sorted shelf list.
2. Make shelf search and filters apply consistently to both books and folders.
3. Keep folder grouping behavior: a top-level subdirectory with multiple books appears as a folder; a subdirectory with one matching book collapses to a book row.
4. Preserve reading progress, rating, and moved-file handling.
5. Make reader in-book search reliable for whitespace-heavy TXT files.

## Non-Goals

- Do not add full-text database indexing for book contents in this iteration.
- Do not introduce router, Pinia, or global frontend state.
- Do not redesign the reader layout beyond what is needed for search and shelf correctness.

## Product Behavior

### Shelf List

The main shelf is a single list of items:

- `book`: a directly openable TXT novel.
- `folder`: a grouped directory containing two or more matching books.

Sorting applies to the unified list:

- `recent`: sort by latest activity descending. For a book, use `progress.updated_at` then `book.updated_at`. For a folder, use the max latest activity among its contained matching books.
- `title`: sort by display name ascending, Chinese-aware on the frontend and `COLLATE NOCASE` fallback on the backend.
- `progress`: sort by progress descending. For a folder, use max progress among contained matching books.
- `rating`: sort by rating descending. For a folder, use max rating among contained matching books.

Tie-breakers:

1. Display name ascending.
2. Item type stable order: folder before book when the same name is impossible to distinguish.
3. Book id for books.

### Shelf Search

Search is title-based for now.

When `search` is non-empty:

- Root-level books match when their title contains the query.
- Folder contents are searched by book title.
- A folder is shown only if at least two books inside that folder match the query.
- If exactly one book inside a folder matches, that book is shown directly in the mixed shelf list.
- The folder display name itself may also match. If it does, all books in that folder are considered matching for grouping and folder counts.

Filters (`status`, `min_rating`) apply before grouping:

- A folder count is the number of contained books after filters.
- A folder disappears if no contained book remains after filters.
- A single remaining contained book collapses to a book row.

### Folder Overlay

Opening a folder shows the same filtered/sorted contents that caused the folder to appear.

For example, if the main shelf is searching `三体` and opens a folder, the overlay should only show matching books in that folder unless the folder name itself matched the query. The overlay should inherit:

- `search`
- `status`
- `min_rating`
- `sort`, with `title` as the default only when the shelf sort is not relevant to the overlay UX.

## API Contract

### Preferred Change: Queryable Shelf Endpoint

Extend `GET /api/shelf` to accept the same query parameters as `GET /api/books`:

- `search`
- `status`
- `min_rating`
- `sort`

Response:

```json
{
  "items": [
    {
      "type": "folder",
      "name": "Author",
      "book_count": 3,
      "max_rating": 5,
      "max_progress": 0.87,
      "latest_activity": "2026-05-13T12:00:00.000Z"
    },
    {
      "type": "book",
      "book": {
        "id": 1,
        "title": "Book",
        "file_path": "C:\\books\\Book.txt",
        "file_hash": "sha256",
        "size": 1024,
        "mtime": 1760000000,
        "encoding": "UTF-8",
        "folder_tag": null,
        "rating": 5,
        "created_at": "2026-04-29T01:00:00.000Z",
        "updated_at": "2026-04-29T01:00:00.000Z",
        "progress": null
      }
    }
  ]
}
```

Compatibility:

- During migration, keep `books` and `folders` in the response if needed by existing code/tests.
- New frontend code should consume `items`.

### Folder Books Endpoint

Keep `GET /api/books?folder_tag=...`, but ensure it accepts and applies:

- `search`
- `status`
- `min_rating`
- `sort`

Document `folder_tag` in `docs/api.md`; it is currently used by `FolderOverlay.vue` but missing from the API docs.

## Implementation Plan

### Backend

1. Reuse `BookListQuery` for `shelf`.
2. Fetch filtered books through `list_books_internal`.
3. Group by `folder_tag` after filtering.
4. Build `ShelfItem` values:
   - no `folder_tag`: `book`
   - grouped tag with one filtered book: `book`
   - grouped tag with two or more filtered books: `folder`
5. Sort `ShelfItem` server-side according to normalized `sort`.
6. Add `max_progress` to `FolderSummary`.
7. Update `docs/api.md`.

### Frontend

1. Replace `getShelf()` with `getShelf(query)` in `frontend/src/api.js`.
2. Pass `{ search, status, minRating, sort }` from `loadBooks()`.
3. Store `shelf.items` instead of separately recombining `shelf.books` and `shelf.folders`.
4. Keep local cached progress merging for book items.
5. Pass active shelf query props into `FolderOverlay`.
6. Remove duplicate client-side shelf status filtering once backend filtering is authoritative.
7. Keep keyboard and rating behavior unchanged.

### Reader Search

1. Stop using indexes from whitespace-collapsed strings against original strings.
2. Either:
   - search a lowercased original string without whitespace collapse, or
   - build a normalized-to-original index map when normalizing.
3. Add unit tests for repeated spaces, tabs, and mixed Chinese/ASCII text.
4. Ensure `highlightParagraph()` receives original-text indexes only.

## Test Plan

Always run:

```bash
cargo clippy
npm run test --prefix frontend
```

Also run because this changes shelf UI flow:

```bash
npx playwright test --config frontend/playwright.config.js
```

Add or update tests:

- Rust unit test: `GET /api/shelf?sort=recent` returns folder and book items in one activity-sorted list.
- Rust unit test: `GET /api/shelf?search=...` collapses a folder to a single book when only one child matches.
- Rust unit test: `GET /api/books?folder_tag=...&search=...` filters folder contents.
- Vitest: reader search highlights correct original substring when whitespace is repeated.
- Playwright: typing in shelf search changes visible rows and can find a book inside a folder.
- Playwright: default shelf ordering can place a recently read root book before an older folder.

## Acceptance Criteria

- Typing in the main shelf search input changes the visible shelf results without a page reload.
- Search can find books inside folders.
- Folders and books are mixed under all sort modes, not only title sort.
- Folder counts reflect the current search/filter result.
- A folder with one remaining matching book appears as that book, not as a folder.
- In-book search highlights the exact matched text and clicking a result scrolls to the correct paragraph.
- Existing progress save, rating, scan, and folder open flows continue to pass tests.
