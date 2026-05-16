import { useEffect, useMemo, useRef, useState } from "react";
import { Play } from "lucide-react";

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
  const dialRef = useRef<HTMLDivElement | null>(null);
  const rafId = useRef<number | null>(null);
  const lastTime = useRef(0);
  const longPressTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const pointerStart = useRef<{ x: number; y: number; time: number } | null>(null);
  const [dialOpen, setDialOpen] = useState(false);
  const [fabVisible, setFabVisible] = useState(false);

  const displaySpeed = Math.max(1, Math.min(10, Math.round(speed || 5)));
  const pxPerMs = SPEED_TABLE[displaySpeed] / 100;
  const arcOffset = useMemo(() => {
    const r = 78;
    const c = 2 * Math.PI * r;
    const filled = (displaySpeed / 10) * c;
    return `${filled} ${c}`;
  }, [displaySpeed]);
  const showFab = fabVisible || dialOpen;

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
      if (!dialOpen) setFabVisible(false);
    }, 3000);
  }

  function onButtonPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    revealFab();
    if (dialOpen) return;
    pointerStart.current = { x: event.clientX, y: event.clientY, time: Date.now() };
    longPressTimer.current = window.setTimeout(() => {
      setDialOpen(true);
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
    }
  }

  function onButtonPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const start = pointerStart.current;
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
      clearLongPress();
    }
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
      const elapsed = Math.min(48, now - lastTime.current);
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
    if (!dialOpen) return undefined;

    function onMove(event: PointerEvent) {
      event.preventDefault();
      const el = dialRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let angle = Math.atan2(event.clientY - cy, event.clientX - cx);
      angle = (angle + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
      onSpeedChange(Math.max(1, Math.min(10, Math.round((angle / (Math.PI * 2)) * 10) || 10)));
    }

    function onUp() {
      setDialOpen(false);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setFabVisible(false), 3000);
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [dialOpen, onSpeedChange]);

  useEffect(() => {
    return () => {
      clearLongPress();
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (rafId.current) window.cancelAnimationFrame(rafId.current);
    };
  }, []);

  return (
    <div className={`auto-scroll-fab ${showFab ? "visible" : ""}`}>
      <button
        className="fab-button"
        type="button"
        title={playing ? `${displaySpeed} 档 · 暂停` : "自动滚屏"}
        onPointerDown={onButtonPointerDown}
        onPointerUp={onButtonPointerUp}
        onPointerLeave={onButtonPointerUp}
        onPointerMove={onButtonPointerMove}
      >
        {playing ? <span className="fab-speed">{displaySpeed}</span> : <Play size={22} />}
      </button>

      {dialOpen && (
        <div className="auto-scroll-dial-overlay" onPointerDown={(event) => event.preventDefault()}>
          <div ref={dialRef} className="speed-dial">
            <svg viewBox="0 0 200 200" className="dial-svg">
              <circle cx="100" cy="100" r="78" fill="none" className="dial-track" strokeWidth="10" />
              <circle
                cx="100"
                cy="100"
                r="78"
                fill="none"
                className="dial-fill"
                strokeWidth="10"
                strokeLinecap="round"
                strokeDasharray={arcOffset}
                transform="rotate(-90 100 100)"
              />
              <text x="100" y="94" className="dial-value">{displaySpeed}</text>
              <text x="100" y="116" className="dial-label">档</text>
            </svg>
            <div className="dial-tickmarks">
              {Array.from({ length: 10 }, (_, index) => {
                const n = index + 1;
                return (
                  <span
                    key={n}
                    className={`dial-tick ${n <= displaySpeed ? "active" : ""}`}
                    style={{ transform: `rotate(${n * 36 - 90}deg) translate(0, -94px)` }}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
