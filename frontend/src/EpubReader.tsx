import { useEffect, useRef, useState } from "react";
import ePub from "epubjs";
import { ArrowLeft, ArrowRight, List, LoaderCircle } from "lucide-react";

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tocOpen, setTocOpen] = useState(false);
  const [toc, setToc] = useState<any[]>([]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

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

    book.ready
      .then(() => book.locations.generate(1200))
      .catch(() => undefined);
    book.loaded.navigation
      .then((navigation: any) => setToc(navigation?.toc || []))
      .catch(() => setToc([]));

    rendition.on("relocated", (location: any) => {
      const cfi = location?.start?.cfi || null;
      let percent = 0;
      if (cfi && book.locations?.length?.()) {
        percent = book.locations.percentageFromCfi(cfi) || 0;
      } else if (Number.isFinite(location?.start?.percentage)) {
        percent = location.start.percentage;
      }
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        onProgress({ percent: Math.min(1, Math.max(0, percent)), locator: cfi });
      }, 350);
    });

    rendition
      .display(progress?.locator || undefined)
      .then(() => setLoading(false))
      .catch((err: Error) => {
        setError(err.message || "EPUB 加载失败");
        setLoading(false);
      });

    return () => {
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
    setTocOpen(false);
    void renditionRef.current?.display(href);
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
              toc.map((item) => (
                <button key={item.id || item.href || item.label} type="button" onClick={() => displayHref(item.href)}>
                  {item.label || item.href}
                </button>
              ))
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
