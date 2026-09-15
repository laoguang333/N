import { useEffect, useRef } from "react";
import { List, X } from "lucide-react";

type Chapter = {
  id: string;
  title: string;
  offset: number;
  paragraphIndex: number;
};

type ChapterDrawerProps = {
  chapters: Chapter[];
  activeIndex: number;
  onClose: () => void;
  onSelect: (chapter: Chapter) => void;
};

export default function ChapterDrawer({
  chapters,
  activeIndex,
  onClose,
  onSelect,
}: ChapterDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="chapter-drawer"
      aria-labelledby="chapter-drawer-title"
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
          <span>
            <List size={19} aria-hidden="true" />
            <strong id="chapter-drawer-title">目录</strong>
          </span>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭目录">
            <X size={20} />
          </button>
        </header>
        <p className="chapter-count">共 {chapters.length} 章</p>
        <nav className="chapter-list" aria-label="章节目录">
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
      </div>
    </dialog>
  );
}
