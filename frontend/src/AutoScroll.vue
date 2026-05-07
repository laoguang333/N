<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Play } from "lucide-vue-next";

const props = defineProps({
  playing: { type: Boolean, default: false },
  speed: { type: Number, default: 5 },
});
const emit = defineEmits(["update:playing", "update:speed"]);

const SPEED_TABLE = [0, 4, 6, 9, 12, 16, 20, 26, 32, 40, 50];

const dialRef = ref(null);
const dialOpen = ref(false);
const fabVisible = ref(false);
let dialDragAngle = 0;
let rafId = null;
let lastTime = 0;
let longPressTimer = null;
let pointerStart = null;
let hideTimer = null;

const displaySpeed = computed(() => props.speed);
const pxPerMs = computed(() => SPEED_TABLE[displaySpeed.value] / 100);
const arcAngle = computed(() => (displaySpeed.value / 10) * 360);
const arcOffset = computed(() => {
  const r = 78;
  const c = 2 * Math.PI * r;
  const filled = (arcAngle.value / 360) * c;
  return `${filled} ${c}`;
});
const showFab = computed(() => fabVisible.value || dialOpen.value);

function emitSpeed(level) {
  emit("update:speed", Math.max(1, Math.min(10, Math.round(level))));
}
function emitPlaying(val) {
  emit("update:playing", val);
}

function revealFab() {
  fabVisible.value = true;
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (!dialOpen.value) {
      fabVisible.value = false;
    }
  }, 3000);
}

function onButtonPointerDown(e) {
  revealFab();
  if (dialOpen.value) return;
  const p = e.touches ? e.touches[0] : e;
  pointerStart = { x: p.clientX, y: p.clientY, time: Date.now() };
  longPressTimer = window.setTimeout(() => {
    dialOpen.value = true;
    pointerStart = null;
    dialDragAngle = displaySpeed.value;
    window.clearTimeout(longPressTimer);
    longPressTimer = null;
  }, 420);
}

function onButtonPointerUp(e) {
  window.clearTimeout(longPressTimer);
  longPressTimer = null;
  if (!pointerStart) return;
  const dt = Date.now() - pointerStart.time;
  const p = e.changedTouches ? e.changedTouches[0] : e;
  const dx = p.clientX - pointerStart.x;
  const dy = p.clientY - pointerStart.y;
  pointerStart = null;
  if (Math.hypot(dx, dy) <= 6 && dt < 400) {
    emitPlaying(!props.playing);
  }
}

function onButtonPointerMove(e) {
  if (!pointerStart) return;
  const p = e.touches ? e.touches[0] : e;
  if (Math.hypot(p.clientX - pointerStart.x, p.clientY - pointerStart.y) > 10) {
    window.clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function onDialPointerMove(e) {
  e.preventDefault();
  const el = dialRef.value;
  if (!el) return;
  const p = e.touches ? e.touches[0] : e;
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let angle = Math.atan2(p.clientY - cy, p.clientX - cx);
  angle = (angle + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
  dialDragAngle = Math.round((angle / (Math.PI * 2)) * 10) || 10;
  emitSpeed(dialDragAngle);
}

function onDialPointerUp() {
  dialOpen.value = false;
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    fabVisible.value = false;
  }, 3000);
}

function getScrollElement() {
  return document.querySelector(".reader-content");
}

function tickRaf(now) {
  if (lastTime === 0) lastTime = now;
  const elapsed = Math.min(48, now - lastTime);
  lastTime = now;

  const el = getScrollElement();
  if (!el) {
    rafId = window.requestAnimationFrame(tickRaf);
    return;
  }
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
    emitPlaying(false);
    return;
  }

  el.scrollTop += pxPerMs.value * elapsed;

  rafId = window.requestAnimationFrame(tickRaf);
}

function startTick() {
  lastTime = 0;
  rafId = window.requestAnimationFrame(tickRaf);
}

function stopTick() {
  if (rafId) {
    window.cancelAnimationFrame(rafId);
    rafId = null;
  }
}

watch(
  () => props.playing,
  (val) => {
    if (val) startTick();
    else stopTick();
  },
);

