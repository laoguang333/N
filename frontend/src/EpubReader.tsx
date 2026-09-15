import { useEffect, useRef, useState } from "react";
import ePub from "epubjs";
import { List, LoaderCircle } from "lucide-react";

import AutoScroll from "./AutoScroll";
import {
  epubProgressFromLocation,
  resolveEpubTocHref,
  type EpubTocItem,
} from "./epub";
import { createReadingTapHandler } from "./readerPosition";

type EpubReaderProps = {
  url: string;
  progress: any;
  settings: {
    fontSize: number;
    lineHeight: number;
    theme: string;
  };
  controlsVisible: boolean;
  autoScrollPlaying: boolean;
  autoScrollSpeed: number;
  interactionBlocked?: boolean;
  onControlsVisibleChange: (visible: boolean) => void;
  onAutoScrollPlayingChange: (playing: boolean) => void;
  onAutoScrollSpeedChange: (speed: number) => void;
  onProgress: (progress: { percent: number; locator: string | null }) => void;
};

type EpubTocItemsProps = {
  items: EpubTocItem[];
  onSelect: (href: string) => void;
};

function EpubTocItems({ items, onSelect }: EpubTocItemsProps) {
  return items.map((item) => (
    <div className="epub-toc-group" key={item.id || item.href || item.label}>
      {item.href && (
        <button type="button" onClick={() => onSelect(item.href!)}>
          {item.label || item.href}
        </button>
      )}
      {item.subitems && item.subitems.length > 0 && (
        <EpubTocItems items={item.subitems} onSelect={onSelect} />
      )}
    </div>
  ));
}

