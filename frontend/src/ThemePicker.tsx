import { Check } from "lucide-react";
import { THEME_OPTIONS } from "./themes";

type ThemePickerProps = {
  value: string;
  onChange: (theme: string) => void;
};

export default function ThemePicker({ value, onChange }: ThemePickerProps) {
  return (
    <div className="theme-grid" role="radiogroup" aria-label="阅读主题">
      {THEME_OPTIONS.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            className={`theme-option ${active ? "active" : ""}`}
            onClick={() => onChange(option.id)}
          >
            <span className={`theme-swatch ${option.id === "auto" ? "is-auto" : `theme-${option.id}`}`} aria-hidden="true">
              <span>文</span>
              {active && <Check className="theme-swatch-check" size={12} strokeWidth={3} />}
            </span>
            <span className="theme-option-label">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
