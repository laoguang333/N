<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  LoaderCircle,
  Moon,
  RefreshCw,
  Search,
  Settings,
  Star,
  Sun,
  Type,
  X,
} from "lucide-vue-next";
import {
  getBookContent,
  getProgress,
  getPublicConfig,
  listBooks,
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
import { buildParagraphs, buildParagraphOffsetMap, findParagraphIndex, formatPercent, formatSize, parseSettings } from "./reader";
import { buildMatchMap, buildSearchIndex, highlightParagraph, searchWithIndex } from "./search";
import AutoScroll from "./AutoScroll.vue";

const STORAGE_KEY = "txt-reader-settings";
const CLIENT_ID_KEY = "txt-reader-client-id";
const clientId = loadClientId();
const sessionId = createId();

const route = reactive({
  name: "shelf",
  bookId: null,
});

const shelf = reactive({
  books: [],
  search: "",
  status: "all",
  minRating: "",
  sort: "recent",
  scrollTop: 0,
  config: null,
  loading: false,
  scanning: false,
  ratingBookId: null,
  error: "",
  scanMessage: "",
});

const reader = reactive({
  loading: false,
  error: "",
  toast: "",
  book: null,
  paragraphs: [],
  searchOpen: false,
  searchQuery: "",
  searchResults: [],
  activeSearchId: "",
  progress: null,
  visiblePercent: 0,
  controlsVisible: false,
  progressSeeking: false,
  pendingSeekPercent: null,
  settingsOpen: false,
  autoScrollPlaying: false,
  autoScrollSpeed: 5,
});

const settings = reactive(loadSettings());
const readerRoot = ref(null);
const searchResultsRoot = ref(null);
let saveTimer = null;
let scrollTimer = null;
let shelfTimer = null;
let periodicSaveTimer = null;
let progressFrame = null;
let saveInFlight = false;
let restoreSavingBlocked = false;
let lastSaveSucceeded = true;
let saveFailureCount = 0;
let toastTimer = null;
let searchDebounceTimer = null;
let searchIndex = null;
let paraOffsetMap = null;
let matchMap = null;
const SAVE_BASE_INTERVAL = 3000;

const virtualizer = useVirtualizer({
  get count() { return reader.paragraphs.length; },
  getScrollElement: () => readerRoot.value,
  estimateSize: () => 80,
  overscan: 30,
});

const themeClass = computed(() => `theme-${settings.theme}`);
const libraryHint = computed(() => shelf.config?.library_dirs?.join(", ") || "novels");
const readerProgressValue = computed(() => Math.round(reader.visiblePercent * 1000));
const readerProgressLabel = computed(() => `${Math.round(reader.visiblePercent * 100)}%`);

watch(
  () => ({ ...settings }),
  () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  },
  { deep: true },
);

watch(
  () => [shelf.search, shelf.status, shelf.minRating, shelf.sort],
  () => {
    window.clearTimeout(shelfTimer);
    shelfTimer = window.setTimeout(loadBooks, 180);
  },
);

watch(
  () => [settings.fontSize, settings.lineHeight, settings.paragraphSpacing],
  () => {
    nextTick(() => {
      virtualizer.value.measure();
    });
  },
);

onMounted(() => {
  parseHash();
  window.addEventListener("hashchange", parseHash);
  window.addEventListener("beforeunload", flushProgress);
  window.addEventListener("pagehide", flushProgress);
  window.addEventListener("touchend", onReaderInteractionEnd, { passive: true });
  window.addEventListener("pointerup", onReaderInteractionEnd, { passive: true });
  document.addEventListener("visibilitychange", onVisibilityChange);
  periodicSaveTimer = window.setTimeout(periodicProgressSave, SAVE_BASE_INTERVAL);
  loadConfig();
  loadBooks();
});

onBeforeUnmount(() => {
  window.removeEventListener("hashchange", parseHash);
  window.removeEventListener("beforeunload", flushProgress);
  window.removeEventListener("pagehide", flushProgress);
  window.removeEventListener("touchend", onReaderInteractionEnd);
  window.removeEventListener("pointerup", onReaderInteractionEnd);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.clearTimeout(saveTimer);
  window.clearTimeout(scrollTimer);
  window.clearTimeout(shelfTimer);
  window.clearTimeout(periodicSaveTimer);
  window.clearTimeout(toastTimer);
  window.clearTimeout(searchDebounceTimer);
  if (progressFrame) {
    window.cancelAnimationFrame(progressFrame);
  }
});

