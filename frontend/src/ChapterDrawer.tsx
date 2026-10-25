import { useEffect, useRef } from "react";
import { Bookmark, List, LoaderCircle, Trash2, X } from "lucide-react";

type Chapter = {
  id: string;
  title: string;
  offset: number;
  paragraphIndex: number;
};

export type BookmarkItem = {
  id: number;
  char_offset: number;
  percent: number;
  paragraph_fraction: number | null;
  excerpt: string;
  chapter_title: string | null;
  created_at: string;
};

export type DrawerTab = "chapters" | "bookmarks";

type ChapterDrawerProps = {
  chapters: Chapter[];
  activeIndex: number;
  bookmarks: BookmarkItem[];
  bookmarksLoading: boolean;
  tab: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
  onClose: () => void;
  onSelect: (chapter: Chapter) => void;
  onSelectBookmark: (bookmark: BookmarkItem) => void;
  onDeleteBookmark: (bookmark: BookmarkItem) => void;
};

function formatBookmarkDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function ChapterDrawer({
  chapters,
  activeIndex,
  bookmarks,
  bookmarksLoading,
  tab,
  onTabChange,
  onClose,
  onSelect,
  onSelectBookmark,
  onDeleteBookmark,
}: ChapterDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const listRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    if (tab !== "chapters") return;
    listRef.current
      ?.querySelector<HTMLElement>("[aria-current='location']")
      ?.scrollIntoView({ block: "center" });
  }, [tab]);

  return (
    <dialog
      ref={dialogRef}
      className="chapter-drawer"
      aria-label="目录与书签"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="chapter-drawer-sheet">
        <header className="chapter-drawer-header">
          <div className="drawer-tabs" role="tablist" aria-label="目录与书签">
            <button type="button" role="tab" aria-selected={tab === "chapters"} className={tab === "chapters" ? "active" : ""} onClick={() => onTabChange("chapters")}>
              <List size={17} aria-hidden="true" /> 目录
            </button>
            <button type="button" role="tab" aria-selected={tab === "bookmarks"} className={tab === "bookmarks" ? "active" : ""} onClick={() => onTabChange("bookmarks")}>
              <Bookmark size={17} aria-hidden="true" /> 书签
              {bookmarks.length > 0 && <span className="drawer-tab-count">{bookmarks.length}</span>}
            </button>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭目录">
            <X size={20} />
          </button>
        </header>

        {tab === "chapters" ? (
          <>
            <p className="chapter-count">{chapters.length > 0 ? `共 ${chapters.length} 章` : "未识别到章节标题"}</p>
            <nav ref={listRef} className="chapter-list" aria-label="章节目录">
              {chapters.map((chapter, index) => (
                <button
                  key={chapter.id}
                  type="button"
                  className={index === activeIndex ? "active" : ""}
                  aria-current={index === activeIndex ? "location" : undefined}
                  onClick={() => onSelect(chapter)}
                >
                  <span>{chapter.title}</span>
                  <small>{index + 1}/{chapters.length}</small>
                </button>
              ))}
            </nav>
          </>
        ) : (
          <>
            <p className="chapter-count">{bookmarksLoading ? "正在加载书签…" : `共 ${bookmarks.length} 个书签`}</p>
            <nav className="chapter-list bookmark-list" aria-label="书签列表">
              {bookmarksLoading && bookmarks.length === 0 && (
                <div className="empty-state drawer-empty"><LoaderCircle className="spin" size={22} /></div>
              )}
              {!bookmarksLoading && bookmarks.length === 0 && (
                <div className="empty-state drawer-empty">
                  <Bookmark size={26} />
                  <p>还没有书签</p>
                  <span>阅读时点击顶部的书签按钮，即可记住当前位置。</span>
                </div>
              )}
              {bookmarks.map((bookmark) => (
                <div key={bookmark.id} className="bookmark-item">
                  <button type="button" className="bookmark-jump" onClick={() => onSelectBookmark(bookmark)}>
                    <span className="bookmark-meta">
                      <b>{bookmark.chapter_title || "未分章"}</b>
                      <span>{Math.round((bookmark.percent || 0) * 100)}%</span>
                    </span>
                    <span className="bookmark-excerpt">{bookmark.excerpt || "（无摘录）"}</span>
                    <small>{formatBookmarkDate(bookmark.created_at)}</small>
                  </button>
                  <button type="button" className="icon-button bookmark-delete" onClick={() => onDeleteBookmark(bookmark)} aria-label="删除书签" title="删除书签">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </nav>
          </>
        )}
      </div>
    </dialog>
  );
}