watch(dialOpen, (val) => {
  if (val) {
    document.addEventListener("pointermove", onDialPointerMove);
    document.addEventListener("pointerup", onDialPointerUp);
    window.clearTimeout(hideTimer);
  } else {
    document.removeEventListener("pointermove", onDialPointerMove);
    document.removeEventListener("pointerup", onDialPointerUp);
  }
});

onBeforeUnmount(() => {
  stopTick();
  window.clearTimeout(longPressTimer);
  window.clearTimeout(hideTimer);
  if (dialOpen.value) {
    document.removeEventListener("pointermove", onDialPointerMove);
    document.removeEventListener("pointerup", onDialPointerUp);
  }
});
</script>

<template>
  <div class="auto-scroll-fab" :class="{ visible: showFab }">
    <button
      class="fab-button"
      type="button"
      :title="playing ? `${displaySpeed} 档 · 暂停` : '自动滚屏'"
      @pointerdown.prevent="onButtonPointerDown"
      @pointerup="onButtonPointerUp"
      @pointerleave="onButtonPointerUp"
      @pointermove="onButtonPointerMove"
    >
      <span v-if="playing" class="fab-speed">{{ displaySpeed }}</span>
      <Play v-else :size="22" />
    </button>

    <Teleport to="body">
      <div v-if="dialOpen" class="auto-scroll-dial-overlay" @pointerdown.prevent>
        <div ref="dialRef" class="speed-dial">
          <svg viewBox="0 0 200 200" class="dial-svg">
            <circle cx="100" cy="100" r="78" fill="none" class="dial-track" stroke-width="10" />
            <circle
              cx="100" cy="100" r="78"
              fill="none"
              class="dial-fill"
              stroke-width="10"
              stroke-linecap="round"
              :stroke-dasharray="arcOffset"
              transform="rotate(-90 100 100)"
            />
            <text x="100" y="94" class="dial-value">{{ displaySpeed }}</text>
            <text x="100" y="116" class="dial-label">档</text>
          </svg>
          <div class="dial-tickmarks">
            <span
              v-for="n in 10"
              :key="n"
              class="dial-tick"
              :class="{ active: n <= displaySpeed }"
              :style="{
                transform: `rotate(${n * 36 - 90}deg) translate(0, -94px)`,
              }"
            />
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.auto-scroll-fab {
  position: fixed;
  right: 16px;
  bottom: calc(44px + env(safe-area-inset-bottom, 0px));
  z-index: 25;
  opacity: 0;
  transform: scale(0.85);
  pointer-events: auto;
  transition:
    opacity 0.22s ease,
    transform 0.22s ease;
}

.auto-scroll-fab.visible {
  opacity: 1;
  transform: scale(1);
}

.fab-button {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 1.5px solid var(--line);
  background: var(--surface);
  color: var(--muted);
  display: grid;
  place-items: center;
  cursor: pointer;
  box-shadow: 0 2px 10px rgb(0 0 0 / 12%);
  transition:
    background 0.18s,
    border-color 0.18s,
    box-shadow 0.18s;
  user-select: none;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
}

.fab-speed {
  font-size: 17px;
  font-weight: 700;
  line-height: 1;
}

.auto-scroll-dial-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgb(0 0 0 / 38%);
  display: grid;
  place-items: center;
  backdrop-filter: blur(6px);
  user-select: none;
  touch-action: none;
}

.auto-scroll-dial-overlay * {
  touch-action: none;
}

.speed-dial {
  position: relative;
  width: min(300px, 72vw);
  height: min(300px, 72vw);
}

.dial-svg {
  width: 100%;
  height: 100%;
}

.dial-track {
  stroke: var(--line);
}

.dial-fill {
  stroke: var(--accent);
}

.dial-value {
  font-size: 52px;
  font-weight: 800;
  fill: var(--text);
  text-anchor: middle;
  dominant-baseline: central;
}

.dial-label {
  font-size: 16px;
  fill: var(--muted);
  text-anchor: middle;
  dominant-baseline: central;
}

.dial-tickmarks {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.dial-tick {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 8px;
  height: 3px;
  margin-left: -4px;
  border-radius: 2px;
  background: var(--line);
  transition: background 0.12s;
}

.dial-tick.active {
  background: var(--accent);
}
</style>
