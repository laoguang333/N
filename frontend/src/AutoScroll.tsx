import { useEffect, useRef } from "react";
import { Minus, Pause, Play, Plus } from "lucide-react";

const SPEED_TABLE = [0, 4, 6, 8, 10, 12, 16, 20, 26, 34, 44];

type AutoScrollProps = {
  playing: boolean;
  speed: number;
  controlsVisible: boolean;
  scrollElement: HTMLElement | null;
  onPlayingChange: (playing: boolean) => void;
  onSpeedChange: (speed: number) => void;
};

export default function AutoScroll({
  playing,
  speed,
  controlsVisible,
  scrollElement,
  onPlayingChange,
  onSpeedChange,
}: AutoScrollProps) {
  const rafId = useRef<number | null>(null);
  const lastTime = useRef(0);
  const fractionalScroll = useRef(0);
  const onPlayingChangeRef = useRef(onPlayingChange);
  const pxPerMsRef = useRef(0);

  const displaySpeed = Math.max(1, Math.min(10, Math.round(speed || 5)));

  onPlayingChangeRef.current = onPlayingChange;
  pxPerMsRef.current = SPEED_TABLE[displaySpeed] / 1000;

  function changeSpeed(nextSpeed: number) {
    onSpeedChange(Math.max(1, Math.min(10, nextSpeed)));
  }

  useEffect(() => {
    if (!playing) {
      if (rafId.current) window.cancelAnimationFrame(rafId.current);
      rafId.current = null;
      lastTime.current = 0;
      fractionalScroll.current = 0;
      return;
    }

    function tick(now: number) {
      if (lastTime.current === 0) lastTime.current = now;
      const elapsed = Math.min(100, Math.max(0, now - lastTime.current));
      lastTime.current = now;

      const el = scrollElement || document.querySelector<HTMLElement>(".reader-content");
      if (!el) {
        rafId.current = window.requestAnimationFrame(tick);
        return;
      }
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
        onPlayingChangeRef.current(false);
        return;
      }
      const distance = fractionalScroll.current + pxPerMsRef.current * elapsed;
      const wholePixels = Math.floor(distance);
      fractionalScroll.current = distance - wholePixels;
      if (wholePixels > 0) el.scrollTop += wholePixels;
      rafId.current = window.requestAnimationFrame(tick);
    }

    rafId.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafId.current) window.cancelAnimationFrame(rafId.current);
      rafId.current = null;
      lastTime.current = 0;
      fractionalScroll.current = 0;
    };
  }, [playing, scrollElement]);

  useEffect(() => {
    return () => {
      if (rafId.current) window.cancelAnimationFrame(rafId.current);
    };
  }, []);

  const showFab = controlsVisible;

  return (
    <div className={`auto-scroll-fab ${showFab ? "visible" : ""}`}>
      {showFab && (
        <div className="auto-scroll-speed-panel" onClick={(event) => event.stopPropagation()}>
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
        aria-label={playing ? `暂停自动滚屏，当前 ${displaySpeed} 档` : "开始自动滚屏"}
        aria-pressed={playing}
        onClick={() => onPlayingChange(!playing)}
      >
        {playing ? <Pause size={22} /> : <Play size={22} />}
      </button>
    </div>
  );
}