watch(
  () => route.bookId,
  (bookId) => {
    if (route.name === "reader" && bookId) {
      openBook(bookId);
    }
  },
);

function loadSettings() {
  return parseSettings(localStorage.getItem(STORAGE_KEY));
}

function loadClientId() {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) {
    return existing;
  }
  const next = createId();
  localStorage.setItem(CLIENT_ID_KEY, next);
  return next;
}

function createId() {
  if (globalThis.crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function progressMeta(source, options = {}) {
  return {
    source,
    clientId,
    sessionId,
    allowBackward: Boolean(options.allowBackward),
  };
}

function parseHash() {
  const match = window.location.hash.match(/^#\/reader\/(\d+)/);
  if (match) {
    const nextBookId = Number(match[1]);
    if (route.name === "reader" && route.bookId && route.bookId !== nextBookId) {
      saveProgressInBackground("route_change", { reuseCurrent: true });
    }
    route.name = "reader";
    route.bookId = nextBookId;
  } else {
    const shouldRestoreShelf = route.name === "reader";
    if (shouldRestoreShelf) {
      saveProgressInBackground("route_change", { reuseCurrent: true });
    }
    route.name = "shelf";
    route.bookId = null;
    reader.settingsOpen = false;
    if (shouldRestoreShelf) {
      nextTick(restoreShelfScroll);
    }
  }
}

async function loadConfig() {
  try {
    shelf.config = await getPublicConfig();
  } catch {
    shelf.config = null;
  }
}

async function loadBooks() {
  shelf.loading = true;
  shelf.error = "";
  try {
    const books = applyCachedProgress(
      await listBooks({
        search: shelf.search,
        status: "all",
        minRating: shelf.minRating,
        sort: shelf.sort,
      }),
    );
    shelf.books = books.filter((book) => matchesShelfStatus(book, shelf.status));
  } catch (error) {
    shelf.error = error.message;
  } finally {
    shelf.loading = false;
  }
}

async function runScan() {
  shelf.scanning = true;
  shelf.error = "";
  shelf.scanMessage = "";
  try {
    const result = await scanLibrary();
    shelf.scanMessage = formatScanMessage(result);
    await loadBooks();
    await loadConfig();
  } catch (error) {
    shelf.error = error.message;
  } finally {
    shelf.scanning = false;
  }
}

function formatScanMessage(result) {
  const parts = [
    `扫描 ${result.scanned} 本`,
    `新增 ${result.added || 0} 本`,
    `更新 ${result.updated || 0} 本`,
    `跳过 ${result.skipped || 0} 本`,
    `移除 ${result.removed} 本`,
  ];
  if (result.errors?.length) {
    parts.push(`错误 ${result.errors.length} 个`);
  }
  return parts.join(" · ");
}

async function openBook(bookId) {
  reader.loading = true;
  reader.error = "";
  reader.book = null;
  reader.paragraphs = [];
  reader.progress = null;
  reader.visiblePercent = 0;
  reader.controlsVisible = false;
  reader.progressSeeking = false;
  reader.pendingSeekPercent = null;
  reader.searchOpen = false;
  reader.searchQuery = "";
  reader.searchResults = [];
  reader.activeSearchId = "";
  reader.autoScrollPlaying = false;
  searchIndex = null;
  paraOffsetMap = null;
  matchMap = null;
  restoreSavingBlocked = true;
  const el = readerRoot.value;
  if (el) {
    el.scrollTop = 0;
  }

  try {
    const [content, progress] = await Promise.all([
      getBookContent(bookId),
      getProgress(bookId),
    ]);
    const serverProgress = normalizeProgress(bookId, progress, { dirty: false });
    const restoredProgress = serverProgress || loadCachedProgress(bookId);
    reader.book = content;
    reader.progress = restoredProgress;
    reader.visiblePercent = restoredProgress?.percent || 0;
    reader.paragraphs = buildParagraphs(content.content);
    searchIndex = buildSearchIndex(reader.paragraphs);
    paraOffsetMap = buildParagraphOffsetMap(reader.paragraphs);
    reader.searchResults = [];
    reader.activeSearchId = "";
    reader.controlsVisible = window.matchMedia("(min-width: 760px)").matches;
    await nextTick();
    restoreScroll(restoredProgress);
    await afterNextPaint();
    updateVisibleProgress();
    reader.loading = false;
    window.setTimeout(() => {
      restoreSavingBlocked = false;
    }, 250);
    if (!serverProgress) {
      scheduleProgressSave(300, { force: true, source: "open_mark" });
    }
  } catch (error) {
    reader.error = error.message;
    reader.loading = false;
    restoreSavingBlocked = false;
  }
}

function afterNextPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resolve);
    });
  });
}

