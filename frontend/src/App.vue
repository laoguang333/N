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
  saveRating,
  scanLibrary,
} from "./api";
import { buildParagraphs, formatPercent, formatSize, parseSettings } from "./reader";

const STORAGE_KEY = "txt-reader-settings";

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
  settingsOpen: false,
});

const settings = reactive(loadSettings());
const readerRoot = ref(null);
let saveTimer = null;
let scrollTimer = null;
let shelfTimer = null;

const themeClass = computed(() => `theme-${settings.theme}`);
const libraryHint = computed(() => shelf.config?.library_dirs?.join(", ") || "novels");

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
  loadConfig();
  loadBooks();
});

onBeforeUnmount(() => {
  window.removeEventListener("hashchange", parseHash);
  window.removeEventListener("scroll", onReaderScroll);
  window.removeEventListener("beforeunload", flushProgress);
  window.clearTimeout(saveTimer);
  window.clearTimeout(scrollTimer);
  window.clearTimeout(shelfTimer);
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

function parseHash() {
  const match = window.location.hash.match(/^#\/reader\/(\d+)/);
  if (match) {
    route.name = "reader";
    route.bookId = Number(match[1]);
  } else {
    route.name = "shelf";
    route.bookId = null;
    reader.settingsOpen = false;
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
    shelf.books = await listBooks({
      search: shelf.search,
      status: shelf.status,
      minRating: shelf.minRating,
      sort: shelf.sort,
    });
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
  window.scrollTo({ top: 0 });

  try {
    const [content, progress] = await Promise.all([
      getBookContent(bookId),
      getProgress(bookId),
    ]);
    reader.book = content;
    reader.progress = progress;
    reader.paragraphs = buildParagraphs(content.content);
    await nextTick();
    restoreScroll(progress?.char_offset || 0);
  } catch (error) {
    reader.error = error.message;
  } finally {
    reader.loading = false;
  }
}

function restoreScroll(charOffset) {
  const target = readerRoot.value?.querySelector(`[data-offset="${charOffset}"]`)
    || nearestParagraph(charOffset);
  if (target) {
    target.scrollIntoView({ block: "start" });
  }
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
  if (route.name !== "reader" || !reader.book) {
    return;
  }

  window.clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(scheduleProgressSave, 160);
}

function scheduleProgressSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => persistProgress(), 1200);
}

function progressPayload() {
  const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  return {
    char_offset: currentOffset(),
    percent: Math.min(1, Math.max(0, window.scrollY / maxScroll)),
  };
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

async function persistProgress(options = {}) {
  if (!reader.book) {
    return;
  }

  reader.saving = true;

  try {
    reader.progress = await saveProgress(reader.book.book_id, progressPayload(), options);
  } catch (error) {
    if (!options.keepalive) {
      reader.error = error.message;
    }
  } finally {
    reader.saving = false;
  }
}

function flushProgress() {
  if (route.name === "reader" && reader.book) {
    window.clearTimeout(saveTimer);
    void persistProgress({ keepalive: true });
  }
}

function goShelf() {
  flushProgress();
  window.location.hash = "#/";
  loadBooks();
}

function openReader(bookId) {
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
      <header class="reader-toolbar">
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
        v-else
        ref="readerRoot"
        class="reader-content"
        :style="{
          '--reader-font-size': `${settings.fontSize}px`,
          '--reader-line-height': settings.lineHeight,
          '--reader-paragraph-spacing': `${settings.paragraphSpacing}px`,
        }"
        @scroll.passive="onReaderScroll"
      >
        <p v-for="paragraph in reader.paragraphs" :key="paragraph.offset" :data-offset="paragraph.offset">
          {{ paragraph.text }}
        </p>
      </article>

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