export default function EpubReader({
  url,
  progress,
  settings,
  controlsVisible,
  autoScrollPlaying,
  autoScrollSpeed,
  interactionBlocked = false,
  onControlsVisibleChange,
  onAutoScrollPlayingChange,
  onAutoScrollSpeedChange,
  onProgress,
}: EpubReaderProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<any>(null);
  const renditionRef = useRef<any>(null);
  const saveTimer = useRef<number | null>(null);
  const onProgressRef = useRef(onProgress);
  const controlsVisibleRef = useRef(controlsVisible);
  const onControlsVisibleChangeRef = useRef(onControlsVisibleChange);
  const autoScrollPlayingRef = useRef(autoScrollPlaying);
  const onAutoScrollPlayingChangeRef = useRef(onAutoScrollPlayingChange);
  const interactionBlockedRef = useRef(interactionBlocked);
  const stageTapHandlerRef = useRef<ReturnType<typeof createReadingTapHandler> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tocOpen, setTocOpen] = useState(false);
  const [toc, setToc] = useState<EpubTocItem[]>([]);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    controlsVisibleRef.current = controlsVisible;
    onControlsVisibleChangeRef.current = onControlsVisibleChange;
    interactionBlockedRef.current = interactionBlocked || tocOpen;
  }, [controlsVisible, interactionBlocked, tocOpen, onControlsVisibleChange]);

  useEffect(() => {
    autoScrollPlayingRef.current = autoScrollPlaying;
    onAutoScrollPlayingChangeRef.current = onAutoScrollPlayingChange;
  }, [autoScrollPlaying, onAutoScrollPlayingChange]);

  if (!stageTapHandlerRef.current) {
    stageTapHandlerRef.current = createReadingTapHandler(() => {
      if (interactionBlockedRef.current) return;
      onControlsVisibleChangeRef.current(!controlsVisibleRef.current);
    });
  }

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let disposed = false;

    root.innerHTML = "";
    setLoading(true);
    setError("");
    setToc([]);
    setTocOpen(false);
    setScrollElement(null);

    const book = ePub(url, { openAs: "epub" });
    const rendition = book.renderTo(root, {
      width: "100%",
      height: "100%",
      flow: "scrolled",
      spread: "none",
      manager: "continuous",
    }) as ReturnType<typeof book.renderTo> & { manager?: { container: HTMLElement } };
    bookRef.current = book;
    renditionRef.current = rendition;
    setScrollElement(rendition.manager?.container || null);
    rendition.hooks.content.register((contents: any) => {
      const tapHandler = createReadingTapHandler(() => {
        if (interactionBlockedRef.current) return;
        onControlsVisibleChangeRef.current(!controlsVisibleRef.current);
      });
      contents.document.addEventListener("pointerdown", tapHandler.pointerdown);
      contents.document.addEventListener("pointermove", tapHandler.pointermove);
      contents.document.addEventListener("pointercancel", tapHandler.pointercancel);
      contents.document.addEventListener("click", tapHandler.click);
      const stopAutoScroll = () => {
        if (autoScrollPlayingRef.current) {
          onAutoScrollPlayingChangeRef.current(false);
        }
      };
      contents.document.addEventListener("wheel", stopAutoScroll, { passive: true });
      contents.document.addEventListener("touchmove", stopAutoScroll, { passive: true });
    });

    rendition.themes.register("paper", {
      body: {
        color: "#29251f",
        background: "#f8f1e5",
        margin: "0 auto !important",
        padding: "20px 20px 64px !important",
        "box-sizing": "border-box !important",
        "max-width": "760px !important",
        "line-height": `${settings.lineHeight} !important`,
      },
      "p, div, li": {
        "line-height": `${settings.lineHeight} !important`,
      },
      "::selection": {
        background: "#d9c7a3",
      },
    });
    rendition.themes.register("night", {
      body: {
        color: "#e8e1d5",
        background: "#141312",
        margin: "0 auto !important",
        padding: "20px 20px 64px !important",
        "box-sizing": "border-box !important",
        "max-width": "760px !important",
        "line-height": `${settings.lineHeight} !important`,
      },
      "p, div, li": {
        "line-height": `${settings.lineHeight} !important`,
      },
      "::selection": {
        background: "#574d3f",
      },
    });
    rendition.themes.select(settings.theme === "night" ? "night" : "paper");
    rendition.themes.fontSize(`${settings.fontSize}px`);

    function reportProgress(location: any) {
      const nextProgress = epubProgressFromLocation(book.locations, location);
      if (!nextProgress || disposed) return;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        onProgressRef.current(nextProgress);
      }, 350);
    }

    book.ready
      .then(() => book.locations.generate(1200))
      .then(() => reportProgress(rendition.currentLocation()))
      .catch(() => undefined);
    book.loaded.navigation
      .then((navigation: any) => setToc(navigation?.toc || []))
      .catch(() => setToc([]));

    rendition.on("relocated", reportProgress);

    rendition
      .display(progress?.locator || undefined)
      .then(() => {
        if (disposed) return;
        setScrollElement(rendition.manager?.container || null);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message || "EPUB 加载失败");
        setLoading(false);
      });

    return () => {
      disposed = true;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      rendition.destroy();
      book.destroy();
      renditionRef.current = null;
      bookRef.current = null;
    };
  }, [url]);

  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    rendition.themes.select(settings.theme === "night" ? "night" : "paper");
    rendition.themes.fontSize(`${settings.fontSize}px`);
    rendition.themes.override("line-height", `${settings.lineHeight}`, true);
  }, [settings.fontSize, settings.lineHeight, settings.theme]);

  function displayHref(href: string) {
    const rendition = renditionRef.current;
    if (!rendition) return;
    onAutoScrollPlayingChange(false);
    const target = resolveEpubTocHref(bookRef.current, href);
    void rendition
      .display(target)
      .then(() => {
        setError("");
        setTocOpen(false);
      })
      .catch((err: Error) => {
        setError(err.message || "EPUB 章节加载失败");
      });
  }

  return (
    <div className="epub-shell">
      <div
        ref={rootRef}
        className="epub-stage"
        onPointerDown={(event) => stageTapHandlerRef.current?.pointerdown(event.nativeEvent)}
        onPointerMove={(event) => stageTapHandlerRef.current?.pointermove(event.nativeEvent)}
        onPointerCancel={() => stageTapHandlerRef.current?.pointercancel()}
        onClick={(event) => stageTapHandlerRef.current?.click(event.nativeEvent)}
        onWheel={() => autoScrollPlaying && onAutoScrollPlayingChange(false)}
        onTouchMove={() => autoScrollPlaying && onAutoScrollPlayingChange(false)}
      />
      {loading && (
        <div className="epub-overlay">
          <LoaderCircle className="spin" size={30} />
        </div>
      )}
      {error && <p className="error reader-error">{error}</p>}
      <div className={`epub-controls ${controlsVisible || tocOpen ? "is-visible" : ""}`}>
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            onAutoScrollPlayingChange(false);
            setTocOpen((value) => !value);
          }}
          title="目录"
          aria-label="打开 EPUB 目录"
          aria-expanded={tocOpen}
        >
          <List size={21} />
        </button>
      </div>
      {!loading && scrollElement && (
        <AutoScroll
          playing={autoScrollPlaying}
          speed={autoScrollSpeed}
          controlsVisible={controlsVisible}
          scrollElement={scrollElement}
          onPlayingChange={onAutoScrollPlayingChange}
          onSpeedChange={onAutoScrollSpeedChange}
        />
      )}
      {tocOpen && (
        <aside className="epub-toc">
          <strong>目录</strong>
          <div className="epub-toc-list">
            {toc.length === 0 ? (
              <span>无目录</span>
            ) : (
              <EpubTocItems items={toc} onSelect={displayHref} />
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