function applyCachedProgress(books) {
  const cache = progressCache();
  return books.map((book) => ({
    ...book,
    progress: normalizeProgress(book.id, cache[book.id]) || normalizeProgress(book.id, book.progress),
  }));
}

function matchesShelfStatus(book, status) {
  if (!status || status === "all") {
    return true;
  }

  const percent = book.progress?.percent || 0;
  if (status === "unread") {
    return !book.progress;
  }
  if (status === "reading") {
    return Boolean(book.progress) && percent < 1;
  }
  if (status === "finished") {
    return percent >= 1;
  }
  return true;
}

function restoreScroll(progress) {
  if (!progress) {
    return;
  }

  if (Number.isFinite(progress.percent) && progress.percent > 0) {
    restoreScrollPercent(progress.percent || 0);
    return;
  }

  if (progress.char_offset > 0 && paraOffsetMap) {
    const index = findParagraphIndex(progress.char_offset, paraOffsetMap);
    if (index > 0) {
      virtualizer.value.scrollToIndex(index, { align: "start" });
      return;
    }
  }

  restoreScrollPercent(0);
}

function restoreScrollPercent(percent) {
  const el = readerRoot.value;
  if (!el) {
    return;
  }
  window.requestAnimationFrame(() => {
    const maxScroll = Math.max(1, el.scrollHeight - el.clientHeight);
    el.scrollTo({ top: maxScroll * Math.min(1, Math.max(0, percent)) });
    window.requestAnimationFrame(updateVisibleProgress);
  });
}

function restoreShelfScroll() {
  if (route.name === "shelf") {
    const top = shelf.scrollTop || 0;
    window.scrollTo({ top });
    window.requestAnimationFrame(() => {
      if (route.name === "shelf") {
        window.scrollTo({ top });
      }
    });
  }
}

function toggleReaderControls() {
  if (!reader.book || reader.loading || reader.settingsOpen) {
    return;
  }
  reader.controlsVisible = !reader.controlsVisible;
}

function toggleSearchPanel() {
  if (!reader.book || reader.loading) {
    return;
  }
  reader.searchOpen = !reader.searchOpen;
  if (reader.searchOpen) {
    reader.controlsVisible = true;
  }
}

function closeSearchPanel() {
  reader.searchOpen = false;
}

function onVisibilityChange() {
  if (document.visibilityState === "hidden") {
    flushProgress("visibility_hidden");
  }
}

function loadCachedProgress(bookId) {
  return normalizeProgress(bookId, progressCache()[bookId]) || null;
}

