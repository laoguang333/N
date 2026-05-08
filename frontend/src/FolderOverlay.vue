<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { LoaderCircle, X } from 'lucide-vue-next'
import { listBooks } from './api'
import { formatPercent } from './reader'

const props = defineProps({
  tag: String,
})

const emit = defineEmits(['close', 'open'])

const books = ref([])
const loading = ref(false)
const error = ref('')
const currentPage = ref(0)
const ITEMS_PER_PAGE = 9

const totalPages = computed(() => Math.max(1, Math.ceil(books.value.length / ITEMS_PER_PAGE)))

const pageBooks = computed(() => {
  const start = currentPage.value * ITEMS_PER_PAGE
  return books.value.slice(start, start + ITEMS_PER_PAGE)
})

function goPage(page) {
  currentPage.value = page
}

async function load() {
  if (!props.tag) return
  loading.value = true
  error.value = ''
  try {
    books.value = await listBooks({ folderTag: props.tag, sort: 'title' })
    currentPage.value = 0
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

watch(() => props.tag, () => { if (props.tag) load() }, { immediate: true })

function handleKeydown(e) {
  if (e.key === 'Escape') {
    emit('close')
  } else if (e.key === 'ArrowLeft' && currentPage.value > 0) {
    currentPage.value--
  } else if (e.key === 'ArrowRight' && currentPage.value < totalPages.value - 1) {
    currentPage.value++
  }
}

onMounted(() => window.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <Transition name="folder-overlay">
    <div v-if="tag" class="folder-overlay" @click.self="emit('close')">
      <div class="folder-panel">
        <header class="folder-panel-header">
          <strong>{{ tag }}</strong>
          <button class="icon-button" type="button" @click="emit('close')" title="关闭文件夹">
            <X :size="18" />
          </button>
        </header>

        <div v-if="loading" class="empty-state folder-loading">
          <LoaderCircle class="spin" :size="26" />
        </div>

        <p v-else-if="error" class="error">{{ error }}</p>

        <div v-else-if="books.length === 0" class="empty-state folder-empty">
          <p>此文件夹没有小说</p>
        </div>

        <template v-else>
          <div class="folder-grid">
            <article
              v-for="book in pageBooks"
              :key="book.id"
              class="folder-book"
              role="button"
              tabindex="0"
              @click="emit('open', book.id)"
              @keydown="(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); emit('open', book.id) } }"
            >
              <strong class="folder-book-title">{{ book.title }}</strong>
              <span class="folder-book-progress">{{ formatPercent(book.progress) }}</span>
            </article>
          </div>

          <div v-if="totalPages > 1" class="folder-dots">
            <button
              v-for="page in totalPages"
              :key="page"
              class="folder-dot"
              :class="{ active: currentPage === page - 1 }"
              :aria-label="`第 ${page} 页`"
              type="button"
              @click.stop="goPage(page - 1)"
            />
          </div>
        </template>
      </div>
    </div>
  </Transition>
</template>
