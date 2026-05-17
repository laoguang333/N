import { expect, test } from "@playwright/test";

test("anime library virtualizes large video lists", async ({ page }) => {
  const videos = Array.from({ length: 1000 }, (_, index) => ({
    id: index + 1,
    title: `Anime Episode ${String(index + 1).padStart(4, "0")}`,
    file_path: `D:\\will\\[A]\\show\\ep${index + 1}.mp4`,
    extension: "mp4",
    folder_tag: "show",
    size: 1024 * 1024 * 200,
    mtime: 1,
    duration_seconds: 1440,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    video_codec: "h264",
    audio_codec: "aac",
    width: 1920,
    height: 1080,
    rating: null,
    file_state: "available",
    last_seen_at: "2026-05-17T00:00:00.000Z",
    missing_since: null,
    progress: null,
    created_at: "2026-05-17T00:00:00.000Z",
    updated_at: "2026-05-17T00:00:00.000Z",
  }));

  await page.route("**/api/config", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        library_dirs: ["fixture-library"],
        scan_recursive: false,
        scan_on_startup: false,
        anime_dirs: ["D:\\will\\[A]"],
        anime_scan_recursive: true,
        anime_scan_on_startup: false,
      }),
    });
  });
  await page.route("**/api/shelf**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], books: [], folders: [] }),
    });
  });
  await page.route("**/api/anime/tools", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ffmpeg: null, ffprobe: null }),
    });
  });
  await page.route("**/api/anime/videos**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(videos),
    });
  });

  await page.goto("/#/a");

  await expect(page.locator(".anime-row", { hasText: "Anime Episode 0001" })).toBeVisible();
  await expect.poll(() => page.locator(".anime-row").count()).toBeLessThan(80);
});
