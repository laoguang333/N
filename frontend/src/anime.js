export function formatVideoDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function formatVideoStatus(progress) {
  if (!progress) return "未看";
  if (progress.percent >= 0.95) return "已看";
  return "观看中";
}

export function buildAnimeQueryParams({ search = "", status = "all", availability = "available", minRating = "", sort = "recent" } = {}) {
  const params = new URLSearchParams();
  if (search.trim()) params.set("search", search.trim());
  if (status && status !== "all") params.set("status", status);
  if (availability && availability !== "available") params.set("availability", availability);
  if (minRating) params.set("min_rating", String(minRating));
  if (sort && sort !== "recent") params.set("sort", sort);
  return params;
}
