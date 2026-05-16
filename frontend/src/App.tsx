import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer, useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  FolderClosed,
  LoaderCircle,
  Moon,
  RefreshCw,
  Search,
  Settings,
  Star,
  Sun,
  Type,
  X,
} from "lucide-react";
import {
  getBookContent,
  getProgress,
  getPublicConfig,
  getShelf,
  saveProgress,
  saveProgressBeacon,
  saveProgressKeepalive,
  saveRating,
  scanLibrary,
} from "./api";
import {
  PROGRESS_CACHE_KEY,
  isSuspiciousLocalReset,
  normalizeProgress,
  savePayload,
} from "./progress";
import { buildParagraphOffsetMap, buildParagraphs, findParagraphIndex, formatPercent, formatSize, parseSettings } from "./reader";
import { buildMatchMap, buildSearchIndex, highlightParagraph, searchWithIndex } from "./search";
import AutoScroll from "./AutoScroll";
import FolderOverlay from "./FolderOverlay";

const STORAGE_KEY = "txt-reader-settings";
const CLIENT_ID_KEY = "txt-reader-client-id";
const SAVE_BASE_INTERVAL = 3000;

type Route = { name: "shelf"; bookId: null } | { name: "reader"; bookId: number } | { name: "tab-a"; bookId: null };

