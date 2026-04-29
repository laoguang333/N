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
        FRONTEND / "node_modules" / "@vitejs" / "plugin-vue" / "dist" / "index.mjs",
        FRONTEND / "node_modules" / "vue" / "dist",
    ]
    return all(path.exists() for path in required_paths)


def cargo_run_command(cargo: str) -> list[str]:
    return [cargo, "run", "--manifest-path", str(ROOT / "Cargo.toml")]


def run(command: list[str], cwd: Path) -> None:
    print(f"+ {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=cwd, check=True)


if __name__ == "__main__":
    sys.exit(main())