function progressCache() {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function cacheProgress(bookId, progress, options = {}) {
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

function updateShelfBookProgress(progress) {
  const index = shelf.books.findIndex((book) => book.id === progress.book_id);
  if (index !== -1) {
    shelf.books[index] = {
      ...shelf.books[index],
      progress,
    };
  }
}

function markShelfScroll() {
  if (route.name === "shelf") {
    shelf.scrollTop = window.scrollY;
  }
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  reader.toast = message;
  toastTimer = window.setTimeout(() => {
    reader.toast = "";
  }, 4500);
}

function canSaveReaderProgress() {
  return route.name === "reader"
    && reader.book
    && reader.paragraphs.length > 0
    && !reader.loading
    && !restoreSavingBlocked;
}

function snapshotProgress(options = {}) {
  if (!canSaveReaderProgress()) {
    return null;
  }

  const payload = progressPayload();
  if (isSuspiciousLocalReset(payload, reader.progress, options)) {
    return reader.progress;
  }

  const progress = cacheProgress(reader.book.book_id, payload, {
    dirty: options.dirty ?? true,
  });
  reader.progress = progress;
  reader.visiblePercent = progress.percent;
  updateShelfBookProgress(progress);
  return progress;
}

function saveProgressInBackground(source = "background", options = {}) {
  const progress = options.reuseCurrent ? reader.progress : snapshotProgress({ source });
  if (!progress || !reader.book) {
    return;
  }

  const payload = savePayload(progress, progressMeta(source));
  if (!saveProgressBeacon(reader.book.book_id, payload)) {
    void saveProgressKeepalive(reader.book.book_id, payload)
      .then((saved) => {
        applySavedProgress(saved);
      })
      .catch(() => {});
  }
}

async function saveProgressNow(options = {}) {
  const source = options.source || "debounced";
  const progress = options.reuseCurrent ? reader.progress : snapshotProgress(options);
  if (!progress || !reader.book) {
    return null;
  }

  if (saveInFlight) {
    return progress;
  }

  saveInFlight = true;
  try {
    const saved = await saveProgress(
      reader.book.book_id,
      savePayload(progress, progressMeta(source, options)),
      options,
    );
    lastSaveSucceeded = true;
    return applySavedProgress(saved);
  } catch (error) {
    lastSaveSucceeded = false;
    showToast(`保存失败: ${error.message}`);
    return progress;
  } finally {
    saveInFlight = false;
  }
}

function applySavedProgress(saved) {
  const normalized = normalizeProgress(reader.book?.book_id, saved, { dirty: false });
  if (!normalized) {
    return reader.progress;
  }

  const cached = cacheProgress(normalized.book_id, normalized, {
    dirty: false,
  });
  reader.progress = cached;
  updateShelfBookProgress(cached);

  return cached;
}

function onUserInterruptAutoScroll() {
  if (reader.autoScrollPlaying) {
    reader.autoScrollPlaying = false;
  }
}

function onReaderScroll() {
  if (!canSaveReaderProgress()) {
    return;
  }

  if (progressFrame === null) {
    progressFrame = window.requestAnimationFrame(() => {
      progressFrame = null;
      snapshotProgress({ source: "scroll" });
    });
  }
  window.clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(() => scheduleProgressSave(450, { source: "scroll" }), 120);
}

function scheduleProgressSave(delay = 650, options = {}) {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveProgressNow({ quiet: true, ...options }), delay);
}

function scheduleNextPeriodicSave(delay = SAVE_BASE_INTERVAL) {
  window.clearTimeout(periodicSaveTimer);
  periodicSaveTimer = window.setTimeout(periodicProgressSave, delay);
}

function periodicProgressSave() {
  if (!canSaveReaderProgress() || reader.loading) {
    scheduleNextPeriodicSave(SAVE_BASE_INTERVAL);
    return;
  }

  snapshotProgress({ source: "periodic" });
  saveProgressNow({ quiet: true, source: "periodic", reuseCurrent: true }).then(() => {
    if (lastSaveSucceeded) {
      saveFailureCount = 0;
      scheduleNextPeriodicSave(SAVE_BASE_INTERVAL);
    } else {
      saveFailureCount += 1;
      const delay = SAVE_BASE_INTERVAL * Math.pow(4, saveFailureCount);
      scheduleNextPeriodicSave(delay);
    }
  });
}

function onReaderInteractionEnd() {
  if (canSaveReaderProgress()) {
    snapshotProgress({ source: "interaction_end" });
    scheduleProgressSave(300, { source: "interaction_end" });
  }
}

function progressPayload() {
  const percent = reader.pendingSeekPercent ?? currentScrollPercent();
  return {
    char_offset: offsetForPercent(percent),
    percent,
  };
}

function currentScrollPercent() {
  const el = readerRoot.value;
  if (!el) {
    return 0;
  }
  const maxScroll = Math.max(1, el.scrollHeight - el.clientHeight);
  return Math.min(1, Math.max(0, el.scrollTop / maxScroll));
}

function updateVisibleProgress() {
  reader.visiblePercent = currentScrollPercent();
}

function updateSearchResults() {
  if (!reader.book) {
    reader.searchResults = [];
    reader.activeSearchId = "";
    matchMap = null;
    return;
  }

  const results = searchWithIndex(searchIndex, reader.searchQuery);
  reader.searchResults = results;
  matchMap = buildMatchMap(results);
  if (!results.some((item) => item.id === reader.activeSearchId)) {
    reader.activeSearchId = results[0]?.id || "";
  }
  queueSearchResultReveal();
}

watch(
  () => [reader.searchQuery, reader.paragraphs.length],
  () => {
    window.clearTimeout(searchDebounceTimer);
    searchDebounceTimer = window.setTimeout(updateSearchResults, 200);
  },
);

function selectSearchResult(result) {
  reader.activeSearchId = result.id;
  reader.controlsVisible = true;
  scrollToSearchResult(result);
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      snapshotProgress({ source: "search", allowBackward: true });
      scheduleProgressSave(250, { source: "search", allowBackward: true });
    });
  });
  queueSearchResultReveal(result.id);
}

