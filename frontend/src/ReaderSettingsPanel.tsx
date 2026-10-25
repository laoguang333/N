import { RotateCcw, Type, X } from "lucide-react";
import ThemePicker from "./ThemePicker";
import { FONT_OPTIONS, WIDTH_OPTIONS } from "./themes";

export type ReaderSettings = {
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  theme: string;
  autoScrollSpeed: number;
  fontFamily: string;
  contentWidth: string;
  textIndent: boolean;
  justify: boolean;
  tapPaging: boolean;
  statusBar: boolean;
};

type ToggleKey = "textIndent" | "justify" | "tapPaging" | "statusBar";

const TOGGLES: { key: ToggleKey; label: string; hint: string }[] = [
  { key: "textIndent", label: "首行缩进", hint: "段首空两格" },
  { key: "justify", label: "两端对齐", hint: "行尾整齐" },
  { key: "tapPaging", label: "点击翻页", hint: "轻点屏幕左右两侧翻页" },
  { key: "statusBar", label: "底部状态栏", hint: "章节、进度与时间" },
];

type ReaderSettingsPanelProps = {
  settings: ReaderSettings;
  isEpub: boolean;
  onChange: (patch: Partial<ReaderSettings>) => void;
  onReset: () => void;
  onClose: () => void;
};

export default function ReaderSettingsPanel({ settings, isEpub, onChange, onReset, onClose }: ReaderSettingsPanelProps) {
  return (
    <aside className="settings-panel" aria-label="阅读设置">
      <div className="settings-header">
        <strong>阅读设置</strong>
        <div className="settings-header-actions">
          <button className="text-button" type="button" onClick={onReset} title="恢复默认设置">
            <RotateCcw size={15} /> 恢复默认
          </button>
          <button className="icon-button" type="button" onClick={onClose} title="关闭" aria-label="关闭阅读设置">
            <X size={20} />
          </button>
        </div>
      </div>

      <div className="settings-body">
        <section className="settings-section">
          <h3>主题</h3>
          <ThemePicker value={settings.theme} onChange={(theme) => onChange({ theme })} />
        </section>

        <section className="settings-section">
          <h3>文字</h3>
          <label className="control-row">
            <span><Type size={16} /> 字号</span>
            <input value={settings.fontSize} onChange={(event) => onChange({ fontSize: Number(event.target.value) })} type="range" min="16" max="32" step="1" aria-label="字号" />
            <b>{settings.fontSize}</b>
          </label>
          <label className="control-row">
            <span>行距</span>
            <input value={settings.lineHeight} onChange={(event) => onChange({ lineHeight: Number(event.target.value) })} type="range" min="1.4" max="2.4" step="0.05" aria-label="行距" />
            <b>{settings.lineHeight.toFixed(2)}</b>
          </label>
          {!isEpub && (
            <label className="control-row">
              <span>段距</span>
              <input value={settings.paragraphSpacing} onChange={(event) => onChange({ paragraphSpacing: Number(event.target.value) })} type="range" min="4" max="36" step="2" aria-label="段距" />
              <b>{settings.paragraphSpacing}</b>
            </label>
          )}
          <div className="segmented" role="radiogroup" aria-label="字体">
            {FONT_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={settings.fontFamily === option.id}
                className={settings.fontFamily === option.id ? "active" : ""}
                style={{ fontFamily: option.stack }}
                onClick={() => onChange({ fontFamily: option.id })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>

        {!isEpub && (
          <>
            <section className="settings-section">
              <h3>版心宽度</h3>
              <div className="segmented" role="radiogroup" aria-label="版心宽度">
                {WIDTH_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={settings.contentWidth === option.id}
                    className={settings.contentWidth === option.id ? "active" : ""}
                    onClick={() => onChange({ contentWidth: option.id })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="settings-section">
              <h3>阅读选项</h3>
              <div className="toggle-grid">
                {TOGGLES.map((toggle) => (
                  <label key={toggle.key} className="toggle-row">
                    <span>
                      <b>{toggle.label}</b>
                      <small>{toggle.hint}</small>
                    </span>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={settings[toggle.key]}
                      onChange={(event) => onChange({ [toggle.key]: event.target.checked })}
                    />
                  </label>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
