const POSITION_KIND = "paragraph_utf16_lf_v1";

function clampFraction(value) {
  return Math.min(1, Math.max(0, value));
}

export function captureParagraphAnchor({ paragraphs, virtualItems, listOffset }) {
  if (!Array.isArray(paragraphs) || !Array.isArray(virtualItems) || !Number.isFinite(listOffset)) {
    return null;
  }

  const row = virtualItems.find((item) => (
    item
    && Number.isInteger(item.index)
    && item.index >= 0
    && item.index < paragraphs.length
    && Number.isFinite(item.start)
    && Number.isFinite(item.end)
    && Number.isFinite(item.size)
    && item.size > 0
    && item.end > listOffset
  ));
  if (!row) return null;

  const paragraph = paragraphs[row.index];
  if (!paragraph || !Number.isFinite(paragraph.offset)) return null;

  return {
    char_offset: paragraph.offset,
    paragraph_fraction: clampFraction((listOffset - row.start) / row.size),
    position_kind: POSITION_KIND,
  };
}
