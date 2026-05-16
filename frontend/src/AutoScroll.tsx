import { useEffect, useRef, useState } from "react";
import { Minus, Pause, Play, Plus } from "lucide-react";

const SPEED_TABLE = [0, 4, 6, 9, 12, 16, 20, 26, 32, 40, 50];

type AutoScrollProps = {
  playing: boolean;
  speed: number;
  scrollElement: HTMLElement | null;
  onPlayingChange: (playing: boolean) => void;
  onSpeedChange: (speed: number) => void;
};

export default function AutoScroll({
  playing,
  speed,
  scrollElement,
  onPlayingChange,
  onSpeedChange,
}: AutoScrollProps) {
  const rafId = useRef<number | null>(null);
  const lastTime = useRef(0);
  const longPressTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const pointerStart = useRef<{ x: number; y: number; time: number } | null>(null);
  const [fabVisible, setFabVisible] = useState(false);

  const displaySpeed = Math.max(1, Math.min(10, Math.round(speed || 5)));
  const pxPerMs = SPEED_TABLE[displaySpeed] / 100;
  const showFab = fabVisible;

  function clearLongPress() {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function revealFab() {
    setFabVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      setFabVisible(false);
    }, playing ? 2200 : 3000);
  }

  function onButtonPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    revealFab();
    pointerStart.current = { x: event.clientX, y: event.clientY, time: Date.now() };
    longPressTimer.current = window.setTimeout(() => {
      pointerStart.current = null;
      clearLongPress();
    }, 420);
  }

  function onButtonPointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    clearLongPress();
    if (!pointerStart.current) return;
    const start = pointerStart.current;
    pointerStart.current = null;
    const dt = Date.now() - start.time;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.hypot(dx, dy) <= 6 && dt < 400) {
      onPlayingChange(!playing);
      revealFab();
    }
  }

  function onButtonPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const start = pointerStart.current;
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
      clearLongPress();
    }
  }

  function changeSpeed(nextSpeed: number) {
    onSpeedChange(Math.max(1, Math.min(10, nextSpeed)));
    revealFab();
  }

  useEffect(() => {
    if (!playing) {
      if (rafId.current) window.cancelAnimationFrame(rafId.current);
      rafId.current = null;
      lastTime.current = 0;
      return;
    }

    function tick(now: number) {
      if (lastTime.current === 0) lastTime.current = now;
      const elapsed = Math.min(24, now - lastTime.current);
      lastTime.current = now;

      const el = scrollElement || document.querySelector<HTMLElement>(".reader-content");
      if (!el) {
        rafId.current = window.requestAnimationFrame(tick);
        return;
      }
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
        onPlayingChange(false);
        return;
      }
      el.scrollTop += pxPerMs * elapsed;
      rafId.current = window.requestAnimationFrame(tick);
    }

    rafId.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafId.current) window.cancelAnimationFrame(rafId.current);
      rafId.current = null;
      lastTime.current = 0;
    };
  }, [onPlayingChange, playing, pxPerMs, scrollElement]);

  useEffect(() => {
    if (playing) revealFab();
  }, [playing]);

  useEffect(() => {
    return () => {
      clearLongPress();
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (rafId.current) window.cancelAnimationFrame(rafId.current);
    };
  }, []);

  return (
    <div className={`auto-scroll-fab ${showFab ? "visible" : ""}`}>
      {showFab && (
        <div className="auto-scroll-speed-panel" onPointerDown={(event) => event.stopPropagation()}>
          <button
            className="speed-step-button"
            type="button"
            title="降低速度"
            onClick={() => changeSpeed(displaySpeed - 1)}
          >
            <Minus size={16} />
          </button>
          <label className="speed-slider">
            <span>{displaySpeed}</span>
            <input
              type="range"
              min="1"
              max="10"
              step="1"
              value={displaySpeed}
              aria-label="自动滚动速度"
              onChange={(event) => changeSpeed(Number(event.target.value))}
            />
          </label>
          <button
            className="speed-step-button"
            type="button"
            title="提高速度"
            onClick={() => changeSpeed(displaySpeed + 1)}
          >
            <Plus size={16} />
          </button>
        </div>
      )}

      <button
        className="fab-button"
        type="button"
        title={playing ? `${displaySpeed} 档 · 暂停` : "自动滚屏"}
        onPointerDown={onButtonPointerDown}
        onPointerUp={onButtonPointerUp}
        onPointerLeave={onButtonPointerUp}
        onPointerMove={onButtonPointerMove}
      >
        {playing ? <Pause size={22} /> : <Play size={22} />}
      </button>
    </div>
  );
}
