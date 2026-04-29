<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  ArrowLeft,
  BookOpen,
  Check,
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
  chooseProgressForOpen,
  isRemoteAhead,
  isSuspiciousLocalReset,
  normalizeProgress,
  progressKey,
  savePayload,
} from "./progress";
import { buildParagraphs, formatPercent, formatSize, parseSettings } from "./reader";

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
  saving: false,
  error: "",
  book: null,
  paragraphs: [],
  progress: null,
  visiblePercent: 0,
  controlsVisible: false,
  progressSeeking: false,
  pendingSeekPercent: null,
  settingsOpen: false,
});

const settings = reactive(loadSettings());
const readerRoot = ref(null);
let saveTimer = null;
let scrollTimer = null;
let shelfTimer = null;
let periodicSaveTimer = null;
let progressFrame = null;
let saveInFlight = false;
let queuedServerSave = false;
let lastServerProgressKey = "";
let progressBaseVersion = null;
let restoreSavingBlocked = false;

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

onMounted(() => {
  parseHash();
  window.addEventListener("hashchange", parseHash);
  window.addEventListener("scroll", onReaderScroll, { passive: true });
  window.addEventListener("beforeunload", flushProgress);
  window.addEventListener("pagehide", flushProgress);
  window.addEventListener("touchend", onReaderInteractionEnd, { passive: true });
  window.addEventListener("pointerup", onReaderInteractionEnd, { passive: true });
  document.addEventListener("scroll", onReaderScroll, { passive: true });
  document.addEventListener("visibilitychange", onVisibilityChange);
  periodicSaveTimer = window.setInterval(periodicProgressSave, 3000);
  loadConfig();
  loadBooks();
});

