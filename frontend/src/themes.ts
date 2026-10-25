// Reader skins. Colors live in styles.css as `.theme-{id}` variable sets; this
// module only describes which skins exist and how settings map onto them.

export type ThemeId = "paper" | "white" | "sepia" | "green" | "pink" | "night" | "midnight" | "oled";
export type ThemeSetting = ThemeId | "auto";

export type ThemeOption = {
  id: ThemeSetting;
  label: string;
  dark: boolean;
};

export const THEME_OPTIONS: ThemeOption[] = [
  { id: "auto", label: "跟随系统", dark: false },
  { id: "paper", label: "纸色", dark: false },
  { id: "white", label: "素白", dark: false },
  { id: "sepia", label: "羊皮", dark: false },
  { id: "green", label: "护眼", dark: false },
  { id: "pink", label: "樱粉", dark: false },
  { id: "night", label: "夜间", dark: true },
  { id: "midnight", label: "深蓝", dark: true },
  { id: "oled", label: "纯黑", dark: true },
];

const THEME_IDS = new Set<string>(THEME_OPTIONS.map((option) => option.id));
const DARK_THEMES = new Set<string>(THEME_OPTIONS.filter((option) => option.dark).map((option) => option.id));

export function isThemeSetting(value: unknown): value is ThemeSetting {
  return typeof value === "string" && THEME_IDS.has(value);
}

export function resolveTheme(setting: string, prefersDark: boolean): ThemeId {
  if (setting === "auto") return prefersDark ? "night" : "paper";
  return isThemeSetting(setting) ? setting as ThemeId : "paper";
}

export function isDarkTheme(theme: string) {
  return DARK_THEMES.has(theme);
}

export type FontOption = {
  id: "system" | "serif" | "kai" | "sans";
  label: string;
  stack: string;
};

export const FONT_OPTIONS: FontOption[] = [
  {
    id: "system",
    label: "默认",
    stack: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
  },
  {
    id: "serif",
    label: "宋体",
    stack: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", STSong, SimSun, serif',
  },
  {
    id: "kai",
    label: "楷体",
    stack: '"LXGW WenKai", "Kaiti SC", STKaiti, KaiTi, "楷体", serif',
  },
  {
    id: "sans",
    label: "黑体",
    stack: '"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Heiti SC", sans-serif',
  },
];

export function fontStack(fontFamily: string) {
  return (FONT_OPTIONS.find((option) => option.id === fontFamily) || FONT_OPTIONS[0]).stack;
}

export type WidthOption = {
  id: "narrow" | "medium" | "wide" | "full";
  label: string;
  width: string;
};

export const WIDTH_OPTIONS: WidthOption[] = [
  { id: "narrow", label: "窄", width: "640px" },
  { id: "medium", label: "标准", width: "760px" },
  { id: "wide", label: "宽", width: "960px" },
  { id: "full", label: "全宽", width: "100%" },
];

export function contentWidth(width: string) {
  return (WIDTH_OPTIONS.find((option) => option.id === width) || WIDTH_OPTIONS[1]).width;
}
