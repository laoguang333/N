#!/usr/bin/env python3
"""Start the TXT Reader backend and frontend dev servers."""

from __future__ import annotations

import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"


def main() -> int:
    cargo = require("cargo")
    npm = require("npm")

    if not frontend_dependencies_ready():
        run([npm, "ci"], FRONTEND)

    kill_port_listener(234)
    clear_vite_cache()
    ensure_frontend_dist_current(npm)

    processes = [
        subprocess.Popen(cargo_run_command(cargo), cwd=ROOT),
        subprocess.Popen([npm, "run", "dev"], cwd=FRONTEND),
    ]

    def stop_processes(*_: object) -> None:
        for process in processes:
            if process.poll() is None:
                process.terminate()

    signal.signal(signal.SIGINT, stop_processes)
    signal.signal(signal.SIGTERM, stop_processes)

    try:
        while True:
            for process in processes:
                code = process.poll()
                if code is not None:
                    stop_processes()
                    return code
            time.sleep(1)
    except KeyboardInterrupt:
        stop_processes()
        return 130
    finally:
        for process in processes:
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()


def require(command: str) -> str:
    resolved = shutil.which(command)
    if not resolved:
        raise SystemExit(f"required command not found: {command}")
    return resolved


def frontend_dependencies_ready() -> bool:
    required_paths = [
        FRONTEND / "node_modules" / "vite" / "bin" / "vite.js",
        FRONTEND / "node_modules" / "@vitejs" / "plugin-react" / "dist" / "index.js",
        FRONTEND / "node_modules" / "react" / "index.js",
        FRONTEND / "node_modules" / "react-dom" / "index.js",
    ]
    return all(path.exists() for path in required_paths)


def clear_vite_cache() -> None:
    cache_dir = (FRONTEND / "node_modules" / ".vite").resolve()
    frontend_dir = FRONTEND.resolve()
    if not cache_dir.exists():
        return
    if frontend_dir not in cache_dir.parents:
        raise SystemExit(f"refusing to remove unexpected cache path: {cache_dir}")
    shutil.rmtree(cache_dir)


def ensure_frontend_dist_current(npm: str) -> None:
    index = FRONTEND / "dist" / "index.html"
    if index.exists() and index.stat().st_mtime >= newest_frontend_input_mtime():
        return
    run([npm, "run", "build"], FRONTEND)


def newest_frontend_input_mtime() -> float:
    roots = [
        FRONTEND / "index.html",
        FRONTEND / "package-lock.json",
        FRONTEND / "package.json",
        FRONTEND / "vite.config.js",
        FRONTEND / "tsconfig.json",
        FRONTEND / "src",
        FRONTEND / "public",
    ]
    newest = 0.0
    for root in roots:
        if not root.exists():
            continue
        if root.is_file():
            newest = max(newest, root.stat().st_mtime)
            continue
        for path in root.rglob("*"):
            if path.is_file():
                newest = max(newest, path.stat().st_mtime)
    return newest


def kill_port_listener(port: int) -> None:
    if sys.platform != "win32":
        return
    subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            f"$pids = @(Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); if ($pids.Count -gt 0) {{ Stop-Process -Id $pids -Force -ErrorAction SilentlyContinue }}",
        ],
        cwd=ROOT,
        check=False,
    )


def cargo_run_command(cargo: str) -> list[str]:
    return [cargo, "run", "--manifest-path", str(ROOT / "Cargo.toml")]


def run(command: list[str], cwd: Path) -> None:
    print(f"+ {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=cwd, check=True)


if __name__ == "__main__":
    sys.exit(main())