onBeforeUnmount(() => {
  window.removeEventListener("hashchange", parseHash);
  window.removeEventListener("scroll", onReaderScroll);
  window.removeEventListener("beforeunload", flushProgress);
  window.removeEventListener("pagehide", flushProgress);
  window.removeEventListener("touchend", onReaderInteractionEnd);
  window.removeEventListener("pointerup", onReaderInteractionEnd);
  document.removeEventListener("scroll", onReaderScroll);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.clearTimeout(saveTimer);
  window.clearTimeout(scrollTimer);
  window.clearTimeout(shelfTimer);
  window.clearInterval(periodicSaveTimer);
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
  progressBaseVersion = null;
  lastServerProgressKey = "";
  restoreSavingBlocked = true;
  window.scrollTo({ top: 0 });

  try {
    const [content, progress] = await Promise.all([
      getBookContent(bookId),
      getProgress(bookId),
    ]);
    const serverProgress = normalizeProgress(bookId, progress, { dirty: false });
    const { progress: restoredProgress, shouldSync } = chooseProgressForOpen(
      serverProgress,
      loadCachedProgress(bookId),
      bookId,
    );
    progressBaseVersion = serverProgress?.version ?? null;
    lastServerProgressKey = progressKey(serverProgress);
    reader.book = content;
    reader.progress = restoredProgress;
    reader.visiblePercent = restoredProgress?.percent || 0;
    reader.paragraphs = buildParagraphs(content.content);
    await nextTick();
    restoreScroll(restoredProgress);
    await afterNextPaint();
    updateVisibleProgress();
    reader.loading = false;
    window.setTimeout(() => {
      restoreSavingBlocked = false;
    }, 250);
    if (shouldSync) {
      cacheProgress(bookId, restoredProgress, { dirty: true, baseVersion: progressBaseVersion });
      scheduleProgressSave(250, { force: true, source: "open_sync" });
    } else if (!serverProgress) {
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
    progress: chooseProgressForOpen(book.progress, cache[book.id], book.id).progress,
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

  if (shouldRestoreByPercent(progress)) {
    restoreScrollPercent(progress.percent || 0);
    return;
  }

  const target = readerRoot.value?.querySelector(`[data-offset="${progress.char_offset}"]`)
    || nearestParagraph(progress.char_offset);

  if (target) {
    target.scrollIntoView({ block: "start" });
    return;
  }

  restoreScrollPercent(progress.percent || 0);
}

function shouldRestoreByPercent(progress) {
  if (!Number.isFinite(progress?.percent) || progress.percent <= 0) {
    return false;
  }

  const target = readerRoot.value?.querySelector(`[data-offset="${progress.char_offset}"]`)
    || nearestParagraph(progress.char_offset);
  if (!target) {
    return true;
  }

  const maxScroll = maxScrollTop();
  const targetScroll = window.scrollY + target.getBoundingClientRect().top - 88;
  const offsetPercent = Math.min(1, Math.max(0, targetScroll / maxScroll));
  return Math.abs(offsetPercent - progress.percent) > 0.08;
}

function restoreScrollPercent(percent) {
  window.requestAnimationFrame(() => {
    const maxScroll = maxScrollTop();
    window.scrollTo({ top: maxScroll * Math.min(1, Math.max(0, percent)) });
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
    base_version: options.baseVersion ?? progress.base_version ?? progressBaseVersion,
  }, {
    dirty: Boolean(options.dirty),
    base_version: options.baseVersion ?? progressBaseVersion,
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
    baseVersion: progressBaseVersion,
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

  const payload = savePayload(progress, progressBaseVersion, progressMeta(source));
  if (!saveProgressBeacon(reader.book.book_id, payload)) {
    void saveProgressKeepalive(reader.book.book_id, payload)
      .then((saved) => {
        applySavedProgress(saved, progress);
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

  const key = progressKey(progress);
  if (!options.force && key === lastServerProgressKey) {
    cacheProgress(reader.book.book_id, progress, {
      dirty: false,
      baseVersion: progressBaseVersion,
    });
    return progress;
  }
  if (saveInFlight) {
    queuedServerSave = true;
    return progress;
  }

  saveInFlight = true;
  reader.saving = true;
  try {
    const saved = await saveProgress(
      reader.book.book_id,
      savePayload(progress, progressBaseVersion, progressMeta(source, options)),
      options,
    );
    return applySavedProgress(saved, progress);
  } catch (error) {
    if (!options.quiet) {
      reader.error = error.message;
    }
    return progress;
  } finally {
    saveInFlight = false;
    reader.saving = false;
    if (queuedServerSave) {
      queuedServerSave = false;
      void saveProgressNow({ quiet: true });
    }
  }
}

function applySavedProgress(saved, attempted = null) {
  const normalized = normalizeProgress(reader.book?.book_id, saved, { dirty: false });
  if (!normalized) {
    return attempted;
  }

  progressBaseVersion = normalized.version;
  lastServerProgressKey = progressKey(normalized);
  const cached = cacheProgress(normalized.book_id, normalized, {
    dirty: false,
    baseVersion: normalized.version,
  });
  reader.progress = cached;
  updateShelfBookProgress(cached);

  if (isRemoteAhead(cached, attempted)) {
    reader.visiblePercent = cached.percent;
    restoreScroll(cached);
  }

  return cached;
}

function nearestParagraph(charOffset) {
  const nodes = [...(readerRoot.value?.querySelectorAll("[data-offset]") || [])];
  let best = nodes[0];
  for (const node of nodes) {
    if (Number(node.dataset.offset) <= charOffset) {
      best = node;
    } else {
      break;
    }
  }
  return best;
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

function periodicProgressSave() {
  if (!canSaveReaderProgress() || reader.loading) {
    return;
  }

  const progress = snapshotProgress({ source: "periodic" });
  if (progressKey(progress) !== lastServerProgressKey) {
    void saveProgressNow({ quiet: true, source: "periodic" });
  }
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
    char_offset: reader.pendingSeekPercent === null ? currentOffset() : offsetForPercent(percent),
    percent,
  };
}

function currentScrollPercent() {
  return Math.min(1, Math.max(0, window.scrollY / maxScrollTop()));
}

function maxScrollTop() {
  const scroller = document.scrollingElement || document.documentElement;
  return Math.max(1, scroller.scrollHeight - window.innerHeight);
}

function updateVisibleProgress() {
  reader.visiblePercent = currentScrollPercent();
}

function currentOffset() {
  const nodes = [...(readerRoot.value?.querySelectorAll("[data-offset]") || [])];
  const topLine = 88;
  let candidate = nodes[0];

  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.top <= topLine) {
      candidate = node;
    } else {
      break;
    }
  }

  return Number(candidate?.dataset.offset || 0);
}

function offsetForPercent(percent) {
  const nodes = [...(readerRoot.value?.querySelectorAll("[data-offset]") || [])];
  if (nodes.length === 0) {
    return 0;
  }

  const maxScroll = maxScrollTop();
  const targetY = maxScroll * Math.min(1, Math.max(0, percent)) + 88;
  let candidate = nodes[0];

  for (const node of nodes) {
    const absoluteTop = window.scrollY + node.getBoundingClientRect().top;
    if (absoluteTop <= targetY) {
      candidate = node;
    } else {
      break;
    }
  }

  return Number(candidate?.dataset.offset || 0);
}

function seekProgress(event) {
  const value = Number(event.target.value) / 1000;
  const maxScroll = maxScrollTop();
  reader.pendingSeekPercent = value;
  window.scrollTo({ top: maxScroll * value, behavior: "auto" });
  reader.visiblePercent = value;
  snapshotProgress({ source: "seek", allowBackward: true });
  scheduleProgressSave(250, { source: "seek", force: true, allowBackward: true });
}

function startSeek() {
  reader.progressSeeking = true;
  reader.controlsVisible = true;
}

function endSeek() {
  reader.progressSeeking = false;
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

    <section v-else class="reader-view" @scroll.passive="onReaderScroll">
      <header class="reader-toolbar" :class="{ 'is-visible': reader.controlsVisible || reader.settingsOpen }">
        <button class="icon-button" type="button" @click="goShelf" title="返回书架">
          <ArrowLeft :size="22" />
        </button>
        <div class="reader-title">
          <strong>{{ reader.book?.title || "读取中" }}</strong>
          <span v-if="reader.saving"><Check :size="14" /> 已保存</span>
        </div>
        <button class="icon-button" type="button" @click="reader.settingsOpen = true" title="阅读设置">
          <Settings :size="22" />
        </button>
      </header>

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
          '--reader-paragraph-spacing': `${settings.paragraphSpacing}px`,
        }"
        @click="toggleReaderControls"
        @scroll.passive="onReaderScroll"
      >
        <p v-for="paragraph in reader.paragraphs" :key="paragraph.offset" :data-offset="paragraph.offset">
          {{ paragraph.text }}
        </p>
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
    </section>
  </main>
</template>
