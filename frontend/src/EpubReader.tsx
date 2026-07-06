import { useEffect, useRef, useState } from "react";
import ePub from "epubjs";
import { ArrowLeft, ArrowRight, List, LoaderCircle } from "lucide-react";

import {
  epubProgressFromLocation,
  resolveEpubTocHref,
  type EpubTocItem,
} from "./epub";

type EpubReaderProps = {
  url: string;
  progress: any;
  settings: {
    fontSize: number;
    lineHeight: number;
    theme: string;
  };
  controlsVisible: boolean;
  onControlsVisibleChange: (visible: boolean) => void;
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
  onControlsVisibleChange,
  onProgress,
}: EpubReaderProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<any>(null);
  const renditionRef = useRef<any>(null);
  const saveTimer = useRef<number | null>(null);
  const onProgressRef = useRef(onProgress);
  const controlsVisibleRef = useRef(controlsVisible);
  const onControlsVisibleChangeRef = useRef(onControlsVisibleChange);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tocOpen, setTocOpen] = useState(false);
  const [toc, setToc] = useState<EpubTocItem[]>([]);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    controlsVisibleRef.current = controlsVisible;
    onControlsVisibleChangeRef.current = onControlsVisibleChange;
  }, [controlsVisible, onControlsVisibleChange]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let disposed = false;

    root.innerHTML = "";
    setLoading(true);
    setError("");
    setToc([]);
    setTocOpen(false);

    const book = ePub(url, { openAs: "epub" });
    const rendition = book.renderTo(root, {
      width: "100%",
      height: "100%",
      flow: "paginated",
      spread: "none",
      manager: "default",
    });
    bookRef.current = book;
    renditionRef.current = rendition;
    rendition.hooks.content.register((contents: any) => {
      contents.document.addEventListener("click", () => {
        onControlsVisibleChangeRef.current(!controlsVisibleRef.current);
      });
    });

    rendition.themes.register("paper", {
      body: {
        color: "#29251f",
        background: "#f8f1e5",
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
      .then(() => setLoading(false))
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

  function previousPage() {
    void renditionRef.current?.prev();
  }

  function nextPage() {
    void renditionRef.current?.next();
  }

  function displayHref(href: string) {
    const rendition = renditionRef.current;
    if (!rendition) return;
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
        onClick={() => onControlsVisibleChange(!controlsVisible)}
      />
      {loading && (
        <div className="epub-overlay">
          <LoaderCircle className="spin" size={30} />
        </div>
      )}
      {error && <p className="error reader-error">{error}</p>}
      <div className={`epub-controls ${controlsVisible || tocOpen ? "is-visible" : ""}`}>
        <button type="button" className="icon-button" onClick={previousPage} title="上一页">
          <ArrowLeft size={21} />
        </button>
        <button type="button" className="icon-button" onClick={() => setTocOpen((value) => !value)} title="目录">
          <List size={21} />
        </button>
        <button type="button" className="icon-button" onClick={nextPage} title="下一页">
          <ArrowRight size={21} />
        </button>
      </div>
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