function scrollToSearchResult(result) {
  if (!result || !paraOffsetMap) {
    return;
  }

  const index = findParagraphIndex(result.paragraphOffset, paraOffsetMap);
  if (index >= 0) {
    virtualizer.value.scrollToIndex(index, { align: "start" });
    window.requestAnimationFrame(() => {
      updateVisibleProgress();
    });
  }
}

function queueSearchResultReveal(targetId = reader.activeSearchId) {
  if (!targetId) {
    return;
  }

  nextTick(() => {
    window.requestAnimationFrame(() => {
      const panel = searchResultsRoot.value;
      const safeId = String(targetId).replaceAll('"', '\\"');
      const activeButton = panel?.querySelector?.(`[data-result-id="${safeId}"]`);
      if (activeButton?.scrollIntoView) {
        activeButton.scrollIntoView({ block: "nearest" });
      }
    });
  });
}

function paragraphMatches(offset) {
  return matchMap?.get(offset) || [];
}

function offsetForPercent(percent) {
  const safePercent = Math.min(1, Math.max(0, percent));
  if (!searchIndex || !paraOffsetMap) {
    return 0;
  }

  const targetOffset = safePercent * searchIndex.totalLength;
  const index = findParagraphIndex(targetOffset, paraOffsetMap);
  if (index < 0 || !reader.paragraphs[index]) {
    return 0;
  }
  return reader.paragraphs[index].offset;
}

function seekProgress(event) {
  const value = Number(event.target.value) / 1000;
  reader.pendingSeekPercent = value;
  reader.visiblePercent = value;
  const el = readerRoot.value;
  if (el) {
    const maxScroll = Math.max(1, el.scrollHeight - el.clientHeight);
    el.scrollTo({ top: maxScroll * value, behavior: "auto" });
  }
}

function startSeek() {
  reader.progressSeeking = true;
  reader.controlsVisible = true;
  reader.autoScrollPlaying = false;
}

function endSeek() {
  reader.progressSeeking = false;
  snapshotProgress({ source: "seek", allowBackward: true });
  scheduleProgressSave(250, { source: "seek", allowBackward: true });
  window.setTimeout(() => {
    reader.pendingSeekPercent = null;
  }, 1200);
}

function flushProgress(source = "flush") {
  if (canSaveReaderProgress()) {
    window.clearTimeout(saveTimer);
    saveProgressInBackground(typeof source === "string" ? source : "flush", { reuseCurrent: true });
  }
}

async function goShelf() {
  window.clearTimeout(saveTimer);
  await saveProgressNow({ quiet: true, source: "go_shelf", reuseCurrent: true });
  window.location.hash = "#/";
}

function openReader(bookId) {
  markShelfScroll();
  window.location.hash = `#/reader/${bookId}`;
}

function openReaderByKeyboard(event, bookId) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openReader(bookId);
  }
}

async function updateRating(book, rating) {
  const nextRating = book.rating === rating ? null : rating;
  shelf.ratingBookId = book.id;
  shelf.error = "";

  try {
    const updated = await saveRating(book.id, nextRating);
    const index = shelf.books.findIndex((item) => item.id === book.id);
    if (index !== -1) {
      shelf.books[index] = updated;
    }
  } catch (error) {
    shelf.error = error.message;
  } finally {
    shelf.ratingBookId = null;
  }
}
</script>

