import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Star, X } from "lucide-react";
import { listBooks, saveRating } from "./api";
import { formatPercent } from "./reader";
import { createRequestScope } from "./request-scope";

const ITEMS_PER_PAGE = 9;

type FolderOverlayProps = {
  tag: string | null;
  search: string;
  status: string;
  minRating: string | number;
  sort: string;
  onClose: () => void;
  onOpen: (bookId: number) => void;
};

export default function FolderOverlay({
  tag,
  search,
  status,
  minRating,
  sort,
  onClose,
  onOpen,
}: FolderOverlayProps) {
  const [books, setBooks] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [currentPage, setCurrentPage] = useState(0);
  const [ratingBookId, setRatingBookId] = useState<number | null>(null);
  const folderScope = useMemo(() => createRequestScope(), []);
  const folderRatingScope = useMemo(() => createRequestScope(), []);
  const tagRef = useRef(tag);
  const queryKey = JSON.stringify([tag, search, status, minRating, sort]);
  const queryKeyRef = useRef(queryKey);
  const ratingOperationRef = useRef<any>(null);

  const invalidateRating = useCallback(() => {
    const operation = ratingOperationRef.current;
    folderRatingScope.invalidate();
    ratingOperationRef.current = null;
    if (operation) {
      setRatingBookId((current) => current === operation.bookId ? null : current);
    }
  }, [folderRatingScope]);

  const effectiveSearch = useMemo(() => {
    const query = String(search || "").trim().toLowerCase();
    if (!query) return "";
    return String(tag || "").toLowerCase().includes(query) ? "" : search;
  }, [search, tag]);

  const totalPages = Math.max(1, Math.ceil(books.length / ITEMS_PER_PAGE));
  const pageBooks = books.slice(currentPage * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE + ITEMS_PER_PAGE);

  useEffect(() => {
    tagRef.current = tag;
    queryKeyRef.current = queryKey;
  }, [queryKey, tag]);

  useEffect(() => {
    if (!tag) {
      folderScope.invalidate();
      invalidateRating();
      return;
    }
    const ticket = folderScope.begin();
    const requestedTag = tag;
    setLoading(true);
    setError("");
    (listBooks as any)({
      folderTag: requestedTag,
      search: effectiveSearch,
      status,
      minRating,
      sort: sort || "title",
    }, { signal: ticket.signal })
      .then((nextBooks: any[]) => {
        if (!folderScope.isCurrent(ticket) || requestedTag !== tagRef.current) return;
        setBooks(nextBooks);
        setCurrentPage(0);
      })
      .catch((err: Error) => {
        if (!folderScope.isCurrent(ticket) || requestedTag !== tagRef.current || err?.name === "AbortError") return;
        setError(err.message);
      })
      .finally(() => {
        if (folderScope.isCurrent(ticket) && requestedTag === tagRef.current) setLoading(false);
      });
    return () => {
      folderScope.invalidate();
      invalidateRating();
    };
  }, [effectiveSearch, folderScope, invalidateRating, minRating, sort, status, tag]);

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (!tag) return;
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowLeft" && currentPage > 0) {
        setCurrentPage((page) => page - 1);
      } else if (event.key === "ArrowRight" && currentPage < totalPages - 1) {
        setCurrentPage((page) => page + 1);
      }
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [currentPage, onClose, tag, totalPages]);

  async function updateRating(book: any, rating: number) {
    const nextRating = book.rating === rating ? null : rating;
    const ticket = folderRatingScope.begin();
    const requestedTag = tag;
    const requestedQueryKey = queryKey;
    ratingOperationRef.current = { bookId: book.id, requestedQueryKey, requestedTag, ticket };
    setRatingBookId(book.id);
    setError("");
    try {
      const updated = await saveRating(book.id, nextRating);
      if (ratingOperationRef.current?.ticket !== ticket
        || !folderRatingScope.isCurrent(ticket)
        || requestedTag !== tagRef.current
        || requestedQueryKey !== queryKeyRef.current) return;
      setBooks((items) => items.map((item) => (item.id === book.id ? updated : item)));
    } catch (err) {
      if (ratingOperationRef.current?.ticket !== ticket
        || !folderRatingScope.isCurrent(ticket)
        || requestedTag !== tagRef.current
        || requestedQueryKey !== queryKeyRef.current
        || (err as Error)?.name === "AbortError") return;
      setError((err as Error).message);
    } finally {
      if (ratingOperationRef.current?.ticket === ticket
        && folderRatingScope.isCurrent(ticket)
        && requestedTag === tagRef.current
        && requestedQueryKey === queryKeyRef.current) {
        ratingOperationRef.current = null;
        setRatingBookId((current) => current === book.id ? null : current);
      }
    }
  }

  if (!tag) return null;

  return (
    <div className="folder-overlay" onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="folder-panel">
        <header className="folder-panel-header">
          <strong>{tag}</strong>
          <button className="icon-button" type="button" onClick={onClose} title="关闭文件夹">
            <X size={18} />
          </button>
        </header>

        {loading ? (
          <div className="empty-state folder-loading">
            <LoaderCircle className="spin" size={26} />
          </div>
        ) : error ? (
          <p className="error">{error}</p>
        ) : books.length === 0 ? (
          <div className="empty-state folder-empty">
            <p>此文件夹没有小说</p>
          </div>
        ) : (
          <>
            <div className="folder-grid">
              {pageBooks.map((book) => (
                <article
                  key={book.id}
                  className="folder-book"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(book.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpen(book.id);
                    }
                  }}
                >
                  <strong className="folder-book-title">{book.title}</strong>
                  <span className="folder-book-progress">{formatPercent(book.progress)}</span>
                  <span
                    className="folder-book-rating"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    {Array.from({ length: 5 }, (_, index) => {
                      const rating = index + 1;
                      return (
                        <button
                          key={rating}
                          className={`folder-star-button ${(book.rating || 0) >= rating ? "active" : ""}`}
                          type="button"
                          disabled={ratingBookId === book.id}
                          title={book.rating === rating ? "清除评分" : `${rating} 星`}
                          onClick={() => updateRating(book, rating)}
                        >
                          <Star size={12} />
                        </button>
                      );
                    })}
                  </span>
                </article>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="folder-dots">
                {Array.from({ length: totalPages }, (_, index) => (
                  <button
                    key={index}
                    className={`folder-dot ${currentPage === index ? "active" : ""}`}
                    aria-label={`第 ${index + 1} 页`}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setCurrentPage(index);
                    }}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
