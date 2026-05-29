import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";

function useIsTauriWindow() {
  const [isTauri, setIsTauri] = useState(false);

  useEffect(() => {
    setIsTauri(typeof window !== "undefined" && "__TAURI_INTERNALS__" in window);
  }, []);

  return isTauri;
}

function TauriTestWindow() {
  const isTauri = useIsTauriWindow();
  const status = useMemo(
    () => (isTauri ? "已检测到 Tauri 运行时" : "当前在普通浏览器中预览"),
    [isTauri],
  );

  async function minimizeWindow() {
    if (!isTauri) return;
    await getCurrentWindow().minimize();
  }

  async function toggleMaximize() {
    if (!isTauri) return;
    const currentWindow = getCurrentWindow();
    if (await currentWindow.isMaximized()) {
      await currentWindow.unmaximize();
      return;
    }
    await currentWindow.maximize();
  }

  async function closeWindow() {
    if (!isTauri) return;
    await getCurrentWindow().close();
  }

  return (
    <main className="tauri-test-page">
      <section className="tauri-test-card">
        <p className="tauri-test-eyebrow">Tauri window probe</p>
        <h1>Tauri 测试窗口</h1>
        <p className="tauri-test-copy">
          这是一个独立的窗口页，用来验证把 Tauri 前端能力引入后会增加多少体积。
        </p>
        <p className="tauri-test-status">{status}</p>
        <div className="tauri-test-actions">
          <button type="button" onClick={minimizeWindow} disabled={!isTauri}>
            Minimize
          </button>
          <button type="button" onClick={toggleMaximize} disabled={!isTauri}>
            Maximize
          </button>
          <button type="button" onClick={closeWindow} disabled={!isTauri}>
            Close
          </button>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("tauri-test")!).render(<TauriTestWindow />);
