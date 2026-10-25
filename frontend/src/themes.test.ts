import { describe, expect, test } from "vitest";
import { contentWidth, fontStack, isDarkTheme, isThemeSetting, resolveTheme, THEME_OPTIONS } from "./themes";

describe("themes", () => {
  test("auto follows the system color scheme", () => {
    expect(resolveTheme("auto", false)).toBe("paper");
    expect(resolveTheme("auto", true)).toBe("night");
  });

  test("unknown skins fall back to paper", () => {
    expect(resolveTheme("neon", true)).toBe("paper");
    expect(isThemeSetting("neon")).toBe(false);
    expect(isThemeSetting("sepia")).toBe(true);
  });

  test("every skin has a label and dark skins are flagged", () => {
    expect(THEME_OPTIONS.every((option) => option.label)).toBe(true);
    expect(["night", "midnight", "oled"].every(isDarkTheme)).toBe(true);
    expect(["paper", "white", "sepia", "green", "pink"].some(isDarkTheme)).toBe(false);
  });

  test("font and width options fall back to defaults", () => {
    expect(fontStack("kai")).toContain("KaiTi");
    expect(fontStack("missing")).toBe(fontStack("system"));
    expect(contentWidth("full")).toBe("100%");
    expect(contentWidth("missing")).toBe("760px");
  });
});
