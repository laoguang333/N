export type EpubTocItem = {
  id?: string;
  href?: string;
  label?: string;
  subitems?: EpubTocItem[];
};

type EpubBook = {
  packaging?: {
    navPath?: string;
  };
  spine?: {
    get: (target: string) => unknown;
  };
};

type EpubLocation = {
  start?: {
    cfi?: string;
  };
};

type EpubLocations = {
  length?: () => number;
  percentageFromCfi?: (cfi: string) => number;
};

export function resolveEpubTocHref(book: EpubBook | null, href: string): string {
  if (!book?.spine || !href || book.spine.get(href)) {
    return href;
  }

  const navPath = book.packaging?.navPath;
  if (!navPath) {
    return href;
  }

  const suffixIndex = findSuffixIndex(href);
  const path = suffixIndex === -1 ? href : href.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? "" : href.slice(suffixIndex);
  const navDirectory = navPath.includes("/")
    ? navPath.slice(0, navPath.lastIndexOf("/") + 1)
    : "";
  const candidate = `${normalizeEpubPath(`${navDirectory}${path}`)}${suffix}`;

  return book.spine.get(candidate) ? candidate : href;
}

export function epubProgressFromLocation(
  locations: EpubLocations | null,
  location: EpubLocation,
): { percent: number; locator: string } | null {
  const locator = location?.start?.cfi;
  if (!locator || !locations?.length || !locations.percentageFromCfi || locations.length() === 0) {
    return null;
  }

  const percent = locations.percentageFromCfi(locator);
  if (!Number.isFinite(percent)) {
    return null;
  }

  return {
    percent: Math.min(1, Math.max(0, percent)),
    locator,
  };
}

function findSuffixIndex(href: string): number {
  const queryIndex = href.indexOf("?");
  const fragmentIndex = href.indexOf("#");
  if (queryIndex === -1) return fragmentIndex;
  if (fragmentIndex === -1) return queryIndex;
  return Math.min(queryIndex, fragmentIndex);
}

function normalizeEpubPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}
