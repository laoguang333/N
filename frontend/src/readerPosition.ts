// Use rendered text rather than the virtual list's estimated total height.
export function readingTop(root: HTMLElement) {
  return root.getBoundingClientRect().top + parseFloat(getComputedStyle(root).paddingTop || "0");
}

export function characterRect(paragraph: HTMLElement, offset: number): DOMRect | null {
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length || 0;
    if (remaining < length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.setEnd(node, remaining + 1);
      return range.getBoundingClientRect();
    }
    remaining -= length;
    node = walker.nextNode();
  }
  return null;
}

export function readTextPosition(root: HTMLElement, totalLength: number) {
  if (root.scrollTop <= 1) return { char_offset: 0, percent: 0 };
  const top = readingTop(root);
  const paragraphs = Array.from(root.querySelectorAll<HTMLElement>("p[data-offset]"));
  const paragraph = paragraphs.find((item) => item.getBoundingClientRect().bottom > top) || paragraphs.at(-1);
  if (!paragraph) return null;
  let low = 0;
  let high = Math.max(0, (paragraph.textContent?.length || 0) - 1);
  // Find the first character on the first readable line, including inside highlights.
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const rect = characterRect(paragraph, middle);
    if (rect && rect.bottom <= top) low = middle + 1;
    else high = middle;
  }
  const offset = Number(paragraph.dataset.offset) + low;
  const atEnd = root.scrollHeight - root.clientHeight - root.scrollTop <= 2;
  return { char_offset: offset, percent: atEnd ? 1 : Math.min(1, offset / Math.max(1, totalLength)) };
}

export function createReadingTapHandler(onTap: () => void) {
  let start: { x: number; y: number; moved: boolean } | null = null;
  return {
    pointerdown(event: PointerEvent) {
      start = event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY, moved: false } : null;
    },
    pointermove(event: PointerEvent) {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) start.moved = true;
    },
    pointercancel() { start = null; },
    click(event: MouseEvent) {
      const selection = (event.target as Node)?.ownerDocument?.getSelection();
      const interactive = (event.target as Element)?.closest?.("a, button, input, select, textarea, [contenteditable=true]");
      if (start && !start.moved && !selection?.toString() && !interactive) onTap();
      start = null;
    },
  };
}