function parseRoute(): Route {
  const readerMatch = window.location.hash.match(/^#\/reader\/(\d+)/);
  if (readerMatch) return { name: "reader", bookId: Number(readerMatch[1]) };
  if (/^#\/a$/.test(window.location.hash)) return { name: "tab-a", bookId: null };
  return { name: "shelf", bookId: null };
}

function createId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function loadClientId() {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const next = createId();
  localStorage.setItem(CLIENT_ID_KEY, next);
  return next;
}

function afterNextPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

export default function App() {
  const clientId = useMemo(loadClientId, []);
  const sessionId = useMemo(createId, []);
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [settings, setSettings] = useState(() => parseSettings(localStorage.getItem(STORAGE_KEY)));
  const [shelf, setShelf] = useState({
    items: [] as any[],
    search: "",
    status: "all",
    minRating: "",
    sort: "recent",
    scrollTop: 0,
    config: null as any,
    loading: false,
    scanning: false,
    ratingBookId: null as number | null,
    error: "",
    scanMessage: "",
    folderTag: null as string | null,
  });
  const [reader, setReader] = useState({
    loading: false,
    error: "",
    toast: "",
    book: null as any,
    paragraphs: [] as any[],
    searchOpen: false,
    searchQuery: "",
    searchResults: [] as any[],
    activeSearchId: "",
    progress: null as any,
    visiblePercent: 0,
    controlsVisible: false,
    progressSeeking: false,
    pendingSeekPercent: null as number | null,
    settingsOpen: false,
    autoScrollPlaying: false,
    autoScrollSpeed: 5,
  });

  const readerRoot = useRef<HTMLElement | null>(null);
  const searchResultsRoot = useRef<HTMLDivElement | null>(null);
  const shelfListRoot = useRef<HTMLDivElement | null>(null);
  const shelfScrollMargin = useRef(0);
  const saveTimer = useRef<number | null>(null);
  const scrollTimer = useRef<number | null>(null);
  const shelfTimer = useRef<number | null>(null);
  const shelfMeasureFrame = useRef<number | null>(null);
  const periodicSaveTimer = useRef<number | null>(null);
  const progressFrame = useRef<number | null>(null);
  const saveInFlight = useRef(false);
  const restoreSavingBlocked = useRef(false);
  const lastSaveSucceeded = useRef(true);
  const saveFailureCount = useRef(0);
  const toastTimer = useRef<number | null>(null);
  const searchDebounceTimer = useRef<number | null>(null);
  const searchIndex = useRef<any>(null);
  const paraOffsetMap = useRef<any[] | null>(null);
  const matchMap = useRef<Map<number, any[]> | null>(null);
  const readerRef = useRef(reader);
  const routeRef = useRef(route);

  useEffect(() => { readerRef.current = reader; }, [reader]);
  useEffect(() => { routeRef.current = route; }, [route]);

  const shelfVirtualizer = useWindowVirtualizer({
    count: shelf.items.length,
    estimateSize: () => 86,
    overscan: 8,
    gap: 10,
    scrollMargin: shelfScrollMargin.current,
    enabled: route.name === "shelf" && shelf.items.length > 0,
  });

  const virtualizer = useVirtualizer({
    count: reader.paragraphs.length,
    getScrollElement: () => readerRoot.current,
    estimateSize: () => 80,
    overscan: 12,
  });

  const themeClass = `theme-${settings.theme}`;
  const libraryHint = shelf.config?.library_dirs?.join(", ") || "novels";
  const readerProgressValue = Math.round(reader.visiblePercent * 1000);
  const readerProgressLabel = `${Math.round(reader.visiblePercent * 100)}%`;

  function updateReader(patch: Partial<typeof reader> | ((value: typeof reader) => typeof reader)) {
    setReader((current) => typeof patch === "function" ? patch(current) : { ...current, ...patch });
  }

  function updateShelf(patch: Partial<typeof shelf> | ((value: typeof shelf) => typeof shelf)) {
    setShelf((current) => typeof patch === "function" ? patch(current) : { ...current, ...patch });
  }

  const canSaveReaderProgress = useCallback(() => {
    const currentRoute = routeRef.current;
    const currentReader = readerRef.current;
    return currentRoute.name === "reader"
      && currentReader.book
      && currentReader.paragraphs.length > 0
      && !currentReader.loading
      && !restoreSavingBlocked.current;
  }, []);

  const currentScrollPercent = useCallback(() => {
    const el = readerRoot.current;
    if (!el) return 0;
    const maxScroll = Math.max(1, el.scrollHeight - el.clientHeight);
    return Math.min(1, Math.max(0, el.scrollTop / maxScroll));
  }, []);

  const offsetForPercent = useCallback((percent: number) => {
    const safePercent = Math.min(1, Math.max(0, percent));
    if (!searchIndex.current || !paraOffsetMap.current) return 0;
    const targetOffset = safePercent * searchIndex.current.totalLength;
    const index = findParagraphIndex(targetOffset, paraOffsetMap.current);
    const paragraph = readerRef.current.paragraphs[index];
    return paragraph ? paragraph.offset : 0;
  }, []);

  const progressPayload = useCallback(() => {
    const currentReader = readerRef.current;
    const percent = currentReader.pendingSeekPercent ?? currentScrollPercent();
    return { char_offset: offsetForPercent(percent), percent };
  }, [currentScrollPercent, offsetForPercent]);

  function progressMeta(source: string, options: any = {}) {
    return {
      source,
      clientId,
      sessionId,
      allowBackward: Boolean(options.allowBackward),
    };
  }

  function progressCache() {
    try {
      return JSON.parse(localStorage.getItem(PROGRESS_CACHE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function loadCachedProgress(bookId: number) {
    return normalizeProgress(bookId, progressCache()[bookId]) || null;
  }

  function cacheProgress(bookId: number, progress: any, options: any = {}) {
    const cachedProgress = normalizeProgress(bookId, {
      ...progress,
      dirty: options.dirty ?? progress.dirty,
    }, {
      dirty: Boolean(options.dirty),
      updated_at: new Date().toISOString(),
    });
    try {
      const cache = JSON.parse(localStorage.getItem(PROGRESS_CACHE_KEY) || "{}");
      cache[bookId] = cachedProgress;
      localStorage.setItem(PROGRESS_CACHE_KEY, JSON.stringify(cache));
    } catch {
      localStorage.setItem(PROGRESS_CACHE_KEY, JSON.stringify({ [bookId]: cachedProgress }));
    }
    return cachedProgress;
  }

  function updateShelfBookProgress(progress: any) {
    updateShelf((current) => ({
      ...current,
      items: current.items.map((item) => item.type === "book" && item.id === progress.book_id ? { ...item, progress } : item),
    }));
  }

  const snapshotProgress = useCallback((options: any = {}) => {
    const currentReader = readerRef.current;
    if (!canSaveReaderProgress()) return null;
    const payload = progressPayload();
    if (isSuspiciousLocalReset(payload, currentReader.progress, options)) {
      return currentReader.progress;
    }
    const progress = options.persistLocal === false
      ? normalizeProgress(currentReader.book.book_id, payload, {
        dirty: options.dirty ?? true,
        updated_at: new Date().toISOString(),
      })
      : cacheProgress(currentReader.book.book_id, payload, { dirty: options.dirty ?? true });
    if (!progress) return currentReader.progress;
    updateReader({ progress, visiblePercent: progress.percent });
    updateShelfBookProgress(progress);
    return progress;
  }, [canSaveReaderProgress, progressPayload]);

  function showToast(message: string) {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    updateReader({ toast: message });
    toastTimer.current = window.setTimeout(() => updateReader({ toast: "" }), 4500);
  }

  function applySavedProgress(saved: any) {
    const currentReader = readerRef.current;
    const normalized = normalizeProgress(currentReader.book?.book_id, saved, { dirty: false });
    if (!normalized) return currentReader.progress;
    const cached = cacheProgress(normalized.book_id, normalized, { dirty: false });
    updateReader({ progress: cached });
    updateShelfBookProgress(cached);
    return cached;
  }

  const saveProgressInBackground = useCallback((source = "background", options: any = {}) => {
    const currentReader = readerRef.current;
    const progress = options.reuseCurrent ? currentReader.progress : snapshotProgress({ source });
    if (!progress || !currentReader.book) return;
    const payload = savePayload(progress, progressMeta(source));
    if (!saveProgressBeacon(currentReader.book.book_id, payload)) {
      void saveProgressKeepalive(currentReader.book.book_id, payload)
        .then((saved: any) => applySavedProgress(saved))
        .catch(() => {});
    }
  }, [snapshotProgress]);

  const saveProgressNow = useCallback(async (options: any = {}) => {
    const currentReader = readerRef.current;
    const source = options.source || "debounced";
    const progress = options.reuseCurrent ? currentReader.progress : snapshotProgress(options);
    if (!progress || !currentReader.book || saveInFlight.current) return progress;
    saveInFlight.current = true;
    try {
      const saved = await saveProgress(
        currentReader.book.book_id,
        savePayload(progress, progressMeta(source, options)),
        options,
      );
      lastSaveSucceeded.current = true;
      return applySavedProgress(saved);
    } catch (error) {
      lastSaveSucceeded.current = false;
      showToast(`保存失败: ${(error as Error).message}`);
      return progress;
    } finally {
      saveInFlight.current = false;
    }
  }, [snapshotProgress]);

  const scheduleProgressSave = useCallback((delay = 650, options: any = {}) => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveProgressNow({ quiet: true, ...options }), delay);
  }, [saveProgressNow]);

  const updateVisibleProgress = useCallback(() => {
    updateReader({ visiblePercent: currentScrollPercent() });
  }, [currentScrollPercent]);

  function scheduleVirtualMeasure() {
    window.requestAnimationFrame(() => {
      virtualizer.measure();
      updateVisibleProgress();
    });
  }

  const scheduleShelfMeasure = useCallback(() => {
    if (routeRef.current.name !== "shelf") return;
    if (shelfMeasureFrame.current) window.cancelAnimationFrame(shelfMeasureFrame.current);
    shelfMeasureFrame.current = window.requestAnimationFrame(() => {
      shelfMeasureFrame.current = null;
      const list = shelfListRoot.current;
      if (!list) return;
      shelfScrollMargin.current = list.getBoundingClientRect().top + window.scrollY;
      shelfVirtualizer.measure();
    });
  }, [shelfVirtualizer]);

  function applyCachedProgress(books: any[]) {
    const cache = progressCache();
    return books.map((book) => ({
      ...book,
      progress: normalizeProgress(book.id, cache[book.id]) || normalizeProgress(book.id, book.progress),
    }));
  }

  function normalizeShelfItems(data: any) {
    if (Array.isArray(data.items)) {
      return data.items.map((item: any) => {
        if (item.type === "book" && item.book) {
          const [book] = applyCachedProgress([item.book]);
          return { type: "book", ...book };
        }
        if (item.type === "folder" && item.folder) {
          return {
            type: "folder",
            name: item.folder.name,
            bookCount: item.folder.book_count,
            maxRating: item.folder.max_rating,
            maxProgress: item.folder.max_progress,
            latestActivity: item.folder.latest_activity,
          };
        }
        return item;
      });
    }
    const folders = (data.folders || []).map((f: any) => ({ type: "folder", name: f.name, bookCount: f.book_count }));
    const books = applyCachedProgress(data.books || []).map((b) => ({ type: "book", ...b }));
    return [...folders, ...books];
  }

  const loadBooks = useCallback(async () => {
    updateShelf({ loading: true, error: "" });
    try {
      const current = await new Promise<typeof shelf>((resolve) => setShelf((value) => {
        resolve(value);
        return value;
      }));
      const data = await getShelf({
        search: current.search,
        status: current.status,
        minRating: current.minRating,
        sort: current.sort,
      });
      updateShelf({ items: normalizeShelfItems(data), loading: false });
      window.requestAnimationFrame(scheduleShelfMeasure);
    } catch (error) {
      updateShelf({ error: (error as Error).message, loading: false });
    }
  }, [scheduleShelfMeasure]);

  async function loadConfig() {
    try {
      updateShelf({ config: await getPublicConfig() });
    } catch {
      updateShelf({ config: null });
    }
  }

  async function runScan() {
    if (shelf.scanning) return;
    updateShelf({ scanning: true, error: "", scanMessage: "" });
    try {
      const result = await scanLibrary();
      const scanMessage = [
        `扫描 ${result.scanned} 本`,
        `新增 ${result.added || 0} 本`,
        `更新 ${result.updated || 0} 本`,
        `跳过 ${result.skipped || 0} 本`,
        `移除 ${result.removed} 本`,
        ...(result.errors?.length ? [`错误 ${result.errors.length} 个`] : []),
      ].join(" · ");
      updateShelf({ scanMessage });
      await loadBooks();
      await loadConfig();
    } catch (error) {
      updateShelf({ error: (error as Error).message });
    } finally {
      updateShelf({ scanning: false });
    }
  }

  function restoreScroll(progress: any) {
    if (!progress) return;
    if (Number.isFinite(progress.percent) && progress.percent > 0) {
      restoreScrollPercent(progress.percent || 0);
      return;
    }
    if (progress.char_offset > 0 && paraOffsetMap.current) {
      const index = findParagraphIndex(progress.char_offset, paraOffsetMap.current);
      if (index > 0) {
        virtualizer.scrollToIndex(index, { align: "start" });
        return;
      }
    }
    restoreScrollPercent(0);
  }

  function restoreScrollPercent(percent: number) {
    const el = readerRoot.current;
    if (!el) return;
    window.requestAnimationFrame(() => {
      const maxScroll = Math.max(1, el.scrollHeight - el.clientHeight);
      el.scrollTo({ top: maxScroll * Math.min(1, Math.max(0, percent)) });
      window.requestAnimationFrame(updateVisibleProgress);
    });
  }

  const openBook = useCallback(async (bookId: number) => {
    updateReader({
      loading: true,
      error: "",
      book: null,
      paragraphs: [],
      progress: null,
      visiblePercent: 0,
      controlsVisible: false,
      progressSeeking: false,
      pendingSeekPercent: null,
      searchOpen: false,
      searchQuery: "",
      searchResults: [],
      activeSearchId: "",
      autoScrollPlaying: false,
    });
    searchIndex.current = null;
    paraOffsetMap.current = null;
    matchMap.current = null;
    restoreSavingBlocked.current = true;
    if (readerRoot.current) readerRoot.current.scrollTop = 0;
    try {
      const [content, progress] = await Promise.all([getBookContent(bookId), getProgress(bookId)]);
      const serverProgress = normalizeProgress(bookId, progress, { dirty: false });
      const restoredProgress = serverProgress || loadCachedProgress(bookId);
      const paragraphs = buildParagraphs(content.content);
      searchIndex.current = buildSearchIndex(paragraphs);
      paraOffsetMap.current = buildParagraphOffsetMap(paragraphs);
      updateReader({
        book: content,
        progress: restoredProgress,
        visiblePercent: restoredProgress?.percent || 0,
        paragraphs,
        controlsVisible: window.matchMedia("(min-width: 760px)").matches,
        loading: false,
      });
      await afterNextPaint();
      restoreScroll(restoredProgress);
      await afterNextPaint();
      updateVisibleProgress();
      window.setTimeout(() => {
        restoreSavingBlocked.current = false;
      }, 250);
      if (!serverProgress) scheduleProgressSave(300, { force: true, source: "open_mark" });
    } catch (error) {
      updateReader({ error: (error as Error).message, loading: false });
      restoreSavingBlocked.current = false;
    }
  }, [scheduleProgressSave, updateVisibleProgress]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    scheduleVirtualMeasure();
  }, [settings.fontSize, settings.lineHeight, settings.paragraphSpacing, settings.theme]);

  useEffect(() => {
    function onHashChange() {
      const next = parseRoute();
      const current = routeRef.current;
      if (current.name === "reader" && (!next.bookId || next.bookId !== current.bookId)) {
        saveProgressInBackground("route_change", { reuseCurrent: true });
      }
      if (next.name !== "reader") updateReader({ settingsOpen: false });
      setRoute(next);
      if (next.name === "shelf") {
        window.requestAnimationFrame(() => window.scrollTo({ top: shelf.scrollTop || 0 }));
      }
    }

    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [saveProgressInBackground, shelf.scrollTop]);

  useEffect(() => {
    loadConfig();
    void loadBooks();
  }, []);

  useEffect(() => {
    if (route.name === "reader" && route.bookId) void openBook(route.bookId);
  }, [openBook, route]);

  useEffect(() => {
    if (shelfTimer.current) window.clearTimeout(shelfTimer.current);
    shelfTimer.current = window.setTimeout(loadBooks, 180);
  }, [shelf.search, shelf.status, shelf.minRating, shelf.sort]);

  useEffect(() => {
    function flushProgress(source: any = "flush") {
      if (canSaveReaderProgress()) {
        if (saveTimer.current) window.clearTimeout(saveTimer.current);
        saveProgressInBackground(typeof source === "string" ? source : "flush", { reuseCurrent: true });
      }
    }
    function onVisibilityChange() {
      if (document.visibilityState === "hidden") flushProgress("visibility_hidden");
    }
    function onReaderInteractionEnd() {
      if (canSaveReaderProgress()) {
        snapshotProgress({ source: "interaction_end" });
        scheduleProgressSave(300, { source: "interaction_end" });
      }
    }
    function scheduleNextPeriodicSave(delay = SAVE_BASE_INTERVAL) {
      if (periodicSaveTimer.current) window.clearTimeout(periodicSaveTimer.current);
      periodicSaveTimer.current = window.setTimeout(periodicProgressSave, delay);
    }
    function periodicProgressSave() {
      const currentReader = readerRef.current;
      if (!canSaveReaderProgress() || currentReader.loading) {
        scheduleNextPeriodicSave(SAVE_BASE_INTERVAL);
        return;
      }
      snapshotProgress({ source: "periodic" });
      saveProgressNow({ quiet: true, source: "periodic", reuseCurrent: true }).then(() => {
        if (lastSaveSucceeded.current) {
          saveFailureCount.current = 0;
          scheduleNextPeriodicSave(SAVE_BASE_INTERVAL);
        } else {
          saveFailureCount.current += 1;
          scheduleNextPeriodicSave(SAVE_BASE_INTERVAL * Math.pow(4, saveFailureCount.current));
        }
      });
    }

    window.addEventListener("beforeunload", flushProgress);
    window.addEventListener("pagehide", flushProgress);
    window.addEventListener("touchend", onReaderInteractionEnd, { passive: true });
    window.addEventListener("pointerup", onReaderInteractionEnd, { passive: true });
    window.addEventListener("resize", scheduleShelfMeasure, { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    scheduleNextPeriodicSave(SAVE_BASE_INTERVAL);
    return () => {
      window.removeEventListener("beforeunload", flushProgress);
      window.removeEventListener("pagehide", flushProgress);
      window.removeEventListener("touchend", onReaderInteractionEnd);
      window.removeEventListener("pointerup", onReaderInteractionEnd);
      window.removeEventListener("resize", scheduleShelfMeasure);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      [saveTimer, scrollTimer, shelfTimer, periodicSaveTimer, toastTimer, searchDebounceTimer].forEach((timer) => {
        if (timer.current) window.clearTimeout(timer.current);
      });
      if (progressFrame.current) window.cancelAnimationFrame(progressFrame.current);
      if (shelfMeasureFrame.current) window.cancelAnimationFrame(shelfMeasureFrame.current);
    };
  }, [canSaveReaderProgress, saveProgressInBackground, saveProgressNow, scheduleProgressSave, scheduleShelfMeasure, snapshotProgress]);

  useEffect(() => {
    if (searchDebounceTimer.current) window.clearTimeout(searchDebounceTimer.current);
    searchDebounceTimer.current = window.setTimeout(() => {
      const currentReader = readerRef.current;
      if (!currentReader.book) {
        matchMap.current = null;
        updateReader({ searchResults: [], activeSearchId: "" });
        return;
      }
      const results = searchWithIndex(searchIndex.current, currentReader.searchQuery);
      matchMap.current = buildMatchMap(results);
      updateReader((current) => ({
        ...current,
        searchResults: results,
        activeSearchId: results.some((item: any) => item.id === current.activeSearchId) ? current.activeSearchId : results[0]?.id || "",
      }));
    }, 200);
  }, [reader.searchQuery, reader.paragraphs.length]);

  function onReaderScroll() {
    if (!canSaveReaderProgress()) return;
    if (progressFrame.current === null) {
      progressFrame.current = window.requestAnimationFrame(() => {
        progressFrame.current = null;
        snapshotProgress({ source: "scroll", persistLocal: false });
      });
    }
    if (scrollTimer.current) window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => scheduleProgressSave(450, { source: "scroll" }), 120);
  }

  async function goShelf() {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    await saveProgressNow({ quiet: true, source: "go_shelf", reuseCurrent: true });
    window.location.hash = "#/";
  }

  function openReader(bookId: number) {
    updateShelf({ scrollTop: window.scrollY });
    window.location.hash = `#/reader/${bookId}`;
  }

  function switchTab(name: "n" | "a") {
    updateShelf({ folderTag: null });
    window.location.hash = name === "a" ? "#/a" : "#/";
  }

  async function updateRating(book: any, rating: number) {
    const nextRating = book.rating === rating ? null : rating;
    updateShelf({ ratingBookId: book.id, error: "" });
    try {
      const updated = await saveRating(book.id, nextRating);
      updateShelf((current) => ({
        ...current,
        items: current.items.map((item) => item.type === "book" && item.id === book.id ? { type: "book", ...updated } : item),
        ratingBookId: null,
      }));
    } catch (error) {
      updateShelf({ error: (error as Error).message, ratingBookId: null });
    }
  }

  function selectSearchResult(result: any) {
    updateReader({ activeSearchId: result.id, controlsVisible: true });
    if (paraOffsetMap.current) {
      const index = findParagraphIndex(result.paragraphOffset, paraOffsetMap.current);
      if (index >= 0) {
        virtualizer.scrollToIndex(index, { align: "start" });
        window.requestAnimationFrame(updateVisibleProgress);
      }
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        snapshotProgress({ source: "search", allowBackward: true });
        scheduleProgressSave(250, { source: "search", allowBackward: true });
      });
    });
  }

  function seekProgress(event: React.ChangeEvent<HTMLInputElement>) {
    const value = Number(event.target.value) / 1000;
    updateReader({ pendingSeekPercent: value, visiblePercent: value });
    const el = readerRoot.current;
    if (el) {
      const maxScroll = Math.max(1, el.scrollHeight - el.clientHeight);
      el.scrollTo({ top: maxScroll * value, behavior: "auto" });
    }
  }

  function endSeek() {
    updateReader({ progressSeeking: false });
    snapshotProgress({ source: "seek", allowBackward: true });
    scheduleProgressSave(250, { source: "seek", allowBackward: true });
    window.setTimeout(() => updateReader({ pendingSeekPercent: null }), 1200);
  }

  function paragraphMatches(offset: number) {
    return matchMap.current?.get(offset) || [];
  }

  const shelfVirtualRows = shelfVirtualizer.getVirtualItems().map((virtualRow) => ({
    virtualRow,
    item: shelf.items[virtualRow.index],
  })).filter(({ item }) => Boolean(item));

  return (
    <main className={`app-shell ${themeClass}`}>
      {route.name === "shelf" && (
        <section className="shelf-view">
          <header className="shelf-header">
            <div>
              <p className="eyebrow">TXT Reader</p>
              <h1>书架</h1>
            </div>
            <button className="icon-button" type="button" disabled={shelf.scanning} onClick={runScan} title="扫描书库">
              {shelf.scanning ? <LoaderCircle className="spin" size={22} /> : <RefreshCw size={22} />}
            </button>
          </header>

          <div className="search-row">
            <Search size={20} />
            <input value={shelf.search} onChange={(event) => updateShelf({ search: event.target.value })} type="search" placeholder="搜索小说" />
          </div>

          <div className="filter-bar">
            <select value={shelf.status} onChange={(event) => updateShelf({ status: event.target.value })} aria-label="阅读状态">
              <option value="all">全部状态</option>
              <option value="unread">未读</option>
              <option value="reading">在读</option>
              <option value="finished">已读</option>
            </select>
            <select value={shelf.minRating} onChange={(event) => updateShelf({ minRating: event.target.value })} aria-label="最低评分">
              <option value="">全部评分</option>
              <option value="1">1 星以上</option>
              <option value="2">2 星以上</option>
              <option value="3">3 星以上</option>
              <option value="4">4 星以上</option>
              <option value="5">5 星</option>
            </select>
            <select value={shelf.sort} onChange={(event) => updateShelf({ sort: event.target.value })} aria-label="排序">
              <option value="recent">最近阅读</option>
              <option value="title">标题</option>
              <option value="progress">进度</option>
              <option value="rating">评分</option>
            </select>
          </div>

          {shelf.scanMessage && <p className="notice">{shelf.scanMessage}</p>}
          {shelf.error && <p className="error">{shelf.error}</p>}

          {shelf.loading ? (
            <div className="empty-state"><LoaderCircle className="spin" size={28} /></div>
          ) : shelf.items.length === 0 ? (
            <div className="empty-state">
              <BookOpen size={34} />
              <p>暂无小说</p>
              <span>书库目录：{libraryHint}</span>
            </div>
          ) : (
            <div
              ref={shelfListRoot}
              className="book-list"
              style={{ height: `${shelfVirtualizer.getTotalSize()}px`, position: "relative" }}
            >
              {shelfVirtualRows.map(({ virtualRow, item }) => item.type === "folder" ? (
                <article
                  key={`f-${item.name}`}
                  className="book-row folder-row"
                  role="button"
                  tabIndex={0}
                  ref={shelfVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start - shelfScrollMargin.current}px)` }}
                  onClick={() => updateShelf({ folderTag: item.name })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      updateShelf({ folderTag: item.name });
                    }
                  }}
                >
                  <span className="book-main">
                    <strong><FolderClosed size={18} className="folder-icon" /> {item.name}</strong>
                    <span>{item.bookCount} 本</span>
                  </span>
                  <span className="book-side" />
                </article>
              ) : (
                <article
                  key={`b-${item.id}`}
                  className="book-row"
                  role="button"
                  tabIndex={0}
                  ref={shelfVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start - shelfScrollMargin.current}px)` }}
                  onClick={() => openReader(item.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openReader(item.id);
                    }
                  }}
                >
                  <span className="book-main">
                    <strong>{item.title}</strong>
                    <span>{formatSize(item.size)} · {item.encoding}</span>
                  </span>
                  <span className="book-side">
                    <span className="book-progress">{formatPercent(item.progress)}</span>
                    <span className="rating-row" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                      {Array.from({ length: 5 }, (_, index) => {
                        const rating = index + 1;
                        return (
                          <button
                            key={rating}
                            className={`star-button ${(item.rating || 0) >= rating ? "active" : ""}`}
                            type="button"
                            disabled={shelf.ratingBookId === item.id}
                            title={item.rating === rating ? "清除评分" : `${rating} 星`}
                            onClick={() => updateRating(item, rating)}
                          >
                            <Star size={17} />
                          </button>
                        );
                      })}
                    </span>
                  </span>
                </article>
              ))}
            </div>
          )}

          <FolderOverlay
            tag={shelf.folderTag}
            search={shelf.search}
            status={shelf.status}
            minRating={shelf.minRating}
            sort={shelf.sort}
            onClose={() => updateShelf({ folderTag: null })}
            onOpen={(bookId) => {
              updateShelf({ folderTag: null });
              openReader(bookId);
            }}
          />
        </section>
      )}

      {route.name === "tab-a" && (
        <section className="tab-a-view">
          <header className="shelf-header">
            <div>
              <p className="eyebrow">TXT Reader</p>
              <h1>A</h1>
            </div>
          </header>
          <div className="empty-state">
            <BookOpen size={34} />
            <p>A 页面</p>
            <span>内容正在建设中</span>
          </div>
        </section>
      )}

      {route.name === "reader" && (
        <section className="reader-view">
          <header className={`reader-toolbar ${reader.controlsVisible || reader.settingsOpen ? "is-visible" : ""}`}>
            <button className="icon-button" type="button" onClick={goShelf} title="Back">
              <ArrowLeft size={22} />
            </button>
            <div className="reader-title">
              <strong>{reader.book?.title || "Reading"}</strong>
            </div>
            <div className="toolbar-actions">
              <button className="icon-button" type="button" onClick={() => updateReader({ searchOpen: !reader.searchOpen, controlsVisible: true })} title="Search">
                <Search size={22} />
              </button>
              <button className="icon-button" type="button" onClick={() => updateReader({ settingsOpen: true })} title="Settings">
                <Settings size={22} />
              </button>
            </div>
          </header>

          {reader.toast && (
            <div className="save-toast" role="alert">
              <AlertTriangle size={14} />
              <span>{reader.toast}</span>
            </div>
          )}
          {reader.error && <p className="error reader-error">{reader.error}</p>}
          {reader.loading && <div className="empty-state reader-loading"><LoaderCircle className="spin" size={30} /></div>}

          {reader.book && (
            <article
              ref={readerRoot}
              className={`reader-content ${reader.loading ? "is-restoring" : ""}`}
              style={{
                "--reader-font-size": `${settings.fontSize}px`,
                "--reader-line-height": settings.lineHeight,
              } as React.CSSProperties}
              onClick={() => {
                if (!reader.book || reader.loading || reader.settingsOpen) return;
                updateReader({ controlsVisible: !reader.controlsVisible });
              }}
              onScroll={onReaderScroll}
              onWheel={() => reader.autoScrollPlaying && updateReader({ autoScrollPlaying: false })}
            >
              <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const paragraph = reader.paragraphs[virtualRow.index];
                  if (!paragraph) return null;
                  const matches = paragraphMatches(paragraph.offset);
                  return (
                    <div
                      key={virtualRow.key}
                      ref={virtualizer.measureElement}
                      data-index={virtualRow.index}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualRow.start}px)`,
                        paddingBottom: `${settings.paragraphSpacing}px`,
                      }}
                    >
                      <p
                        data-offset={paragraph.offset}
                        className={matches.some((item) => item.id === reader.activeSearchId) ? "is-match-target" : ""}
                      >
                        {highlightParagraph(paragraph.text, matches, reader.activeSearchId).map((part: any, index: number) => (
                          part.highlight
                            ? <mark key={`${paragraph.offset}-${index}`} className={part.active ? "is-active-match" : ""}>{part.text}</mark>
                            : <span key={`${paragraph.offset}-${index}`}>{part.text}</span>
                        ))}
                      </p>
                    </div>
                  );
                })}
              </div>
            </article>
          )}

          {reader.book && !reader.loading && (
            <div className={`reader-progress ${reader.controlsVisible || reader.progressSeeking ? "is-visible" : ""}`}>
              <input
                type="range"
                min="0"
                max="1000"
                step="1"
                value={readerProgressValue}
                aria-label={`阅读进度 ${readerProgressLabel}`}
                onPointerDown={() => updateReader({ progressSeeking: true, controlsVisible: true, autoScrollPlaying: false })}
                onPointerUp={endSeek}
                onTouchStart={() => updateReader({ progressSeeking: true, controlsVisible: true, autoScrollPlaying: false })}
                onTouchEnd={endSeek}
                onChange={seekProgress}
              />
              <span>{readerProgressLabel}</span>
            </div>
          )}

          <AutoScroll
            playing={reader.autoScrollPlaying}
            speed={reader.autoScrollSpeed}
            scrollElement={readerRoot.current}
            onPlayingChange={(autoScrollPlaying) => updateReader({ autoScrollPlaying })}
            onSpeedChange={(autoScrollSpeed) => updateReader({ autoScrollSpeed })}
          />

          {reader.settingsOpen && (
            <aside className="settings-panel">
              <div className="settings-header">
                <strong>阅读设置</strong>
                <button className="icon-button" type="button" onClick={() => updateReader({ settingsOpen: false })} title="关闭">
                  <X size={20} />
                </button>
              </div>
              <label className="control-row">
                <span><Type size={18} /> 字号</span>
                <input value={settings.fontSize} onChange={(event) => setSettings((current) => ({ ...current, fontSize: Number(event.target.value) }))} type="range" min="16" max="32" step="1" />
                <b>{settings.fontSize}</b>
              </label>
              <label className="control-row">
                <span>行距</span>
                <input value={settings.lineHeight} onChange={(event) => setSettings((current) => ({ ...current, lineHeight: Number(event.target.value) }))} type="range" min="1.4" max="2.4" step="0.05" />
                <b>{settings.lineHeight.toFixed(2)}</b>
              </label>
              <label className="control-row">
                <span>段距</span>
                <input value={settings.paragraphSpacing} onChange={(event) => setSettings((current) => ({ ...current, paragraphSpacing: Number(event.target.value) }))} type="range" min="4" max="36" step="2" />
                <b>{settings.paragraphSpacing}</b>
              </label>
              <div className="theme-row">
                <button type="button" className={settings.theme === "paper" ? "active" : ""} onClick={() => setSettings((current) => ({ ...current, theme: "paper" }))}>
                  <Sun size={18} /> 纸色
                </button>
                <button type="button" className={settings.theme === "night" ? "active" : ""} onClick={() => setSettings((current) => ({ ...current, theme: "night" }))}>
                  <Moon size={18} /> 夜间
                </button>
              </div>
            </aside>
          )}

          {reader.searchOpen && (
            <aside className="search-panel">
              <div className="search-panel-header">
                <strong>Search</strong>
                <button className="icon-button" type="button" onClick={() => updateReader({ searchOpen: false })} title="Close search panel">
                  <X size={20} />
                </button>
              </div>
              <label className="search-input">
                <Search size={18} />
                <input value={reader.searchQuery} onChange={(event) => updateReader({ searchQuery: event.target.value })} type="search" placeholder="Search within the book" />
              </label>
              {reader.searchQuery && reader.searchResults.length === 0 ? (
                <p className="search-empty">No matches found</p>
              ) : (
                <div ref={searchResultsRoot} className="search-result-list">
                  {reader.searchResults.map((result) => (
                    <button
                      key={result.id}
                      data-result-id={result.id}
                      className={`search-result ${result.id === reader.activeSearchId ? "active" : ""}`}
                      type="button"
                      onClick={() => selectSearchResult(result)}
                    >
                      <span className="search-result-percent">{Math.round(result.percent * 100)}%</span>
                      <span className="search-result-text">{result.text}</span>
                    </button>
                  ))}
                </div>
              )}
            </aside>
          )}
        </section>
      )}

      {route.name !== "reader" && (
        <nav className="tab-bar">
          <button type="button" className={`tab-button ${route.name === "shelf" ? "active" : ""}`} onClick={() => switchTab("n")}>N</button>
          <button type="button" className={`tab-button ${route.name === "tab-a" ? "active" : ""}`} onClick={() => switchTab("a")}>A</button>
        </nav>
      )}
    </main>
  );
}
