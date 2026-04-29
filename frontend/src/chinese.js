import * as OpenCC from "opencc-js";

const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });

export function normalizeChinese(text) {
  if (!text) {
    return "";
  }

  return toSimplified(String(text))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeChineseQuery(text) {
  return normalizeChinese(text);
}