<template>
  <main :class="['app-shell', themeClass]">
    <section v-if="route.name === 'shelf'" class="shelf-view">
      <header class="shelf-header">
        <div>
          <p class="eyebrow">TXT Reader</p>
          <h1>书架</h1>
        </div>
        <button class="icon-button" type="button" :disabled="shelf.scanning" @click="runScan" title="扫描书库">
          <LoaderCircle v-if="shelf.scanning" class="spin" :size="22" />
          <RefreshCw v-else :size="22" />
        </button>
      </header>

      <div class="search-row">
        <Search :size="20" />
        <input v-model="shelf.search" type="search" placeholder="搜索小说" />
      </div>

      <div class="filter-bar">
        <select v-model="shelf.status" aria-label="阅读状态">
          <option value="all">全部状态</option>
          <option value="unread">未读</option>
          <option value="reading">在读</option>
          <option value="finished">已读</option>
        </select>
        <select v-model="shelf.minRating" aria-label="最低评分">
          <option value="">全部评分</option>
          <option value="1">1 星以上</option>
          <option value="2">2 星以上</option>
          <option value="3">3 星以上</option>
          <option value="4">4 星以上</option>
          <option value="5">5 星</option>
        </select>
        <select v-model="shelf.sort" aria-label="排序">
          <option value="recent">最近阅读</option>
          <option value="title">标题</option>
          <option value="progress">进度</option>
          <option value="rating">评分</option>
        </select>
      </div>

      <p v-if="shelf.scanMessage" class="notice">{{ shelf.scanMessage }}</p>
      <p v-if="shelf.error" class="error">{{ shelf.error }}</p>

      <div v-if="shelf.loading" class="empty-state">
        <LoaderCircle class="spin" :size="28" />
      </div>

      <div v-else-if="shelf.books.length === 0" class="empty-state">
        <BookOpen :size="34" />
        <p>暂无小说</p>
        <span>书库目录：{{ libraryHint }}</span>
      </div>

      <div v-else class="book-list">
        <article
          v-for="book in shelf.books"
          :key="book.id"
          class="book-row"
          role="button"
          tabindex="0"
          @click="openReader(book.id)"
          @keydown="openReaderByKeyboard($event, book.id)"
        >
          <span class="book-main">
            <strong>{{ book.title }}</strong>
            <span>{{ formatSize(book.size) }} · {{ book.encoding }}</span>
          </span>
          <span class="book-side">
            <span class="book-progress">{{ formatPercent(book.progress) }}</span>
            <span class="rating-row" @click.stop @keydown.stop>
              <button
                v-for="rating in 5"
                :key="rating"
                class="star-button"
                :class="{ active: (book.rating || 0) >= rating }"
                type="button"
                :disabled="shelf.ratingBookId === book.id"
                :title="book.rating === rating ? '清除评分' : `${rating} 星`"
                @click="updateRating(book, rating)"
              >
                <Star :size="17" />
              </button>
            </span>
          </span>
        </article>
      </div>
    </section>

    <section v-else class="reader-view">
      <header class="reader-toolbar" :class="{ 'is-visible': reader.controlsVisible || reader.settingsOpen }">
        <button class="icon-button" type="button" @click="goShelf" title="Back">
          <ArrowLeft :size="22" />
        </button>
        <div class="reader-title">
          <strong>{{ reader.book?.title || "Reading" }}</strong>
        </div>
        <div class="toolbar-actions">
          <button class="icon-button" type="button" @click="toggleSearchPanel" title="Search">
            <Search :size="22" />
          </button>
          <button class="icon-button" type="button" @click="reader.settingsOpen = true" title="Settings">
            <Settings :size="22" />
          </button>
        </div>
      </header>

      <transition name="toast-fade">
        <div v-if="reader.toast" class="save-toast" role="alert">
          <AlertTriangle :size="14" />
          <span>{{ reader.toast }}</span>
        </div>
      </transition>

      <p v-if="reader.error" class="error reader-error">{{ reader.error }}</p>
      <div v-if="reader.loading" class="empty-state reader-loading">
        <LoaderCircle class="spin" :size="30" />
      </div>

      <article
        v-if="reader.book"
        ref="readerRoot"
        class="reader-content"
        :class="{ 'is-restoring': reader.loading }"
        :style="{
          '--reader-font-size': `${settings.fontSize}px`,
          '--reader-line-height': settings.lineHeight,
        }"
        @click="toggleReaderControls"
        @scroll.passive="onReaderScroll"
        @wheel.passive="onUserInterruptAutoScroll"
      >
        <div
          :style="{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }"
        >
          <div
            v-for="virtualRow in virtualizer.getVirtualItems()"
            :key="virtualRow.key"
            :ref="virtualizer.measureElement"
            :data-index="virtualRow.index"
            :style="{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
              paddingBottom: `${settings.paragraphSpacing}px`,
            }"
          >
            <p
              :data-offset="reader.paragraphs[virtualRow.index].offset"
              :class="{ 'is-match-target': paragraphMatches(reader.paragraphs[virtualRow.index].offset).some((item) => item.id === reader.activeSearchId) }"
            >
              <template
                v-for="(part, index) in highlightParagraph(
                  reader.paragraphs[virtualRow.index].text,
                  paragraphMatches(reader.paragraphs[virtualRow.index].offset),
                  reader.activeSearchId,
                )"
                :key="`${reader.paragraphs[virtualRow.index].offset}-${index}`"
              >
                <mark v-if="part.highlight" :class="{ 'is-active-match': part.active }">{{ part.text }}</mark>
                <span v-else>{{ part.text }}</span>
              </template>
            </p>
          </div>
        </div>
      </article>

      <div
        v-if="reader.book && !reader.loading"
        class="reader-progress"
        :class="{ 'is-visible': reader.controlsVisible || reader.progressSeeking }"
      >
        <input
          type="range"
          min="0"
          max="1000"
          step="1"
          :value="readerProgressValue"
          :aria-label="`阅读进度 ${readerProgressLabel}`"
          @pointerdown="startSeek"
          @pointerup="endSeek"
          @touchstart.passive="startSeek"
          @touchend.passive="endSeek"
          @input="seekProgress"
        />
        <span>{{ readerProgressLabel }}</span>
      </div>

      <AutoScroll
        v-model:playing="reader.autoScrollPlaying"
        v-model:speed="reader.autoScrollSpeed"
      />

      <aside v-if="reader.settingsOpen" class="settings-panel">
        <div class="settings-header">
          <strong>阅读设置</strong>
          <button class="icon-button" type="button" @click="reader.settingsOpen = false" title="关闭">
            <X :size="20" />
          </button>
        </div>

        <label class="control-row">
          <span><Type :size="18" /> 字号</span>
          <input v-model.number="settings.fontSize" type="range" min="16" max="32" step="1" />
          <b>{{ settings.fontSize }}</b>
        </label>

        <label class="control-row">
          <span>行距</span>
          <input v-model.number="settings.lineHeight" type="range" min="1.4" max="2.4" step="0.05" />
          <b>{{ settings.lineHeight.toFixed(2) }}</b>
        </label>

        <label class="control-row">
          <span>段距</span>
          <input v-model.number="settings.paragraphSpacing" type="range" min="4" max="36" step="2" />
          <b>{{ settings.paragraphSpacing }}</b>
        </label>

        <div class="theme-row">
          <button type="button" :class="{ active: settings.theme === 'paper' }" @click="settings.theme = 'paper'">
            <Sun :size="18" /> 纸色
          </button>
          <button type="button" :class="{ active: settings.theme === 'night' }" @click="settings.theme = 'night'">
            <Moon :size="18" /> 夜间
          </button>
        </div>
      </aside>

      <aside v-if="reader.searchOpen" class="search-panel">
        <div class="search-panel-header">
          <strong>Search</strong>
          <button class="icon-button" type="button" @click="closeSearchPanel" title="Close search panel">
            <X :size="20" />
          </button>
        </div>

        <label class="search-input">
          <Search :size="18" />
          <input
            v-model="reader.searchQuery"
            type="search"
            placeholder="Search within the book"
          />
        </label>

        <p v-if="reader.searchQuery && reader.searchResults.length === 0" class="search-empty">
          No matches found
        </p>

        <div v-else ref="searchResultsRoot" class="search-result-list">
          <button
            v-for="result in reader.searchResults"
            :key="result.id"
            :data-result-id="result.id"
            class="search-result"
            type="button"
            :class="{ active: result.id === reader.activeSearchId }"
            @click="selectSearchResult(result)"
          >
            <span class="search-result-percent">{{ Math.round(result.percent * 100) }}%</span>
            <span class="search-result-text">{{ result.text }}</span>
          </button>
        </div>
      </aside>
    </section>
  </main>
</template>
